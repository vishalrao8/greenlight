import React from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import xCloudPlayer from 'xbox-xcloud-player'

import { useSettings } from '../../context/userContext'
import StreamComponent from '../../components/ui/streamcomponent'
import StreamPreload from '../../components/ui/streampreload'
import Ipc from '../../lib/ipc'
import { useTranslation } from 'react-i18next'

function Stream() {
    const router = useRouter()
    const { settings } = useSettings()
    const { t } = useTranslation()

    let streamStateInterval
    let keepaliveInterval
    let gamepadDebugInterval

    const [xPlayer, setxPlayer] = React.useState(undefined)
    const [sessionId, setSessionId] = React.useState('')
    const [queueTime, setQueueTime] = React.useState(0)

    React.useEffect(() => {
        const onGamepadConnect = (e: GamepadEvent) => {
            console.log('debug999 [Stream Window Event] gamepadconnected:', { id: e.gamepad.id, index: e.gamepad.index, connected: e.gamepad.connected })
        }
        const onGamepadDisconnect = (e: GamepadEvent) => {
            console.log('debug999 [Stream Window Event] gamepaddisconnected:', { id: e.gamepad.id, index: e.gamepad.index })
        }
        window.addEventListener('gamepadconnected', onGamepadConnect)
        window.addEventListener('gamepaddisconnected', onGamepadDisconnect)

        // Detect stream type and title / server id
        let streamType = 'home'
        let serverId = router.query.serverid
        if((router.query.serverid as string).substr(0, 6) === 'xcloud'){
            streamType = 'cloud'
            serverId = (router.query.serverid as string).substr(7)
        }

        if(xPlayer !== undefined){
            document.getElementById('streamComponentHolder').innerHTML = '<div id="streamComponent" class="size_'+settings.video_size+'"></div>'
            xPlayer.bind()

            // Attach debug999 interceptor directly to xPlayer._inputDriver in git-tracked code
            try {
                if (xPlayer._inputDriver && typeof xPlayer._inputDriver.requestStates === 'function') {
                    const originalRequestStates = xPlayer._inputDriver.requestStates.bind(xPlayer._inputDriver)
                    let lastDebugStatesLog = 0
                    xPlayer._inputDriver.requestStates = function() {
                        const states = originalRequestStates()
                        const now = Date.now()
                        if (now - lastDebugStatesLog > 2500) {
                            lastDebugStatesLog = now
                            const gps = Array.from(navigator.getGamepads()).map((gp, i) => gp ? { slot: i, id: gp.id, index: gp.index, connected: gp.connected } : { slot: i, disconnected: true })
                            console.log('debug999 [GamepadDriver.requestStates] raw navigator.getGamepads():', gps, 'states generated:', states.map((s: any) => ({ GamepadIndex: s.GamepadIndex, A: s.A, B: s.B, X: s.X, Y: s.Y })))
                        }
                        if (states.some((s: any) => s.A || s.B || s.X || s.Y || s.LeftShoulder || s.RightShoulder || s.View || s.Menu || s.Nexus || Math.abs(s.LeftThumbXAxis) > 0.1 || Math.abs(s.LeftThumbYAxis) > 0.1)) {
                            console.log('debug999 [GamepadDriver.requestStates] CONTROLLER INPUT DETECTED:', states.filter((s: any) => s.A || s.B || s.X || s.Y || s.LeftShoulder || s.RightShoulder || s.View || s.Menu || s.Nexus || Math.abs(s.LeftThumbXAxis) > 0.1 || Math.abs(s.LeftThumbYAxis) > 0.1))
                        }

                        // Ensure connected controllers are mapped to logical slot 0, 1, 2...
                        // so a controller sitting on hardware index 1 gets assigned to slot 0 (Player 1)
                        states.forEach((s: any, idx: number) => {
                            if (s.GamepadIndex !== idx) {
                                console.log(`debug999 [GamepadDriver.requestStates] Remapping GamepadIndex from ${s.GamepadIndex} to logical slot ${idx}`)
                                s.GamepadIndex = idx
                            }
                        })

                        return states
                    }
                }
            } catch (err) {
                console.error('debug999 error hooking inputDriver:', err)
            }

            // Set bitrates & video codec profiles
            if((streamType === 'cloud') ? settings.xcloud_bitrate : settings.xhome_bitrate > 0){
                xPlayer.setVideoBitrate((streamType === 'cloud') ? settings.xcloud_bitrate : settings.xhome_bitrate)
            }

            if(settings.video_profiles.length > 0){
                xPlayer.setCodecPreferences('video/H264', { profiles: settings.video_profiles || [] }) // 4d = high, 42e = mid, 420 = low
            }

            // Stream is ready so we start the player
            xPlayer.setControllerRumble(settings.controller_vibration)
            xPlayer.setSdpHandler((client, offer) => {
                Ipc.send('streaming', 'sendChatSdp', {
                    sessionId: sessionId,
                    sdp: offer.sdp,
                }).then((sdpResponse) => {
                    xPlayer.setRemoteOffer(sdpResponse.sdp)

                }).catch((error) => {
                    console.log('ChatSDP Exchange error:', error)
                    alert(t('errors.chatSDPExchangeError') + ' ' + JSON.stringify(error))
                })
            })

            xPlayer.createOffer().then((offer:any) => {
                Ipc.send('streaming', 'sendSdp', {
                    sessionId: sessionId,
                    sdp: offer.sdp,
                }).then((sdpResult:any) => {
                    xPlayer.setRemoteOffer(sdpResult.sdp)

                    // Gather candidates
                    const iceCandidates = xPlayer.getIceCandidates()
                    const candidates = []
                    for(const candidate in iceCandidates){
                        candidates.push({
                            candidate: iceCandidates[candidate].candidate,
                            sdpMLineIndex: iceCandidates[candidate].sdpMLineIndex,
                            sdpMid: iceCandidates[candidate].sdpMid,
                        })
                    }

                    Ipc.send('streaming', 'sendIce', {
                        sessionId: sessionId,
                        ice: candidates,
                    }).then((iceResult:any) => {
                        console.log(iceResult)
                        xPlayer.setIceCandidates(iceResult)

                        // All done. Waiting for the event 'connectionstate' to be triggered

                    }).catch((error) => {
                        console.log('ICE Exchange error:', error)
                        alert(t('errors.ICEExchangeError') + ' ' + JSON.stringify(error))
                    })

                }).catch((error) => {
                    console.log('SDP Exchange error:', error)
                    alert(t('errors.SDPExchangeError') + ' ' + JSON.stringify(error))
                })
            })

            xPlayer.getEventBus().on('connectionstate', (event) => {
                console.log('connectionstate changed:', event)

                const connStatus = document.getElementById('component_streamcomponent_connectionstatus')
                if(connStatus !== null){
                    if(event.state === 'connected'){
                        connStatus.innerText = t('streamWindow.clientHasBeenDisconnected')
                        document.getElementById('component_streamcomponent_loader').className = 'hidden'

                        // Set audio / Video settings
                        // @TODO: Implement api's in xbox-xcloud-player
                        if(settings.audio_enabled === false){
                            xPlayer._audioComponent._audioRender.muted = true
                        }

                        if(settings.video_enabled === false){
                            xPlayer._videoComponent._videoRender.style.opacity = 0
                        }

                        // Start keepalive loop
                        keepaliveInterval = setInterval(() => {
                            Ipc.send('streaming', 'sendKeepalive', {
                                sessionId: sessionId,
                            }).then((result) => {
                                console.log('StartStream keepalive:', result)
                            }).catch((error) => {
                                console.error('Failed to send keepalive. Error details:\n'+JSON.stringify(error))
                            })
                        }, 30000) // Send every 30 seconds

                        // Attach debug999 interceptor to control and input channels in git-tracked code
                        try {
                            const controlChannel = xPlayer.getChannelProcessor('control')
                            if (controlChannel && typeof controlChannel.sendGamepadAdded === 'function') {
                                const origAdded = controlChannel.sendGamepadAdded.bind(controlChannel)
                                controlChannel.sendGamepadAdded = function(slot: number) {
                                    console.log('debug999 [ControlChannel.sendGamepadAdded] Notifying cloud of added gamepad slot:', slot)
                                    return origAdded(slot)
                                }
                                const origRemoved = controlChannel.sendGamepadRemoved.bind(controlChannel)
                                controlChannel.sendGamepadRemoved = function(slot: number) {
                                    console.log('debug999 [ControlChannel.sendGamepadRemoved] Notifying cloud of removed gamepad slot:', slot)
                                    return origRemoved(slot)
                                }
                            }

                            const inputChannel = xPlayer.getChannelProcessor('input')
                            if (inputChannel && typeof inputChannel.queueGamepadState === 'function') {
                                const origQueueState = inputChannel.queueGamepadState.bind(inputChannel)
                                let lastLoggedQueue = 0
                                inputChannel.queueGamepadState = function(state: any) {
                                    const now = Date.now()
                                    if (state && (state.A || state.B || state.X || state.Y || state.LeftShoulder || state.RightShoulder || state.View || state.Menu || state.Nexus || Math.abs(state.LeftThumbXAxis) > 0.1 || Math.abs(state.LeftThumbYAxis) > 0.1)) {
                                        console.log('debug999 [InputChannel.queueGamepadState] Queuing active state to cloud:', state)
                                    } else if (now - lastLoggedQueue > 3000) {
                                        lastLoggedQueue = now
                                        console.log('debug999 [InputChannel.queueGamepadState] Heartbeat frame queued:', { GamepadIndex: state?.GamepadIndex })
                                    }
                                    return origQueueState(state)
                                }
                            }
                        } catch (e) {
                            console.error('debug999 error hooking channels:', e)
                        }

                        // Live gamepad input monitor for debugging during active stream
                        let lastLoggedButtons = ''
                        gamepadDebugInterval = setInterval(() => {
                            const gps = Array.from(navigator.getGamepads()).filter(Boolean)
                            for (const gp of gps) {
                                const pressed = gp.buttons.map((b, i) => b.pressed ? i : null).filter((v) => v !== null)
                                const movedAxes = gp.axes.map((a, i) => Math.abs(a) > 0.2 ? `axis${i}:${a.toFixed(2)}` : null).filter(Boolean)
                                const stateStr = `gp#${gp.index} buttons:[${pressed.join(',')}] axes:[${movedAxes.join(',')}]`
                                if ((pressed.length > 0 || movedAxes.length > 0) && stateStr !== lastLoggedButtons) {
                                    lastLoggedButtons = stateStr
                                    console.log('debug999 [Stream Live Input]:', stateStr)
                                }
                            }
                        }, 50)

                    } else if(event.state === 'new'){
                        connStatus.innerText = t('streamWindow.startingConnection')

                    } else if(event.state === 'connecting'){
                        connStatus.innerText = t('streamWindow.connectingToConsole')

                    } else if(event.state === 'closed') {
                        // Client has been disconnected. Lets return to home.
                        // xPlayer.close()
                        console.log('Client has been disconnected. Returning to prev page.')
                        window.history.back()
                    }
                }
            })
        } else if(sessionId === '') {
            // Stream is not ready yet, lets start it...

            Ipc.send('streaming', 'startStream', {
                type: streamType,
                target: serverId,
            }).then((result:string) => {
                console.log('StartStream session:', result)
                setSessionId(result)

            }).catch((error) => {
                alert(t('errors.failedToStartStream') + '\n' + JSON.stringify(error))
            })
        } else {

            streamStateInterval = setInterval(() => {
                Ipc.send('streaming', 'getPlayerState', {
                    sessionId: sessionId,
                }).then((session:any) => {
                    console.log('Player state:', session)

                    switch(session.playerState){
                        case 'pending':
                            // Waiting for console to start
                            break

                        case 'started':
                            // Console is ready
                            clearInterval(streamStateInterval)

                            // Start xPlayer interface
                            console.log('debug999 [Stream] Console ready. Initializing xCloudPlayer with config:', {
                                input_touch: settings.input_touch || false,
                                input_mousekeyboard: settings.input_mousekeyboard || false,
                                input_legacykeyboard: (settings.input_newgamepad) ? false : true,
                                input_newgamepad: settings.input_newgamepad,
                                gamepads: Array.from(navigator.getGamepads()).map((gp, i) => gp ? {
                                    slot: i,
                                    id: gp.id,
                                    index: gp.index,
                                    connected: gp.connected,
                                    buttons: gp.buttons.length,
                                    axes: gp.axes.length
                                } : { slot: i, nullOrDisconnected: true })
                            })

                            setxPlayer(new xCloudPlayer('streamComponent', {
                                ui_systemui: [],
                                input_touch: settings.input_touch || false,
                                input_mousekeyboard: settings.input_mousekeyboard || false,
                                input_legacykeyboard: (settings.input_newgamepad) ? false : true,
                                input_mousekeyboard_config: settings.input_mousekeyboard_config !== undefined ? {
                                    _keymapping: settings.input_mousekeyboard_config,
                                } : undefined as any,
                            }))
                            break

                        case 'failed':
                            // Error
                            clearInterval(streamStateInterval)

                            if(session.errorDetails.code === 'WNSError' && session.errorDetails.message.includes('WaitingForServerToRegister')){
                                // Detected the "WaitingForServerToRegister" error. This means the console is not connected to the xbox servers
                                alert(t('errors.unableToStartStreamSession') + '\n\n' + t('errors.streamErrorResult') + ' ' + session.state + '\n' + t('errors.details') + ' [' + session.errorDetails.code + '] ' + session.errorDetails.message)
                            } else {
                                alert(t('errors.streamErrorResult') + ' ' + session.state + '\n' + t('errors.details') + ' [' + session.errorDetails.code + '] ' + session.errorDetails.message)
                            }
                            console.log('Full stream error:', session.errorDetails)
                            onDisconnect()
                            xPlayer.close()
                            break

                        case 'queued':
                            // Waiting in queue
                            // @TODO: Show queue position
                            if(queueTime === 0){
                                setQueueTime(session.waitingTimes.estimatedTotalWaitTimeInSeconds)
                                console.log('Setting queue to:', session.waitingTimes.estimatedTotalWaitTimeInSeconds)


                            }
                            break
                    }

                }).catch((error) => {
                    alert(t('errors.failedToGetPlayerState') + '\n' + JSON.stringify(error))
                })
            }, 1000)
        }

        // Modal window
        return () => {
            if(xPlayer !== undefined){
                xPlayer.close()
            }

            if(keepaliveInterval){
                clearInterval(keepaliveInterval)
            }

            if(streamStateInterval){
                clearInterval(streamStateInterval)
            }

            if(gamepadDebugInterval){
                clearInterval(gamepadDebugInterval)
            }

            window.removeEventListener('gamepadconnected', onGamepadConnect)
            window.removeEventListener('gamepaddisconnected', onGamepadDisconnect)
        }
    })

    function gamepadSend(button){
        console.log('Pressed button:', button)
        xPlayer.getChannelProcessor('input').pressButton(0, 'Nexus')
    }

    function onDisconnect(){
        Ipc.send('streaming', 'stopStream', {
            sessionId: sessionId,
        }).then((result) => {
            console.log('Stream stopped:', result)
        })

        if(streamStateInterval){
            clearInterval(streamStateInterval)
        }
    }

    return (
        <React.Fragment>
            <Head>
                <title>Greenlight - {t('streamWindow.pageTitle')} {router.query.serverid}</title>
            </Head>

            { (xPlayer !== undefined) ? <StreamComponent onDisconnect={ () => {
                onDisconnect()
            }} onMenu={ () => {
                gamepadSend('nexus')
            } } xPlayer={ xPlayer }></StreamComponent> : (queueTime > 0) ?<StreamPreload onDisconnect={ () => {
                onDisconnect()
            }} waitingTime={ queueTime }></StreamPreload> : <StreamPreload onDisconnect={ () => {
                onDisconnect()
            }}></StreamPreload> }
        </React.Fragment>
    )
}

export default Stream
