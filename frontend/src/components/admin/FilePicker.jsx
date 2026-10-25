import { useEffect, useId, useRef, useState } from 'react'
import { fileError } from './videoFormUtils.js'

function LocalPreview({ file, video }) {
  const ref = useRef(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const element = ref.current
    element.src = url
    return () => { element.removeAttribute('src'); URL.revokeObjectURL(url) }
  }, [file])
  return video ? <video ref={ref} className="av-file-preview" controls preload="metadata" /> : <img ref={ref} className="av-file-preview" alt="썸네일 미리보기" />
}

export default function FilePicker({ kind, file, currentUrl, currentPath, onChange, disabled, error, onError, compact = false }) {
  const id = useId()
  const [dragging, setDragging] = useState(false)
  const video = kind === 'video'
  const url = currentUrl
  function choose(files) {
    if (disabled || !files.length) return
    const issue = files.length > 1 ? '파일을 하나만 선택해 주세요.' : fileError(kind, files[0])
    onError(issue)
    if (!issue) onChange(files[0])
  }
  return <div>
    <div className={`av-file-drop ${compact ? 'compact' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files) }}>
      <input id={id} type="file" aria-label={video ? '영상 파일 선택' : '썸네일 이미지 선택'} disabled={disabled} accept={video ? 'video/mp4,video/webm,.mp4,.webm' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'} onChange={(e) => { choose(e.target.files); e.target.value = '' }} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
      {(file || currentPath || url) ? <>
        {file ? <LocalPreview file={file} video={video} /> : url ? (video ? <video className="av-file-preview" src={url} controls preload="metadata" /> : <img className="av-file-preview" src={url} alt="썸네일 미리보기" />) : <span className="av-file-symbol" aria-hidden="true">▷</span>}
        <div className="av-file-meta"><strong>{file?.name || currentPath?.split('/').pop() || '기존 파일'}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(2)}MB` : '현재 등록된 파일'}</span></div>
        <label className="av-button" htmlFor={id}>{video ? '다른 파일로 변경' : '다른 이미지로 변경'}</label>
      </> : <label className="av-file-empty" htmlFor={id}>
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M24 32V8m-8 8 8-8 8 8M8 30v10h32V30" /></svg>
        <strong>{video ? 'MP4 파일을 선택하거나 끌어다 놓기' : '썸네일 이미지 선택'}</strong><span>{video ? 'MP4, WebM · 최대 50MB · 세로형 9:16 권장' : 'PNG, JPG, WebP · 최대 10MB · 1280 × 720 권장'}</span>
      </label>}
    </div>
    {error && <p id={`${id}-error`} className="av-error" role="alert">{error}</p>}
  </div>
}
