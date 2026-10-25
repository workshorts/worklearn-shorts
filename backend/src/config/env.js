import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../../.env', import.meta.url))

try {
  loadEnvFile(envFile)
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw new Error('Unable to load backend/.env configuration.')
  }
}
