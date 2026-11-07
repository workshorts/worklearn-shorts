import '../src/config/env.js'
import { config } from '../src/config/index.js'
import { closeDb, getDb } from '../src/db/client.js'
import { removeStaleIncoming } from '../src/lib/uploads.js'
import { DEFAULT_AGE_HOURS, MIN_AGE_HOURS, cleanupOrphanUploads } from '../src/lib/upload-cleanup.js'

// 미등록 업로드 파일 정리 명령.
//   npm run uploads:cleanup                      미리보기(아무것도 지우지 않고 지울 파일만 보여 줌)
//   npm run uploads:cleanup -- --apply           실제로 지움
//   npm run uploads:cleanup -- --min-age-hours=48  마지막 수정이 48시간 넘은 파일만 대상으로 함(기본 24, 최소 1)
const usage = '사용법: npm run uploads:cleanup -- [--apply] [--min-age-hours=24]'

function parseArguments(argv) {
  const options = { apply: false, minAgeHours: DEFAULT_AGE_HOURS }
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true
    else if (/^--min-age-hours=/.test(argument)) {
      const text = argument.slice('--min-age-hours='.length)
      const hours = Number(text)
      if (text === '' || !Number.isFinite(hours) || hours < MIN_AGE_HOURS || hours > 24 * 365) {
        throw new Error(`--min-age-hours는 ${MIN_AGE_HOURS} 이상 ${24 * 365} 이하의 숫자여야 합니다(방금 올려 아직 등록 중인 파일을 지우지 않도록 최소 ${MIN_AGE_HOURS}시간).`)
      }
      options.minAgeHours = hours
    } else throw new Error(`알 수 없는 옵션입니다: ${argument}`)
  }
  return options
}

const formatSize = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`)
const formatAge = (now, mtimeMs) => {
  const hours = Math.floor((now - mtimeMs) / 3600 / 1000)
  return hours >= 48 ? `${Math.floor(hours / 24)}일 전` : `${hours}시간 전`
}

let options
try {
  options = parseArguments(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  console.error(usage)
  process.exit(1)
}

try {
  const now = Date.now()
  const { scan, applied } = cleanupOrphanUploads(getDb(), config.uploadDir, { apply: options.apply, minAgeMs: options.minAgeHours * 3600 * 1000, now })
  const total = scan.candidates.reduce((sum, file) => sum + file.size, 0)

  console.log(`업로드 폴더 점검 (마지막 수정이 ${options.minAgeHours}시간 넘은 미등록 파일이 대상)`)
  console.log(`  영상이 쓰는 파일 ${scan.used}개 / 최근 올려서 보류 ${scan.tooNew}개 / 이름 규칙이 달라 건드리지 않음 ${scan.skipped.length}개`)
  for (const item of scan.skipped.slice(0, 10)) console.log(`    건드리지 않음: ${item.path} (${item.reason})`)
  console.log(`  정리 대상(미등록) ${scan.candidates.length}개, 합계 ${formatSize(total)}`)
  for (const file of scan.candidates.slice(0, 50)) console.log(`    ${file.path}  ${formatSize(file.size)}, ${formatAge(now, file.mtimeMs)}`)
  if (scan.candidates.length > 50) console.log(`    ... 외 ${scan.candidates.length - 50}개`)

  if (!options.apply) {
    console.log(scan.candidates.length > 0 ? '\n[미리보기] 아무것도 지우지 않았습니다. 실제로 지우려면 --apply 를 붙여 다시 실행하세요.' : '\n정리할 파일이 없습니다.')
  } else {
    for (const item of applied.skipped) console.log(`    지우지 않음: ${item.path} (${item.reason})`)
    for (const item of applied.failed) console.error(`    삭제 실패: ${item.path} (${item.code})`)
    const stale = await removeStaleIncoming(config.uploadDir)
    console.log(`\n삭제 완료: ${applied.deleted.length}개, ${formatSize(applied.freedBytes)} 확보` + (stale > 0 ? ` / 중단된 업로드 임시 파일 ${stale}개도 정리` : ''))
    if (applied.failed.length > 0) process.exitCode = 1
  }
} catch (error) {
  console.error('업로드 파일을 정리하지 못했습니다. DB가 초기화되어 있는지(npm run db:init), 다른 프로그램이 DB를 오래 잠그고 있지 않은지 확인하세요.')
  process.exitCode = 1
} finally {
  closeDb()
}
