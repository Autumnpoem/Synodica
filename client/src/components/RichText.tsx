import type { ReactNode } from 'react'
import type { Team } from '../../../shared/types'
import { openFile } from '../api'
import { personFor } from '../people'
import { Avatar } from './Avatar'

/** Absolute file paths employees produce (Windows or POSIX) become "Open" chips. */
const FILE_PATH_SOURCE = String.raw`(?:[A-Za-z]:[\\/]|/(?:home|Users|tmp|var|opt|srv)/)[^\x60"'<>|*?\n]+?\.(?:html?|md|txt|json|ts|tsx|js|jsx|css|py|pdf|png|jpe?g|svg|csv|xlsx?|docx?|pptx?|sql|sh|ps1|yml|yaml|toml)(?![\w./\\])`
const FILE_PATH_EXACT = new RegExp(`^${FILE_PATH_SOURCE}$`, 'i')

interface RichTextProps {
  text: string
  team: Team
}

/**
 * Minimal chat markdown: fenced code, inline code, bold, bullet lists, tables, file paths as
 * clickable chips, and @NAME mentions rendered as pills with the employee's avatar.
 */
export function RichText({ text, team }: RichTextProps) {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const body = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
          return (
            <pre key={i} className="code-block">
              <code>{body.replace(/\n$/, '')}</code>
            </pre>
          )
        }
        return <Blocks key={i} text={part} team={team} />
      })}
    </>
  )
}

/** Split table columns without treating escaped pipes or inline-code pipes as separators. */
function tableCells(line: string): string[] | null {
  const source = line.trim()
  const cells: string[] = []
  let cell = ''
  let codeTicks = 0
  let separators = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '\\' && source[i + 1] === '|') {
      cell += '|'
      i++
    } else if (char === '`') {
      let count = 1
      while (source[i + count] === '`') count++
      if (codeTicks === 0) codeTicks = count
      else if (codeTicks === count) codeTicks = 0
      cell += '`'.repeat(count)
      i += count - 1
    } else if (char === '|' && codeTicks === 0) {
      cells.push(cell.trim())
      cell = ''
      separators++
    } else {
      cell += char
    }
  }
  if (separators === 0) return null
  cells.push(cell.trim())
  if (source.startsWith('|')) cells.shift()
  if (cells[cells.length - 1] === '') cells.pop()
  return cells
}

function Blocks({ text, team }: { text: string; team: Team }) {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  let list: string[] = []
  let para: string[] = []
  const flushList = () => {
    if (list.length === 0) return
    out.push(
      <ul key={`ul-${out.length}`} className="chat-list">
        {list.map((item, i) => (
          <li key={i}>
            <Inline text={item} team={team} />
          </li>
        ))}
      </ul>,
    )
    list = []
  }
  const flushPara = () => {
    if (para.length === 0) return
    out.push(
      <p key={`p-${out.length}`}>
        {para.map((l, i) => (
          <span key={i}>
            {i > 0 && <br />}
            <Inline text={l} team={team} />
          </span>
        ))}
      </p>,
    )
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.replace(/\s+$/, '')
    const header = tableCells(line)
    const separator = i + 1 < lines.length ? tableCells(lines[i + 1] ?? '') : null
    if (header && separator && header.length > 0 && header.length === separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      flushPara()
      flushList()
      const alignments: ('left' | 'center' | 'right' | undefined)[] = separator.map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined)
      const rows: string[][] = []
      i++ // separator row
      while (i + 1 < lines.length) {
        const cells = tableCells(lines[i + 1] ?? '')
        if (!cells || cells.length === 0) break
        rows.push(cells)
        i++
      }
      out.push(
        <div key={`table-${out.length}`} className="chat-table-scroll">
          <table className="chat-table">
            <thead><tr>{header.map((cell, column) => <th key={column} scope="col" style={alignments[column] ? { textAlign: alignments[column] } : undefined}><Inline text={cell} team={team} /></th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, column) => <td key={column} style={alignments[column] ? { textAlign: alignments[column] } : undefined}><Inline text={row[column] ?? ''} team={team} /></td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (li && li[1] !== undefined) {
      flushPara()
      list.push(li[1])
    } else if (line.trim() === '') {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line.replace(/^#{1,6}\s+/, ''))
    }
  }
  flushPara()
  flushList()
  return <>{out}</>
}

function Inline({ text, team }: { text: string; team: Team }) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mentionable = [
    ...team.agents.map((a) => ({ id: a.id, name: a.name })),
    { id: 'user', name: team.owner.name },
    { id: 'user', name: team.owner.name.split(/\s+/)[0] ?? team.owner.name },
  ].filter((m) => m.name.length > 0)
  const names = [...new Set(mentionable.map((m) => m.name))].sort((a, b) => b.length - a.length).map(escape)
  const mention = names.length > 0 ? `@(?:${names.join('|')})(?![A-Za-z0-9_])` : null
  const pattern = new RegExp(`(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|${FILE_PATH_SOURCE}${mention ? `|${mention}` : ''})`, 'gi')
  const tokens = text.split(pattern)
  return (
    <>
      {tokens.map((tok, i) => {
        if (!tok) return null
        if (tok.startsWith('`') && tok.endsWith('`')) {
          const inner = tok.slice(1, -1)
          return FILE_PATH_EXACT.test(inner) ? <FileChip key={i} path={inner} /> : <code key={i}>{inner}</code>
        }
        if (FILE_PATH_EXACT.test(tok)) return <FileChip key={i} path={tok} />
        if (tok.startsWith('**') && tok.endsWith('**')) return <strong key={i}>{tok.slice(2, -2)}</strong>
        if (tok.startsWith('@')) {
          const hit = mentionable.find((m) => m.name.toLowerCase() === tok.slice(1).toLowerCase())
          if (hit) {
            const person = personFor(team, hit.id)
            return (
              <span key={i} className="mention">
                <Avatar person={person} size={16} />
                <span>{person.label}</span>
              </span>
            )
          }
        }
        return <span key={i}>{tok}</span>
      })}
    </>
  )
}

function FileChip({ path }: { path: string }) {
  const name = path.split(/[\\/]/).pop() ?? path
  return (
    <button
      type="button"
      className="file-chip"
      title={`Open ${path}`}
      onClick={(e) => {
        e.stopPropagation()
        void openFile(path).catch(() => window.alert(`Could not open ${path}`))
      }}
    >
      <span className="file-chip-icon">↗</span>
      <span>{name}</span>
    </button>
  )
}
