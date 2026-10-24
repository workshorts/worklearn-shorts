import { app } from './app.js'
import { config } from './config.js'

if (config.authSecret.length < 16) {
  console.error('backend/.env의 AUTH_SECRET을 16자 이상으로 설정하세요.')
  process.exit(1)
}

app.listen(config.port, () => {
  console.log('Server running on http://localhost:' + config.port)
})