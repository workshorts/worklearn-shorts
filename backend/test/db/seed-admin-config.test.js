import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { readSeedAdminCredentials } from '../../src/config/seed-admin.js'
import { createDatabaseContext } from '../helpers/database-context.js'

const valid = { ADMIN_USERNAME: 'seed-admin', ADMIN_PASSWORD: 'test-only-password' }

function assertInvalid(environment, expectedFields) {
  assert.throws(() => readSeedAdminCredentials(environment), error => {
    assert.equal(error.code, 'INVALID_SEED_ADMIN_CONFIG')
    assert.deepEqual(Object.keys(error.fields).sort(), [...expectedFields].sort())
    assert.ok(Object.values(error.fields).every(value => typeof value === 'string'))
    return true
  })
}

test('seed administrator settings accept both minimum and maximum credential lengths', () => {
  for (const [username, password] of [['a', 'p'.repeat(8)], ['u'.repeat(50), 'p'.repeat(128)]]) {
    assert.deepEqual(readSeedAdminCredentials({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password }), {
      username, password
    })
  }
})

test('seed administrator settings preserve whitespace, case and Unicode representation exactly', () => {
  const username = ' Mixed Admin '
  const password = ' e\u0301 Test Password '
  const environment = Object.freeze({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password })

  assert.deepEqual(readSeedAdminCredentials(environment), { username, password })
  assert.notEqual(password, password.trim())
  assert.notEqual(password, password.normalize('NFC'))
  assert.equal(environment.ADMIN_USERNAME, username)
  assert.equal(environment.ADMIN_PASSWORD, password)
})

test('seed administrator settings report all missing fields without default credentials', () => {
  assertInvalid({}, ['ADMIN_USERNAME', 'ADMIN_PASSWORD'])
})

test('seed administrator settings reject non-string usernames without coercion', () => {
  for (const value of [undefined, null, 1, false, {}, [], new String('admin')]) {
    assertInvalid({ ...valid, ADMIN_USERNAME: value }, ['ADMIN_USERNAME'])
  }
})

test('seed administrator settings reject non-string passwords without coercion', () => {
  for (const value of [undefined, null, 12345678, false, {}, [], new String('password')]) {
    assertInvalid({ ...valid, ADMIN_PASSWORD: value }, ['ADMIN_PASSWORD'])
  }
})

test('seed administrator settings reject empty and overlong usernames', () => {
  for (const value of ['', 'u'.repeat(51)]) {
    assertInvalid({ ...valid, ADMIN_USERNAME: value }, ['ADMIN_USERNAME'])
  }
})

test('seed administrator settings reject empty, short and overlong passwords', () => {
  for (const value of ['', 'p'.repeat(7), 'p'.repeat(129)]) {
    assertInvalid({ ...valid, ADMIN_PASSWORD: value }, ['ADMIN_PASSWORD'])
  }
})

test('seed administrator settings reject null characters instead of storing truncated environment values', () => {
  assertInvalid({ ...valid, ADMIN_USERNAME: '\0admin' }, ['ADMIN_USERNAME'])
  assertInvalid({ ...valid, ADMIN_PASSWORD: 'password\0value' }, ['ADMIN_PASSWORD'])
})

test('seed administrator settings return current values without mutating or retaining an input snapshot', () => {
  const environment = { ...valid }
  const first = readSeedAdminCredentials(environment)
  environment.ADMIN_USERNAME = 'second-admin'
  environment.ADMIN_PASSWORD = 'second-test-password'
  const second = readSeedAdminCredentials(environment)

  assert.deepEqual(first, { username: valid.ADMIN_USERNAME, password: valid.ADMIN_PASSWORD })
  assert.deepEqual(second, { username: 'second-admin', password: 'second-test-password' })
  assert.equal(environment.ADMIN_USERNAME, 'second-admin')
  assert.equal(environment.ADMIN_PASSWORD, 'second-test-password')
})

test('seed administrator settings read process.env at call time when no object is supplied', t => {
  const previous = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }
  t.after(() => {
    for (const [key, value] of [['ADMIN_USERNAME', previous.username], ['ADMIN_PASSWORD', previous.password]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.ADMIN_USERNAME = valid.ADMIN_USERNAME
  process.env.ADMIN_PASSWORD = valid.ADMIN_PASSWORD
  assert.deepEqual(readSeedAdminCredentials(), { username: valid.ADMIN_USERNAME, password: valid.ADMIN_PASSWORD })

  delete process.env.ADMIN_PASSWORD
  assertInvalid(process.env, ['ADMIN_PASSWORD'])
})

test('seed administrator settings reject invalid environment containers with a fixed error', () => {
  for (const value of [null, 'secret-container-value', 7, true, [], () => {}]) {
    assert.throws(() => readSeedAdminCredentials(value), {
      name: 'TypeError', message: 'Seed administrator configuration requires an environment object.'
    })
  }
})

test('seed administrator configuration errors expose no supplied credentials in messages or serialization', () => {
  const username = 'private-username-sentinel-'.repeat(3)
  const password = 'private-password-sentinel-'.repeat(6)

  assert.throws(() => readSeedAdminCredentials({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password }), error => {
    for (const output of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
      assert.equal(output.includes(username), false)
      assert.equal(output.includes(password), false)
      assert.equal(output.includes('private-username-sentinel'), false)
      assert.equal(output.includes('private-password-sentinel'), false)
    }
    assert.deepEqual(Object.keys(error).sort(), ['code', 'fields'])
    return true
  })
})

test('seed settings reuse backend .env from another cwd and preserve process environment precedence', { timeout: 15000 }, t => {
  const context = createDatabaseContext(t)
  const directory = context.path('backend', 'src', 'config')
  mkdirSync(directory, { recursive: true })
  for (const file of ['env.js', 'seed-admin.js']) {
    copyFileSync(new URL(`../../src/config/${file}`, import.meta.url), join(directory, file))
  }
  writeFileSync(context.path('backend', '.env'), 'ADMIN_USERNAME=file-admin\nADMIN_PASSWORD=file-test-password\n')
  const moduleUrl = pathToFileURL(join(directory, 'seed-admin.js')).href
  const environment = { ...process.env, ADMIN_USERNAME: 'process-admin' }
  delete environment.ADMIN_PASSWORD
  delete environment.NODE_TEST_CONTEXT
  const program = `
    import assert from 'node:assert/strict';
    const { readSeedAdminCredentials } = await import(${JSON.stringify(moduleUrl)});
    const credentials = readSeedAdminCredentials();
    assert.equal(credentials.username === 'process-admin', true);
    assert.equal(credentials.password === 'file-test-password', true);
    console.log('Configuration verified without printing credentials.');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: context.directory, env: environment, encoding: 'utf8', timeout: 10000, windowsHide: true
  })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.equal(result.stdout.trim(), 'Configuration verified without printing credentials.')
  for (const secret of ['process-admin', 'file-admin', 'file-test-password']) {
    assert.equal(result.stdout.includes(secret), false)
    assert.equal(result.stderr.includes(secret), false)
  }
})
