import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTagName } from '../../src/utils/tag-name.js'
import { createDatabaseContext } from '../helpers/database-context.js'
import { insertMinimalFixture } from '../helpers/minimal-fixture.js'

function setup(t) {
  const context = createDatabaseContext(t)
  const path = context.path('tag-normalization.db')
  context.initialize(path)
  const database = context.open(path)
  return { context, path, database, ...insertMinimalFixture(database) }
}

function snapshotTags(database) {
  return {
    tags: database.prepare('SELECT * FROM tags ORDER BY id').all(),
    links: database.prepare('SELECT * FROM video_tags ORDER BY video_id, tag_id').all(),
    sequences: database.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
  }
}

function assertRejected(database, write) {
  const before = snapshotTags(database)
  assert.throws(write, error => {
    // Other constraint failures must not stand in for normalized uniqueness.
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
    assert.equal(error.errcode, 2067)
    return true
  })
  assert.deepEqual(snapshotTags(database), before)
  assert.equal(database.isTransaction, false)
}

const cases = [
  { label: 'ASCII case and whitespace', name: 'JavaScript', key: 'javascript',
    variants: ['JavaScript', 'javascript', 'JAVASCRIPT', ' JavaScript ', '\tJAVASCRIPT\r\n'] },
  { label: 'accented case and Unicode whitespace', name: 'ÉCLAIR', key: 'éclair',
    variants: ['éclair', ' \tÉclair\u00a0', '\ufefféCLAIR\u3000'] },
  { label: 'Korean and Latin case', name: '노드JS', key: '노드js',
    variants: [' 노드js\t', '노드Js'] },
  { label: 'fullwidth Latin case', name: 'ＮＯＤＥ', key: 'ｎｏｄｅ',
    variants: ['ｎｏｄｅ', '\u3000ＮｏＤｅ\u3000'] },
  { label: 'lowercase expansion', name: 'İ', key: 'i\u0307',
    variants: ['i\u0307', '\u00a0İ '] }
]

for (const { label, name, key, variants } of cases) {
  test(`normalized tag INSERT rejects ${label} duplicates and preserves rows`, { timeout: 10000 }, t => {
    const { database, videoId } = setup(t)
    const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
    const tagId = insert.run(name).lastInsertRowid
    database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, tagId)
    const sqlKey = database.prepare('SELECT normalize_tag_name(?) AS key')

    // Fixed expected keys keep the check independent of the production helper.
    assert.equal(normalizeTagName(name), key)
    assert.equal(sqlKey.get(name).key, key)
    for (const variant of variants) {
      assert.equal(normalizeTagName(variant), key)
      assert.equal(sqlKey.get(variant).key, key)
      assertRejected(database, () => insert.run(variant))
    }

    assert.equal(database.prepare('SELECT name FROM tags WHERE id = ?').get(tagId).name, name)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  })
}

test('normalized tag UPDATE rejects collisions but permits display changes and a new key', { timeout: 10000 }, t => {
  const { database, tagId, videoId } = setup(t)
  const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
  const secondId = insert.run('Other tag').lastInsertRowid
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, secondId)
  const links = snapshotTags(database).links
  const update = database.prepare('UPDATE tags SET name = ? WHERE id = ?')

  for (const name of ['fixture tag', ' FIXTURE TAG ', '\tFixture TAG\u00a0']) {
    assertRejected(database, () => update.run(name, secondId))
  }

  const displayName = ' FIXTURE TAG '
  assert.equal(update.run(displayName, tagId).changes, 1)
  assert.equal(database.prepare('SELECT name FROM tags WHERE id = ?').get(tagId).name, displayName)
  assertRejected(database, () => insert.run('fixture tag'))
  assert.equal(update.run('Renamed tag', secondId).changes, 1)
  assert.equal(insert.run(' OTHER TAG ').changes, 1)
  assert.equal(database.prepare('SELECT name FROM tags WHERE id = ?').get(secondId).name, 'Renamed tag')
  assert.equal(database.prepare('SELECT count(*) AS count FROM tags').get().count, 3)
  assert.deepEqual(snapshotTags(database).links, links)
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
})

test('tag keys preserve internal whitespace and distinct Unicode forms without changing display names', { timeout: 10000 }, t => {
  const { database } = setup(t)
  const insert = database.prepare('INSERT INTO tags (name) VALUES (?)')
  const cases = [
    [' Node JS ', 'node js'], ['Node  JS', 'node  js'],
    ['Éclair', 'éclair'], ['E\u0301clair', 'e\u0301clair'],
    ['Straße', 'straße'], ['STRASSE', 'strasse'],
    ['Node', 'node'], ['Ｎｏｄｅ', 'ｎｏｄｅ']
  ]
  const ids = []

  for (const [name, key] of cases) {
    const result = insert.run(name)
    assert.equal(result.changes, 1)
    ids.push(result.lastInsertRowid)
    assert.equal(normalizeTagName(name), key)
    const row = database.prepare('SELECT name, normalize_tag_name(name) AS key FROM tags WHERE id = ?')
      .get(result.lastInsertRowid)
    assert.deepEqual({ ...row }, { name, key })
  }

  assert.equal(new Set(ids).size, cases.length)
  assert.equal(database.prepare('SELECT count(*) AS count FROM tags').get().count, cases.length + 1)
})

test('normalized tag uniqueness applies across connections and after reopening', { timeout: 10000 }, t => {
  const { context, path, database, tagId, videoId } = setup(t)
  const accentedId = database.prepare('INSERT INTO tags (name) VALUES (?)').run('ÉCLAIR').lastInsertRowid
  database.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, accentedId)
  const before = snapshotTags(database)
  const second = context.open(path)
  assert.deepEqual(snapshotTags(second), before)
  assertRejected(second, () => second.prepare('INSERT INTO tags (name) VALUES (?)').run('\u00a0éCLAIR\t'))
  assertRejected(second, () => second.prepare('UPDATE tags SET name = ? WHERE id = ?')
    .run(' Éclair ', tagId))
  assert.deepEqual(snapshotTags(database), before)
  database.close()
  second.close()

  const reopened = context.open(path)
  assert.deepEqual(snapshotTags(reopened), before)
  assertRejected(reopened, () => reopened.prepare('INSERT INTO tags (name) VALUES (?)').run('\ufeffÉclair\u3000'))
  assert.equal(reopened.prepare('INSERT INTO tags (name) VALUES (?)').run('Different tag').changes, 1)
  assert.deepEqual(snapshotTags(reopened).links, before.links)
  assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
})
