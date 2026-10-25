import { withTransaction } from '../../src/db/transaction.js'

export function insertMinimalFixture(database) {
  return withTransaction(database, connection => {
    // These placeholders belong only to database tests, never authentication.
    const adminId = connection.prepare(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?)'
    ).run('fixture-admin', 'test-only-placeholder').lastInsertRowid
    const videoId = connection.prepare(
      'INSERT INTO videos (title, video_path) VALUES (?, ?)'
    ).run('Fixture video', '/uploads/videos/fixture.mp4').lastInsertRowid
    const tagId = connection.prepare('INSERT INTO tags (name) VALUES (?)')
      .run('Fixture tag').lastInsertRowid
    const courseId = connection.prepare('INSERT INTO courses (name) VALUES (?)')
      .run('Fixture course').lastInsertRowid

    connection.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)')
      .run(courseId, videoId, 1)
    connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tagId)

    const visitorId = '00000000-0000-4000-8000-000000000001'
    connection.prepare('INSERT INTO video_views (video_id, visitor_id) VALUES (?, ?)')
      .run(videoId, visitorId)
    connection.prepare('INSERT INTO video_likes (video_id, visitor_id) VALUES (?, ?)')
      .run(videoId, visitorId)

    const commentId = connection.prepare(
      'INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)'
    ).run(videoId, 'Fixture user', 'test-only-placeholder', 'Fixture comment').lastInsertRowid
    const quizId = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)')
      .run(videoId, 'Fixture question?').lastInsertRowid
    const insertOption = connection.prepare(
      'INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)'
    )
    const correctOptionId = insertOption.run(quizId, 'Correct option', 1, 1).lastInsertRowid
    const incorrectOptionId = insertOption.run(quizId, 'Incorrect option', 2, 0).lastInsertRowid

    return { adminId, videoId, tagId, courseId, visitorId, commentId, quizId, correctOptionId, incorrectOptionId }
  })
}
