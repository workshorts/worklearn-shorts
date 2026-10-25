import React, { useEffect, useRef, useState } from 'react';
import { getAdmin, loginAdmin } from '../../api/adminApi.js';
import './login.css';

function EyeIcon({ visible }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {visible && <path d="m3 3 18 18" />}
    </svg>
  );
}

export default function AdminLogin({ onAuthenticated, homeHref = '/' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const usernameRef = useRef(null);
  const passwordRef = useRef(null);
  const submitting = useRef(false);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;

  useEffect(() => {
    const controller = new AbortController();
    getAdmin(controller.signal)
      .then(() => onAuthenticatedRef.current())
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err.status !== 401) setError(err.message);
        setStatus('idle');
      });
    return () => controller.abort();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting.current || status === 'checking') return;
    const nextFields = {
      username: username.trim() ? '' : '아이디를 입력해 주세요.',
      password: password ? '' : '비밀번호를 입력해 주세요.',
    };
    setFields(nextFields);
    setError('');
    if (nextFields.username || nextFields.password) {
      (nextFields.username ? usernameRef : passwordRef).current?.focus();
      return;
    }
    submitting.current = true;
    setStatus('submitting');
    try {
      await loginAdmin(username.trim(), password);
      await getAdmin(); // Confirm the HttpOnly session cookie actually works.
      setPassword('');
      onAuthenticatedRef.current();
    } catch (err) {
      setError(err.message);
      if (err.fields && typeof err.fields === 'object' && !Array.isArray(err.fields)) {
        setFields({
          username: typeof err.fields.username === 'string' ? err.fields.username : '',
          password: typeof err.fields.password === 'string' ? err.fields.password : '',
        });
      }
    } finally {
      submitting.current = false;
      setStatus('idle');
    }
  }

  const busy = status !== 'idle';
  return (
    <main className="login-page">
      <a className="login-brand" href={homeHref}>스킬클립</a>
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title">관리자 로그인</h1>
        <p>스킬클립 콘텐츠를 관리하세요.</p>
        <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
          <label htmlFor="username">아이디</label>
          <input ref={usernameRef} id="username" name="username" autoComplete="username"
            placeholder="아이디를 입력하세요" value={username} disabled={busy}
            onChange={(e) => { setUsername(e.target.value); setFields((f) => ({ ...f, username: '' })); }}
            aria-invalid={!!fields.username} aria-describedby={fields.username ? 'username-error' : undefined} required />
          {fields.username && <p id="username-error" className="field-error">{fields.username}</p>}
          <label htmlFor="password">비밀번호</label>
          <div className="password-control">
            <input ref={passwordRef} id="password" name="password" type={visible ? 'text' : 'password'}
              autoComplete="current-password" placeholder="비밀번호를 입력하세요"
              value={password} disabled={busy}
              onChange={(e) => { setPassword(e.target.value); setFields((f) => ({ ...f, password: '' })); }}
              aria-invalid={!!fields.password} aria-describedby={fields.password ? 'password-error' : undefined} required />
            <button className="password-toggle" type="button" onClick={() => setVisible((v) => !v)}
              aria-label={visible ? '비밀번호 숨기기' : '비밀번호 보기'} aria-pressed={visible}>
              <EyeIcon visible={visible} />
            </button>
          </div>
          {fields.password && <p id="password-error" className="field-error">{fields.password}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button login-submit" type="submit" disabled={busy}>
            <span aria-live="polite">{status === 'checking' ? '로그인 상태 확인 중…' : status === 'submitting' ? '로그인 중…' : '로그인'}</span>
            {!busy && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="false">
              <path d="M4 12h16m-6-6 6 6-6 6" />
            </svg>}
          </button>
        </form>
        <a className="login-home" href={homeHref}>사용자 화면으로 돌아가기</a>
      </section>
    </main>
  );
}
