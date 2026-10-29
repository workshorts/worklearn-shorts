import { randomUUID } from 'node:crypto'

// 시험용 멀티파트 본문을 만든다. parts: [{ name, data, filename?, type? }]
export function multipart(parts) {
  const boundary = `----worklearn${randomUUID().replaceAll('-', '')}`
  const chunks = []
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`
    if (part.filename !== undefined) head += `; filename="${part.filename}"`
    head += '\r\n'
    if (part.type) head += `Content-Type: ${part.type}\r\n`
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}
