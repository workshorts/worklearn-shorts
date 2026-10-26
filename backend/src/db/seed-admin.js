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
