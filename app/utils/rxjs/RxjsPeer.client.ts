import {
	Observable,
	combineLatest,
	distinctUntilChanged,
	from,
	fromEvent,
	map,
	of,
	retry,
	share,
	shareReplay,
	switchMap,
	take,
	tap,
	withLatestFrom,
} from 'rxjs'
import invariant from 'tiny-invariant'
import type {
	RenegotiationResponse,
	TrackObject,
	TracksResponse,
} from '../callsTypes'
import { History } from '../History'
import { BulkRequestDispatcher, FIFOScheduler } from '../Peer.utils'

export interface PeerConfig {
	apiExtraParams?: string
	iceServers?: RTCIceServer[]
	apiBase: string
	maxApiHistory?: number
}

export type ApiHistoryEntry =
	| {
			type: 'request'
			method: string
			endpoint: string
			body: unknown
	  }
	| {
			type: 'response'
			endpoint: string
			body: unknown
	  }

export class RxjsPeer {
	history: History<ApiHistoryEntry>
	peerConnection$: Observable<RTCPeerConnection>
	session$: Observable<{
		peerConnection: RTCPeerConnection
		sessionId: string
	}>
	peerConnectionState$: Observable<RTCPeerConnectionState>
	config: PeerConfig

	constructor(config: PeerConfig) {
		this.config = config
		this.history = new History<ApiHistoryEntry>(config.maxApiHistory)
		this.peerConnection$ = new Observable<RTCPeerConnection>((subscribe) => {
			let peerConnection: RTCPeerConnection
			const setup = () => {
				peerConnection?.close()
				peerConnection = createPeerConnection({
					iceServers: config.iceServers,
				})
				peerConnection.addEventListener('connectionstatechange', () => {
					if (
						peerConnection.connectionState === 'failed' ||
						peerConnection.connectionState === 'closed'
					) {
						console.debug(
							`💥 Peer connectionState is ${peerConnection.connectionState}`
						)
						subscribe.next(setup())
					}
				})

				let iceTimeout = -1
				peerConnection.addEventListener('iceconnectionstatechange', () => {
					clearTimeout(iceTimeout)
					if (
						peerConnection.iceConnectionState === 'failed' ||
						peerConnection.iceConnectionState === 'closed'
					) {
						console.debug(
							`💥 Peer iceConnectionState is ${peerConnection.iceConnectionState}`
						)
						subscribe.next(setup())
					} else if (peerConnection.iceConnectionState === 'disconnected') {
						const timeoutSeconds = 3
						iceTimeout = window.setTimeout(() => {
							console.debug(
								`💥 Peer iceConnectionState was ${peerConnection.iceConnectionState} for more than ${timeoutSeconds} seconds`
							)
							subscribe.next(setup())
						}, timeoutSeconds * 1000)
					}
				})

				// TODO: Remove this
				Object.assign(window, {
					explode: () => {
						console.debug('💥 Manually exploding connection')
						peerConnection.close()
						peerConnection.dispatchEvent(new Event('connectionstatechange'))
					},
				})

				return peerConnection
			}

			subscribe.next(setup())

			return () => {
				peerConnection.close()
			}
		}).pipe(
			shareReplay({
				bufferSize: 1,
				refCount: true,
			})
		)

		this.session$ = this.peerConnection$.pipe(
			// TODO: Convert the promise based session creation here
			// into an observable that will close the session in cleanup
			switchMap((pc) => from(this.createSession(pc))),
			// we want new subscribers to receive the session right away
			shareReplay({
				bufferSize: 1,
				refCount: true,
			})
		)

		this.peerConnectionState$ = this.peerConnection$.pipe(
			switchMap((peerConnection) =>
				fromEvent(
					peerConnection,
					'connectionstatechange',
					() => peerConnection.connectionState
				)
			),
			share()
		)
	}

	taskScheduler = new FIFOScheduler()
	pushTrackDispatcher = new BulkRequestDispatcher<
		{
			trackName: string
			transceiver: RTCRtpTransceiver
		},
		{ tracks: TrackObject[] }
	>(32)
	pullTrackDispatcher = new BulkRequestDispatcher<
		TrackObject,
		{
			trackMap: Map<
				TrackObject,
				{ resolvedTrack: Promise<MediaStreamTrack>; mid: string }
			>
		}
	>(32)
	closeTrackDispatcher = new BulkRequestDispatcher(32)

