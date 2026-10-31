import { LOCALE_NAMES, LOCALES } from '../../../shared/i18n'
import { setLocale, t, useLocale } from '../i18n'

/** The visible interface-language switch (English / Simplified Chinese). It changes nothing but the UI. */
export function LocaleSwitch() {
  const locale = useLocale()
  return (
    <div className="locale-switch" role="group" aria-label={t('settings.language')} title={t('settings.languageHint')}>
      {LOCALES.map((l) => (
        <button key={l} type="button" className="btn btn-small" lang={l} aria-pressed={locale === l} onClick={() => setLocale(l)}>
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  )
}
