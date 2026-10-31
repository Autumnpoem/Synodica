import type { AvatarShape, Effort, PermissionMode, ProviderDef, ProviderKind, RateLimitType } from './types.js'

export const MODELS: { id: string; label: string; hint: string }[] = [
  { id: 'claude-opus-5', label: 'Opus 5', hint: 'Smartest. Best for the manager, developers and anything hard.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', hint: 'Previous Opus generation.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Fast and strong. Good default for most roles.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hint: 'Previous Sonnet generation.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'Cheapest and quickest. Chat-only roles.' },
]

/** Suggested model ids per provider kind (free text is always allowed). */
export const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = {
  claude: MODELS.map((m) => m.id),
  codex: ['default', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  gemini: ['default', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  openai: [],
}

export const PROVIDER_KINDS: { id: ProviderKind; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude Code', hint: 'Anthropic. Uses your Claude subscription login, or an API key if you add one. Full tools + MCP.' },
  { id: 'codex', label: 'Codex CLI', hint: 'OpenAI. Uses your ChatGPT / Codex subscription login (`codex login`). Full coding tools.' },
  { id: 'gemini', label: 'Gemini CLI', hint: 'Google. Signs in with your Google account, the same one Antigravity uses. Full coding tools.' },
  { id: 'openai', label: 'API (OpenAI-compatible)', hint: 'Any chat API: Kimi, OpenRouter, DeepSeek, Groq, xAI Grok, Ollama… Chat plus built-in file/shell tools.' },
]

/** Built-in defaults that always exist in team.providers. */
export const DEFAULT_PROVIDERS: Record<string, ProviderDef> = {
  claude: { kind: 'claude', label: 'Claude (subscription)' },
  codex: { kind: 'codex', label: 'Codex (ChatGPT subscription)' },
  gemini: { kind: 'gemini', label: 'Gemini (Google account)' },
  deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  'kimi-cn': { kind: 'openai', label: 'Kimi Open Platform (China)', baseUrl: 'https://api.moonshot.cn/v1' },
  'kimi-code-cn': { kind: 'openai', label: 'Kimi Code (China subscription)', baseUrl: 'https://api.kimi.com/coding/v1', models: ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'] },
}

/** One-click presets for OpenAI-compatible APIs. */
export const API_PRESETS: { id: string; label: string; baseUrl: string; models: string[]; keyHint: string }[] = [
  { id: 'kimi', label: 'Kimi Open Platform (Overseas)', baseUrl: 'https://api.moonshot.ai/v1', models: [], keyHint: 'platform.kimi.com → API keys' },
  { id: 'kimi-cn', label: 'Kimi Open Platform (China)', baseUrl: 'https://api.moonshot.cn/v1', models: [], keyHint: 'platform.kimi.com → API keys' },
  { id: 'kimi-code-cn', label: 'Kimi Code (China subscription)', baseUrl: 'https://api.kimi.com/coding/v1', models: ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'], keyHint: 'kimi.com/code/console → API keys' },
  { id: 'kimi-code-overseas', label: 'Kimi Code (Overseas subscription)', baseUrl: 'https://api.kimi.ai/coding/v1', models: ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'], keyHint: 'kimi.com/code/console → API keys' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-4-fast', 'grok-code-fast-1'], keyHint: 'console.x.ai' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'moonshotai/kimi-k2'], keyHint: 'openrouter.ai/keys' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'], keyHint: 'platform.deepseek.com → API keys' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'], keyHint: 'console.groq.com' },
  { id: 'openai', label: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], keyHint: 'platform.openai.com' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'], keyHint: 'console.mistral.ai' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3:32b', 'llama3.3', 'deepseek-r1:32b'], keyHint: 'No key needed (type anything)' },
]

/** Treat DeepSeek's documented root and legacy `/v1` base URLs as the same endpoint. */
export function providerEndpointKey(value: string | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '') ?? ''
  return normalized === 'https://api.deepseek.com/v1' ? 'https://api.deepseek.com' : normalized
}

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
]

