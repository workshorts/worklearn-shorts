## 폴더 구조

```text
frontend/
├── src/
│   ├── api/adminApi.js              # 관리자 공통 API 요청
│   ├── pages/admin/AdminLogin.jsx  # 로그인 폼 및 세션 확인
│   ├── pages/admin/login.css       # 로그인 스타일
│   ├── App.jsx                     # 화면 경로 연결
│   ├── main.jsx                    # 기존 React 진입점
│   └── index.css                   # 공통 기본 스타일
├── vite.config.js                 # 기존 /api 프록시 유지
├── package.json                   # 기존 의존성 유지
└── package-lock.json              # 기존 잠금 파일 유지
```

## 실행

터미널에서 아래 명령을 실행합니다. 절대 경로를 사용하므로 현재 어느 폴더에 있어도 됩니다.

```sh
cd 상위 폴더
npm ci
npm run dev
```

터미널에 `Local: http://localhost:5173/`가 표시되면 브라우저에서 아래 주소를 엽니다.

로그인 화면: http://localhost:5173/admin/login

**화면을 사용하는 동안 `npm run dev`를 실행한 터미널을 켜 두세요.** `Ctrl+C`를 누르거나 터미널을 닫으면 개발 서버가 종료되어 주소에 접속할 수 없습니다. 이 주소는 현재 컴퓨터에서 서버를 실행하는 동안 사용하는 로컬 주소이며, 배포된 사이트 주소가 아닙니다. `https://`가 아닌 `http://`로 접속하세요.

### 주소에 접속되지 않을 때

1. 터미널에서 개발 서버가 실행 중인지 확인합니다. 서버가 종료됐다면 위의 `cd`와 `npm run dev`를 다시 실행합니다.
2. `Local:`에 출력된 주소를 사용하고 뒤에 `/admin/login`을 붙입니다. 현재 환경에서는 `localhost`로 연결되며 `127.0.0.1`로 바꾸면 연결되지 않을 수 있습니다.
3. `Port 5173 is already in use`가 나오면 기존 개발 서버의 주소로 접속하거나, 기존 서버를 실행한 터미널에서 종료한 뒤 다시 실행합니다. 현재 설정은 다른 포트로 자동 변경하지 않습니다.
4. 로그인 화면이 보이면서 서버 연결 오류 안내가 나오면 FE 접속은 성공한 것입니다. 이는 `/api/admin/me`를 처리할 백엔드가 아직 준비되지 않은 상태입니다.

### 빌드 확인

개발 서버를 유지하면서 빌드하려면 별도 터미널을 사용합니다.

```sh
cd /Users/suin/internship/worklearn-shorts/frontend
npm run build
```

`npm run build`는 배포 파일만 생성하며 서버를 실행하지 않습니다. 빌드 결과를 확인하려면 `npm run preview`를 실행하고 그 명령이 출력한 주소에 `/admin/login`을 붙입니다.

현재 Vite 설정은 `/api`를 `http://localhost:3000`으로 전달합니다. 서버 주소 변경이 필요하면 기존 `vite.config.js`의 proxy를 수정합니다. 별도 `.env`는 현재 필요하지 않습니다.

## 현재 구현 범위

- 아이디·비밀번호 입력, 비밀번호 보기/숨기기, 입력 검증
- 로그인 버튼 글자 가운데 정렬 및 오른쪽 화살표 고정
- 로그인 상태 확인, 중복 제출 방지, 요청 지연·오류 안내
- 쿠키 기반 `GET /api/admin/me`, `POST /api/admin/login`
- 로그인 성공 후 `/admin/videos`로 이동

`/admin/videos`와 사용자 홈은 준비 안내만 표시하는 임시 화면입니다. 영상 관리 구현 시 서버 세션을 확인하는 보호 라우트와 로그아웃을 함께 추가해야 합니다. 라우팅 라이브러리는 아직 추가하지 않았습니다. 공통 라우터 도입 시 App의 경로 분기를 교체합니다.

## 백엔드 협업

현재 `backend/src/server.js`에는 인증 API가 아직 없습니다. 따라서 화면은 실행되지만 실제 인증 성공 검증은 백엔드 구현 후 가능합니다.

로그인 요청은 `{ username, password }`이며 모든 요청에 `credentials: 'include'`를 적용합니다. 서버에서 HttpOnly 쿠키를 설정해야 합니다. 운영에서는 Secure와 Origin 검증을 적용합니다. 성공 응답은 JSON 2xx 또는 204, 오류는 `{ code, message, fields }`를 사용합니다. `fields`는 `{ username?: string, password?: string }`을 가정하므로 백엔드와 합의가 필요합니다. 비밀번호·토큰은 localStorage에 보관하지 않습니다.

로그인 CSS 기본 규칙은 `.login-page` 안으로 제한했습니다. 공통 `index.css`에는 body 여백 초기화만 추가했습니다.

## 배포

실제 Render 주소가 확정된 후 Netlify Base를 `frontend`, Build를 `npm run build`, Publish를 `dist`로 설정합니다. `/api/*` → Render 프록시를 `/*` → `/index.html` 규칙보다 먼저 적용해야 합니다. 운영 주소가 없어 배포 파일은 추가하지 않았습니다.