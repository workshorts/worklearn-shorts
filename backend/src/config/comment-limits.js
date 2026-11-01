import './env.js'

// Keep windows within Node's signed 32-bit timer range, expressed as whole seconds.
const maximumWindowSeconds = Math.floor(2147483647 / 1000)

export function readCommentLimitConfig(environment = process.env) {
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('Comment limit configuration requires an environment object.')
  }

  function positiveInteger(name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const value = environment[name]
    if (value === undefined) return fallback
    if (typeof value === 'string' && value !== '' && !/[^0-9]/.test(value)) {
      const number = Number(value)
      if (Number.isSafeInteger(number) && number >= 1 && number <= maximum) return number
    }
    // Report only the setting name and fixed rule, never its supplied value.
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`)
  }

  // Separate buckets prevent comment creation and password attempts from sharing a quota.
  return Object.freeze({
    create: Object.freeze({
      max: positiveInteger('COMMENT_CREATE_MAX', 5),
      windowMs: positiveInteger('COMMENT_CREATE_WINDOW_SECONDS', 60, maximumWindowSeconds) * 1000,
    }),
    delete: Object.freeze({
      max: positiveInteger('COMMENT_DELETE_MAX', 10),
      windowMs: positiveInteger('COMMENT_DELETE_WINDOW_SECONDS', 900, maximumWindowSeconds) * 1000,
    }),
  })
}
