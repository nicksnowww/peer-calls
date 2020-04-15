package routes

import (
	"fmt"
	"net/http"
	"reflect"
	"unsafe"

	"github.com/jeremija/peer-calls/src/server/iceauth"
	"github.com/jeremija/peer-calls/src/server/wrtc/signals"
	"github.com/jeremija/peer-calls/src/server/wrtc/tracks"
	"github.com/jeremija/peer-calls/src/server/ws/wsmessage"
	"github.com/jeremija/peer-calls/src/server/wshandler"
	"github.com/pion/webrtc/v2"
)

const localPeerID = "__SERVER__"

type TracksManager interface {
	Add(room string, clientID string, peerConnection tracks.PeerConnection, signaller tracks.Signaller) (closeChannel <-chan struct{})
}

const serverIsInitiator = true

func NewPeerToServerRoomHandler(
	wss *wshandler.WSS,
	iceServers []iceauth.ICEServer,
	tracksManager TracksManager,
) http.Handler {

	webrtcICEServers := []webrtc.ICEServer{}
	for _, iceServer := range iceServers {
		var c webrtc.ICECredentialType
		if iceServer.Username != "" && iceServer.Credential != "" {
			c = webrtc.ICECredentialTypePassword
		}
		webrtcICEServers = append(webrtcICEServers, webrtc.ICEServer{
			URLs:           iceServer.URLs,
			CredentialType: c,
			Username:       iceServer.Username,
			Credential:     iceServer.Credential,
		})
	}

	webrtcConfig := webrtc.Configuration{
		ICEServers: webrtcICEServers,
	}

	fn := func(w http.ResponseWriter, r *http.Request) {
		settingEngine := webrtc.SettingEngine{}
		// settingEngine.SetTrickle(true)
		api := webrtc.NewAPI(
			webrtc.WithMediaEngine(webrtc.MediaEngine{}),
			webrtc.WithSettingEngine(settingEngine),
		)

		// Hack to be able to update dynamic codec payload IDs with every new sdp
		// renegotiation of passive (non-server initiated) peer connections.
		field := reflect.ValueOf(api).Elem().FieldByName("mediaEngine")
		unsafeField := reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem()

		mediaEngine, ok := unsafeField.Interface().(*webrtc.MediaEngine)
		if !ok {
			log.Printf("Error in hack to obtain mediaEngine")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		cleanup := func(event wshandler.CleanupEvent) {
			err := event.Adapter.Broadcast(
				wsmessage.NewMessage("hangUp", event.Room, map[string]string{
					"userId": event.ClientID,
				}),
			)
			if err != nil {
				log.Printf("[%s] Error in cleanup: %s", event.ClientID, err)
			}
		}

		var signaller *signals.Signaller

		handleMessage := func(event wshandler.RoomEvent) {
			msg := event.Message
			adapter := event.Adapter
			room := event.Room
			clientID := event.ClientID

			initiator := localPeerID
			if !serverIsInitiator {
				initiator = clientID
			}

			var err error

			switch msg.Type {
			case "ready":
				log.Printf("[%s] Initiator: %s", clientID, initiator)

				peerConnection, err := api.NewPeerConnection(webrtcConfig)
				if err != nil {
					err = fmt.Errorf("[%s] Error creating peer connection: %s", clientID, err)
					break
				}
				peerConnection.OnICEGatheringStateChange(func(state webrtc.ICEGathererState) {
					log.Printf("ICE gathering state changed: %s", state)
				})

				// FIXME check for errors
				payload, _ := msg.Payload.(map[string]interface{})
				adapter.SetMetadata(clientID, payload["nickname"].(string))

				clients, clientsError := getReadyClients(adapter)
				if clientsError != nil {
					log.Printf("[%s] Error retrieving clients: %s", clientID, err)
				}

				err = adapter.Broadcast(
					wsmessage.NewMessage("users", room, map[string]interface{}{
						"initiator": initiator,
						"peerIds":   []string{localPeerID},
						"nicknames": clients,
					}),
				)

				if initiator == localPeerID {
					// need to do this to connect with simple peer
					// only when we are the initiator
					_, err = peerConnection.CreateDataChannel("test", nil)
					if err != nil {
						log.Printf("[%s] Error creating data channel: %s", clientID, err)
						// TODO abort connection
					}
				}

				// TODO use this to get all client IDs and request all tracks of all users
				// adapter.Clients()
				if signaller == nil {
					signaller, err = signals.NewSignaller(
						initiator == localPeerID,
						peerConnection,
						mediaEngine,
						localPeerID,
						clientID,
						func(signal interface{}) {
							err := adapter.Emit(clientID, wsmessage.NewMessage("signal", room, signal))
							if err != nil {
								log.Printf("[%s] Error sending local signal: %s", clientID, err)
								// TODO abort connection
							}
						},
					)
					if err != nil {
						err = fmt.Errorf("[%s] Error initializing signaller: %s", clientID, err)
						break
					}
					closeChannel := tracksManager.Add(room, clientID, peerConnection, signaller)
					go func() {
						// TODO figure out what happens if WS socket connectino terminates
						// before peer connection
						<-closeChannel
						signaller = nil
						log.Printf("[%s] Peer connection closed, updating user list and re-sending users", clientID)
						adapter.SetMetadata(clientID, "")

						clients, clientsError := getReadyClients(adapter)
						if clientsError != nil {
							log.Printf("[%s] Error retrieving clients: %s", clientID, err)
						}

						err := adapter.Broadcast(
							wsmessage.NewMessage("users", room, map[string]interface{}{
								"initiator": initiator,
								"peerIds":   []string{localPeerID},
								"nicknames": clients,
							}),
						)

						if err != nil {
							log.Printf("[%s] Error broadcasting users after peer connection closed: %s", clientID)
						}
					}()
				}
			case "signal":
				payload, _ := msg.Payload.(map[string]interface{})
				if signaller == nil {
					err = fmt.Errorf("[%s] Ignoring signal because signaller is not initialized", clientID)
				} else {
					err = signaller.Signal(payload)
				}
			}

			if err != nil {
				log.Printf("[%s] Error handling event (event: %s, room: %s): %s", clientID, msg.Type, room, err)
			}
		}

		wss.HandleRoomWithCleanup(w, r, handleMessage, cleanup)
	}
	return http.HandlerFunc(fn)
}
