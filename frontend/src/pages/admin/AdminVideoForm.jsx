import { useEffect, useRef, useState } from 'react'
import { getTags, getVideo, saveVideo, uploadFile } from '../../api/videoApi.js'
import FilePicker from '../../components/admin/FilePicker.jsx'
import TagPicker from '../../components/admin/TagPicker.jsx'
import QuizEditor from '../../components/admin/QuizEditor.jsx'
import { blankQuiz, readQuiz, fileError, routeLink } from '../../components/admin/videoFormUtils.js'
import './videos.css'

export default function AdminVideoForm({ id, navigate }) {
  const editing = !!id
  const [form, setForm] = useState(null)
  const [tags, setTags] = useState([])
  const [tagsLoading, setTagsLoading] = useState(true)
  const [tagsError, setTagsError] = useState('')
  const [tagsAttempt, setTagsAttempt] = useState(0)
  const [quiz, setQuiz] = useState(blankQuiz)
  const [videoFile, setVideoFile] = useState(null)
  const [thumbnailFile, setThumbnailFile] = useState(null)
  const [thumbnailRemoved, setThumbnailRemoved] = useState(false)
  const [picker, setPicker] = useState(false)
  const [errors, setErrors] = useState({})
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [stage, setStage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const formRef = useRef(null)
  const locked = useRef(false)
  // 메타데이터 저장에 실패하여 재시도할 때 이미 업로드에 성공한 파일은 다시 업로드하지 않고 재사용
  const uploaded = useRef({})
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    const request = editing ? getVideo(id, controller.signal) : Promise.resolve({ title: '', description: '', tagIds: [], videoPath: null, thumbnailPath: null, videoUrl: '', thumbnailUrl: '' })
    request.then((video) => { if (!controller.signal.aborted) { setForm(video); setQuiz(readQuiz(video.quiz)) } })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401) navigate('/admin/login', { replace: true })
        else setLoadError(err.message)
      })
    return () => controller.abort()
  }, [id, editing, attempt, navigate])
  useEffect(() => {
    const controller = new AbortController()
    getTags(controller.signal)
      .then((result) => { if (!controller.signal.aborted) setTags(result.data) })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401) navigate('/admin/login', { replace: true })
        else setTagsError(err.message)
      })
      .finally(() => { if (!controller.signal.aborted) setTagsLoading(false) })
    return () => controller.abort()
  }, [tagsAttempt, navigate])
  useEffect(() => {
    if (!saving) return
    const warn = (event) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [saving])
  function change(patch) { setForm((old) => ({ ...old, ...patch })); setError('') }
  function fieldError(key, value) { setErrors((old) => ({ ...old, [key]: value })) }
  function unauthorized() { navigate('/admin/login', { replace: true }) }

  async function upload(kind, file) {
    if (uploaded.current[kind]?.file === file) return uploaded.current[kind].result
    const result = await uploadFile(kind, file)
    uploaded.current[kind] = { file, result }
    return result
  }
  async function submit(event) {
    event.preventDefault()
    if (locked.current) return
    const next = {}
    if (form.title.trim().length < 2 || form.title.trim().length > 100) next.title = '제목은 2~100자로 입력해 주세요.'
    if (form.description.length > 500) next.description = '설명은 500자 이내로 입력해 주세요.'
    if (!videoFile && !editing) next.video = '영상 파일을 선택해 주세요.'
    if (videoFile) next.video = fileError('video', videoFile)
    if (thumbnailFile) next.thumbnail = fileError('thumbnail', thumbnailFile)
    if (quiz.enabled && (!quiz.question.trim() || quiz.question.trim().length > 200 || quiz.options.length < 2 || quiz.options.length > 5 || quiz.options.some((o) => !o.content.trim() || o.content.trim().length > 100) || quiz.options.filter((o) => o.isCorrect).length !== 1)) next.quiz = '질문과 보기 2~5개를 입력하고 정답 하나를 선택해 주세요.'
    setErrors(next); setError('')
    if (Object.values(next).some(Boolean)) {
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"], .av-error')?.focus())
      return
    }
    locked.current = true; setSaving(true)
    try {
      let videoPath = form.videoPath, thumbnailPath = thumbnailRemoved ? null : form.thumbnailPath
      if (videoFile) { setStage('영상 업로드 중…'); videoPath = (await upload('video', videoFile)).path }
      if (thumbnailFile) { setStage('썸네일 업로드 중…'); thumbnailPath = (await upload('thumbnail', thumbnailFile)).path }
      if (!alive.current) return
      setStage('저장 중…')
      const payload = {
        title: form.title.trim(), description: form.description, tagIds: form.tagIds,
        thumbnailPath: thumbnailPath || null,
        quiz: quiz.enabled ? { question: quiz.question.trim(), options: quiz.options.map((o) => ({ content: o.content.trim(), isCorrect: o.isCorrect })) } : null,
      }
      // 미리보기 모드에 등록된 초기 영상 데이터는 실제 파일이 없음, 따라서 PATCH 요청 시 파일을 생략할 수도 있음
      if (videoPath) payload.videoPath = videoPath
      await saveVideo(id, payload)
      if (alive.current) navigate('/admin/videos')
    } catch (err) {
      if (!alive.current) return
      if (err.status === 401) unauthorized()
      else {
        setError(err.message)
        if (err.fields && typeof err.fields === 'object') {
          const fields = {}
          for (const [key, value] of Object.entries(err.fields)) if (typeof value === 'string') fields[key === 'videoPath' ? 'video' : key === 'thumbnailPath' ? 'thumbnail' : key.startsWith('quiz') ? 'quiz' : key] = value
          setErrors(fields)
        }
      }
    } finally { locked.current = false; if (alive.current) setSaving(false) }
  }
  const tagsDisabled = saving || tagsLoading || !!tagsError
  // 태그 목록 응답으로 선택 ID를 덮어쓰거나 필터링하지 않는다. 이름을 몰라도 기존 연결은 보존한다.
  const selectedTags = form?.tagIds.map((id) => ({ id, name: tags.find((tag) => tag.id === id)?.name || `태그 #${id}` })) || []
  const videoPicker = form && <FilePicker kind="video" file={videoFile} currentUrl={form.videoUrl} currentPath={form.videoPath} onChange={setVideoFile} compact={editing} disabled={saving} error={errors.video} onError={(issue) => fieldError('video', issue)} />
  return <div className="av-form-page">
    <header className="admin-heading"><h1>{editing && <a href="/admin/videos" aria-label="영상 목록으로" onClick={(e) => routeLink(e, navigate, '/admin/videos')}>←</a>}{editing ? '영상 수정' : '영상 등록'}</h1></header>
    {loadError ? <div className="av-state" role="alert"><p>{loadError}</p><button className="av-button" onClick={() => { setLoadError(''); setAttempt((v) => v + 1) }}>다시 시도</button><a className="av-button" href="/admin/videos" onClick={(e) => routeLink(e, navigate, '/admin/videos')}>목록으로</a></div> : !form ? <p role="status">영상 정보를 불러오고 있습니다.</p> : <form ref={formRef} className={`av-form ${editing ? 'editing' : ''}`} onSubmit={submit} noValidate aria-busy={saving}>
      {!editing && <div className="av-field"><label>영상 파일 <em>*</em></label>{videoPicker}</div>}
      <div className="av-field"><label htmlFor="video-title">제목 <em>*</em></label><div><input id="video-title" name="title" maxLength={100} placeholder="예: 엑셀 단축키 5개로 퇴근 10분 당기기" value={form.title} disabled={saving} aria-invalid={!!errors.title} aria-describedby={errors.title ? 'title-error' : undefined} onChange={(e) => { change({ title: e.target.value }); fieldError('title', '') }} />{errors.title && <p id="title-error" className="av-error" role="alert">{errors.title}</p>}</div></div>
      <div className="av-field"><label htmlFor="video-description">설명</label><div className="av-description"><textarea id="video-description" name="description" maxLength={500} placeholder="영상 설명을 입력하세요." value={form.description} disabled={saving} onChange={(e) => change({ description: e.target.value })} /><span className="av-count">{form.description.length}/500</span>{errors.description && <p className="av-error" role="alert">{errors.description}</p>}</div></div>
      <div className="av-field"><label>영상 태그</label><div><div className="av-inline"><div className="av-selected-tags">{selectedTags.map((tag) => <span key={tag.id}>{tag.name}<button type="button" disabled={tagsDisabled} aria-label={`${tag.name} 선택 해제`} onClick={() => change({ tagIds: form.tagIds.filter((id) => id !== tag.id) })}>×</button></span>)}</div><button type="button" className="av-button" disabled={tagsDisabled} onClick={() => setPicker(true)}>＋ 태그 추가</button></div><p className="av-hint">영상 태그는 선택사항입니다.</p>{tagsLoading && <p className="av-hint" role="status">태그 목록을 불러오고 있습니다. 다른 항목은 계속 작성할 수 있습니다.</p>}{tagsError && <div><p className="av-error" role="alert">태그 목록을 불러오지 못했습니다. {tagsError}</p><p className="av-hint">기존 태그는 유지됩니다. 다른 항목을 수정하고 저장할 수 있습니다.</p><button type="button" className="av-button" disabled={saving} onClick={() => { setTagsLoading(true); setTagsError(''); setTagsAttempt((value) => value + 1) }}>태그 다시 시도</button></div>}{errors.tagIds && <p className="av-error" role="alert">{errors.tagIds}</p>}</div></div>
      {editing && <div className="av-field"><label>영상 파일 <em>*</em></label>{videoPicker}</div>}
      <div className="av-field"><label>썸네일</label><div><FilePicker kind="thumbnail" file={thumbnailFile} currentUrl={thumbnailRemoved ? '' : form.thumbnailUrl} currentPath={thumbnailRemoved ? '' : form.thumbnailPath} onChange={(file) => { setThumbnailFile(file); setThumbnailRemoved(false) }} compact disabled={saving} error={errors.thumbnail} onError={(issue) => fieldError('thumbnail', issue)} /><div className="av-thumbnail-hint"><span className="av-hint">없으면 기본 이미지가 사용됩니다.</span>{(thumbnailFile || (!thumbnailRemoved && form.thumbnailPath)) && <button className="av-text-button" type="button" disabled={saving} onClick={() => { setThumbnailFile(null); setThumbnailRemoved(true); fieldError('thumbnail', '') }}>썸네일 제거</button>}</div></div></div>
      <QuizEditor value={quiz} onChange={(value) => { setQuiz(value); fieldError('quiz', '') }} disabled={saving} error={errors.quiz} />
      {error && <p className="av-error" role="alert">{error}</p>}
      <footer className="av-form-actions"><button className="av-button" type="button" disabled={saving} onClick={() => navigate('/admin/videos')}>취소</button><button className={`av-button ${editing ? 'av-dark' : 'av-primary'}`} type="submit" disabled={saving}>{saving ? stage : editing ? '수정하기' : '등록'}</button></footer>
    </form>}
    {picker && !tagsDisabled && <TagPicker tags={tags} selected={form.tagIds} onTagsChange={setTags} onSelectionChange={(ids) => change({ tagIds: ids })} onClose={() => setPicker(false)} onUnauthorized={unauthorized} />}
  </div>
}
