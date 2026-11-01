import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Agent, Attachment, Conversation, ProviderDef, Team } from '../shared/types.js'

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export interface TurnImage { path: string; mime: ImageMime; data: Buffer }
export interface TurnImageSelection { images: TurnImage[]; problem?: 'unreadable' }

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024

function imageMime(data: Buffer): ImageMime | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 6).toString() === 'GIF87a' || data.subarray(0, 6).toString() === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return undefined
}

export function isImageAttachment(attachment: Attachment): boolean {
  return /^image\//i.test(attachment.mime) || /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(attachment.name)
}

/** Image bytes come only from the triggering user message, never from transcript history. */
export function turnImages(conversation: Conversation, _agent: Agent, resolveAttachment?: (file: string) => string | undefined, inputMessageId?: string): TurnImageSelection {
  if (!inputMessageId) return { images: [] }
  const message = conversation.messages.find((item) => item.id === inputMessageId)
  if (!message || message.authorId !== 'user' || message.status !== 'done') return { images: [] }
  const attachments = (message.attachments ?? []).filter(isImageAttachment)
  if (attachments.length === 0) return { images: [] }
  if (!resolveAttachment || attachments.length > MAX_IMAGES) return { images: [], problem: 'unreadable' }
  const images: TurnImage[] = []
  let total = 0
  for (const attachment of attachments) {
    const real = resolveAttachment(attachment.path)
    if (!real || !path.isAbsolute(real)) return { images: [], problem: 'unreadable' }
    try {
      const stat = statSync(real)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_TOTAL_BYTES) return { images: [], problem: 'unreadable' }
      const data = readFileSync(real)
      const mime = imageMime(data)
      if (!mime) return { images: [], problem: 'unreadable' }
      total += data.length
      images.push({ path: real, mime, data })
    } catch {
      return { images: [], problem: 'unreadable' }
    }
  }
  return { images }
}

/** `unknown` must be sent to the provider; absence of catalog evidence is not a denial. */
export function imageSupport(provider: ProviderDef, model: string, modalities?: string[]): 'supported' | 'unsupported' | 'unknown' {
  if (modalities) return modalities.includes('image') ? 'supported' : 'unsupported'
  if (provider.baseUrl) {
    try {
      if (new URL(provider.baseUrl).hostname === 'api.deepseek.com') {
        if (model === 'deepseek-v4-pro') return 'unsupported'
        if (model === 'deepseek-flash' || model === 'deepseek-v4-flash-vision-exp') return 'supported'
      }
    } catch { /* invalid URLs are handled by the provider boundary */ }
  }
  return 'unknown'
}

export function isImageUnsupportedError(detail: string): boolean {
  return /(?:image|vision).{0,50}(?:unsupported|not supported|not available)|(?:does not support|unsupported).{0,30}(?:image|vision)/i.test(detail)
}

/** Give a file-reading CLI an isolated directory containing only this turn's selected images. */
export function stageImages(images: TurnImage[]): { directory: string; paths: string[]; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'synodica-images-'))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  try {
    const extension: Record<ImageMime, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
    const paths = images.map((image, index) => {
      const file = path.join(directory, `${index + 1}${extension[image.mime]}`)
      writeFileSync(file, image.data, { flag: 'wx', mode: 0o600 })
      return file
    })
    return { directory, paths, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** Directly explain an image limitation without spending a model call. */
export function imageReply(team: Team, conversation: Conversation, problem: 'unsupported' | 'unreadable' | 'no-read-tool'): string {
  const latest = [...conversation.messages].reverse().find((message) => message.authorId === 'user')?.text ?? ''
  const lang = team.settings.language === 'auto' ? /[\u0600-\u06ff]/.test(latest) ? 'ar' : /[\u3400-\u9fff]/.test(latest) ? 'zh-CN' : 'en' : team.settings.language
  if (lang === 'zh-CN' || lang.startsWith('zh')) return problem === 'unsupported' ? '当前模型不支持查看图片。请换用支持图片的模型，或用文字描述图片内容。' : problem === 'unreadable' ? '我无法读取这张图片。请重新上传 PNG、JPEG、GIF 或 WebP 图片。' : '当前连接未能读取图片，请改用支持图片的连接。'
  if (lang === 'ar') return problem === 'unsupported' ? 'النموذج الحالي لا يستطيع رؤية الصور. اختر نموذجًا يدعم الصور أو صفها بالكلمات.' : problem === 'unreadable' ? 'لا أستطيع قراءة الصورة المرفقة. أعد رفعها بصيغة PNG أو JPEG أو GIF أو WebP.' : 'الاتصال الحالي لا يستطيع قراءة الصورة. اختر اتصالًا يدعم الصور.'
  return problem === 'unsupported' ? 'This model cannot view images. Choose a model that supports images, or describe the image in text.' : problem === 'unreadable' ? 'I could not read the attached image. Please upload a PNG, JPEG, GIF, or WebP image again.' : 'This connection could not read the image. Choose an image-capable connection.'
}
