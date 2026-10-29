// 학습과정 시연 데이터를 넣는 별도 명령이다. 먼저 npm run db:seed 로 샘플 영상을 만들어 둬야 한다.
const failureMessages = {
  INVALID_SEED_ARGUMENTS: 'Course seeding refused: db:seed:courses accepts no arguments. Configure DB_PATH.',
  INVALID_DATABASE_SCHEMA: 'Course seeding refused: the existing database schema is incompatible. Existing data was preserved.',
  INVALID_DATABASE_INTEGRITY: 'Course seeding refused: the existing database failed integrity checks. Existing data was preserved.',
  MISSING_SEED_COURSE_VIDEO: 'Course seeding failed: the sample videos are missing. Run npm run db:seed first.',
  AMBIGUOUS_SEED_VIDEO: 'Course seeding refused: multiple existing videos match a sample media path.',
  AMBIGUOUS_SEED_COURSE: 'Course seeding refused: multiple existing courses match a sample course name.'
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

  const { openSeedDatabase } = await import('../src/db/seed-preflight.js')
  const connection = await import('../src/db/connection.js')
  const { insertSeedCourses } = await import('../src/db/seed-courses.js')
  const { withTransaction } = await import('../src/db/transaction.js')
  closeDatabase = connection.closeDatabase
  database = openSeedDatabase()
  summary = withTransaction(database, connected => insertSeedCourses(connected))
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
  // 네이티브 오류, 원인, 경로를 출력하지 않는다.
  console.error(Object.hasOwn(failureMessages, failure?.code) ? failureMessages[failure.code] :
    'Course seeding failed. Check access to an initialized database and the local configuration.')
  if (cleanupFailed) console.error('Database connection cleanup also failed.')
  process.exitCode = 1
} else if (cleanupFailed) {
  console.error('Database connection cleanup failed.')
  process.exitCode = 1
} else {
  const created = summary.filter(course => course.created).length
  const links = summary.reduce((sum, course) => sum + course.videoCount, 0)
  console.log(`Course samples ready. Courses: ${summary.length} (created: ${created}); links: ${links}.`)
}
