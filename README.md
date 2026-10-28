# worklearn-shorts

직장인 대상 숏폼 학습 플랫폼 (더존비앤씨티 인턴십 3조)

## 기술 스택

- Frontend: React + Vite
- Backend: Node.js(22.20 이상) + Express
- DB: SQLite (`backend/data/app.db`)
- 파일: 로컬 폴더 (`backend/uploads`)

## 로컬 실행

### 1. 백엔드

```sh
cd backend
cp .env.example .env   # AUTH_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD 입력
npm ci
npm run db:init        # DB 생성
npm run admin:create   # 관리자 계정 생성
npm run dev            # http://localhost:3000
```

#### 시연 데이터 (선택)

영상·학습과정 화면과 API를 시험하려면 샘플 데이터가 필요하다.

```sh
# 1) 샘플 영상·썸네일(sample-media.zip)을 backend/ 안에서 풀어 backend/uploads/ 아래에 둔다 (Git에 올라가지 않음)
# 2) 관리자·태그·샘플 영상 8개를 넣는다 (관리자 계정도 만들어 주므로 admin:create는 생략해도 된다)
npm run db:seed
# 3) 학습과정 3개를 넣는다 (db:seed 다음에 실행, 여러 번 실행해도 안전)
npm run db:seed:courses
```

### 2. 프론트엔드

```sh
cd frontend
npm ci
npm run dev            # http://localhost:5173
```

- 관리자 로그인: http://localhost:5173/admin/login
- 백엔드 없이 관리자 화면만 볼 때: `frontend/.env`에 `VITE_ADMIN_PREVIEW=true`

### 테스트

```sh
cd backend && npm test
```

## 문서

- API 명세서 v2, DB 명세서 v2 (4주차 제출)

## 브랜치 규칙

main에서 `feat/기능명` 브랜치 생성 → PR → 리뷰 후 병합
