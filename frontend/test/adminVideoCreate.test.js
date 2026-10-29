import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';
import { readQuiz } from '../src/components/admin/videoFormUtils.js';

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

// AdminVideoForm이 하는 일과 같은 순서: 파일 업로드 → 그 경로로 영상 등록(POST /api/admin/videos).
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없어, 같은 요청을 공통 요청 함수로 보낸다.
function upload(kind, file) {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return adminRequest('uploads', { method: 'POST', body, timeoutMs: 120_000 });
}
const saveNewVideo = (data) => adminRequest('videos', { method: 'POST', body: JSON.stringify(data) });

// AdminVideoForm.jsx가 서버 오류의 키를 화면 칸으로 옮기는 규칙(95번째 줄 근처)과 같다.
const toFormField = (key) => key === 'videoPath' ? 'video' : key === 'thumbnailPath' ? 'thumbnail' : key.startsWith('quiz') ? 'quiz' : key;
const FORM_FIELDS = ['title', 'description', 'video', 'thumbnail', 'tagIds', 'quiz'];

test('FE 영상 등록 흐름(업로드 → 등록)과 실제 서버 연동', async (t) => {
  const { request, login, getDb } = await startAuthServer(t, { uploads: true });
  const { cookie } = await login();
  const db = getDb();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options) => {
    let body = options.body;
    const headers = { ...options.headers, Origin: 'http://localhost:5173' };
    if (body instanceof FormData) {
      const encoded = new Response(body); // 브라우저와 같은 방식의 멀티파트
      headers['Content-Type'] = encoded.headers.get('content-type');
      body = Buffer.from(await encoded.arrayBuffer());
    }
    const res = await request(path, { method: options.method, body, headers, cookie });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };
  const tagId = Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run('엑셀').lastInsertRowid);

  await t.test('폼이 만드는 payload 그대로 등록하면 AdminVideo를 받고 퀴즈가 폼 상태로 바뀐다', async () => {
    const videoPath = (await upload('video', new File([MP4], 'lesson.mp4', { type: 'video/mp4' }))).path;
    const thumbnailPath = (await upload('thumbnail', new File([PNG], 'cover.png', { type: 'image/png' }))).path;
    // AdminVideoForm.jsx의 payload 구성(79~85번째 줄)과 같은 모양
    const payload = {
      title: '  엑셀 단축키  '.trim(), description: '빠른 채우기', tagIds: [tagId], thumbnailPath: thumbnailPath || null,
      quiz: { question: ' 빠른 채우기 단축키는? '.trim(), options: [{ content: 'Ctrl + E', isCorrect: true }, { content: 'Ctrl + R', isCorrect: false }] },
    };
    if (videoPath) payload.videoPath = videoPath;

    const created = await saveNewVideo(payload);
    assert.equal(created.title, '엑셀 단축키');
    assert.deepEqual(created.tagIds, [tagId]);
    assert.equal(created.videoPath, videoPath);
    assert.equal(created.thumbnailPath, thumbnailPath);
    assert.equal(created.hasQuiz, true);

    const form = readQuiz(created.quiz);
    assert.equal(form.enabled, true);
    assert.deepEqual(form.options.map(({ content, isCorrect }) => [content, isCorrect]), [['Ctrl + E', true], ['Ctrl + R', false]]);

    // 목록 화면이 바로 새 영상을 보여 준다
    const list = await adminRequest('videos?page=1&limit=20');
    assert.equal(list.data[0].id, created.id);
  });

  await t.test('썸네일·퀴즈 없이 영상만 올려도 등록된다(thumbnailPath: null, quiz: null)', async () => {
    const videoPath = (await upload('video', new File([MP4], 'a.mp4', { type: 'video/mp4' }))).path;
    const created = await saveNewVideo({ title: '단순 영상', description: '', tagIds: [], thumbnailPath: null, quiz: null, videoPath });
    assert.equal(created.thumbnailPath, null);
    assert.equal(created.quiz, null);
  });

  await t.test('서버가 돌려주는 오류 키는 모두 폼의 화면 칸으로 이어진다', async () => {
    const videoPath = (await upload('video', new File([MP4], 'b.mp4', { type: 'video/mp4' }))).path;
    const bad = {
      title: 'a', description: 'x'.repeat(501), videoPath: 'videos/not-valid.mp4', thumbnailPath: 'videos/not-valid.mp4', tagIds: [1, 1],
      quiz: { question: '', options: [{ content: '하나', isCorrect: true }] },
    };
    await assert.rejects(saveNewVideo(bad), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      const fields = Object.keys(error.fields).map(toFormField);
      assert.deepEqual([...new Set(fields)].sort(), [...FORM_FIELDS].sort(), '여섯 칸 모두에 오류가 표시된다');
      return true;
    });
    // 이미 등록된 파일을 다시 쓰면 영상 파일 칸에 안내가 표시된다
    await saveNewVideo({ title: '첫 영상', videoPath });
    await assert.rejects(saveNewVideo({ title: '둘째 영상', videoPath }), (error) =>
      error.status === 409 && error.code === 'FILE_ALREADY_USED' && toFormField(Object.keys(error.fields)[0]) === 'video');
  });

  await t.test('videoApi.js의 saveVideo가 새 영상은 POST videos로 보내는지 소스로 지킨다', () => {
    const source = readFileSync(new URL('../src/api/videoApi.js', import.meta.url), 'utf8');
    assert.match(source, /adminRequest\(id \? `videos\/\$\{id\}` : 'videos', \{ method: id \? 'PATCH' : 'POST'/);
    const form = readFileSync(new URL('../src/pages/admin/AdminVideoForm.jsx', import.meta.url), 'utf8');
    assert.match(form, /key === 'videoPath' \? 'video' : key === 'thumbnailPath' \? 'thumbnail' : key\.startsWith\('quiz'\) \? 'quiz' : key/);
  });
});
