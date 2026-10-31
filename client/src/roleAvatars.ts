import { getLocale } from './i18n'
import type { Person } from './people'

export const ROLE_AVATARS = [
  { id: 'manager', en: 'Bunny · project manager', zh: '\u5154\u5b50 \u00b7 \u9879\u76ee\u7ecf\u7406' },
  { id: 'architect', en: 'Owl · technical director', zh: '\u732b\u5934\u9e70 \u00b7 \u6280\u672f\u4e3b\u7ba1' },
  { id: 'developer', en: 'Fox · developer', zh: '\u72d0\u72f8 \u00b7 \u5f00\u53d1\u5de5\u7a0b\u5e08' },
  { id: 'devops', en: 'Penguin · infrastructure', zh: '\u4f01\u9e45 \u00b7 \u8fd0\u7ef4\u5de5\u7a0b\u5e08' },
  { id: 'operations', en: 'Bear · operations', zh: '\u5c0f\u718a \u00b7 \u8fd0\u8425\u534f\u8c03' },
  { id: 'backend', en: 'Beaver · backend', zh: '\u6cb3\u72f8 \u00b7 \u540e\u7aef\u5de5\u7a0b\u5e08' },
  { id: 'sales', en: 'Puppy · customer advisor', zh: '\u5c0f\u72d7 \u00b7 \u5ba2\u6237\u987e\u95ee' },
  { id: 'tester', en: 'Red panda · quality assurance', zh: '\u5c0f\u718a\u732b \u00b7 \u6d4b\u8bd5\u5de5\u7a0b\u5e08' },
  { id: 'growth', en: 'Squirrel · growth researcher', zh: '\u677e\u9f20 \u00b7 \u589e\u957f\u7814\u7a76' },
  { id: 'designer', en: 'Cat · designer', zh: '\u732b\u54aa \u00b7 \u8bbe\u8ba1\u5e08' },
  { id: 'product', en: 'Otter · product manager', zh: '\u6c34\u736d \u00b7 \u4ea7\u54c1\u7ecf\u7406' },
  { id: 'writer', en: 'Hamster · writer', zh: '\u4ed3\u9f20 \u00b7 \u6587\u6863\u64b0\u5199' },
  { id: 'critic', en: 'Husky · independent reviewer', zh: '\u54c8\u58eb\u5947 \u00b7 \u72ec\u7acb\u8bc4\u5ba1' },
] as const

export type RoleAvatarId = (typeof ROLE_AVATARS)[number]['id']
export const roleAvatarUrl = (id: RoleAvatarId): string => `/avatars/${id}.jpg`
export const roleAvatarLabel = (a: (typeof ROLE_AVATARS)[number]): string => getLocale() === 'zh-CN' ? a.zh : a.en

/** A visual default from the saved role; never changes the member's provider, model or identity. */
export function defaultRoleAvatar(person: Person): RoleAvatarId {
  if (person.kind === 'owner') return 'manager'
  const role = person.agent?.role.toLowerCase() ?? ''
  if (/architect|cto|technical director|tech lead|\u6280\u672f\u4e3b\u7ba1|\u67b6\u6784/.test(role)) return 'architect'
  if (/review|critic|\u8bc4\u5ba1|\u5ba1\u67e5/.test(role)) return 'critic'
  if (/devops|sre|infrastructure|\u8fd0\u7ef4/.test(role)) return 'devops'
  if (/backend|back.end|\u540e\u7aef/.test(role)) return 'backend'
  if (/\bqa\b|test|quality|\u6d4b\u8bd5/.test(role)) return 'tester'
  if (/design|\bux\b|\bui\b|\u8bbe\u8ba1/.test(role)) return 'designer'
  if (/writ|document|editor|\u6587\u6863|\u6587\u6848|\u5199\u4f5c|\u6da6\u8272/.test(role)) return 'writer'
  if (/growth|research|\u589e\u957f|\u8c03\u7814/.test(role)) return 'growth'
  if (/sale|customer|\u9500\u552e|\u5ba2\u670d/.test(role)) return 'sales'
  if (/product|\u4ea7\u54c1/.test(role)) return 'product'
  if (/dev|engineer|program|\u5f00\u53d1|\u7f16\u7a0b|\u5de5\u7a0b/.test(role)) return 'developer'
  if (/\bops\b|operation|\u8fd0\u8425/.test(role)) return 'operations'
  return 'manager'
}
