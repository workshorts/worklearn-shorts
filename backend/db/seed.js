const failureMessages = {
  INVALID_SEED_ARGUMENTS: 'Database seeding refused: db:seed accepts no arguments. Configure DB_PATH, UPLOAD_DIR, ADMIN_USERNAME and ADMIN_PASSWORD.',
  INVALID_DATABASE_SCHEMA: 'Database seeding refused: the existing database schema is incompatible. Existing data was preserved.',
  INVALID_DATABASE_INTEGRITY: 'Database seeding refused: the existing database failed integrity checks. Existing data was preserved.',
  INVALID_SEED_ADMIN_CONFIG: 'Database seeding failed: configure ADMIN_USERNAME (1-50 characters) and ADMIN_PASSWORD (8-128 characters).',
  INVALID_SEED_MEDIA: 'Database seeding failed: sample media is missing or invalid. Check UPLOAD_DIR and the sample media paths.',
  AMBIGUOUS_SEED_VIDEO: 'Database seeding refused: multiple existing videos match a sample media path.',
  MISSING_SEED_VIDEO: 'Database seeding failed: a sample video required for a tag link is missing.',
  MISSING_SEED_TAG: 'Database seeding failed: a sample tag required for a video link is missing.',
  SEED_ADMIN_CHANGED: 'Database seeding refused: the existing administrator changed during preparation. Retry seeding.'
}

let database
let closeDatabase
let summary
let failure
let failed = false
let cleanupFailed = false

try {
  if (process.argv.length > 2) {
    throw Object.assign(new Error('Unexpected seed arguments.'), { code: 'INVALID_SEED_ARGUMENTS' })
  }

  // Keep configuration and dependency loading inside the same failure boundary.
  const { openSeedDatabase } = await import('../src/db/seed-preflight.js')
  const connection = await import('../src/db/connection.js')
  const { seedDatabase } = await import('../src/db/seed.js')
  closeDatabase = connection.closeDatabase
  database = openSeedDatabase()
  summary = await seedDatabase(database)
} catch (error) {
  failed = true
  failure = error
} finally {
  if (database !== undefined) {
    try {
      closeDatabase(database)
    } catch {
      cleanupFailed = true
    }
  }
}

if (failed) {
  // Never print native errors, causes or stacks containing secrets or local paths.
  console.error(Object.hasOwn(failureMessages, failure?.code) ? failureMessages[failure.code] :
    'Database seeding failed. Check access to an initialized database and the local configuration.')
  if (cleanupFailed) console.error('Database connection cleanup also failed.')
  process.exitCode = 1
} else if (cleanupFailed) {
  // A close failure cannot undo a completed commit; report that distinction clearly.
  console.error('Database seeding committed, but closing the database failed. Verify the saved data before retrying.')
  process.exitCode = 1
} else {
  console.log(`Database seeded successfully. Administrator ${summary.administratorCreated ? 'created' : 'preserved'}; baseline tags: ${summary.tagCount}; videos: ${summary.videoCount}; links: ${summary.videoTagCount}.`)
}
