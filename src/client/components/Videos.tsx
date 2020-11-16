import React from 'react'
import { StreamWithURL, StreamsState, LocalStream } from '../reducers/streams'
import forEach from 'lodash/forEach'
import map from 'lodash/map'
// Custom code
import isEqual from 'lodash/isEqual'

import { ME } from '../constants'
import { getNickname } from '../nickname'
import Video from './Video'
import { Nicknames } from '../reducers/nicknames'
import { getStreamKey, WindowStates, WindowState } from '../reducers/windowStates'
import { MinimizeTogglePayload, StreamTypeCamera, StreamTypeDesktop, StreamType } from '../actions/StreamActions'

var screensharing = 0

export interface VideosProps {
  nicknames: Nicknames
  play: () => void
  streams: StreamsState
  onMinimizeToggle: (payload: MinimizeTogglePayload) => void
  windowStates: WindowStates
}

interface StreamProps {
  key: string
  stream?: StreamWithURL
  userId: string
  muted?: boolean
  localUser?: boolean
  mirrored?: boolean
  windowState: WindowState
}

export default class Videos extends React.PureComponent<VideosProps> {
  private gridRef = React.createRef<HTMLDivElement>()
  componentDidUpdate() {
    const videos = this.gridRef.current!
    .querySelectorAll('.video-container') as unknown as HTMLElement[]
    const size = videos.length
    const x = (1 / Math.ceil(Math.sqrt(size))) * 100

    videos.forEach(v => {
      v.style.flexBasis = x + '%'
    })
  }
  private getStreams() {
    const { windowStates, nicknames, streams } = this.props

    console.log("These streams:\n\n" + JSON.stringify(streams))
    // const minimized: StreamProps[] = []
    // const maximized: StreamProps[] = []
    var minimized = []
    var maximized = []
    // Custom code
    var newStreams = []

    function addStreamProps(props: StreamProps) {
      if (props.windowState === 'minimized') {
        minimized.push(props)
      } else {
        maximized.push(props)
      }
    }

    function isLocalStream(s: StreamWithURL): s is LocalStream {
      return 'mirror' in s && 'type' in s
    }

    function addStreamsByUser(
      localUser: boolean,
      userId: string,
      streams: Array<StreamWithURL | LocalStream>,
    ) {

      if (!streams.length) {
        const key = getStreamKey(userId, undefined)
        const props: StreamProps = {
          key,
          userId,
          localUser,
          windowState: windowStates[key],
        }

        // addStreamProps(props)
        return
      }

      streams.forEach((stream, i) => {
        const key = getStreamKey(userId, stream.streamId)
        const props: StreamProps = {
          key,
          stream: stream,
          userId,
          mirrored: localUser && isLocalStream(stream) &&
            stream.type === StreamTypeCamera && stream.mirror,
          muted: localUser,
          localUser,
          windowState: windowStates[key],
        }

        newStreams.push(props)
        // addStreamProps(props)
      })
    }

    const localStreams = map(streams.localStreams, s => s!)
    addStreamsByUser(true, ME, localStreams)

    forEach(nicknames, (_, userId) => {
      if (userId != ME) {
        const s = streams.streamsByUserId[userId]
        addStreamsByUser(false, userId, s && s.streams || [])
      }
    })

    var storeStreams = []
    // var indexToSkip = 999
    var indexToSkip = []

    if (screensharing === 0 || screensharing === 2) {
      newStreams.forEach((stream) => {
        var i = 0

        while(newStreams[i] !== undefined) {
          if (newStreams[i].userId === stream.userId &&
              newStreams[i].key !== stream.key &&
              /* indexToSkip !== i */
              !indexToSkip.includes(i)) {

            // indexToSkip = newStreams.indexOf(stream)
            indexToSkip.push(newStreams.indexOf(stream))
            // console.log("\n\nI'm in while:\n\n" + i)

            screensharing === 0 ?
              screensharing = 1 :
              screensharing = 2

            if (stream.localUser) {
              // console.log("stored stream:\n\n" + JSON.stringify(stream))
              storeStreams.push(stream)
            }
            else {
              // console.log("stored stream:\n\n" + JSON.stringify(newStreams[i]))
              storeStreams.push(newStreams[i])
            }
          }
          i++
        }
      })
    }


    // console.log("storeStreams:\n\n" + JSON.stringify(storeStreams))

    // Screensharing status 1: first time activated
    if (screensharing === 1) {
      // Change status to active
      screensharing = 2
      let difference = newStreams.filter(x => !storeStreams.includes(x));

      difference.forEach((props) => {
        props.windowState = 'minimized'
        addStreamProps(props)
      })
      storeStreams.forEach((props) => {
        props.windowState = undefined
        addStreamProps(props)
      })

      return { minimized, maximized }
    }
    // Screensharing status 2: active
    else if (screensharing === 2) {
      // Screensharing is no longer active
      if (storeStreams.length < 1) {
        screensharing = 0

        newStreams.forEach((props) => {
          props.windowState = undefined
          addStreamProps(props)
        })
      }
      // Still active
      else {
        let difference = newStreams.filter(x => !storeStreams.includes(x));

        difference.forEach((props) => {
          console.log()
          if (!props.windowState) {
            props.windowState = 'minimized'
          }
          else {
            props.windowState = undefined
          }

          addStreamProps(props)
        })
        storeStreams.forEach((props) => {
          addStreamProps(props)
        })
      }

      // minimized.forEach((props) => {
      //   console.log("Minimized props:\n\n\n" + JSON.stringify(props))
      // })

      return { minimized, maximized }
    }
    // Screensharing status 0: not active
    else if (screensharing === 0) {
      newStreams.forEach((props) => {
        addStreamProps(props)
      })
    }

    return { minimized, maximized }
  }
  render() {
    const { minimized, maximized } = this.getStreams()

    const videosToolbar = (
      <div className="videos videos-toolbar" key="videos-toolbar">
        {minimized.map(props => (
          <Video
            {...props}
            key={props.key}
            onMinimizeToggle={this.props.onMinimizeToggle}
            play={this.props.play}
            nickname={getNickname(this.props.nicknames, props.userId)}
          />
        ))}
      </div>
    )

    const videosGrid = (
      <div className="videos videos-grid" key="videos-grid" ref={this.gridRef}>
        {maximized.map(props => (
          <Video
            {...props}
            key={props.key}
            onMinimizeToggle={this.props.onMinimizeToggle}
            play={this.props.play}
            nickname={getNickname(this.props.nicknames, props.userId)}
          />
        ))}
      </div>
    )

    return [videosToolbar, videosGrid]
  }
}
