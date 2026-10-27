import { readSeedAdminCredentials } from '../config/seed-admin.js'
import { hashPassword } from '../lib/password.js'

// Recheck inside the final seed transaction before inserting a new administrator.
export function hasSeedAdmin(database, username) {
  if (typeof username !== 'string' || username.length < 1 || username.length > 50 || username.includes('\0')) {
    throw new TypeError('Seed administrator lookup requires a username of 1 to 50 characters without null characters.')
  }
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }

  // Do not read password hashes or normalize the exact stored account name.
  return database.prepare('SELECT 1 FROM admins WHERE username = ? COLLATE BINARY LIMIT 1')
    .get(username) !== undefined
}

// Prepare outside the write transaction; insertion must recheck account existence.
export function prepareSeedAdmin(database, environment = process.env) {
  const { username, password } = readSeedAdminCredentials(environment)
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (database.isTransaction) {
    throw new Error('Seed administrator hashing must run before a transaction starts.')
  }
  if (hasSeedAdmin(database, username)) return null

  // Retain only the hash in the candidate passed to the later insertion step.
  return { username, passwordHash: hashPassword(password) }
}
