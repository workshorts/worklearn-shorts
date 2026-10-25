import { useEffect, useState } from 'react'
import AdminLogin from './pages/admin/AdminLogin.jsx'

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', updatePath)
    return () => window.removeEventListener('popstate', updatePath)
  }, [])

  function navigate(path) {
    window.history.replaceState(null, '', path)
    setPathname(path)
  }

  if (pathname === '/admin/login') {
    return <AdminLogin onAuthenticated={() => navigate('/admin/videos')} />
  }

  // Replace with the real protected video-management page in the next step.
  // This placeholder contains no administrator data and grants no access.
  if (pathname === '/admin/videos') {
    return (
      <main className="login-page">
        <section className="login-card">
          <h1>영상 관리</h1>
          <p>영상 관리 화면은 준비 중입니다.</p>
          <a className="login-home" href="/">사용자 화면으로 돌아가기</a>
        </section>
      </main>
    )
  }

  // The learner-facing home will be implemented by its owner.
  return (
    <main style={{ padding: 32 }}>
      <h1>스킬클립</h1>
      <p>사용자 화면은 준비 중입니다.</p>
      <a href="/admin/login">관리자 로그인</a>
    </main>
  )
}