	async createSession(peerConnection: RTCPeerConnection) {
		console.debug('🆕 creating new session')
		const { apiBase } = this.config
		// create an offer and set it as the local description
		await peerConnection.setLocalDescription(await peerConnection.createOffer())
		const { sessionId, sessionDescription } =
			await this.fetchWithRecordedHistory(`${apiBase}/sessions/new?SESSION`, {
				method: 'POST',
				body: JSON.stringify({
					sessionDescription: peerConnection.localDescription,
				}),
			}).then((res) =>
				res.json<{
					sessionId: string
					sessionDescription: RTCSessionDescription
				}>()
			)
		const connected = new Promise((res, rej) => {
			// timeout after 5s
			setTimeout(rej, 5000)
			const connectionStateChangeHandler = () => {
				if (peerConnection.connectionState === 'connected') {
					peerConnection.removeEventListener(
						'connectionstatechange',
						connectionStateChangeHandler
					)
					res(undefined)
				}
			}
			peerConnection.addEventListener(
				'connectionstatechange',
				connectionStateChangeHandler
			)
		})

		// Once both local and remote descriptions are set, the ICE process begins
		await peerConnection.setRemoteDescription(sessionDescription)
		// Wait until the peer connection's iceConnectionState is "connected"
		await connected
		return { peerConnection, sessionId }
	}

	async fetchWithRecordedHistory(path: string, requestInit?: RequestInit) {
		this.history.log({
			endpoint: path,
			method: requestInit?.method ?? 'get',
			type: 'request',
			body:
				typeof requestInit?.body === 'string'
					? JSON.parse(requestInit.body)
					: undefined,
		})
		const response = await fetch(path, requestInit)
		const responseBody = await response.clone().json()
		this.history.log({
			endpoint: path,
			type: 'response',
			body: responseBody,
		})
		return response
	}

