import './learner.css'

function Icon({ learning }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{learning ? <path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15" /> : <path d="m3 10 9-7 9 7v10h-6v-7H9v7H3Z" />}</svg>
}

export default function LearnerNavigation({ navigate, active = 'feed' }) {
  function follow(event, href) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault(); navigate(href)
  }
  const links = () => [{ id: 'feed', href: '/', name: '피드' }, { id: 'learning', href: '/paths', name: '학습하기' }].map((item) => <a key={item.id} href={item.href} aria-current={active === item.id ? 'page' : undefined} onClick={(e) => follow(e, item.href)}><Icon learning={item.id === 'learning'} /><span>{item.name}</span></a>)
  return <>
    <header className="learner-header"><a className="learner-brand" href="/" onClick={(e) => follow(e, '/')}>스킬클립</a><nav aria-label="사용자 메뉴">{links()}</nav></header>
    <nav className="learner-bottom-nav" aria-label="모바일 사용자 메뉴">{links()}</nav>
  </>
}
