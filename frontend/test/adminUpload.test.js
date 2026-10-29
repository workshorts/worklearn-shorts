import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startAuthServer } from '../../backend/test/helpers/auth-server.js';
import { adminRequest } from '../src/api/adminApi.js';

// 시험용 최소 파일: 형식을 알아볼 수 있는 시그니처만 담았다(재생 가능한 영상이 아니다).
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

// videoApi.js의 uploadFile과 같은 요청(FormData: kind → file, 120초 제한)을 공통 요청 함수로 보낸다.
// videoApi.js는 Vite 전용 환경값을 읽어서 Node에서 직접 불러올 수 없다.
function uploadFile(kind, file) {
  const body = new FormData();
  body.append('kind', kind);
  body.append('file', file);
  return adminRequest('uploads', { method: 'POST', body, timeoutMs: 120_000 });
}

// 실제 서버와 임시 업로드 폴더를 쓰고, FormData를 브라우저처럼 멀티파트로 직렬화해서 보낸다.
test('FE 업로드 함수와 실제 업로드 API 연동', async (t) => {
  const { request, login, uploadDir } = await startAuthServer(t, { uploads: true });
  const { cookie } = await login();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, 'include');
    let body = options.body;
    const headers = { ...options.headers, Origin: 'http://localhost:5173' };
    if (body instanceof FormData) {
      const encoded = new Response(body); // 브라우저가 하는 것과 같은 방식으로 멀티파트로 만든다
      headers['Content-Type'] = encoded.headers.get('content-type');
      body = Buffer.from(await encoded.arrayBuffer());
    }
    const res = await request(path, { method: options.method, body, headers, cookie });
    return new Response(res.status === 204 ? null : res.text, { status: res.status, headers: res.headers });
  };

  await t.test('영상과 썸네일을 올리면 서버가 만든 경로를 받는다', async () => {
    const video = await uploadFile('video', new File([MP4], 'lesson.mp4', { type: 'video/mp4' }));
    assert.match(video.path, /^videos\/[0-9a-f-]{36}\.mp4$/);
    assert.equal(video.url, `/uploads/${video.path}`);
    assert.deepEqual(readFileSync(join(uploadDir, video.path)), MP4);

    const thumbnail = await uploadFile('thumbnail', new File([PNG], 'cover.png', { type: 'image/png' }));
    assert.match(thumbnail.path, /^thumbnails\/[0-9a-f-]{36}\.png$/);
  });

  await t.test('형식이 틀린 파일은 415 오류 코드로 전달된다', async () => {
    await assert.rejects(
      uploadFile('video', new File(['영상이 아닙니다'], 'fake.mp4', { type: 'video/mp4' })),
      (error) => error.status === 415 && error.code === 'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  await t.test('kind가 잘못되면 필드 오류로 전달된다', async () => {
    await assert.rejects(
      uploadFile('audio', new File([MP4], 'a.mp4', { type: 'video/mp4' })),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR' && !!error.fields.kind,
    );
  });
});

// 서버는 kind가 file보다 먼저 와야 받는다. 화면 코드가 순서를 바꾸면 이 시험이 알려 준다.
test('videoApi.js의 uploadFile이 kind를 file보다 먼저 보낸다', () => {
  const source = readFileSync(new URL('../src/api/videoApi.js', import.meta.url), 'utf8');
  const kindAt = source.indexOf("body.append('kind'");
  const fileAt = source.indexOf("body.append('file'");
  assert.ok(kindAt !== -1 && fileAt !== -1 && kindAt < fileAt);
  assert.match(source, /adminRequest\('uploads', \{ method: 'POST', body/);
});
