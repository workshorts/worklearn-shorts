// Match the name ordering used by the shared Video loader, without limiting the available tags.
export function loadTagList(database) {
  return database.prepare('SELECT id, name FROM tags ORDER BY name, id').all()
}
