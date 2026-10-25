export class ApiError extends Error {
  constructor(message, status, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function adminRequest(path, { signal, ...options } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 25_000);
  try {
    const response = await fetch(`/api/admin/${path}`, {
      ...options,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: controller.signal,
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : null;
    if (!response.ok) {
      const message =
        response.status === 401 ? '아이디 또는 비밀번호를 확인해 주세요.' :
        response.status === 403 ? '관리자 접근 권한이 없습니다.' :
        response.status === 429 ? '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.' :
        response.status >= 500 ? '서버가 준비 중이거나 응답하지 않습니다. 잠시 후 다시 시도해 주세요.' :
        data?.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
      throw new ApiError(message, response.status, data?.fields);
    }
    // SPA fallback HTML must never be mistaken for successful authentication.
    if (!isJson && response.status !== 204) {
      throw new ApiError('로그인 서버 연결을 확인해 주세요.', 502);
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      error.name === 'AbortError'
        ? '서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.'
        : '서버에 연결할 수 없습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.',
      0,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const getAdmin = (signal) => adminRequest('me', { signal });
export const loginAdmin = (username, password) =>
  adminRequest('login', { method: 'POST', body: JSON.stringify({ username, password }) });
