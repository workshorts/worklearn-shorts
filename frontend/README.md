## 구조

```text
src/
├── api/
│   ├── adminApi.js          # 공통 요청, 인증, 오류 코드
│   ├── videoApi.js          # 영상·파일 업로드·태그
│   ├── courseApi.js         # 학습과정
│   └── mockVideoApi.js      # 개발용 미리보기
├── components/admin/       # 보호 라우트, 레이아웃, 폼·모달
├── pages/admin/            # 로그인, 영상 목록·편집, 학습과정
├── App.jsx                 # 기존 History API 라우팅
├── main.jsx
└── index.css
test/adminAuth.test.js       # 실제 인증 서버와 FE 요청 함수 테스트
```

## 관리자 프론트엔드

React·Vite 기반 관리자 화면입니다. 기존 팀원 구현 위에 인증 API v2에 맞춘 입력 검증·세션 확인·오류 안내를 보완했습니다.

## 로컬 실행

저장소 루트에서 터미널을 두 개 사용합니다. Node.js 22.20 이상이 필요합니다.

### 백엔드

```sh
cd backend
# 최초 설정 시에만 복사하며, 기존 .env는 덮어쓰지 않습니다.
cp .env.example .env
# .env에 AUTH_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD 설정
npm ci
npm run db:init
npm run admin:create
npm run dev
```

DB 초기화·관리자 생성은 최초 설정 시 진행합니다. 이미 DB가 있으면 다시 초기화하지 않습니다. 비밀값과 DB는 Git에 올리지 않습니다. 이후에는 `backend`에서 `npm run dev`로 시작합니다.

### 프론트엔드

다른 터미널에서 저장소 루트로 이동한 후:

```sh
cd frontend
npm ci
npm run dev
```

로그인: http://localhost:5173/admin/login

`Local: http://localhost:5173/`가 표시된 상태로 터미널을 켜 두어야 합니다. `npm run build`만으로 서버가 시작되지는 않습니다. Origin 검증 때문에 `127.0.0.1`이나 다른 포트 대신 `http://localhost:5173`을 사용합니다. `/api`, `/uploads`는 Vite를 통해 `localhost:3000`으로 전달됩니다.

## 백엔드 없는 화면 미리보기

`frontend/.env`에 다음을 추가하고 Vite를 재시작합니다.

```dotenv
VITE_ADMIN_PREVIEW=true
```

로그인 화면의 관리자 화면 미리보기 링크 또는 `/admin/videos`, `/admin/courses`로 접속합니다. 로그인 폼은 실제 인증 API를 사용하며, 미리보기 링크는 가짜 계정을 만들지 않습니다. 미리보기 데이터는 실제 DB에 저장되지 않습니다. 프로덕션 빌드에서는 미리보기 인증 우회가 비활성화됩니다.

실제 인증을 테스트할 때는 값을 `false`로 변경하거나 제거한 뒤 Vite를 재시작합니다.

## 현재 구현과 남은 연동

| 기능 | FE 상태 | 현재 로컬 백엔드 상태 |
| --- | --- | --- |
| 로그인·세션 확인·로그아웃 | 구현 및 API 함수 통합 테스트 완료 | 구현 |
| 관리자 진입 보호 | 구현 | `/api/admin/me` 사용 |
| 영상 목록·등록·수정·삭제 | 화면 및 요청 함수 구현 | API 미구현 |
| 파일 업로드·태그 관리 | 화면 및 요청 함수 구현 | API 미구현 |
| 퀴즈 편집 | 영상 폼에 구현 | 영상 API 연동 대기 |
| 학습과정 목록·생성·수정·삭제·영상 순서 | 화면 및 요청 함수 구현 | API 미구현 |
| 관리자 댓글 삭제 | 화면 미구현 | API 미구현 |

따라서 실제 로그인 후 영상 목록에서 404가 발생할 수 있습니다. 인증 실패가 아니라 관리 API 구현 대기 상태입니다. 영상·학습과정 기능은 현재 미리보기로 확인하고 실제 API 구현 후 연동을 검증합니다.


## 인증 계약

- 로그인: `POST /api/admin/login`, `{ username, password }`, 성공 `200 { id, username }`
- 아이디 1~50자(앞뒤 공백 제거), 비밀번호 1~128자(입력 그대로 전송)
- 세션: `GET /api/admin/me`, 성공 `200 { id, username }`
- 로그아웃: `POST /api/admin/logout`, 성공 `204`
- `credentials: 'include'`, 서버가 발급한 HttpOnly 쿠키 사용. 비밀번호·토큰을 localStorage에 저장하지 않음
- 오류는 `{ code, message, fields }`. 계정 불일치·세션 만료·Origin 거절을 구분하고 필드 오류 표시
- 파일 업로드는 `POST /api/admin/uploads`에 `FormData(kind, file)` 전송. Content-Type boundary는 브라우저가 설정

## 검증

`frontend`에서:

```sh
npm run build
node --test test/adminAuth.test.js
```

통합 테스트에는 백엔드 의존성 설치도 필요합니다. 기존 백엔드 테스트 도우미로 임시 DB·계정을 만들고 종료 시 정리합니다. 실제 개발 DB나 계정을 수정하지 않습니다. 로그인 성공·실패, 길이 검증, 세션 확인·로그아웃, Origin 거절, multipart 헤더, HTML fallback 처리를 검사합니다. Node에서 쿠키 전달을 모사하므로 브라우저 쿠키 정책·화면 검증은 별도로 필요합니다.

백엔드 전체 검증은 저장소 루트에서 `cd backend && npm test`로 실행합니다.

### 브라우저 연동 확인 항목

- 미리보기를 끄고 실제 계정으로 로그인
- 로그인 후 새로고침 및 로그인 URL 재접속 시 세션 유지 확인
- 로그아웃 후 관리자 URL 직접 접속 시 로그인으로 이동
- 세션 만료와 잘못된 계정 오류 확인
- 실제 관리 API 구현 후 영상·태그·퀴즈·학습과정 저장·삭제 확인

## 배포·협업

현재 명세는 SQLite와 서버 로컬 `uploads` 저장 방식입니다.

`package.json`, `package-lock.json`, 기존 API·화면 구조를 유지합니다. 기능 미리보기 성공과 실제 API 연동 성공은 구분해서 기록합니다.