import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

globalThis.React = React // tsx's Node loader uses the classic JSX transform for this direct component fixture.
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return nextLoad(url, context) }')}`, import.meta.url)
const { RichText } = await import('../client/src/components/RichText.tsx')

const team = {
  owner: { name: 'Owner' },
  agents: [{ id: 'dsh', name: 'DSH', role: 'Reviewer', color: '#345678', shape: 'round' }],
}
const draw = (text) => renderToStaticMarkup(React.createElement(RichText, { text, team }))

test('a four-column Chinese Markdown table has semantic headers, rows, cells and alignment', () => {
  const html = draw('结果如下：\n\n| 项目 | 数量 | 状态 | 负责人 |\n| :--- | ---: | :---: | --- |\n| 登录 | **12** | 完成 | DSH |\n| 导出 | 3 | 待办 | Owner |\n\n以上为本轮统计。')
  assert.match(html, /<p>.*结果如下：.*<\/p>/)
  assert.match(html, /<table[^>]*>.*<thead>.*<tbody>/s)
  assert.equal((html.match(/<th\b/g) ?? []).length, 4)
  assert.equal((html.match(/<td\b/g) ?? []).length, 8)
  assert.match(html, /<strong>12<\/strong>/)
  assert.match(html, /text-align:right/)
  assert.match(html, /<p>.*以上为本轮统计。.*<\/p>/)
})

test('escaped and inline-code pipes stay inside their Markdown cells', () => {
  const html = draw('| 名称 | 内容 |\n| --- | --- |\n| A\\|B | `x|y` |')
  assert.equal((html.match(/<td\b/g) ?? []).length, 2)
  assert.match(html, /A\|B/)
  assert.match(html, /<code>x\|y<\/code>/)
})

test('multiple tables coexist with lists and fenced code without parsing code as a table', () => {
  const html = draw('- 一项\n\n| A | B |\n| --- | --- |\n| @DSH | /tmp/report.md |\n\n```md\n| code | only |\n| --- | --- |\n```\n\n| C | D |\n| --- | --- |\n| 1 | 2 |')
  assert.equal((html.match(/<table\b/g) ?? []).length, 2)
  assert.match(html, /<ul[^>]*>/)
  assert.match(html, /class="mention"/)
  assert.match(html, /class="file-chip"/)
  assert.match(html, /<pre[^>]*>.*\| code \| only \|.*<\/pre>/s)
})

test('partial table syntax remains readable text and user HTML stays escaped', () => {
  const html = draw('| A | B |\n| --- | --\n\n<script>alert(1)</script>')
  assert.doesNotMatch(html, /<table\b/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  const streamingCode = draw('说明\n```md\n| A | B |\n| --- | --- |')
  assert.doesNotMatch(streamingCode, /<table\b/)
  assert.match(streamingCode, /<pre[^>]*>/)
})
