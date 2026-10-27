import { config } from '../config/index.js'
import { readSeedAdminCredentials } from '../config/seed-admin.js'
import { hasSeedAdmin, insertSeedAdmin, prepareSeedAdmin } from './seed-admin.js'
import { verifySeedMedia } from './seed-media.js'
import { verifySeedDatabase } from './seed-preflight.js'
import { insertSeedTags } from './seed-tags.js'
import { insertSeedVideoTags } from './seed-video-tags.js'
import { insertSeedVideos, SEED_VIDEOS } from './seed-videos.js'
import { withTransaction } from './transaction.js'

function prepareAdministrator(database, environment) {
  const { username, password } = readSeedAdminCredentials(environment)
  const candidate = prepareSeedAdmin(database, { ADMIN_USERNAME: username, ADMIN_PASSWORD: password })
  return { username, candidate }
}

// The caller opens and closes the DB; this function owns only its transactions.
export async function seedDatabase(database, { environment = process.env, uploadDir = config.uploadDir } = {}) {
  if (!database.isOpen) {
    throw new Error('Database connection is closed.')
  }
  if (database.isTransaction) {
    throw new Error('Seed execution requires a connection without an active transaction.')
  }

  withTransaction(database, verifySeedDatabase, { mode: 'DEFERRED' })
  const { username, candidate } = prepareAdministrator(database, environment)
  await verifySeedMedia(SEED_VIDEOS, { uploadDir })

  // Keep asynchronous media work and expensive hashing outside the write lock.
  return withTransaction(database, connection => {
    verifySeedDatabase(connection)
    if (candidate === null && !hasSeedAdmin(connection, username)) {
      const error = new Error('The existing seed administrator disappeared during preparation; retry seeding.')
      error.code = 'SEED_ADMIN_CHANGED'
      throw error
    }

    const administratorCreated = insertSeedAdmin(connection, candidate)
    const tags = insertSeedTags(connection)
    const videos = insertSeedVideos(connection)
    const videoTags = insertSeedVideoTags(connection)
    return { administratorCreated, tagCount: tags.length, videoCount: videos.length, videoTagCount: videoTags.length }
  })
}
