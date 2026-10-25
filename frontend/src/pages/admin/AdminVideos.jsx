import { useEffect, useRef, useState } from 'react'
import { deleteVideo, getVideos } from '../../api/videoApi.js'
import Modal from '../../components/admin/Modal.jsx'
import { routeLink } from '../../components/admin/videoFormUtils.js'
import './videos.css'

export default function AdminVideos({ navigate }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [pending, setPending] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [message, setMessage] = useState('')
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    getVideos(page, controller.signal).then((data) => {
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
  function reload(nextPage = page) { setResult(null); setError(''); setPage(nextPage); setVersion((v) => v + 1) }
  async function remove() {
    if (locked.current) return
    locked.current = true; setDeleting(true); setDeleteError('')
    try {
      await deleteVideo(pending.id); setPending(null); setMessage('영상을 삭제했습니다.'); reload()
    } catch (err) {
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setDeleteError(err.message)
    } finally { locked.current = false; setDeleting(false) }
  }
  return <>
    <header className="admin-heading"><h1>영상 관리</h1><a href="/admin/videos/new" className="av-button av-primary" onClick={(e) => routeLink(e, navigate, '/admin/videos/new')}>＋ 영상 등록</a></header>
    {message && <p className="av-status" role="status">{message}</p>}
    {error ? <div className="av-state" role="alert"><p>{error}</p><button className="av-button" onClick={() => reload()}>다시 시도</button></div> : <div className="av-table-scroll" aria-busy={!result}>
      <table className="av-video-table"><thead><tr>{['번호', '제목', '조회수', '좋아요', '등록일', '작업'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{!result ? <tr><td colSpan={6} className="av-table-empty" role="status">영상 목록을 불러오고 있습니다.</td></tr> : !result.data.length ? <tr><td colSpan={6} className="av-table-empty">등록된 영상이 없습니다.</td></tr> : result.data.map((video, i) => {
          const href = `/admin/videos/${video.id}/edit`
          return <tr key={video.id}><td>{(page - 1) * result.limit + i + 1}</td><td><a href={href} onClick={(e) => routeLink(e, navigate, href)}>{video.title}</a></td><td>{video.viewCount.toLocaleString()}</td><td>{video.likeCount.toLocaleString()}</td><td>{video.createdAt.slice(0, 10)}</td><td><div className="av-actions"><a className="av-button av-small" href={href} onClick={(e) => routeLink(e, navigate, href)}>수정</a><button type="button" className="av-button av-small av-danger" aria-label={`${video.title} 삭제`} onClick={() => { setPending(video); setDeleteError('') }}>삭제</button></div></td></tr>
        })}</tbody>
      </table>
    </div>}
    {result && result.total > result.limit && <nav className="av-pagination" aria-label="영상 목록 페이지"><button className="av-button" disabled={page === 1} onClick={() => reload(page - 1)}>이전</button><span>{page} / {Math.ceil(result.total / result.limit)}</span><button className="av-button" disabled={page * result.limit >= result.total} onClick={() => reload(page + 1)}>다음</button></nav>}
    {pending && <Modal title="영상을 삭제할까요?" onClose={() => setPending(null)} busy={deleting}>
      <p className="av-confirm-title">{pending.title}</p><p className="av-muted">영상과 관련 댓글·퀴즈가 삭제되고 학습과정에서도 제외됩니다.</p>
      {deleteError && <p className="av-error" role="alert">{deleteError}</p>}
      <footer className="av-modal-actions"><button className="av-button" disabled={deleting} onClick={() => setPending(null)}>취소</button><button className="av-button av-danger" disabled={deleting} onClick={remove}>{deleting ? '삭제 중…' : '삭제하기'}</button></footer>
    </Modal>}
  </>
}
