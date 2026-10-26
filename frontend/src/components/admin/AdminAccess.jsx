import { useEffect, useState } from 'react'
import { getAdmin } from '../../api/adminApi.js'
import { adminPreview } from './adminPreview.js'
import './admin.css'

export default function AdminAccess({ children, navigate }) {
  const [status, setStatus] = useState('checking')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (adminPreview) return // 어드민 프리뷰 모드라면 로그인 상태확인 패스
    const controller = new AbortController()
    getAdmin(controller.signal)
      .then(() => { if (!controller.signal.aborted) setStatus('ready') })
      .catch((err) => {
        if (controller.signal.aborted) return
        if (err.status === 401) navigate('/admin/login', { replace: true })
        else { setError(err.message); setStatus('error') }
      })
    return () => controller.abort()
  }, [navigate, attempt])

  if (adminPreview || status === 'ready') return children
  return (
    <main className="admin-access">
      <section aria-live="polite" aria-busy={status === 'checking'}>
        <h1>관리자</h1>
        {status === 'checking' ? <p>로그인 상태를 확인하고 있습니다.</p> : <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => { setStatus('checking'); setAttempt((value) => value + 1) }}>다시 시도</button>
          <a href="/admin/login" onClick={(event) => { event.preventDefault(); navigate('/admin/login') }}>로그인 화면으로</a>
        </>}
      </section>
    </main>
  )
}
