try {
  if (process.argv.length > 2) {
    throw new TypeError('db:init does not accept arguments. Configure the target with DB_PATH.')
  }

  // Load inside the error boundary so configuration failures also exit cleanly.
  const { initializeDatabase } = await import('../src/db/initialization.js')
  initializeDatabase()
  console.log('Database initialized successfully.')
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.error('Database initialization refused: a target path or SQLite sidecar already exists.')
  } else {
    console.error('Database initialization failed:', error)
  }

  process.exitCode = 1
}
