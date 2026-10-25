import { useCallback, useEffect, useState } from 'react'
import AdminLogin from './pages/admin/AdminLogin.jsx'
import AdminLayout from './components/admin/AdminLayout.jsx'
import AdminAccess from './components/admin/AdminAccess.jsx'
import AdminVideos from './pages/admin/AdminVideos.jsx'
import AdminVideoForm from './pages/admin/AdminVideoForm.jsx'
import AdminCourses from './pages/admin/AdminCourses.jsx'

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', updatePath)
    return () => window.removeEventListener('popstate', updatePath)
  }, [])

  const navigate = useCallback((path, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
    setPathname(path)
  }, [])

  useEffect(() => {
    if (pathname === '/admin' || pathname === '/admin/') {
      window.location.replace('/admin/videos')
    }
  }, [pathname])

  if (pathname === '/admin' || pathname === '/admin/') return null

  if (pathname === '/admin/login') {
    return <AdminLogin onAuthenticated={() => navigate('/admin/videos', { replace: true })} />
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const editing = pathname.match(/^\/admin\/videos\/([1-9]\d*)\/edit$/)
    const videos = pathname === '/admin/videos'
    const creating = pathname === '/admin/videos/new'
    const courses = pathname === '/admin/courses'
    return (
      <AdminAccess navigate={navigate}>
        <AdminLayout pathname={pathname} navigate={navigate} showHeading={!videos && !creating && !editing && !courses}>
          {courses ? <AdminCourses navigate={navigate} /> : videos ? <AdminVideos navigate={navigate} /> : creating || editing ? <AdminVideoForm key={pathname} id={editing ? Number(editing[1]) : undefined} navigate={navigate} /> : <section className="admin-placeholder" aria-label="페이지 준비 안내">
            <p>페이지를 찾을 수 없습니다.</p>
          </section>}
        </AdminLayout>
      </AdminAccess>
    )
  }

  // The learner-facing home will be implemented by its owner.
  return (
    <main style={{ padding: 32 }}>
      <h1>스킬클립</h1>
      <p>사용자 화면은 준비 중입니다.</p>
      <a href="/admin/login">관리자 로그인</a>
      <p><a href="/admin/videos">관리자 화면</a> — 로그인 기능 준비 중이므로 이 링크로 접속해 주세요.</p>
    </main>
  )
}
