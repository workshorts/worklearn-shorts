import { useEffect, useRef, useState } from 'react'
import { getCourse, saveCourse } from '../../api/courseApi.js'
import { getVideos } from '../../api/videoApi.js'
import Modal from './Modal.jsx'

function AvailableVideos({ selected, onAdd, disabled, navigate }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getVideos(page, controller.signal).then((data) => {
      if (!controller.signal.aborted) {
        if (!data.data.length && page > 1) { setPage(page - 1); return }
        setResult(data)
      }
    }).catch((err) => {
      if (controller.signal.aborted) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setError(err.message)
    })
    return () => controller.abort()
  }, [page, attempt, navigate])
  function reload(nextPage = page) { setResult(null); setError(''); setPage(nextPage); setAttempt((old) => old + 1) }
  const available = result?.data.filter((video) => !selected.some((item) => item.id === video.id))
  return <section className="ac-builder-panel" aria-labelledby="available-videos-title">
    <h3 id="available-videos-title">등록된 영상</h3>
    <div className="ac-builder-items" aria-busy={!result && !error}>
      {error ? <div className="ac-builder-empty" role="alert"><p>{error}</p><button type="button" className="av-button" onClick={() => reload()}>영상 다시 불러오기</button></div> : !result ? <p className="ac-builder-empty" role="status">영상을 불러오고 있습니다.</p> : available.length ? available.map((video) => <div className="ac-builder-video" key={video.id}>
        <span>{video.title}<small>{video.tags.map((tag) => tag.name).join(' · ') || '태그 없음'}</small></span>
        <button type="button" className="ac-icon-button" aria-label={`${video.title} 추가`} disabled={disabled} onClick={() => onAdd(video)}>＋</button>
      </div>) : <p className="ac-builder-empty">{!result.total ? '등록된 영상이 없습니다. 영상 관리에서 먼저 등록해 주세요.' : result.total > result.limit ? '이 페이지의 영상을 모두 추가했습니다.' : '모든 영상을 추가했습니다.'}</p>}
    </div>
    {result && result.total > result.limit && <nav className="ac-builder-pagination" aria-label="등록된 영상 페이지"><button type="button" className="av-button av-small" disabled={disabled || page === 1} onClick={() => reload(page - 1)}>이전</button><span>{page} / {Math.ceil(result.total / result.limit)}</span><button type="button" className="av-button av-small" disabled={disabled || page * result.limit >= result.total} onClick={() => reload(page + 1)}>다음</button></nav>}
  </section>
}

