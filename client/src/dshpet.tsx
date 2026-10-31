// Browser host for the upstream dsh-pet client half (lib/client.js of the pinned package, served
// unmodified by /api/pet/client.js). The package registers itself through window.__ModuleLoader__
// with a factory `(require) => { name, inject, apply }`; this file is the minimal host context
// it needs: React from our bundle, a locale service, ctx.effect / provide / get, and the two UI
// slots it uses (shell.overlay for the animated pets, settings.section for its settings page).
// Everything the pet does in the page (animation chaining, transparency, drag / throw / bounce,
// walking, the right-click menu, multiple pets, sizes and display modes) is the upstream code.
import * as React from 'react'
import { useEffect, useState, type ComponentType } from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JsxRuntime from 'react/jsx-runtime'
import type { Locale } from '../../shared/i18n'

interface UpstreamModule {
  name: string
  inject?: string[]
  apply: (ctx: unknown) => void
}

export interface UpstreamPet {
  /** The animated pets (upstream PetMulti). */
  Overlay?: ComponentType
  /** The upstream settings page: size, display mode, multiple pets, pet packs. */
  Settings?: ComponentType<{ close?: () => void }>
  /** Effects the host deliberately does not run (with the reason), for the status panel. */
  skipped: string[]
  dispose: () => void
}

/** Effects that need host services Synodica does not provide; skipping them keeps them truthfully off. */
const NOT_HOSTED: Record<string, string> = {
  // DSH session notifications: no such events here, and it would ask for an OS notification permission.
  'dsh-pet: notifications': 'system notifications need DSH session events (not provided)',
  'dsh-pet: /pet picker': 'the DSH slash-command picker does not exist here',
  'dsh-pet: command faces': 'the DSH slash-command menu does not exist here',
  'dsh-pet: settings nav icon': 'the DSH settings navigation does not exist here',
}

const MODULES: Record<string, unknown> = {
  react: React,
  'react/jsx-runtime': JsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
}

let loading: Promise<UpstreamModule> | null = null

/** Load lib/client.js once; resolves with the module its factory returns. */
function loadModule(): Promise<UpstreamModule> {
  if (loading) return loading
  loading = new Promise<UpstreamModule>((resolve, reject) => {
    const w = window as unknown as { __ModuleLoader__?: { load(info: { id: string; factory: (req: (m: string) => unknown) => unknown }): void } }
    const previous = w.__ModuleLoader__
    w.__ModuleLoader__ = {
      load(info) {
        w.__ModuleLoader__ = previous
        if (info.id !== 'dsh-pet') return reject(new Error(`unexpected module ${info.id}`))
        try {
          const mod = info.factory((m) => {
            if (m in MODULES) return MODULES[m]
            // e.g. @deepseek-ai/dsh-client-ui-primitives: the upstream code degrades without it.
            throw new Error(`module ${m} is not provided by Synodica`)
          }) as UpstreamModule
          resolve(mod)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      },
    }
    const s = document.createElement('script')
    s.src = '/api/pet/client.js'
    s.async = true
    s.onerror = () => {
      w.__ModuleLoader__ = previous
      loading = null
      reject(new Error('the dsh-pet client could not be loaded (is the package installed? npm run pet:install)'))
    }
    document.head.appendChild(s)
  })
  return loading
}

/** Apply the upstream module on our host context. */
export async function startUpstreamPet(locale: Locale): Promise<UpstreamPet> {
  const mod = await loadModule()
  const disposers: (() => void)[] = []
  const skipped: string[] = []
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const slots = new Map<string, { spec: Record<string, unknown>; render: ComponentType<Record<string, unknown>> }>()
  const ctx = {
    effect(fn: () => unknown, label?: string) {
      if (label && label in NOT_HOSTED) {
        skipped.push(NOT_HOSTED[label] as string)
        return undefined
      }
      try {
        const d = fn()
        if (typeof d === 'function') disposers.push(d as () => void)
        return d
      } catch (err) {
        console.warn('[dsh-pet] effect failed:', label, err)
        return undefined
      }
    },
    locale: {
      register(ns: string, dicts: Record<string, Record<string, string>>) {
        dictionaries.set(ns, dicts)
        return () => dictionaries.delete(ns)
      },
      bind(ns: string) {
        return (key: string) => {
          const d = dictionaries.get(ns)
          const lang = locale === 'zh-CN' ? 'zh' : 'en'
          return d?.[lang]?.[key] ?? d?.en?.[key] ?? key
        }
      },
    },
    provide: () => () => {},
    get: () => undefined,
    slots: {
      register(spec: Record<string, unknown>, render: ComponentType<Record<string, unknown>>) {
        return { spec, render }
      },
      inject(name: string, gen: () => Generator<unknown>) {
        for (const item of gen()) {
          const r = item as { spec?: Record<string, unknown>; render?: ComponentType<Record<string, unknown>> }
          if (r?.spec && r.render) slots.set(name, { spec: r.spec, render: r.render })
        }
      },
    },
  }
  mod.apply(ctx)
  const overlay = slots.get('shell.overlay')
  const settings = slots.get('settings.section')
  const settingsProps = (settings?.spec.inject as (() => Record<string, unknown>) | undefined)?.() ?? {}
  return {
    ...(overlay ? { Overlay: overlay.render as ComponentType } : {}),
    ...(settings ? { Settings: ((props: { close?: () => void }) => React.createElement(settings.render, { ...settingsProps, ...props })) as ComponentType<{ close?: () => void }> } : {}),
    skipped,
    dispose: () => {
      for (const d of disposers.splice(0).reverse()) {
        try {
          d()
        } catch {
          // ignore
        }
      }
    },
  }
}

/** Hook: the upstream pet for this page while `on`, re-applied when the UI locale changes. */
export function useUpstreamPet(on: boolean, locale: Locale): { pet?: UpstreamPet; error?: string } {
  const [state, setState] = useState<{ pet?: UpstreamPet; error?: string }>({})
  useEffect(() => {
    if (!on) {
      setState({})
      return
    }
    let alive = true
    let made: UpstreamPet | undefined
    startUpstreamPet(locale)
      .then((p) => {
        made = p
        if (alive) setState({ pet: p })
        else p.dispose()
      })
      .catch((err: unknown) => alive && setState({ error: err instanceof Error ? err.message : String(err) }))
    return () => {
      alive = false
      made?.dispose()
    }
  }, [on, locale])
  return state
}
