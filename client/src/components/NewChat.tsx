import { useState } from 'react'
import type { Conversation, Team } from '../../../shared/types'
import { createConversation, updateConversation } from '../api'
import { t } from '../i18n'
import { personFor } from '../people'
import { RolePicker } from './RolePicker'

interface NewChatProps {
  team: Team
  /** When set, edits this group's name and members instead of creating one. */
  conversation?: Conversation
  onDone: (id?: string) => void
}

export function NewChat({ team, conversation, onDone }: NewChatProps) {
  const [name, setName] = useState(conversation?.name ?? '')
  const [members, setMembers] = useState<string[]>(conversation ? conversation.memberIds.filter((m) => m !== 'user') : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMain = conversation?.id === 'group'

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (conversation) {
        await updateConversation(conversation.id, isMain ? { name: name.trim() } : { name: name.trim(), memberIds: members })
        onDone(conversation.id)
      } else {
        const { conversation: c } = await createConversation(name.trim() || members.map((id) => personFor(team, id).name).join(', '), members)
        onDone(c.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet" role="dialog">
        <h2>{conversation ? t('menu.editChat') : t('nav.newChat')}</h2>
        {error && <div className="form-error">{error}</div>}
        <label className="field">
          <span>{t('newChat.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newChat.namePh')} autoFocus />
        </label>
        {!isMain && (
          <RolePicker team={team} selected={members} onChange={setMembers} />
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={() => onDone()}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || (!isMain && members.length === 0)} onClick={() => void save()}>
            {busy ? t('common.saving') : conversation ? t('common.save') : t('newChat.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
