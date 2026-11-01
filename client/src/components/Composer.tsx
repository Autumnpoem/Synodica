import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Attachment, Conversation, CorrectionMode, CorrectionRecord, Message, Team } from '../../../shared/types'
import { uploadFile } from '../api'
import { getLocale, t } from '../i18n'
import { conversationTitle, personFor } from '../people'
import { Avatar } from './Avatar'

export interface ReplyTarget {
  messageId: string
  authorId: string
  excerpt: string
}

interface ComposerProps {
  team: Team
  conversation: Conversation
  busy: boolean
  replyTo: ReplyTarget | null
  onClearReply: () => void
  onSend: (body: { text: string; attachments?: Attachment[]; replyTo?: Message['replyTo'] }) => Promise<void>
  onStop: () => void
  /** Interrupt the running work and continue with this correction (same chat, same project). */
  onCorrect: (text: string, mode: CorrectionMode) => Promise<void>
  /** The latest correction in this conversation, for the Stopping / Stopped line. */
  correction?: CorrectionRecord
  onResumeCorrection?: (id: string) => void
}

interface Trigger {
  kind: '@' | '/'
  start: number
  query: string
}

function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret)
  const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('/'))
  if (at === -1) return null
  const ch = before[at]
  if (ch !== '@' && ch !== '/') return null
  if (at > 0 && /[A-Za-z0-9_]/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { kind: ch, start: at, query }
}

interface Option {
  id: string
  label: string
  hint: string
  insert: string
  avatar?: string
}

/** Browser speech-to-text, when available (Chrome/Electron). */
function useDictation(onText: (t: string) => void) {
  const [listening, setListening] = useState(false)
  const rec = useRef<{ start: () => void; stop: () => void } | null>(null)
  const supported = typeof window !== 'undefined' && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
  const toggle = () => {
    if (listening) {
      rec.current?.stop()
      return
    }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition
    if (!Ctor) return
    const r = new Ctor()
    r.lang = navigator.language.startsWith('ar') ? 'ar-EG' : navigator.language
    r.interimResults = false
    r.continuous = true
    r.onresult = (e) => {
      let out = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (res?.isFinal) out += `${res[0]?.transcript ?? ''} `
      }
      if (out) onText(out)
    }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    rec.current = r
    r.start()
    setListening(true)
  }
  return { supported, listening, toggle }
}

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

