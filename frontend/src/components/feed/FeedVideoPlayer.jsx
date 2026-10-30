import { useCallback, useEffect, useRef, useState } from 'react'

function timeLabel(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function PlayerIcon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'play' ? <path d="m9 5 12 7-12 7Z" fill="currentColor" stroke="none" /> : name === 'pause' ? <path d="M8 5v14M16 5v14" /> : <><path d="m11 4-6 5H2v6h3l6 5Z" />{name === 'muted' ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />}</>}
  </svg>
}

export default function FeedVideoPlayer({ src, poster, title, isActive = false, muted = true, onRequestPlay, onMutedChange }) {
  const videoRef = useRef(null)
  const wantsPlay = useRef(false)
  const requestId = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [needsTap, setNeedsTap] = useState(false)
  const [error, setError] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // play()는 브라우저 정책이나 pause()와의 경합으로 거절될 수 있음
  const play = useCallback(() => {
    const video = videoRef.current
    if (!video || document.hidden) return
    const id = ++requestId.current
    wantsPlay.current = true
    video.play().then(() => {
      if (!wantsPlay.current || document.hidden) video.pause()
    }).catch((err) => {
      if (requestId.current !== id || !wantsPlay.current) return
      if (err.name === 'NotAllowedError') setNeedsTap(true)
      else if (err.name !== 'AbortError') setError('영상을 재생하지 못했어요.')
    })
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (isActive) play()
    else { wantsPlay.current = false; requestId.current += 1; video.pause() }
    return () => { wantsPlay.current = false; requestId.current += 1; video.pause() }
  }, [isActive, play])

  useEffect(() => {
    const video = videoRef.current
    const pauseWhenHidden = () => {
      if (document.hidden) { wantsPlay.current = false; requestId.current += 1; video.pause() }
    }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden)
  }, [])

  function togglePlay() {
    if (!isActive && onRequestPlay) { onRequestPlay(); return }
    const video = videoRef.current
    if (video.paused) { setNeedsTap(false); play() }
    else { wantsPlay.current = false; requestId.current += 1; video.pause() }
  }
  function retry() {
    setError(''); setNeedsTap(false); setBuffering(false)
    videoRef.current.load()
    if (!isActive && onRequestPlay) onRequestPlay()
    else play()
  }
  function readDuration() {
    const value = videoRef.current.duration
    setDuration(Number.isFinite(value) ? value : 0)
  }
  function seek(event) {
    const value = Number(event.target.value)
    videoRef.current.currentTime = value
    setCurrentTime(value)
  }

  return <div className="feed-player-shell">
    <video ref={videoRef} className="feed-video-player" src={src || undefined} poster={poster || undefined}
      aria-label={title} muted={muted} playsInline loop preload={isActive ? 'auto' : 'metadata'}
      onPlay={() => {
        if (!wantsPlay.current || document.hidden) { videoRef.current.pause(); return }
        setPlaying(true); setNeedsTap(false)
      }}
      onPlaying={() => setBuffering(false)} onWaiting={() => setBuffering(true)}
      onPause={() => { setPlaying(false); setBuffering(false) }}
      onLoadedMetadata={readDuration} onDurationChange={readDuration}
      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onSeeked={() => setBuffering(false)}
      onError={() => { setError('영상을 불러오지 못했어요.'); setBuffering(false) }}
    />
    {!error && <>
      <button className={`feed-video-toggle${playing ? ' is-playing' : ''}`} type="button" aria-label={playing ? '영상 일시정지' : '영상 재생'} onClick={togglePlay}>
        <span className="feed-play-symbol"><PlayerIcon name={playing ? 'pause' : 'play'} /></span>
      </button>
      {needsTap && <p className="feed-player-notice" role="status">재생 버튼을 눌러 영상을 시작하세요.</p>}
      {buffering && playing && <span className="feed-player-loading" role="status">영상을 불러오는 중…</span>}
      <button className="feed-sound-button" type="button" aria-label={muted ? '소리 켜기' : '음소거'} onClick={() => {
        videoRef.current.muted = !muted
        onMutedChange?.(!muted)
      }}><PlayerIcon name={muted ? 'muted' : 'volume'} /></button>
      <div className="feed-video-controls">
        <span className="feed-time-label" aria-hidden="true">{timeLabel(currentTime)} / {timeLabel(duration)}</span>
        <input type="range" className="feed-seek" aria-label="영상 재생 위치" aria-valuetext={`${timeLabel(currentTime)} / ${timeLabel(duration)}`}
          min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 1)} disabled={!duration} onChange={seek} />
      </div>
    </>}
    {error && <div className="feed-player-error" role="alert"><p>{error}</p><button type="button" onClick={retry}>다시 시도</button></div>}
  </div>
}
