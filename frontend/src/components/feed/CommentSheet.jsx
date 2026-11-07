import { useEffect, useRef, useState } from 'react'
import { createComment, deleteComment, getComments } from '../../api/commentApi.js'
import Modal from '../admin/Modal.jsx'
import '../../pages/admin/videos.css'
import './comments.css'

export default function CommentSheet({ video, onClose, onCountChange }) {
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ nickname: '', password: '', content: '' })
  const [formError, setFormError] = useState('')
  const [pending, setPending] = useState(null)
  const [password, setPassword] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [busy, setBusy] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [message, setMessage] = useState('')
  const locked = useRef(false)
  const controllerRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; controllerRef.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    getComments(video.id, 1, controller.signal).then((data) => {
      if (!controller.signal.aborted) { setResult(data); onCountChange(video.id, data.total) }
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [video.id, attempt, onCountChange])
  async function more() {
    if (locked.current || !result) return
    locked.current = true; setMoreBusy(true); setMoreError('')
    const controller = new AbortController(); controllerRef.current = controller
    try {
      const data = await getComments(video.id, result.page + 1, controller.signal)
      if (alive.current) setResult((old) => ({ ...data, data: [...new Map([...old.data, ...data.data].map((c) => [c.id, c])).values()] }))
    } catch (err) { if (!controller.signal.aborted) setMoreError(err.message) }
    finally { locked.current = false; if (alive.current) setMoreBusy(false) }
  }
  function refresh() { setResult(null); setError(''); setMoreError(''); setAttempt((old) => old + 1) }
  async function submit(event) {
    event.preventDefault()
    if (locked.current) return
    if (!form.nickname.trim() || Array.from(form.nickname).length > 20 || !form.content.trim() || Array.from(form.content).length > 500 || Array.from(form.password).length < 4 || Array.from(form.password).length > 30) {
      setFormError('닉네임 1~20자, 삭제 비밀번호 4~30자, 댓글 1~500자를 입력해 주세요.'); return
    }
    locked.current = true; setBusy(true); setFormError(''); setMessage('')
    try {
      await createComment(video.id, form)
      if (alive.current) { setForm((old) => ({ ...old, password: '', content: '' })); setMessage('댓글을 등록했습니다.'); refresh() }
    } catch (err) { if (alive.current) setFormError(err.message) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  async function remove(event) {
    event.preventDefault()
    if (locked.current) return
    if (Array.from(password).length < 4 || Array.from(password).length > 30) { setDeleteError('삭제 비밀번호를 4~30자로 입력해 주세요.'); return }
    locked.current = true; setBusy(true); setDeleteError(''); setMessage('')
    try {
      await deleteComment(pending, password)
      if (alive.current) { setPending(null); setPassword(''); setMessage('댓글을 삭제했습니다.'); refresh() }
    } catch (err) { if (alive.current) setDeleteError(err.message) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return <Modal title={`댓글 ${result?.total ?? video.commentCount ?? 0}`} onClose={onClose} busy={busy} className="comment-sheet">
    <p className="comment-video-title">{video.title}</p>
    {message && <p className="comment-success" role="status">{message}</p>}
    <div className="comment-list">
      {error ? <div role="alert"><p>{error}</p><button type="button" className="av-button" onClick={refresh}>다시 시도</button></div> : !result ? <p role="status">댓글을 불러오는 중…</p> : !result.data.length ? <p className="comment-empty">첫 댓글을 남겨보세요.</p> : result.data.map((comment) => <article className="comment-item" key={comment.id}>
        <header><strong>{comment.nickname}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('ko-KR')}</time><button type="button" disabled={busy || moreBusy} aria-label={`${comment.nickname} 댓글 삭제`} onClick={() => { setPending(pending === comment.id ? null : comment.id); setPassword(''); setDeleteError('') }}>삭제</button></header>
        <p>{comment.content}</p>
        {pending === comment.id && <form className="comment-delete-form" onSubmit={remove}><label htmlFor={`delete-password-${comment.id}`}>삭제 비밀번호</label><input id={`delete-password-${comment.id}`} type="password" value={password} maxLength={30} disabled={busy} autoComplete="off" onChange={(e) => setPassword(e.target.value)} /><div className="comment-delete-actions"><button type="button" disabled={busy} onClick={() => { setPending(null); setPassword('') }}>취소</button><button type="submit" disabled={busy}>{busy ? '삭제 중…' : '삭제 확인'}</button></div>{deleteError && <p className="comment-error" role="alert">{deleteError}</p>}</form>}
      </article>)}
      {result && result.page * result.limit < result.total && <button type="button" className="comment-more" disabled={busy || moreBusy} onClick={more}>{moreBusy ? '불러오는 중…' : '댓글 더 보기'}</button>}
      {moreError && <p className="comment-error" role="alert">{moreError}</p>}
    </div>
    <form className="comment-compose" onSubmit={submit} noValidate><div className="comment-identity"><label><span className="feed-sr-only">닉네임</span><input placeholder="닉네임" aria-label="닉네임" maxLength={20} value={form.nickname} disabled={busy || moreBusy} onChange={(e) => setForm({ ...form, nickname: e.target.value })} /></label><label><span className="feed-sr-only">삭제 비밀번호</span><input placeholder="삭제 비밀번호 (4자 이상)" aria-label="삭제 비밀번호" type="password" maxLength={30} autoComplete="new-password" value={form.password} disabled={busy || moreBusy} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label></div><label className="feed-sr-only" htmlFor="comment-content">댓글 내용</label><textarea id="comment-content" placeholder="영상에 대한 생각을 남겨주세요." maxLength={500} value={form.content} disabled={busy || moreBusy} onChange={(e) => setForm({ ...form, content: e.target.value })} /><footer><span>{form.content.length}/500</span><button type="submit" disabled={busy || moreBusy}>{busy ? '처리 중…' : '댓글 등록'}</button></footer>{formError && <p className="comment-error" role="alert">{formError}</p>}</form>
  </Modal>
}
