import './env.js'

export function readSeedAdminCredentials(environment = process.env) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('Seed administrator configuration requires an environment object.')
  }

  const username = environment.ADMIN_USERNAME
  const password = environment.ADMIN_PASSWORD
  const fields = {}

  if (typeof username !== 'string' || username.length < 1 || username.length > 50 || username.includes('\0')) {
    fields.ADMIN_USERNAME = 'Must be a string of 1 to 50 characters without null characters.'
  }

  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || password.includes('\0')) {
    fields.ADMIN_PASSWORD = 'Must be a string of 8 to 128 characters without null characters.'
  }

  if (Object.keys(fields).length > 0) {
    // Include only field names and fixed rules, never supplied credentials.
    const error = new Error('Invalid seed administrator configuration.')
    error.code = 'INVALID_SEED_ADMIN_CONFIG'
    error.fields = fields
    throw error
  }

  // Preserve exact inputs so hashing and username lookup use the same values.
  return { username, password }
}
