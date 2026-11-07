import { useRef, useState } from 'react'
import Modal from '../admin/Modal.jsx'
import '../../pages/admin/videos.css'

export default function ShareSheet({ video, onClose }) {
  const [message, setMessage] = useState('')
  const ref = useRef(null)
  const url = new URL(`/?video=${video.id}`, window.location.origin).href
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage('링크를 복사했습니다.') }
    catch { ref.current.focus(); ref.current.select(); setMessage('링크를 선택했습니다. 직접 복사해 주세요.') }
  }
  return <Modal title="영상 공유" onClose={onClose} className="share-sheet"><p>{video.title}</p><label htmlFor="share-video-url">공유 링크</label><input ref={ref} id="share-video-url" value={url} readOnly /><footer className="av-modal-actions"><button className="av-button av-primary" onClick={copy}>링크 복사</button></footer><p role="status">{message}</p></Modal>
}
