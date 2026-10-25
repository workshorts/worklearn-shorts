-- Apply this schema only to a newly created database.
CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    username TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 50),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 100),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    video_path TEXT NOT NULL,
    thumbnail_path TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30)
);

-- The shared DB connection registers normalize_tag_name before schema use.
CREATE UNIQUE INDEX idx_tags_name_normalized ON tags (normalize_tag_name(name));

CREATE TABLE courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 50),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE course_videos (
    course_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 1),
    PRIMARY KEY (course_id, video_id),
    UNIQUE (course_id, sort_order),
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE video_tags (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, tag_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE video_views (
    video_id INTEGER NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (video_id, visitor_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE video_likes (
    video_id INTEGER NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (video_id, visitor_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    video_id INTEGER NOT NULL,
    nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 20),
    password_hash TEXT NOT NULL,
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    video_id INTEGER NOT NULL UNIQUE,
    question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE quiz_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    quiz_id INTEGER NOT NULL,
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100),
    sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order BETWEEN 1 AND 5),
    is_correct INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)),
    UNIQUE (quiz_id, sort_order),
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_quiz_options_one_correct
    ON quiz_options (quiz_id) WHERE is_correct = 1;