export const TOOLS: { id: string; label: string; hint: string; kinds: ProviderKind[] }[] = [
  { id: 'Read', label: 'Read', hint: 'Read files', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'Glob', label: 'Glob', hint: 'Find files by pattern', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'Grep', label: 'Grep', hint: 'Search file contents', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'Edit', label: 'Edit', hint: 'Edit files', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'Write', label: 'Write', hint: 'Create files', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'Bash', label: 'Bash', hint: 'Run shell commands', kinds: ['claude', 'codex', 'gemini', 'openai'] },
  { id: 'WebSearch', label: 'Web search', hint: 'Search the web', kinds: ['claude', 'codex', 'gemini'] },
  { id: 'WebFetch', label: 'Web fetch', hint: 'Read web pages', kinds: ['claude', 'openai'] },
  { id: 'Task', label: 'Subagents', hint: 'Spawn Claude Code subagents for big jobs', kinds: ['claude'] },
  { id: 'NotebookEdit', label: 'Notebooks', hint: 'Edit Jupyter notebooks', kinds: ['claude'] },
]

export const PERMISSION_MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'dontAsk', label: "Don't ask", hint: 'Only the listed tools run; anything else is denied.' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'File edits in the workspace are approved automatically.' },
  { id: 'default', label: 'Default', hint: 'Claude Code defaults; unlisted tools are denied.' },
  { id: 'plan', label: 'Plan only', hint: 'Read-only exploration, no changes.' },
  { id: 'bypassPermissions', label: 'Bypass all', hint: 'Everything allowed. Use with care.' },
]

export interface ProviderCapabilities {
  /** Keeps a resumable provider session between turns. */
  sessions: boolean
  /** Tool calls can stop for Allow / Deny in the chat. */
  inChatApprovals: boolean
  /** native: the vendor's own agent tools. local: Synodica's built-in file/shell tools. */
  tools: 'native' | 'local'
  mcp: boolean
  /** Streams text while it is generated (otherwise the reply appears at the end). */
  streaming: boolean
  /** Review and planning steps are held to read-only by the adapter (tool removal or an OS sandbox). */
  readOnlyReview: boolean
  /** Shell commands are available in project chats and workflow work turns. */
  projectShell: boolean
  /** How file writes are confined. */
  writeScope: string
  notes: string
}

/** What each adapter really does. Shown in Providers and the profile so nobody assumes parity. */
export const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  claude: { sessions: true, inChatApprovals: true, tools: 'native', mcp: true, streaming: true, readOnlyReview: true, projectShell: true, writeScope: 'Claude Code permission mode and working directory (Bash is not OS-sandboxed by Synodica)', notes: 'Full Claude Code agent: native tools, MCP servers, subagents. Review and planning steps get only Read/Glob/Grep/WebSearch/WebFetch, no MCP.' },
  codex: { sessions: true, inChatApprovals: false, tools: 'native', mcp: false, streaming: false, readOnlyReview: true, projectShell: true, writeScope: 'Codex OS sandbox (read-only or workspace-write)', notes: 'Approval policy is enforced by the Codex sandbox, not by in-chat Allow / Deny. Review and planning steps run in the read-only sandbox, where commands can read and run but not write. Messages arrive when each step completes.' },
  gemini: { sessions: false, inChatApprovals: false, tools: 'native', mcp: false, streaming: false, readOnlyReview: false, projectShell: true, writeScope: 'Gemini CLI approval mode (no OS sandbox applied by Synodica)', notes: 'Stateless: each turn re-sends the recent transcript. No in-chat approvals; the reply appears at the end. Read-only review cannot be enforced, so a Gemini employee cannot be a project reviewer, and a Gemini planning step still takes the folder’s writer lock.' },
  openai: { sessions: false, inChatApprovals: true, tools: 'local', mcp: false, streaming: true, readOnlyReview: true, projectShell: false, writeScope: 'Synodica local file tools, confined to the real working folder (symlinks cannot lead out)', notes: "Chat API plus Synodica's local Read/Glob/Grep/Write/Edit/Bash/WebFetch tools, not the vendor website's tools. Bash is a plain shell on this computer with the folder as its working directory, not a sandbox: it is disabled in project chats and review steps, and stays available (with your approval rules) only in ordinary chats." },
}

export const SHAPES: AvatarShape[] = ['blob', 'round', 'triangle', 'hex', 'drop']

export const RATE_LIMIT_LABELS: Record<RateLimitType, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly incl. overage',
  overage: 'Overage credits',
}
