import { useRef, useState } from 'react'
import { logoutAdmin } from '../../api/adminApi.js'
import { adminPreview } from './adminPreview.js'
import './admin.css'

const menus = [
  { href: '/admin/videos', title: '영상 관리' },
  { href: '/admin/courses', title: '학습과정 관리' },
]

function Icon({ logout = false }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    {logout ? <path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h11" /> : <path d="M5 12h14m-6-6 6 6-6 6" />}
  </svg>
}

export default function AdminLayout({ pathname, navigate, children, showHeading = true }) {
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const titleRef = useRef(null)
  const active = menus.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    || (pathname === '/admin' ? menus[0] : null)

  function follow(event, href) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
    setError('')
    titleRef.current?.focus()
  }

  async function handleLogout() {
    if (submitting.current) return
    submitting.current = true
    setLoggingOut(true)
    setError('')
    try {
      if (!adminPreview) await logoutAdmin()
      navigate('/admin/login', { replace: true })
    } catch (err) {
      if (err.status === 401) navigate('/admin/login', { replace: true })
      else setError(err.message)
    } finally { submitting.current = false; setLoggingOut(false) }
  }

  return (
    <div className="admin-shell">
      <a className="admin-skip-link" href="#admin-content">본문으로 바로가기</a>
      <aside className="admin-sidebar">
        <a className="admin-wordmark" href="/admin/videos" onClick={(event) => follow(event, '/admin/videos')}>관리자</a>
        <nav aria-label="관리자 메뉴">
          {menus.map((item) => <a key={item.href} href={item.href}
            className={active === item ? 'active' : undefined} aria-current={active === item ? 'page' : undefined}
            onClick={(event) => follow(event, item.href)}>{item.title}</a>)}
        </nav>
        <div className="admin-sidebar-bottom">
          {/* <a className="admin-view-site" href="/"><Icon />사용자 화면 보기</a> */}
          <button className="admin-logout" type="button" disabled={loggingOut} onClick={handleLogout}>
            <Icon logout />{loggingOut ? '로그아웃 중…' : '로그아웃'}
          </button>
          {error && <p className="admin-logout-error" role="alert">{error}</p>}
        </div>
      </aside>
      <main className="admin-main" id="admin-content" tabIndex={-1}>
        <div className="admin-content">
          {showHeading && <header className="admin-heading"><h1 tabIndex={-1} ref={titleRef}>{active?.title || '페이지를 찾을 수 없습니다'}</h1></header>}
          {children}
        </div>
      </main>
    </div>
  )
}
