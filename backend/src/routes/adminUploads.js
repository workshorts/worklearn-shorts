import { Router } from 'express'
import { config } from '../config/index.js'
import { errors } from '../errors.js'
import { detectExtension, isUploadKind, publishUpload } from '../lib/uploads.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import {
  cleanupTempFiles, receiveUpload, rejectOversizedRequest, requireMultipart
} from '../middleware/uploadFile.js'

export const adminUploadsRouter = Router()

adminUploadsRouter.use(requireAdmin)

// POST /api/admin/uploads - 영상·썸네일 파일을 올리고 서버가 만든 경로를 돌려준다.
// 영상 등록·수정 요청에는 여기서 받은 path를 넣는다.
adminUploadsRouter.post('/', rejectOversizedRequest, requireMultipart, cleanupTempFiles, receiveUpload, async (req, res) => {
  const kind = req.body?.kind
  const fields = {}
  if (!isUploadKind(kind)) fields.kind = 'kind는 video 또는 thumbnail이어야 합니다.'
  if (!req.file) fields.file = '파일을 선택하세요.'
  if (Object.keys(fields).length > 0) throw errors.validation(fields)

  // 파일 안의 실제 형식으로 판단한다. 확장자·Content-Type은 믿지 않는다.
  const extension = await detectExtension(req.file.path, kind)
  if (extension === null) throw errors.unsupportedMediaType()

  const path = await publishUpload(config.uploadDir, req.file.path, kind, extension)
  res.status(201).json({ path, url: `/uploads/${path}` })
})
