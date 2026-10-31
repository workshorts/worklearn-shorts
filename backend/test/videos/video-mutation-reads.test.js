import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withTransaction } from '../../src/db/transaction.js'
import { startAuthServer } from '../helpers/auth-server.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

const visitorA = 'aabbccdd-eeff-4abc-8def-012345abcdef'
const createdAt = '2001-02-03T04:05:06.000Z'
const updatedAt = '2002-03-04T05:06:07.000Z'
const tables = ['admins', 'videos', 'tags', 'courses', 'course_videos', 'video_tags',
  'video_views', 'video_likes', 'comments', 'quizzes', 'quiz_options', 'sqlite_sequence']

test('public reads reflect committed video, tag, comment and quiz changes while preserving rolled-back and unrelated data', { timeout: 30000 }, async t => {
  const { request, getDb, databasePath } = await startAuthServer(t, { uploads: true })
  const database = getDb()
  const fixture = insertMinimalFixture(database)
  let controlId
  let bareId
  let beta
  let unused
  let delta
  let replacementQuiz
  withTransaction(database, connection => {
    connection.prepare('UPDATE videos SET title = ?, description = ?, video_path = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run('Mutation target', 'Target description', 'videos/10000000-0000-4000-8000-000000000001.mp4', createdAt, updatedAt, fixture.videoId)
    connection.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Alpha', fixture.tagId)
    const insertTag = connection.prepare('INSERT INTO tags (name) VALUES (?)')
    beta = insertTag.run('Beta').lastInsertRowid
    unused = insertTag.run('Unused').lastInsertRowid
    const insertVideo = connection.prepare('INSERT INTO videos (title, video_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
    controlId = insertVideo.run('Retained control', 'videos/20000000-0000-4000-8000-000000000002.mp4', createdAt, updatedAt).lastInsertRowid
    bareId = insertVideo.run('Bare control', 'videos/30000000-0000-4000-8000-000000000003.webm', createdAt, updatedAt).lastInsertRowid
    const link = connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
    for (const tag of [fixture.tagId, beta]) link.run(controlId, tag)
    connection.prepare('INSERT INTO course_videos (course_id, video_id, sort_order) VALUES (?, ?, ?)').run(fixture.courseId, controlId, 2)
    for (const table of ['video_views', 'video_likes']) {
      connection.prepare(`INSERT INTO ${table} (video_id, visitor_id) VALUES (?, ?)`).run(controlId, fixture.visitorId)
    }
    connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
      .run(controlId, 'Control visitor', 'test-only-placeholder', 'Retained comment')
    const quiz = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(controlId, 'Retained question?').lastInsertRowid
    const option = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
    option.run(quiz, 'Retained correct', 1, 1)
    option.run(quiz, 'Retained other', 2, 0)
  })
  const tagNames = new Map([[fixture.tagId, 'Alpha'], [beta, 'Beta'], [unused, 'Unused']])
  const knownTags = new Set(tagNames.keys())
  function modelVideo(id, title, path, populated, tagIds, description = '') {
    return { video: { id, title, description, videoUrl: '/uploads/' + path,
      thumbnailUrl: '/images/default-thumbnail.svg', viewCount: populated ? 1 : 0,
      likeCount: populated ? 1 : 0, commentCount: populated ? 1 : 0, hasQuiz: populated, createdAt, updatedAt },
    tagIds: new Set(tagIds), likedVisitors: new Set(populated ? [fixture.visitorId] : []) }
  }
  const model = new Map([
    [fixture.videoId, modelVideo(fixture.videoId, 'Mutation target', 'videos/10000000-0000-4000-8000-000000000001.mp4', true, [fixture.tagId], 'Target description')],
    [controlId, modelVideo(controlId, 'Retained control', 'videos/20000000-0000-4000-8000-000000000002.mp4', true, [fixture.tagId, beta])],
    [bareId, modelVideo(bareId, 'Bare control', 'videos/30000000-0000-4000-8000-000000000003.webm', false, [])],
  ])
  let checkpoints = 0

  function snapshot() {
    return {
      rows: Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()])),
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      hash: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    }
  }
  const controlBaseline = snapshot().rows
  const controlQuizIds = new Set(controlBaseline.quizzes.filter(row => row.video_id !== fixture.videoId).map(row => row.id))

  function orderedTags(ids) {
    return [...ids].map(id => ({ id, name: tagNames.get(id) }))
      .sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : first.id - second.id)
  }

  function expectedVideo(id, visitor) {
    const entry = model.get(id)
    return { ...entry.video, tags: orderedTags(entry.tagIds), likedByMe: entry.likedVisitors.has(visitor) }
  }

  async function get(path, visitor = null) {
    const response = await request(path, { headers: visitor === null ? {} : { 'X-Visitor-Id': visitor.toUpperCase() } })
    assert.equal(response.status, 200, path)
    assert.match(response.headers['content-type'], /^application\/json\b/)
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(database.isTransaction, false)
    return response.json
  }

  async function assertState() {
    const before = snapshot()
    for (const table of ['admins', 'courses']) assert.deepEqual(before.rows[table], controlBaseline[table])
    assert.deepEqual(before.rows.videos.filter(row => row.id !== fixture.videoId), controlBaseline.videos.filter(row => row.id !== fixture.videoId))
    for (const table of ['course_videos', 'video_views', 'video_likes', 'comments', 'quizzes']) {
      assert.deepEqual(before.rows[table].filter(row => row.video_id !== fixture.videoId),
        controlBaseline[table].filter(row => row.video_id !== fixture.videoId))
    }
    assert.deepEqual(before.rows.quiz_options.filter(row => controlQuizIds.has(row.quiz_id)),
      controlBaseline.quiz_options.filter(row => controlQuizIds.has(row.quiz_id)))
    const ids = [...model.keys()].sort((first, second) => second - first)
    assert.deepEqual(before.rows.videos.map(row => row.id).sort((first, second) => second - first), ids)
    for (const [id, entry] of model) {
      for (const [table, field] of [['video_views', 'viewCount'], ['video_likes', 'likeCount'], ['comments', 'commentCount']]) {
        assert.equal(before.rows[table].filter(row => row.video_id === id).length, entry.video[field])
      }
      assert.equal(before.rows.quizzes.some(row => row.video_id === id), entry.video.hasQuiz)
      assert.deepEqual(before.rows.video_tags.filter(row => row.video_id === id).map(row => row.tag_id).sort((a, b) => a - b),
        [...entry.tagIds].sort((a, b) => a - b))
    }
    for (const visitor of [null, visitorA, fixture.visitorId]) {
      const collected = []
      for (let page = 1; page <= Math.ceil(ids.length / 2) + 1; page += 1) {
        const pageIds = ids.slice((page - 1) * 2, page * 2)
        const response = await get(`/api/videos?page=${page}&limit=2`, visitor)
        assert.deepEqual(response, { data: pageIds.map(id => expectedVideo(id, visitor)), page, limit: 2, total: ids.length })
        collected.push(...response.data.map(video => video.id))
      }
      assert.deepEqual(collected, ids)
      for (const id of ids) assert.deepEqual(await get('/api/videos/' + id, visitor), expectedVideo(id, visitor))
    }
    assert.deepEqual(await get('/api/tags'), { data: orderedTags(tagNames.keys()) })
    for (const tag of knownTags) {
      const matching = ids.filter(id => model.get(id).tagIds.has(tag))
      for (let page = 1; page <= Math.ceil(matching.length / 2) + 1; page += 1) {
        const response = await get(`/api/videos?tagId=${tag}&page=${page}&limit=2`, visitorA)
        assert.deepEqual(response, { data: matching.slice((page - 1) * 2, page * 2).map(id => expectedVideo(id, visitorA)),
          page, limit: 2, total: matching.length })
      }
    }
    assert.deepEqual(snapshot(), before)
    assert.equal(database.isOpen, true)
    checkpoints += 1
  }

  await t.test('committed video metadata changes appear in all reads without altering the controls or stored creation time', async () => {
    await assertState()
    withTransaction(database, connection => {
      connection.prepare('UPDATE videos SET title = ?, description = ?, video_path = ?, thumbnail_path = ?, updated_at = ? WHERE id = ?')
        .run('Changed mutation target', 'Changed description', 'videos/40000000-0000-4000-8000-000000000004.webm',
          'thumbnails/40000000-0000-4000-8000-000000000004.webp', '2003-04-05T06:07:08.000Z', fixture.videoId)
    })
    Object.assign(model.get(fixture.videoId).video, { title: 'Changed mutation target', description: 'Changed description',
      videoUrl: '/uploads/videos/40000000-0000-4000-8000-000000000004.webm',
      thumbnailUrl: '/uploads/thumbnails/40000000-0000-4000-8000-000000000004.webp', updatedAt: '2003-04-05T06:07:08.000Z' })
    await assertState()
  })

  await t.test('tag links, renames, shared deletion and new tags refresh ordered tag arrays, filtered membership and totals', async () => {
    withTransaction(database, connection => {
      const link = connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)')
      link.run(fixture.videoId, beta)
      link.run(bareId, fixture.tagId)
    })
    model.get(fixture.videoId).tagIds.add(beta)
    model.get(bareId).tagIds.add(fixture.tagId)
    await assertState()
    database.prepare('UPDATE tags SET name = ? WHERE id = ?').run('Zulu', fixture.tagId)
    tagNames.set(fixture.tagId, 'Zulu')
    await assertState()
    database.prepare('DELETE FROM tags WHERE id = ?').run(beta)
    tagNames.delete(beta)
    for (const entry of model.values()) entry.tagIds.delete(beta)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM video_tags WHERE tag_id = ?').get(beta).count, 0)
    await assertState()
    withTransaction(database, connection => {
      delta = connection.prepare('INSERT INTO tags (name) VALUES (?)').run('Delta').lastInsertRowid
      connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(fixture.videoId, delta)
    })
    tagNames.set(delta, 'Delta')
    knownTags.add(delta)
    model.get(fixture.videoId).tagIds.add(delta)
    await assertState()
  })

  await t.test('comment creation, edits and deletions update only the correct video count including zero', async () => {
    const added = withTransaction(database, connection => {
      const insert = connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
      return ['First added comment', 'Second added comment'].map(content =>
        insert.run(fixture.videoId, 'Mutation visitor', 'test-only-placeholder', content).lastInsertRowid)
    })
    model.get(fixture.videoId).video.commentCount = 3
    await assertState()
    database.prepare('UPDATE comments SET content = ? WHERE id = ?').run('Edited comment', added[1])
    await assertState()
    withTransaction(database, connection => {
      const remove = connection.prepare('DELETE FROM comments WHERE id = ?')
      remove.run(fixture.commentId)
      remove.run(added[0])
    })
    model.get(fixture.videoId).video.commentCount = 1
    await assertState()
    database.prepare('DELETE FROM comments WHERE id = ?').run(added[1])
    model.get(fixture.videoId).video.commentCount = 0
    await assertState()
  })

  await t.test('quiz edits, removal and recreation update hasQuiz while old options cascade and other quizzes stay intact', async () => {
    const oldOptionIds = [fixture.correctOptionId, fixture.incorrectOptionId]
    withTransaction(database, connection => {
      connection.prepare('UPDATE quizzes SET question = ? WHERE id = ?').run('Changed question?', fixture.quizId)
      connection.prepare('DELETE FROM quiz_options WHERE quiz_id = ?').run(fixture.quizId)
      const insert = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
      insert.run(fixture.quizId, 'Changed correct', 1, 1)
      insert.run(fixture.quizId, 'Changed other', 2, 0)
    })
    for (const id of oldOptionIds) assert.equal(database.prepare('SELECT id FROM quiz_options WHERE id = ?').get(id), undefined)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM quiz_options WHERE quiz_id = ?').get(fixture.quizId).count, 2)
    await assertState()
    database.prepare('DELETE FROM quizzes WHERE id = ?').run(fixture.quizId)
    model.get(fixture.videoId).video.hasQuiz = false
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM quiz_options WHERE quiz_id = ?').get(fixture.quizId).count, 0)
    await assertState()
    withTransaction(database, connection => {
      replacementQuiz = connection.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(fixture.videoId, 'Replacement question?').lastInsertRowid
      const insert = connection.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)')
      insert.run(replacementQuiz, 'Replacement correct', 1, 1)
      insert.run(replacementQuiz, 'Replacement other', 2, 0)
    })
    assert.notEqual(replacementQuiz, fixture.quizId)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM quiz_options WHERE quiz_id = ?').get(replacementQuiz).count, 2)
    model.get(fixture.videoId).video.hasQuiz = true
    await assertState()
  })

  await t.test('a rolled-back mixed metadata and relation change leaves every subsequent response and database row unchanged', async () => {
    const before = snapshot()
    const failure = new Error('Rollback-only fixture mutation')
    assert.throws(() => withTransaction(database, connection => {
      connection.prepare('UPDATE videos SET title = ? WHERE id = ?').run('Discarded title', fixture.videoId)
      connection.prepare('DELETE FROM tags WHERE id = ?').run(delta)
      connection.prepare('DELETE FROM quizzes WHERE id = ?').run(replacementQuiz)
      connection.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
        .run(fixture.videoId, 'Rollback visitor', 'test-only-placeholder', 'Discarded comment')
      const transient = connection.prepare('INSERT INTO tags (name) VALUES (?)').run('Discarded tag').lastInsertRowid
      connection.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(bareId, transient)
      throw failure
    }), error => error === failure)
    assert.deepEqual(snapshot(), before)
    await assertState()
  })

  await t.test('video deletion removes every child and quiz option from reads while retaining shared tags, courses and control videos', async () => {
    database.prepare('INSERT INTO comments (video_id, nickname, password_hash, content) VALUES (?, ?, ?, ?)')
      .run(fixture.videoId, 'Cascade visitor', 'test-only-placeholder', 'Cascade target comment')
    model.get(fixture.videoId).video.commentCount = 1
    await assertState()
    const before = snapshot()
    const childTables = ['course_videos', 'video_tags', 'video_views', 'video_likes', 'comments', 'quizzes']
    const quizIds = new Set(before.rows.quizzes.filter(row => row.video_id === fixture.videoId).map(row => row.id))
    for (const table of childTables) assert.ok(before.rows[table].some(row => row.video_id === fixture.videoId))
    database.prepare('DELETE FROM videos WHERE id = ?').run(fixture.videoId)
    model.delete(fixture.videoId)
    const expected = { ...before.rows, videos: before.rows.videos.filter(row => row.id !== fixture.videoId),
      ...Object.fromEntries(childTables.map(table => [table, before.rows[table].filter(row => row.video_id !== fixture.videoId)])),
      quiz_options: before.rows.quiz_options.filter(row => !quizIds.has(row.quiz_id)) }
    assert.deepEqual(snapshot().rows, expected)
    assert.deepEqual(snapshot().schema, before.schema)
    await assertState()
    const beforeMissing = snapshot()
    const missing = await request('/api/videos/' + fixture.videoId)
    assert.equal(missing.status, 404)
    assert.deepEqual(missing.json, { code: 'NOT_FOUND', message: '영상을 찾을 수 없습니다.', fields: {} })
    assert.deepEqual(snapshot(), beforeMissing)
  })

  assert.equal(checkpoints, 16)
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})