export default function CourseEditor({ id, onClose, onSaved, navigate }) {
  const [form, setForm] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const locked = useRef(false)
  const alive = useRef(true)
  const formRef = useRef(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    const request = id ? getCourse(id, controller.signal) : Promise.resolve({ name: '', description: '', videos: [] })
    request.then((course) => { if (!controller.signal.aborted) setForm({ name: course.name, description: course.description, videos: [...course.videos].sort((a, b) => a.sortOrder - b.sortOrder) }) })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401) navigate('/admin/login', { replace: true })
        else setLoadError(err.message)
      })
    return () => controller.abort()
  }, [id, attempt, navigate])
  function change(patch) { setForm((old) => ({ ...old, ...patch })); setError('') }
  function clear(key) { setErrors((old) => ({ ...old, [key]: '' })) }
  function add(video) {
    setForm((old) => old.videos.some((item) => item.id === video.id) ? old : { ...old, videos: [...old.videos, video] })
    clear('videoIds'); setError('')
  }
  function move(index, delta) {
    const videos = [...form.videos]
    ;[videos[index], videos[index + delta]] = [videos[index + delta], videos[index]]
    change({ videos })
  }
  async function submit(event) {
    event.preventDefault()
    if (locked.current) return
    const issues = {}
    if (form.name.trim().length < 2 || form.name.trim().length > 50) issues.name = '이름은 2~50자로 입력해 주세요.'
    if (form.description.length > 300) issues.description = '설명은 300자 이내로 입력해 주세요.'
    if (!form.videos.length) issues.videoIds = '학습과정에 영상을 1개 이상 추가해 주세요.'
    setErrors(issues); setError('')
    if (Object.keys(issues).length) {
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus())
      return
    }
    locked.current = true; setSaving(true)
    try {
      await saveCourse(id, { name: form.name.trim(), description: form.description, videoIds: form.videos.map((video) => video.id) })
      if (alive.current) onSaved(id ? '학습과정을 수정했습니다.' : '학습과정을 생성했습니다.')
    } catch (err) {
      if (!alive.current) return
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else {
        setError(err.message)
        if (err.fields) setErrors(Object.fromEntries(Object.entries(err.fields).filter(([, value]) => typeof value === 'string')))
      }
    } finally { locked.current = false; if (alive.current) setSaving(false) }
  }
  return <Modal title={id ? '학습과정 수정' : '학습과정 생성'} onClose={onClose} busy={saving} className="ac-editor">
    <p className="av-muted">이름과 설명을 입력하고, 영상을 추가해 학습 순서를 구성하세요.</p>
    {loadError ? <div className="av-state" role="alert"><p>{loadError}</p><button type="button" className="av-button" onClick={() => { setLoadError(''); setAttempt((old) => old + 1) }}>다시 시도</button></div> : !form ? <p role="status">학습과정을 불러오고 있습니다.</p> : <form ref={formRef} className="ac-form" onSubmit={submit} noValidate aria-busy={saving}>
      <label htmlFor="course-name">학습과정 이름 <em>*</em></label><input id="course-name" maxLength={50} value={form.name} disabled={saving} placeholder="학습과정 이름을 입력하세요" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'course-name-error' : undefined} onChange={(e) => { change({ name: e.target.value }); clear('name') }} />
      {errors.name && <p id="course-name-error" className="av-error" role="alert">{errors.name}</p>}
      <label htmlFor="course-description">설명</label><textarea id="course-description" maxLength={300} value={form.description} disabled={saving} placeholder="이 학습과정을 소개해주세요" onChange={(e) => { change({ description: e.target.value }); clear('description') }} />
      <span className="ac-description-count">{form.description.length}/300</span>
      {errors.description && <p className="av-error" role="alert">{errors.description}</p>}
      <div className="ac-builder">
        <AvailableVideos selected={form.videos} onAdd={add} disabled={saving} navigate={navigate} />
        <section className="ac-builder-panel" aria-labelledby="ordered-videos-title"><h3 id="ordered-videos-title">학습 순서 <span aria-live="polite">{form.videos.length}개</span></h3>
          <ol className="ac-builder-items ac-ordered" tabIndex={errors.videoIds ? -1 : undefined} aria-invalid={!!errors.videoIds} aria-describedby={errors.videoIds ? 'course-videos-error' : 'course-builder-hint'}>
            {form.videos.map((video, index) => <li className="ac-builder-video" key={video.id}><span className="ac-order-number">{index + 1}</span><span>{video.title}</span><div className="ac-order-actions">
              <button type="button" className="ac-icon-button" aria-label={`${video.title} 위로 이동`} disabled={saving || !index} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="ac-icon-button" aria-label={`${video.title} 아래로 이동`} disabled={saving || index === form.videos.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="ac-icon-button" aria-label={`${video.title} 제외`} disabled={saving} onClick={() => { change({ videos: form.videos.filter((item) => item.id !== video.id) }); clear('videoIds') }}>×</button>
            </div></li>)}
            {!form.videos.length && <li className="ac-builder-empty">등록된 영상에서 영상을 추가해주세요.</li>}
          </ol>
        </section>
      </div>
      <p id="course-builder-hint" className="av-hint">＋ 버튼으로 영상을 추가하고, 위·아래 화살표로 순서를 바꿀 수 있습니다.</p>
      {errors.videoIds && <p id="course-videos-error" className="av-error" role="alert">{errors.videoIds}</p>}
      {error && <p className="av-error" role="alert">{error}</p>}
      <footer className="av-modal-actions"><button className="av-button" type="button" disabled={saving} onClick={onClose}>취소</button><button className="av-button av-primary" type="submit" disabled={saving}>{saving ? '저장 중…' : id ? '저장' : '생성'}</button></footer>
    </form>}
  </Modal>
}
