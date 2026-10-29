## 구조

```text
src/
├── api/
│   ├── adminApi.js          # 공통 요청, 인증, 오류 코드
│   ├── videoApi.js          # 영상·파일 업로드·태그
│   ├── courseApi.js         # 학습과정
│   ├── mockVideoApi.js      # 관리자 화면 미리보기
│   ├── learnerApi.js        # 사용자(학습자) 화면용 요청: 학습과정 목록·상세
│   ├── learnerPreview.js    # 사용자 화면 미리보기 스위치(VITE_LEARNER_PREVIEW)
│   └── mockLearnerApi.js    # 사용자 화면 미리보기용 가짜 데이터
├── lib/
│   ├── storage.js           # localStorage 안전 접근(막히면 메모리 대체)
│   ├── visitorId.js         # 로그인 없는 방문자 식별값(UUID)
│   └── courseProgress.js    # 학습 진도(브라우저 저장)·상태 계산
├── components/admin/       # 보호 라우트, 레이아웃, 폼·모달
├── pages/admin/            # 로그인, 영상 목록·편집, 학습과정
├── App.jsx                 # 기존 History API 라우팅
├── main.jsx
└── index.css
public/images/default-thumbnail.svg   # 썸네일이 없는 영상의 기본 이미지
test/adminAuth.test.js       # 실제 인증 서버와 FE 요청 함수 테스트
test/learnerApi.test.js      # 실제 학습과정 API와 사용자 요청 함수 테스트
test/learnerLib.test.js      # 방문자 ID·진도 계산 테스트
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

사용자(학습자) 화면용 미리보기는 `VITE_LEARNER_PREVIEW=true`입니다. 가짜 학습과정 3개를 실제 API와 같은 모양으로 돌려주며, 실제 백엔드와 시드 데이터가 준비되면 값을 제거하고 Vite를 재시작합니다.

## 현재 구현과 남은 연동

| 기능 | FE 상태 | 현재 로컬 백엔드 상태 |
| --- | --- | --- |
| 로그인·세션 확인·로그아웃 | 구현 및 API 함수 통합 테스트 완료 | 구현 |
| 관리자 진입 보호 | 구현 | `/api/admin/me` 사용 |
| 영상 목록·편집 정보 조회 | 화면 및 요청 함수 구현, 실제 API 통합 테스트 완료 | 구현 |
| 영상 등록 | 화면 및 요청 함수 구현, 실제 API 통합 테스트 완료(업로드 → 등록) | 구현 |
| 영상 수정 | 화면 및 요청 함수 구현, 실제 API 통합 테스트 완료(불러오기 → 고치기 → 저장) | 구현 |
| 영상 삭제 | 화면 및 요청 함수 구현, 실제 API 통합 테스트 완료 | 구현 |
| 파일 업로드 | 화면 및 요청 함수 구현, 실제 API 통합 테스트 완료 | 구현 |
| 태그 관리 | 화면 및 요청 함수 구현 | API 미구현 |
| 퀴즈 편집 | 영상 폼에 구현(등록·수정 시 저장) | 퀴즈 조회·저장은 영상 등록·편집 정보 API에 포함 |
| 학습과정 목록·생성·수정·삭제·영상 순서 | 화면 및 요청 함수 구현 | API 미구현 |
| 관리자 댓글 삭제 | 화면 미구현 | API 미구현 |
| 학습과정 목록·상세(사용자) | 요청 함수·진도 계산 구현, **화면은 미구현** | 구현(`feat/course-api`, main 병합 전) |
| 영상 피드·태그·조회수·좋아요(사용자) | 미구현 | API 미구현 |

실제 로그인 후 영상 목록과 편집 화면의 정보 조회는 동작하지만, 학습과정·태그 관리는 아직 404가 발생할 수 있습니다. 인증 실패가 아니라 관리 API 구현 대기 상태입니다. 해당 기능은 미리보기로 확인하고 API 구현 후 연동을 검증합니다.


## 인증 계약

- 로그인: `POST /api/admin/login`, `{ username, password }`, 성공 `200 { id, username }`
- 아이디 1~50자(앞뒤 공백 제거), 비밀번호 1~128자(입력 그대로 전송)
- 세션: `GET /api/admin/me`, 성공 `200 { id, username }`
- 로그아웃: `POST /api/admin/logout`, 성공 `204`
- `credentials: 'include'`, 서버가 발급한 HttpOnly 쿠키 사용. 비밀번호·토큰을 localStorage에 저장하지 않음
- 오류는 `{ code, message, fields }`. 계정 불일치·세션 만료·Origin 거절을 구분하고 필드 오류 표시
- 파일 업로드는 `POST /api/admin/uploads`에 `FormData(kind, file)` 전송. Content-Type boundary는 브라우저가 설정
- `kind`(`video`·`thumbnail`)는 **반드시 `file`보다 먼저** append합니다. 성공 `201 { path, url }`이며, `path`(`videos/UUID.mp4` 등)를 영상 등록·수정 요청에 넣습니다. 영상은 MP4·WebM 50MB, 썸네일은 PNG·JPEG·WebP 10MB까지이고, 형식은 파일 내용으로 판단합니다(확장자를 바꿔도 통과하지 않음). 오류는 `400 VALIDATION_ERROR`·`413 FILE_TOO_LARGE`·`415 UNSUPPORTED_MEDIA_TYPE`

## 사용자(학습자) 화면에서 API 쓰는 법 (학습과정)

요청 함수는 성공하면 API 명세서의 응답 JSON을 그대로, 실패하면 `ApiError(message, status, fields, code)`를 던집니다. `message`는 화면에 그대로 보여 줘도 됩니다. 로그인이 필요 없고, 학습 진도는 서버가 아니라 이 브라우저(localStorage)에 저장합니다.

```jsx
import { useEffect, useState } from 'react'
import { getLearningCourse } from '../api/learnerApi.js'
import { getFollowingVideoId, markCompleted, markStarted, readProgress, summarizeCourse } from '../lib/courseProgress.js'

function CourseDetail({ courseId }) {
  const [course, setCourse] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()            // 화면을 떠나면 요청 취소
    getLearningCourse(courseId, { signal: controller.signal })
      .then(setCourse)
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [courseId])

  if (error) return <p>{error}</p>
  if (!course) return null

  // 영상별 상태(completed·in-progress·next·upcoming), 진행률, 이어볼 영상
  const summary = summarizeCourse(course, readProgress().courses[course.id])
  // <video onPlay={() => markStarted(course.id, video.id)}
  //        onEnded={() => { markCompleted(course.id, video.id); const nextId = getFollowingVideoId(course, video.id) }} />
}
```

- `getLearningCourses({ page, limit, signal })` → `{ data, page, limit, total }`
- `getLearningCourse(id, { signal })` → `videos`가 학습 순서대로, 각 영상에 `sortOrder`
- 썸네일이 없는 영상은 `thumbnailUrl`이 `/images/default-thumbnail.svg`이고, 이 파일은 `public/images/`에 있습니다.
- 영상·썸네일 주소(`/uploads/...`)는 그대로 `<video src>`·`<img src>`에 씁니다(Vite가 백엔드로 전달).
- 백엔드에서 샘플 데이터를 준비하는 방법은 루트 README의 '시연 데이터' 항목을 봅니다.

## 검증

`frontend`에서:

```sh
npm run build
npm test      # test/ 아래 모든 시험 (adminAuth, adminUpload, learnerApi, learnerLib)
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