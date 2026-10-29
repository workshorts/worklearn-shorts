import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';
import { readQuiz } from '../src/components/admin/videoFormUtils.js';

// videoApi.js의 getVideos·getVideo와 같은 주소(videos?page=…&limit=20, videos/{id})를 공통 요청 함수로 부른다.
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없다.
const getVideos = (page = 1) => adminRequest(`videos?page=${page}&limit=20`);
const getVideo = (id) => adminRequest(`videos/${id}`);

// 실제 서버와 임시 DB를 쓰고, 로그인 쿠키만 Node에서 모사한다. 브라우저 화면 검증을 대체하지 않는다.
test('FE 영상 목록·편집 정보 요청과 실제 관리자 영상 API 연동', async (t) => {
  const { request, login, getDb } = await startAuthServer(t);
  const db = getDb();
  const { cookie } = await login();
  const original = globalThis.fetch;
  let loggedIn = true;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options) => {
    const res = await request(path, {
      method: options.method, body: options.body,
      headers: { ...options.headers, Origin: 'http://localhost:5173' }, cookie: loggedIn ? cookie : '',
    });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };

  const tagId = Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run('엑셀').lastInsertRowid);
  const insertVideo = db.prepare('INSERT INTO videos (title, description, video_path, thumbnail_path) VALUES (?, ?, ?, ?)');
  const plain = Number(insertVideo.run('태그 없는 영상', '', `videos/${randomUUID()}.mp4`, null).lastInsertRowid);
  const withQuiz = Number(insertVideo.run('퀴즈 있는 영상', '설명', `videos/${randomUUID()}.webm`, `thumbnails/${randomUUID()}.png`).lastInsertRowid);
  db.prepare('INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(withQuiz, tagId);
  const quizId = Number(db.prepare('INSERT INTO quizzes (video_id, question) VALUES (?, ?)').run(withQuiz, '단축키는?').lastInsertRowid);
  const addOption = db.prepare('INSERT INTO quiz_options (quiz_id, content, sort_order, is_correct) VALUES (?, ?, ?, ?)');
  addOption.run(quizId, '보기 B', 2, 0);
  addOption.run(quizId, '보기 A', 1, 1);

  await t.test('목록 화면이 쓰는 필드가 응답에 있다', async () => {
    const result = await getVideos(1);
    assert.deepEqual([result.page, result.limit, result.total], [1, 20, 2]);
    assert.deepEqual(result.data.map((video) => video.id), [withQuiz, plain]);
    for (const video of result.data) {
      for (const key of ['id', 'title', 'tags', 'viewCount', 'likeCount', 'commentCount', 'hasQuiz', 'createdAt', 'thumbnailUrl']) {
        assert.ok(key in video, key);
      }
    }
    assert.deepEqual(result.data[0].tags, [{ id: tagId, name: '엑셀' }]);
    assert.equal(result.data[0].hasQuiz, true);
  });

  await t.test('편집 폼이 쓰는 필드가 있고 퀴즈가 폼 상태로 바뀐다', async () => {
    const video = await getVideo(withQuiz);
    assert.deepEqual(video.tagIds, [tagId]);
    assert.match(video.videoPath, /^videos\/.+\.webm$/);
    assert.equal(video.videoUrl, `/uploads/${video.videoPath}`);
    assert.match(video.thumbnailPath, /^thumbnails\/.+\.png$/);

    const form = readQuiz(video.quiz);
    assert.equal(form.enabled, true);
    assert.equal(form.question, '단축키는?');
    assert.deepEqual(form.options.map(({ content, isCorrect }) => [content, isCorrect]), [['보기 A', true], ['보기 B', false]]);
  });

  await t.test('퀴즈·썸네일이 없는 영상은 빈 퀴즈 폼과 null 경로가 된다', async () => {
    const video = await getVideo(plain);
    assert.equal(video.thumbnailPath, null);
    assert.deepEqual(video.tagIds, []);
    assert.equal(video.quiz, null);
    const form = readQuiz(video.quiz);
    assert.equal(form.enabled, false);
    assert.equal(form.options.length, 2);
  });

  await t.test('없는 영상과 미로그인은 오류 코드로 전달된다', async () => {
    await assert.rejects(getVideo(999999), (error) => error.status === 404 && error.code === 'NOT_FOUND');
    loggedIn = false;
    await assert.rejects(getVideos(1), (error) => error.code === 'AUTH_REQUIRED');
    await assert.rejects(getVideo(plain), (error) => error.code === 'AUTH_REQUIRED');
    loggedIn = true;
  });

  await t.test('videoApi.js가 같은 주소로 호출하는지 소스로 지킨다', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/api/videoApi.js', import.meta.url), 'utf8');
    assert.match(source, /adminRequest\(`videos\?page=\$\{page\}&limit=20`/);
    assert.match(source, /adminRequest\(`videos\/\$\{id\}`/);
  });
});
