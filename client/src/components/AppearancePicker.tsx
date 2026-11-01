import { useLocale } from '../i18n'
import { setThemePreference, useThemePreference } from '../theme'

const labels = {
  en: { light: 'Light', dark: 'Dark', system: 'System' },
  'zh-CN': { light: '浅色', dark: '深色', system: '跟随系统' },
} as const

export function AppearancePicker() {
  const locale = useLocale()
  const preference = useThemePreference()
  const t = labels[locale]
  return <select aria-label={locale === 'zh-CN' ? '外观' : 'Appearance'} value={preference} onChange={(event) => setThemePreference(event.target.value as 'light' | 'dark' | 'system')}>
    <option value="light">{t.light}</option>
    <option value="dark">{t.dark}</option>
    <option value="system">{t.system}</option>
  </select>
}
