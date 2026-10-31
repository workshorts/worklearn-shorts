import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const npm = process.env.npm_execpath

if (!npm) {
  console.error('Run this command with npm run test:regression in backend.')
  process.exitCode = 1
} else {
  const results = []
  // Run sequentially because existing CLI tests temporarily replace backend/.env.
  for (const name of ['backend', 'frontend']) {
    console.log(`\nRegression: ${name} npm test`)
    const result = spawnSync(process.execPath, [npm, 'test'], {
      cwd: fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
      stdio: 'inherit',
      windowsHide: true,
    })
    const passed = !result.error && result.signal === null && result.status === 0
    results.push({ name, passed })
    if (result.error) console.error(`${name}: test process could not start.`)
    else if (result.signal) console.error(`${name}: test process ended with ${result.signal}.`)
  }

  console.log('\nRegression summary:')
  for (const { name, passed } of results) console.log(`${name}: ${passed ? 'PASS' : 'FAIL'}`)
  process.exitCode = results.every(result => result.passed) ? 0 : 1
}