	#pushTrackInBulk(
		peerConnection: RTCPeerConnection,
		transceiver: RTCRtpTransceiver,
		sessionId: string,
		trackName: string
	): Observable<TrackObject> {
		return new Observable<TrackObject>((subscribe) => {
			let pushedTrackPromise: Promise<unknown>
			// we're doing this in a timeout so that we can bail if the observable
			// is unsubscribed from immediately after subscribing. This will prevent
			// React's StrictMode from causing extra API calls to push/pull tracks.
			const timeout = setTimeout(() => {
				console.debug('📤 pushing track ', trackName)
				pushedTrackPromise = this.pushTrackDispatcher
					.doBulkRequest({ trackName, transceiver }, (tracks) =>
						this.taskScheduler.schedule(async () => {
							await peerConnection.setLocalDescription(
								await peerConnection.createOffer()
							)

							const requestBody = {
								sessionDescription: {
									sdp: peerConnection.localDescription?.sdp,
									type: 'offer',
								},
								tracks: tracks.map(({ trackName, transceiver }) => ({
									trackName,
									mid: transceiver.mid,
									location: 'local',
								})),
							}
							const response = await this.fetchWithRecordedHistory(
								`${this.config.apiBase}/sessions/${sessionId}/tracks/new?PUSHING`,
								{
									method: 'POST',
									body: JSON.stringify(requestBody),
								}
							).then((res) => res.json<TracksResponse>())
							invariant(response.tracks !== undefined)
							if (!response.errorCode) {
								await peerConnection.setRemoteDescription(
									new RTCSessionDescription(response.sessionDescription)
								)
							}

							return {
								tracks: response.tracks,
							}
						})
					)
					.then(({ tracks }) => {
						const trackData = tracks.find((t) => t.mid === transceiver.mid)
						if (trackData) {
							subscribe.next({
								...trackData,
								sessionId,
								location: 'remote',
							})
						} else {
							subscribe.error(new Error('Missing TrackData'))
						}
					})
					.catch((err) => subscribe.error(err))
			})

			return () => {
				clearTimeout(timeout)
				pushedTrackPromise?.then(
					() => {
						this.taskScheduler
							.schedule(async () => {
								console.debug('🔚 Closing pushed track ', trackName)
								return this.closeTrack(
									peerConnection,
									transceiver.mid,
									sessionId
								)
							})
							.catch((err) => {
								console.error('Error closing pushed track')
								console.error(err)
							})
					},
					(err) => {
						console.error('Error closing pushed track')
						console.error(err)
					}
				)
			}
		})
	}

	pushTrack(
		track$: Observable<MediaStreamTrack>,
		encodings$: Observable<RTCRtpEncodingParameters[]> = of([])
	): Observable<TrackObject> {
		// we want a single id for this connection, but we need to wait for
		// the first track to show up before we can proceed, so we
		const stableId$ = track$.pipe(
			take(1),
			map(() => crypto.randomUUID())
		)

		const transceiver$ = combineLatest([stableId$, this.session$]).pipe(
			withLatestFrom(track$),
			map(([[stableId, session], track]) => {
				const transceiver = session.peerConnection.addTransceiver(track, {
					direction: 'sendonly',
				})
				console.debug('🌱 creating transceiver!')

				return {
					transceiver,
					stableId,
					session,
				}
			}),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)

		const pushedTrackData$ = transceiver$.pipe(
			switchMap(
				({ session: { peerConnection, sessionId }, transceiver, stableId }) =>
					this.#pushTrackInBulk(
						peerConnection,
						transceiver,
						sessionId,
						stableId
					)
			)
		)

		return combineLatest([
			pushedTrackData$,
			transceiver$,
			track$,
			encodings$,
		]).pipe(
			tap(([_trackData, { transceiver }, track, encodings]) => {
				const parameters = transceiver.sender.getParameters()
				encodings.forEach((encoding, i) => {
					const existing = parameters.encodings[i]
					parameters.encodings[i] = { ...existing, ...encoding }
				})
				transceiver.sender.setParameters(parameters)
				if (transceiver.sender.transport !== null) {
					console.debug('♻︎ replacing track')
					transceiver.sender.replaceTrack(track)
				}
			}),
			map(([trackData]) => trackData),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}

	#pullTrackInBulk(
		peerConnection: RTCPeerConnection,
		sessionId: string,
		trackData: TrackObject
	): Observable<MediaStreamTrack> {
		let mid = ''
		return new Observable<MediaStreamTrack>((subscribe) => {
			let pulledTrackPromise: Promise<unknown>
			// we're doing this in a timeout so that we can bail if the observable
			// is unsubscribed from immediately after subscribing. This will prevent
			// React's StrictMode from causing extra API calls to push/pull tracks.
			const timeout = setTimeout(() => {
				console.debug('📥 pulling track ', trackData.trackName)
				pulledTrackPromise = this.pullTrackDispatcher
					.doBulkRequest(trackData, (tracks) =>
						this.taskScheduler.schedule(async () => {
							const newTrackResponse: TracksResponse =
								await this.fetchWithRecordedHistory(
									`${this.config.apiBase}/sessions/${sessionId}/tracks/new?PULLING`,
									{
										method: 'POST',
										body: JSON.stringify({
											tracks,
										}),
									}
								).then((res) => res.json<TracksResponse>())
							if (newTrackResponse.errorCode) {
								throw new Error(newTrackResponse.errorDescription)
							}
							invariant(newTrackResponse.tracks)
							const trackMap = tracks.reduce((acc, track) => {
								const pulledTrackData = newTrackResponse.tracks?.find(
									(t) =>
										t.trackName === track.trackName &&
										t.sessionId === track.sessionId
								)

								if (pulledTrackData && pulledTrackData.mid) {
									acc.set(track, {
										mid: pulledTrackData.mid,
										resolvedTrack: resolveTrack(
											peerConnection,
											(t) => t.mid === pulledTrackData.mid
										),
									})
								}

								return acc
							}, new Map<TrackObject, { resolvedTrack: Promise<MediaStreamTrack>; mid: string }>())

							if (newTrackResponse.requiresImmediateRenegotiation) {
								await peerConnection.setRemoteDescription(
									new RTCSessionDescription(newTrackResponse.sessionDescription)
								)
								const answer = await peerConnection.createAnswer()
								await peerConnection.setLocalDescription(answer)

								const renegotiationResponse =
									await this.fetchWithRecordedHistory(
										`${this.config.apiBase}/sessions/${sessionId}/renegotiate`,
										{
											method: 'PUT',
											body: JSON.stringify({
												sessionDescription: {
													type: 'answer',
													sdp: peerConnection.currentLocalDescription?.sdp,
												},
											}),
										}
									).then((res) => res.json<RenegotiationResponse>())
								if (renegotiationResponse.errorCode)
									throw new Error(renegotiationResponse.errorDescription)
							}

							return { trackMap }
						})
					)
					.then(({ trackMap }) => {
						const trackInfo = trackMap.get(trackData)

						if (trackInfo) {
							trackInfo.resolvedTrack
								.then((track) => {
									mid = trackInfo.mid
									subscribe.next(track)
								})
								.catch((err) => subscribe.error(err))
						} else {
							subscribe.error(new Error('Missing Track Info'))
						}
						return trackData.trackName
					})
			})

			return () => {
				clearTimeout(timeout)
				pulledTrackPromise?.then((trackName) => {
					if (mid) {
						console.debug('🔚 Closing pulled track ', trackName)
						this.taskScheduler.schedule(async () =>
							this.closeTrack(peerConnection, mid, sessionId)
						)
					}
				})
			}
		}).pipe(retry(2))
	}

	pullTrack(trackData$: Observable<TrackObject>): Observable<MediaStreamTrack> {
		return combineLatest([
			this.session$,
			trackData$.pipe(
				// only necessary when pulling a track that was pushed locally to avoid
				// re-pulling when pushed track transceiver replaces track
				distinctUntilChanged((x, y) => JSON.stringify(x) === JSON.stringify(y))
			),
		]).pipe(
			switchMap(([{ peerConnection, sessionId }, trackData]) => {
				return this.#pullTrackInBulk(peerConnection, sessionId, trackData)
			}),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}

	async closeTrack(
		peerConnection: RTCPeerConnection,
		mid: string | null,
		sessionId: string
	) {
		// TODO: Close tracks in bulk
		const { apiBase } = this.config
		const transceiver = peerConnection
			.getTransceivers()
			.find((t) => t.mid === mid)
		if (
			peerConnection.connectionState !== 'connected' ||
			transceiver === undefined
		) {
			return
		}
		transceiver.direction = 'inactive'
		await peerConnection.setLocalDescription(await peerConnection.createOffer())
		const requestBody = {
			tracks: [{ mid: transceiver.mid }],
			sessionDescription: {
				sdp: peerConnection.localDescription?.sdp,
				type: 'offer',
			},
			force: false,
		}
		const response = await this.fetchWithRecordedHistory(
			`${apiBase}/sessions/${sessionId}/tracks/close`,
			{
				method: 'PUT',
				body: JSON.stringify(requestBody),
			}
		).then((res) => res.json<TracksResponse>())
		await peerConnection.setRemoteDescription(
			new RTCSessionDescription(response.sessionDescription)
		)
	}
}

function createPeerConnection(
	configuration: RTCConfiguration = {
		iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
		bundlePolicy: 'max-bundle',
	}
) {
	const pc = new RTCPeerConnection(configuration)

	pc.addTransceiver('audio', {
		direction: 'inactive',
	})

	return pc
}

async function resolveTrack(
	peerConnection: RTCPeerConnection,
	compare: (t: RTCRtpTransceiver) => boolean,
	timeout = 5000
) {
	return new Promise<MediaStreamTrack>((resolve, reject) => {
		setTimeout(reject, timeout)
		const handler = () => {
			const transceiver = peerConnection.getTransceivers().find(compare)
			if (transceiver) {
				resolve(transceiver.receiver.track)
				peerConnection.removeEventListener('track', handler)
			}
		}

		peerConnection.addEventListener('track', handler)
	})
}
