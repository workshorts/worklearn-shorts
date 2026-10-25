import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function Modal({ title, children, onClose, busy = false }) {
  const ref = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = ref.current
    dialog.focus()
    return () => { document.body.style.overflow = oldOverflow; previous?.focus() }
  }, [])
  function keyDown(event) {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
    if (event.key !== 'Tab') return
    const controls = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (!first) { event.preventDefault(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
  }
  return createPortal(<div className="av-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="av-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} ref={ref} tabIndex={-1} onKeyDown={keyDown}>
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="av-modal-close" aria-label="닫기" disabled={busy} onClick={onClose}>×</button>
      {children}
    </section>
  </div>, document.body)
}
