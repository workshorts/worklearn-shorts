import './config/env.js'
import fs from 'node:fs'
import path from 'node:path'
import { app } from './app.js'
import { config } from './config/index.js'
import { getDb } from './db/client.js'

if (config.authSecret.length < 16) {
  console.error('backend/.env의 AUTH_SECRET을 16자 이상으로 설정하세요.')
  process.exit(1)
}

// DB가 없으면 바로 알려 준다
try {
  getDb()
} catch (error) {
  console.error('DB를 열 수 없습니다. 먼저 npm run db:init 을 실행하세요.')
  console.error(error.message)
  process.exit(1)
}

// 업로드 폴더는 서버가 직접 만든다
fs.mkdirSync(path.join(config.uploadDir, 'videos'), { recursive: true })
fs.mkdirSync(path.join(config.uploadDir, 'thumbnails'), { recursive: true })

app.listen(config.port, () => {
  console.log('Server running on http://localhost:' + config.port)
})
