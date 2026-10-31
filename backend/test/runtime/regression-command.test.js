import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDatabaseContext } from '../helpers/database-context.js'

const backend = fileURLToPath(new URL('../../', import.meta.url))
const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(path => path && existsSync(path))
const command = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8')).scripts['test:regression']

for (const [backendExit, frontendExit] of [[0, 0], [7, 0], [0, 9]]) {
  test(`regression command runs both package tests and reports exits ${backendExit}/${frontendExit}`, t => {
    assert.ok(npm, 'The npm CLI must be available.')
    const context = createDatabaseContext(t)
    const events = context.path('events.jsonl')
    for (const [name, exit] of [['backend', backendExit], ['frontend', frontendExit]]) {
      const directory = context.path(name)
      mkdirSync(directory)
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module',
        scripts: { test: 'node fixture.js', ...(name === 'backend' ? { 'test:regression': command } : {}) } }))
      // Independent package processes record their working directory and completion order.
      writeFileSync(join(directory, 'fixture.js'), `
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(events)}, JSON.stringify({ name: ${JSON.stringify(name)}, cwd: process.cwd(), phase: 'start' }) + '\\n')
await new Promise(resolve => setTimeout(resolve, 40))
appendFileSync(${JSON.stringify(events)}, JSON.stringify({ name: ${JSON.stringify(name)}, phase: 'end' }) + '\\n')
console.log(${JSON.stringify(name + ' fixture output')})
process.exitCode = ${exit}
`)
    }
    mkdirSync(context.path('backend', 'scripts'))
    copyFileSync(join(backend, 'scripts/test-regression.js'), context.path('backend', 'scripts', 'test-regression.js'))
    // Invoke the real npm entry point from an unrelated directory, including paths with spaces.
    const unrelated = context.path('unrelated working directory')
    mkdirSync(unrelated)
    const result = spawnSync(process.execPath, [npm, '--prefix', context.path('backend'), 'run', 'test:regression'], {
      cwd: unrelated, encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.status, backendExit === 0 && frontendExit === 0 ? 0 : 1, result.stdout + result.stderr)
    assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
      { name: 'backend', cwd: context.path('backend'), phase: 'start' },
      { name: 'backend', phase: 'end' },
      { name: 'frontend', cwd: context.path('frontend'), phase: 'start' },
      { name: 'frontend', phase: 'end' },
    ])
    for (const [name, exit] of [['backend', backendExit], ['frontend', frontendExit]]) {
      assert.ok(result.stdout.includes(name + ' fixture output'))
      assert.ok(result.stdout.includes(name + ': ' + (exit === 0 ? 'PASS' : 'FAIL')))
    }
  })
}

test('direct invocation without the npm entry point fails with an actionable message', () => {
  const env = { ...process.env }
  delete env.npm_execpath
  const result = spawnSync(process.execPath, [join(backend, 'scripts/test-regression.js')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 5000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('npm run test:regression'))
  assert.equal(result.stdout, '')
})
