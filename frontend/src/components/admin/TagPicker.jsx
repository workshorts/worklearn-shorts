import { useState } from 'react'
import Modal from './Modal.jsx'
import { createTag, deleteTag } from '../../api/videoApi.js'

export default function TagPicker({ tags, selected, onTagsChange, onSelectionChange, onClose, onUnauthorized }) {
  const [managing, setManaging] = useState(false)
  const [pending, setPending] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function create(event) {
    event.preventDefault()
    if (busy) return
    if (!name.trim() || name.trim().length > 30) { setError('태그 이름을 1~30자로 입력해 주세요.'); return }
    setBusy(true); setError('')
    try {
      const tag = await createTag(name.trim())
      onTagsChange([...tags, tag]); onSelectionChange([...selected, tag.id]); setName('')
    } catch (err) { if (err.status === 401) onUnauthorized(); else setError(err.message) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await deleteTag(pending.id)
      onTagsChange(tags.filter((tag) => tag.id !== pending.id))
      onSelectionChange(selected.filter((id) => id !== pending.id)); setPending(null)
    } catch (err) { if (err.status === 401) onUnauthorized(); else setError(err.message) }
    finally { setBusy(false) }
  }
  return <Modal title="영상 태그 추가" onClose={onClose} busy={busy}>
    <p className="av-muted">기존 태그를 선택하거나 새 태그를 만들어보세요.</p>
    <div className="av-tag-toolbar"><span>{managing ? '휴지통을 눌러 태그 자체를 삭제할 수 있습니다.' : '태그를 선택해 이 영상에 추가하세요.'}</span><button className="av-button" type="button" disabled={busy} aria-pressed={managing} onClick={() => { setManaging(!managing); setPending(null) }}>{managing ? '관리 완료' : '태그 관리'}</button></div>
    {pending && <div className="av-delete-warning" role="region" aria-label="태그 삭제 확인">
      <strong>‘{pending.name}’ 태그를 삭제할까요?</strong><p>모든 영상에서 이 태그가 제거됩니다. 영상은 유지됩니다.</p>
      <div className="av-actions"><button className="av-button" type="button" disabled={busy} onClick={() => setPending(null)}>취소</button><button className="av-button av-danger" type="button" disabled={busy} onClick={remove}>태그 삭제</button></div>
    </div>}
    <div className="av-tag-picker">{tags.map((tag) => <div key={tag.id} className="av-tag-option">
      <button type="button" className={`av-pill ${selected.includes(tag.id) ? 'selected' : ''}`} disabled={busy || managing} aria-pressed={selected.includes(tag.id)} onClick={() => onSelectionChange(selected.includes(tag.id) ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])}>{tag.name}<span aria-hidden="true">{selected.includes(tag.id) ? '✓' : '+'}</span></button>
      {managing && <button className="av-trash" type="button" disabled={busy} aria-label={`${tag.name} 태그 삭제`} onClick={() => setPending(tag)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg></button>}
    </div>)}</div>
    {!tags.length && <p className="av-muted">등록된 태그가 없습니다. 새 태그를 추가하세요.</p>}
    <form className="av-create-tag" onSubmit={create} noValidate>
      <label htmlFor="new-tag">새 태그</label><div className="av-inline"><input id="new-tag" maxLength={30} placeholder="새 태그 이름" value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setError('') }} /><button className="av-button av-primary" disabled={busy}>＋ 추가</button></div>
    </form>
    {error && <p className="av-error" role="alert">{error}</p>}
    <footer className="av-modal-actions"><button type="button" className="av-button av-primary" disabled={busy} onClick={onClose}>완료</button></footer>
  </Modal>
}
