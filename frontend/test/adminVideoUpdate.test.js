import assert from 'node:assert/strict';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';
import { readQuiz } from '../src/components/admin/videoFormUtils.js';

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// AdminVideoForm이 수정할 때 하는 일: 편집 정보를 불러와(getVideo) 폼에 채우고, 고친 값으로 PATCH(saveVideo)한다.
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없어, 같은 요청을 공통 요청 함수로 보낸다.
const getVideo = (id) => adminRequest(`videos/${id}`);
const saveVideo = (id, data) => adminRequest(`videos/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
function upload(kind, file) {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return adminRequest('uploads', { method: 'POST', body, timeoutMs: 120_000 });
}
// AdminVideoForm.jsx의 payload 구성(79~85번째 줄)과 같은 모양: 폼은 수정 때도 모든 필드를 보낸다.
function formPayload(form, quizState, { videoPath = form.videoPath, thumbnailPath = form.thumbnailPath } = {}) {
  const payload = {
    title: form.title.trim(), description: form.description, tagIds: form.tagIds, thumbnailPath: thumbnailPath || null,
    quiz: quizState.enabled
      ? { question: quizState.question.trim(), options: quizState.options.map((o) => ({ content: o.content.trim(), isCorrect: o.isCorrect })) }
      : null,
  };
  if (videoPath) payload.videoPath = videoPath;
  return payload;
}

test('FE 영상 수정 흐름(불러오기 → 고치기 → 저장)과 실제 서버 연동', async (t) => {
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
  const excel = Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run('엑셀').lastInsertRowid);
  const auto = Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run('업무자동화').lastInsertRowid);

  async function register(extra = {}) {
    const videoPath = (await upload('video', new File([MP4], 'a.mp4', { type: 'video/mp4' }))).path;
    return adminRequest('videos', { method: 'POST', body: JSON.stringify({ title: '원래 제목', videoPath, ...extra }) });
  }

  await t.test('폼이 모든 필드를 보내도, 값이 그대로면 아무것도 바뀌지 않는다(저장 버튼만 눌러도 안전)', async () => {
    const created = await register({
      description: '설명', tagIds: [excel],
      quiz: { question: '질문', options: [{ content: '가', isCorrect: true }, { content: '나', isCorrect: false }] },
    });
    await pause(15);
    const form = await getVideo(created.id);
    const saved = await saveVideo(created.id, formPayload(form, readQuiz(form.quiz)));
    assert.deepEqual(saved, created, 'updatedAt, 퀴즈 번호까지 그대로');
  });

  await t.test('제목·태그·퀴즈를 고쳐 저장하면 편집 정보와 목록에 바로 반영된다', async () => {
    const created = await register({ tagIds: [excel] });
    const form = await getVideo(created.id);
    const quiz = readQuiz(form.quiz); // 퀴즈가 없으면 비활성 폼 상태
    assert.equal(quiz.enabled, false);

    form.title = '  고친 제목  ';
    form.tagIds = [auto];
    quiz.enabled = true;
    quiz.question = '새 질문';
    quiz.options = [{ content: '가', isCorrect: false }, { content: '나', isCorrect: true }];
    const saved = await saveVideo(created.id, formPayload(form, quiz));
    assert.equal(saved.title, '고친 제목');
    assert.deepEqual(saved.tagIds, [auto]);
    assert.equal(saved.hasQuiz, true);
    assert.deepEqual(readQuiz(saved.quiz).options.map(({ content, isCorrect }) => [content, isCorrect]), [['가', false], ['나', true]]);

    const list = await adminRequest('videos?page=1&limit=20');
    assert.equal(list.data.find((video) => video.id === created.id).title, '고친 제목');
  });

  await t.test('퀴즈를 끄면(null) 삭제되고, 썸네일을 지우면 기본 이미지로 돌아간다', async () => {
    const thumbnailPath = (await upload('thumbnail', new File([PNG], 'c.png', { type: 'image/png' }))).path;
    const created = await register({ thumbnailPath, quiz: { question: '질문', options: [{ content: '가', isCorrect: true }, { content: '나', isCorrect: false }] } });
    const form = await getVideo(created.id);
    const quiz = readQuiz(form.quiz);
    quiz.enabled = false; // 폼에서 퀴즈 사용을 끈 경우
    const thumbnailRemoved = true; // 폼의 '썸네일 삭제' 버튼
    const saved = await saveVideo(created.id, formPayload(form, quiz, { thumbnailPath: thumbnailRemoved ? null : form.thumbnailPath }));
    assert.equal(saved.quiz, null);
    assert.equal(saved.hasQuiz, false);
    assert.equal(saved.thumbnailPath, null);
    assert.equal(saved.thumbnailUrl, '/images/default-thumbnail.svg');
  });

  await t.test('새 영상·썸네일 파일을 올려 교체하면 새 경로가 저장된다(폼의 업로드 → 저장 순서)', async () => {
    const created = await register();
    const form = await getVideo(created.id);
    const videoPath = (await upload('video', new File([MP4], 'new.mp4', { type: 'video/mp4' }))).path;
    const thumbnailPath = (await upload('thumbnail', new File([PNG], 'new.png', { type: 'image/png' }))).path;
    const saved = await saveVideo(created.id, formPayload(form, readQuiz(form.quiz), { videoPath, thumbnailPath }));
    assert.equal(saved.videoPath, videoPath);
    assert.equal(saved.thumbnailPath, thumbnailPath);
    assert.equal(saved.videoUrl, `/uploads/${videoPath}`);
  });

  await t.test('서버 오류가 폼의 칸 이름으로 이어진다(없는 영상, 다른 영상의 파일)', async () => {
    const first = await register();
    const second = await register();
    await assert.rejects(saveVideo(999999, { title: '제목입니다' }), (error) => error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(saveVideo(second.id, { videoPath: first.videoPath }), (error) =>
      error.status === 409 && error.code === 'FILE_ALREADY_USED' && Object.keys(error.fields)[0] === 'videoPath');
    await assert.rejects(saveVideo(second.id, { title: 'a', quiz: { question: '', options: [] } }), (error) =>
      error.status === 400 && !!error.fields.title && Object.keys(error.fields).some((key) => key.startsWith('quiz')));
  });
});
