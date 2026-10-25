import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const databasePath = process.env.DB_PATH
const gatePath = process.env.TEST_DB_INITIALIZATION_GATE
const barrier = process.env.TEST_DB_INITIALIZATION_BARRIER

function waitForRelease() {
  fs.writeSync(1, 'INITIALIZATION_READY\n')
  const deadline = Date.now() + 15000
  const pause = new Int32Array(new SharedArrayBuffer(4))

  while (!fs.existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error('Initialization barrier release timed out.')
    }

    // Poll an explicit release signal; elapsed time never triggers initialization.
    Atomics.wait(pause, 0, 0, 10)
  }
}

const originalOpen = fs.openSync
fs.openSync = function(path, flags, ...args) {
  if (path === databasePath && flags === 'wx') {
    if (barrier === 'claim') {
      waitForRelease()
    }

    const descriptor = originalOpen.call(this, path, flags, ...args)
    const identity = fs.fstatSync(descriptor, { bigint: true })
    fs.writeSync(1, 'CREATED_FILE=' + JSON.stringify({
      dev: identity.dev.toString(), ino: identity.ino.toString()
    }) + '\n')
    return descriptor
  }

  return originalOpen.call(this, path, flags, ...args)
}
syncBuiltinESMExports()

if (barrier === 'start') {
  waitForRelease()
}

await import('../../db/init.js')
