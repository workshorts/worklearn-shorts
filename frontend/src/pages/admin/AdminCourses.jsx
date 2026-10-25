import { useEffect, useRef, useState } from 'react'
import { deleteCourse, getCourses } from '../../api/courseApi.js'
import CourseEditor from '../../components/admin/CourseEditor.jsx'
import Modal from '../../components/admin/Modal.jsx'
import './videos.css'
import './courses.css'

export default function AdminCourses({ navigate }) {
  const [result, setResult] = useState(null)
  const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState(null)
  const [pending, setPending] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [message, setMessage] = useState('')
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    getCourses(page, controller.signal).then((data) => {
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
  function reload(nextPage = page) { setResult(null); setError(''); setPage(nextPage); setVersion((old) => old + 1) }
  function saved(message) { setEditor(null); setMessage(message); reload(editor.id ? page : 1) }
  async function remove() {
    if (locked.current) return
    locked.current = true; setDeleting(true); setDeleteError('')
    try {
      await deleteCourse(pending.id)
      if (alive.current) { setPending(null); setMessage('학습과정을 삭제했습니다.'); reload() }
    } catch (err) {
      if (!alive.current) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setDeleteError(err.message)
    } finally { locked.current = false; if (alive.current) setDeleting(false) }
  }
  return <>
    <header className="admin-heading ac-heading"><div><h1>학습과정 관리</h1><p>여러 개의 영상을 묶어 학습과정을 만들고 관리할 수 있습니다.</p></div><button type="button" className="av-button av-primary" onClick={() => { setMessage(''); setEditor({}) }}>＋ 학습과정 생성</button></header>
    {message && <p className="av-status" role="status">{message}</p>}
    {error ? <div className="av-state" role="alert"><p>{error}</p><button type="button" className="av-button" onClick={() => reload()}>다시 시도</button></div> : !result ? <div className="av-state" role="status">학습과정을 불러오고 있습니다.</div> : !result.data.length ? <div className="av-state"><p>등록된 학습과정이 없습니다. 새 학습과정을 만들어보세요.</p></div> : <div className="ac-course-list">{result.data.map((course) => <article className="ac-course-card" key={course.id} aria-label={course.name}>
      <div className="ac-course-description"><h2>{course.name}</h2><p>{course.description || '설명이 없습니다.'}</p></div>
      <span className="ac-course-count"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m9 5 11 7-11 7z" /></svg>{course.videoCount}개 영상</span>
      <button type="button" className="av-button ac-delete" aria-label={`${course.name} 삭제`} onClick={() => { setPending(course); setDeleteError('') }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>삭제하기</button>
      <button type="button" className="av-button ac-edit" aria-label={`${course.name} 수정`} onClick={() => { setMessage(''); setEditor({ id: course.id }) }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m14 4 6 6M4 20l2-7L16 3l5 5L11 18z" /></svg>수정</button>
    </article>)}</div>}
    {result && result.total > result.limit && <nav className="av-pagination" aria-label="학습과정 목록 페이지"><button type="button" className="av-button" disabled={page === 1} onClick={() => reload(page - 1)}>이전</button><span>{page} / {Math.ceil(result.total / result.limit)}</span><button type="button" className="av-button" disabled={page * result.limit >= result.total} onClick={() => reload(page + 1)}>다음</button></nav>}
    {editor && <CourseEditor key={editor.id || 'new'} id={editor.id} onClose={() => setEditor(null)} onSaved={saved} navigate={navigate} />}
    {pending && <Modal title="학습과정을 삭제할까요?" onClose={() => setPending(null)} busy={deleting}><p className="av-confirm-title">{pending.name}</p><p className="av-muted">학습과정과 구성 정보가 삭제됩니다. 등록된 영상은 영상 관리에 그대로 유지됩니다.</p>{deleteError && <p className="av-error" role="alert">{deleteError}</p>}<footer className="av-modal-actions"><button type="button" className="av-button" disabled={deleting} onClick={() => setPending(null)}>취소</button><button type="button" className="av-button av-danger" disabled={deleting} onClick={remove}>{deleting ? '삭제 중…' : '삭제하기'}</button></footer></Modal>}
  </>
}
