import { getBrowserStorage } from './storage.js';

// 방문자 식별값: 로그인 없이 좋아요·조회를 구분하는 UUID다. 브라우저에 한 번 만들어 계속 쓴다.
// API에는 X-Visitor-Id 헤더로 보낸다(백엔드는 UUID 형식만 받는다).
const STORAGE_KEY = 'worklearn.visitorId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // randomUUID는 https·localhost에서만 있으므로, 그 밖의 주소에서는 직접 만든다.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function getVisitorId({ storage = getBrowserStorage(), createId = createUuid } = {}) {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (typeof saved === 'string' && UUID_PATTERN.test(saved)) return saved.toLowerCase();
  } catch {
    // 읽을 수 없으면 새로 만든다.
  }

  const id = String(createId()).toLowerCase();
  try {
    storage.setItem(STORAGE_KEY, id);
  } catch {
    // 저장하지 못해도 이번 접속에서는 이 값을 쓴다.
  }
  return id;
}
