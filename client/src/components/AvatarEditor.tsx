import { useRef, useState } from 'react'
import { AVATAR_LIMITS } from '../../../shared/avatar'
import type { AvatarRef } from '../../../shared/types'
import { refitAvatar, resetAvatar, uploadAvatar } from '../api'
import { t, useLocale } from '../i18n'
import { ROLE_AVATARS, roleAvatarLabel, roleAvatarUrl, type RoleAvatarId } from '../roleAvatars'
import type { Person } from '../people'
import { Avatar } from './Avatar'

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * Upload / replace / reset the avatar of an employee or of the owner ("user"). Files are picked by
 * you and sent as bytes; the server checks the real format, size and geometry and stores them
 * under a generated id. The team update arrives over the event stream.
 */
export function AvatarEditor({ target, person }: { target: string; person: Person }) {
  const locale = useLocale()
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref: AvatarRef | undefined = person.avatar
  const fit: AvatarRef['fit'] = ref?.fit ?? 'cover'

  const run = (p: Promise<unknown>) => {
    setBusy(true)
    setError(null)
    void p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
  }
  const pick = (file: File | undefined) => {
    if (!file) return
    // A quick check before uploading; the server decides from the bytes.
    if (file.size > AVATAR_LIMITS.maxBytes) return setError(t('avatar.hint'))
    run(uploadAvatar(target, file, fit))
  }
  const choose = async (id: RoleAvatarId) => {
    const response = await fetch(roleAvatarUrl(id))
    if (!response.ok) throw new Error(locale === 'zh-CN' ? '\u5934\u50cf\u52a0\u8f7d\u5931\u8d25' : 'Could not load portrait')
    const blob = await response.blob()
    await uploadAvatar(target, new File([blob], `${id}.jpg`, { type: 'image/jpeg' }), 'cover')
  }

  return (
    <div className="field">
      <span>{t('avatar.title')}</span>
      <div className="avatar-editor">
        <Avatar person={person} size={56} />
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }} />
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t('avatar.uploading') : ref ? t('avatar.replace') : t('avatar.upload')}
        </button>
        {ref && (
          <>
            <select value={fit} disabled={busy} onChange={(e) => run(refitAvatar(target, e.target.value === 'contain' ? 'contain' : 'cover'))} aria-label={t('avatar.title')}>
              <option value="cover">{t('avatar.fitCover')}</option>
              <option value="contain">{t('avatar.fitContain')}</option>
            </select>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(resetAvatar(target))}>
              {t('avatar.reset')}
            </button>
          </>
        )}
        <small className="hint">{t('avatar.hint')}</small>
        {error && <small className="form-error">{error}</small>}
        <details className="avatar-gallery">
          <summary>{locale === 'zh-CN' ? '\u4ece\u53ef\u7231\u5934\u50cf\u5e93\u9009\u62e9\uff0813 \u4e2a\u89d2\u8272\uff09' : 'Choose from 13 role portraits'}</summary>
          <small className="avatar-gallery-note">{locale === 'zh-CN' ? '\u9ed8\u8ba4\u5934\u50cf\u6839\u636e\u804c\u8d23\u5339\u914d\u3002\u4f60\u53ef\u4ee5\u81ea\u7531\u9009\u62e9\uff0c\u4e5f\u53ef\u4ee5\u4e0a\u4f20\u81ea\u5df1\u7684\u56fe\u7247\uff1b\u9009\u62e9\u4f1a\u4fdd\u5b58\u5230\u5f53\u524d\u529e\u516c\u5ba4\u5e76\u5728\u5176\u4ed6\u8bbe\u5907\u540c\u6b65\u3002' : 'Defaults follow the role. Choose any portrait or upload your own; selections are saved to this office and shared with your other devices.'}</small>
          <div className="avatar-gallery-grid">
            {ROLE_AVATARS.map((a) => <button key={a.id} type="button" className="avatar-choice" disabled={busy} onClick={() => run(choose(a.id))} aria-label={roleAvatarLabel(a)}>
              <img src={roleAvatarUrl(a.id)} alt="" width="64" height="64" loading="lazy" />
              <span>{roleAvatarLabel(a)}</span>
            </button>)}
          </div>
        </details>
      </div>
    </div>
  )
}
