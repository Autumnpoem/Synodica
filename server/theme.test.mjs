import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTheme, getThemePreference } from '../client/src/theme.ts'

test('appearance preference defaults to the existing light theme', () => {
  assert.equal(getThemePreference(), 'light')
})

test('explicit appearance choices ignore the system preference', () => {
  assert.equal(resolveEffectiveTheme('light', true), 'light')
  assert.equal(resolveEffectiveTheme('dark', false), 'dark')
})

test('system appearance follows the system dark preference', () => {
  assert.equal(resolveEffectiveTheme('system', true), 'dark')
  assert.equal(resolveEffectiveTheme('system', false), 'light')
})
