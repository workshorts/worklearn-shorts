// 브라우저 저장소(localStorage)를 안전하게 얻는다.
// 사생활 보호 모드처럼 쓸 수 없는 환경에서는 새로고침 전까지만 기억하는 메모리 저장소로 대신한다.
const memory = new Map();

export const memoryStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};

export function getBrowserStorage() {
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      const probe = '__worklearn_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    }
  } catch {
    // 접근이 막힌 환경: 메모리 저장소를 쓴다.
  }
  return memoryStorage;
}