export function Composer({ team, conversation, busy, replyTo, onClearReply, onSend, onStop, onCorrect, correction, onResumeCorrection }: ComposerProps) {
  const [text, setText] = useState('')
  const [scopeChange, setScopeChange] = useState(false)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const dictation = useDictation((t) => setText((v) => (v ? `${v} ${t}` : t)))

  const members = conversation.kind === 'group' ? team.agents.filter((a) => conversation.memberIds.includes(a.id)) : []
  const trigger = triggerAt(text, caret)
  const options: Option[] = (() => {
    if (!trigger) return []
    const q = trigger.query.toLowerCase()
    if (trigger.kind === '@') {
      const list: Option[] = members.map((a) => ({ id: a.id, label: a.name, hint: a.role, insert: `@${a.name} `, avatar: a.id }))
      if (members.length > 1) list.push({ id: 'everyone', label: 'everyone', hint: t('composer.everyone'), insert: '@everyone ' })
      return list.filter((o) => o.label.toLowerCase().startsWith(q))
    }
    // Project chats also offer the workflow commands.
    const workflow: Option[] = conversation.projectId
      ? [
          { id: 'kickoff', label: '/kickoff', hint: t('composer.cmdKickoff'), insert: '/kickoff ' },
          { id: 'critique', label: '/critique', hint: t('composer.cmdCritique'), insert: '/critique' },
          { id: 'start', label: '/start', hint: t('composer.cmdStart'), insert: '/start' },
        ]
      : []
    return [...workflow, ...Object.entries(team.skills).map(([id, s]) => ({ id, label: `/${id}`, hint: s.description || s.name, insert: `/${id} ` }))].filter((o) => o.id.toLowerCase().startsWith(q))
  })()

  useEffect(() => setHighlight(0), [trigger?.query, trigger?.kind])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => {
    setText('')
    setAttachments([])
    area.current?.focus()
  }, [conversation.id])

  useEffect(() => {
    if (replyTo) area.current?.focus()
  }, [replyTo])

  const insert = (opt: Option) => {
    if (!trigger) return
    const next = `${text.slice(0, trigger.start)}${opt.insert}${text.slice(caret)}`
    setText(next)
    const pos = trigger.start + opt.insert.length
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(pos, pos)
      setCaret(pos)
      area.current?.focus()
    })
  }

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].slice(0, 6)
    if (list.length === 0) return
    setError(null)
    setUploading((n) => n + list.length)
    for (const f of list) {
      try {
        const a = await uploadFile(conversation.id, f)
        setAttachments((prev) => [...prev, a])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  /**
   * While the team works, the default (Enter) is Interrupt and correct: the current turn or workflow
   * step is stopped and the work continues with this message. "Send after the current turn"
   * queues it the old way. Workflow commands (/kickoff…) and file-only messages are always sent.
   */
  const correcting = busy && text.trim().length > 0 && !text.trim().startsWith('/') && attachments.length === 0
  const submit = async (mode: 'auto' | 'queue' = 'auto') => {
    const value = text.trim()
    if ((value.length === 0 && attachments.length === 0) || sending || uploading > 0) return
    setSending(true)
    setError(null)
    try {
      if (mode === 'auto' && correcting) {
        await onCorrect(value, scopeChange ? 'replan' : 'continue')
        setText('')
        setScopeChange(false)
        onClearReply()
        return
      }
      await onSend({ text: value, ...(attachments.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}) })
      setText('')
      setAttachments([])
      onClearReply()
    } catch (err) {
      // e.g. a workflow command the project cannot take right now; keep the text so it can be retried.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % options.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h - 1 + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const pick = options[highlight] ?? options[0]
        if (pick) insert(pick)
        return
      }
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault()
      onClearReply()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const replyPerson = replyTo ? (replyTo.authorId === 'user' ? team.owner.name : personFor(team, replyTo.authorId).name) : null
  const correctionLine = (() => {
    if (!correction) return null
    // Applied corrections are shown briefly (until the next update of this conversation's state).
    if (correction.status === 'stopping') return { cls: 'is-stopping', text: t('correction.stopping', { detail: correction.detail ?? '' }) }
    if (correction.status === 'stopped') return { cls: '', text: t('correction.stopped') }
    if (correction.status === 'pending-restart') return { cls: 'is-stopping', text: t('correction.pending') }
    if (Date.now() - correction.updatedAt > 15000) return null
    if (correction.status === 'superseded') return { cls: '', text: t('correction.superseded') }
    return { cls: '', text: correction.mode === 'replan' ? t('correction.replan') : t('correction.applied') }
  })()

  return (
    <div
      className="composer-wrap"
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
    >
      {options.length > 0 && (
        <div className="mention-menu" role="listbox">
          {options.map((o, i) => (
            <button
              type="button"
              key={o.id}
              role="option"
              aria-selected={i === highlight}
              className={`mention-option${i === highlight ? ' is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(o)
              }}
            >
              {o.avatar ? <Avatar person={personFor(team, o.avatar)} size={22} /> : <span className="mention-glyph">{trigger?.kind === '/' ? '/' : '@'}</span>}
              <span className="mention-option-name">{o.label}</span>
              <span className="mention-option-role">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="reply-bar">
          <span className="reply-bar-text">
            {t('composer.replying')} <strong>{replyPerson}</strong>: <span dir="auto">{replyTo.excerpt}</span>
          </span>
          <button type="button" className="icon-button" onClick={onClearReply} aria-label={t('composer.cancelReply')}>
            ×
          </button>
        </div>
      )}
      {(attachments.length > 0 || uploading > 0) && (
        <div className="compose-attachments">
          {attachments.map((a) => (
            <span key={a.path} className="compose-attachment">
              📎 {a.name}
              <button type="button" onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} aria-label={t('composer.remove')}>
                ×
              </button>
            </span>
          ))}
          {uploading > 0 && <span className="compose-attachment muted">{t('composer.uploading')}</span>}
        </div>
      )}
      {attachments.some((a) => a.mime.startsWith('image/')) && <p className="hint" style={{ margin: '4px 12px 8px', fontSize: 12 }}>{getLocale() === 'zh-CN' ? '图片会交给本轮参与回复的模型处理；不支持看图的连接会明确提示。' : 'Images are sent to the models replying in this round. A connection that cannot read images will say so.'}</p>}
      {error && <div className="form-error">{error}</div>}
      {correctionLine && (
        <div className={`correction-status ${correctionLine.cls}`} role="status" aria-live="polite">
          {correctionLine.text}
          {correction?.status === 'pending-restart' && !correction.projectId && onResumeCorrection && (
            <button type="button" className="btn btn-small" onClick={() => onResumeCorrection(correction.id)}>
              {t('correction.continue')}
            </button>
          )}
        </div>
      )}
      {correcting && (
        <div className="correction-options">
          {conversation.projectId && (
            <label>
              <input type="checkbox" checked={scopeChange} onChange={(e) => setScopeChange(e.target.checked)} /> {t('composer.scope')}
            </label>
          )}
          <button type="button" className="link-button" onClick={() => void submit('queue')}>
            {t('composer.queue')}
          </button>
        </div>
      )}
      <div className="composer">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button type="button" className="composer-plus" onClick={() => fileInput.current?.click()} aria-label={t('composer.attach')} title={t('composer.attachHint')}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={busy ? t('composer.placeholderBusy') : conversation.memberIds.length > 4 ? t('composer.placeholderTeam', { company: team.company }) : t('composer.placeholder', { name: conversationTitle(team, conversation) })}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length > 0) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
        />
        {dictation.supported && (
          <button type="button" className={`composer-mic${dictation.listening ? ' is-on' : ''}`} onClick={dictation.toggle} aria-label={dictation.listening ? t('composer.stopDictation') : t('composer.dictate')} title={t('composer.dictate')}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="7" y="2.5" width="6" height="10" rx="3" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6" />
            </svg>
          </button>
        )}
        {busy && (
          <button type="button" className="composer-action is-stop" onClick={onStop} aria-label={t('composer.stop')} title={conversation.projectId ? t('composer.stopStep') : t('composer.stop')}>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        )}
        {correcting && (
          <button type="button" className="composer-action is-correct" onClick={() => void submit()} disabled={sending} title={t('composer.correctHint')}>
            {t('composer.correct')}
          </button>
        )}
        {/* While the team works you can still type: Enter interrupts and corrects; files and commands are sent. */}
        {!correcting && (!busy || text.trim().length > 0 || attachments.length > 0) && (
          <button type="button" className="composer-action" onClick={() => void submit()} disabled={(text.trim().length === 0 && attachments.length === 0) || sending || uploading > 0} aria-label={t('composer.send')}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 16V4M4.5 9.5L10 4l5.5 5.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
