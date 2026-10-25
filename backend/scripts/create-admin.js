import '../src/config/env.js'
import { getDb } from '../src/db/client.js'
import { hashPassword } from '../src/lib/password.js'

const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env

if (!ADMIN_USERNAME || ADMIN_USERNAME.length > 50) {
  console.error('backend/.env의 ADMIN_USERNAME을 1~50자로 설정하세요.')
  process.exit(1)
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8 || ADMIN_PASSWORD.length > 128) {
  console.error('backend/.env의 ADMIN_PASSWORD를 8~128자로 설정하세요.')
  process.exit(1)
}

try {
  const db = getDb()
  const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(ADMIN_USERNAME)

  if (exists) {
    console.log('관리자 계정이 이미 있어 건너뜁니다:', ADMIN_USERNAME)
  } else {
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run(ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD))
    console.log('관리자 계정을 만들었습니다:', ADMIN_USERNAME)
  }
} catch (error) {
  console.error('관리자 계정을 만들지 못했습니다. 먼저 npm run db:init 을 실행했는지 확인하세요.')
  console.error(error.message)
  process.exit(1)
}
