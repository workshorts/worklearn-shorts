import { closeDatabase, openExistingDatabase } from './connection.js'

// API 코드가 함께 쓰는 DB 연결 하나. 처음 쓸 때 열고, 닫혀 있으면 다시 연다.
let database = null

export function getDb() {
  if (!database || !database.isOpen) {
    database = openExistingDatabase()
  }
  return database
}

export function closeDb() {
  if (database) closeDatabase(database)
  database = null
}
