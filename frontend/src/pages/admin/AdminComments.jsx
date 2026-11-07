import { useEffect, useRef, useState } from 'react'
import { deleteCommentAsAdmin, getCommentVideos, getVideoComments } from '../../api/adminCommentApi.js'
import Modal from '../../components/admin/Modal.jsx'
import './videos.css'
import './comments.css'

function Pagination({ label, page, result, onChange }) {
  if (!result || result.total <= result.limit) return null
  return <nav className="av-pagination" aria-label={label}>
    <button className="av-button" disabled={page === 1} onClick={() => onChange(page - 1)}>이전</button>
    <span>{page} / {Math.ceil(result.total / result.limit)}</span>
    <button className="av-button" disabled={page * result.limit >= result.total} onClick={() => onChange(page + 1)}>다음</button>
  </nav>
}

function VideoComments({ video, navigate }) {
  const [result, setResult] = useState(null)
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [message, setMessage] = useState('')
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    getVideoComments(video.id, page, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      if (!data.data.length && page > 1) { setPage(page - 1); return }
      setResult(data)
    }).catch((err) => {
      if (controller.signal.aborted) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setError(err.message)
    })
    return () => controller.abort()
  }, [video.id, page, version, navigate])
  function reload(next = page) { setResult(null); setError(''); setPage(next); setVersion((v) => v + 1) }
  async function remove() {
    if (locked.current) return
    locked.current = true; setDeleting(true); setDeleteError('')
    try {
      await deleteCommentAsAdmin(pending.id)
      if (!alive.current) return
      setPending(null); setMessage('댓글을 삭제했습니다.'); reload()
    } catch (err) {
      if (!alive.current) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else if (err.status === 404) { setPending(null); setMessage('이미 삭제된 댓글입니다.'); reload() }
      else setDeleteError(err.message)
    } finally { locked.current = false; if (alive.current) setDeleting(false) }
  }
  return <section className="am-comments" aria-label={`${video.title} 댓글`}>
    <header className="am-section-heading"><h2>{video.title}</h2><button className="av-button av-small" onClick={() => reload()}>새로고침</button></header>
    <p className="av-muted">{result ? `댓글 ${result.total.toLocaleString()}개` : '영상에 등록된 댓글을 확인하세요.'}</p>
    {message && <p className="av-status" role="status">{message}</p>}
    {error ? <div className="av-state" role="alert"><p>{error}</p><button className="av-button" onClick={() => reload()}>다시 시도</button></div>
      : !result ? <div className="av-state" role="status">댓글을 불러오고 있습니다.</div>
        : !result.data.length ? <div className="av-state">등록된 댓글이 없습니다.</div>
          : <ul className="am-comment-list">{result.data.map((comment) => <li key={comment.id}>
            <div className="am-comment-meta"><strong>{comment.nickname}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString('ko-KR')}</time></div>
            <p className="am-comment-content">{comment.content}</p>
            <button className="av-button av-small av-danger" aria-label={`${comment.nickname} 댓글 삭제`} onClick={() => { setPending(comment); setDeleteError('') }}>삭제</button>
          </li>)}</ul>}
    <Pagination label="댓글 목록 페이지" page={page} result={result} onChange={reload} />
    {pending && <Modal title="댓글을 삭제할까요?" onClose={() => setPending(null)} busy={deleting}>
      <p className="av-confirm-title">{pending.nickname}</p><p className="am-comment-content am-delete-content">{pending.content}</p>
      <p className="av-muted">관리자는 비밀번호 없이 삭제할 수 있습니다. 삭제한 댓글은 복구할 수 없습니다.</p>
      {deleteError && <p className="av-error" role="alert">{deleteError}</p>}
      <footer className="av-modal-actions"><button className="av-button" disabled={deleting} onClick={() => setPending(null)}>취소</button><button className="av-button av-danger" disabled={deleting} onClick={remove}>{deleting ? '삭제 중…' : '삭제하기'}</button></footer>
    </Modal>}
  </section>
}

export default function AdminComments({ navigate }) {
  const [result, setResult] = useState(null)
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    getCommentVideos(page, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      if (!data.data.length && page > 1) { setPage(page - 1); return }
      setResult(data)
    }).catch((err) => {
      if (controller.signal.aborted) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setError(err.message)
    })
    return () => controller.abort()
  }, [page, version, navigate])
  function reload(next = page) { setResult(null); setError(''); setPage(next); setSelected(null); setVersion((v) => v + 1) }
  return <div>
    <header className="admin-heading"><div><h1>댓글 관리</h1><p>영상을 선택해 댓글을 확인하고 삭제할 수 있습니다.</p></div></header>
    <div className="am-layout">
      <section className="am-videos" aria-label="댓글 관리 영상 선택"><h2>영상 목록</h2>
        {error ? <div className="av-state" role="alert"><p>{error}</p><button className="av-button" onClick={() => reload()}>다시 시도</button></div>
          : !result ? <p role="status">영상을 불러오고 있습니다.</p>
            : !result.data.length ? <p className="av-muted">등록된 영상이 없습니다.</p>
              : <ul>{result.data.map((video) => <li key={video.id}><button className={selected?.id === video.id ? 'selected' : ''} aria-pressed={selected?.id === video.id} onClick={() => setSelected(video)}>{video.title}</button></li>)}</ul>}
        <Pagination label="댓글 관리 영상 페이지" page={page} result={result} onChange={reload} />
      </section>
      {selected ? <VideoComments key={selected.id} video={selected} navigate={navigate} /> : <div className="av-state am-placeholder">댓글을 관리할 영상을 선택해 주세요.</div>}
    </div>
  </div>
}
