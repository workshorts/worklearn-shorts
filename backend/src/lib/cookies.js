// 요청 헤더의 Cookie 문자열을 { 이름: 값 } 형태로 바꾼다
export function parseCookies(header) {
  const result = Object.create(null)
  if (!header) return result

  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    let value = part.slice(index + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      result[name] = decodeURIComponent(value)
    } catch {
      result[name] = value
    }
  }
  return result
}
