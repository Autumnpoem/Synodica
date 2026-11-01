import type { Locale } from '../../shared/i18n'

const en = {
  engineReady: 'Engine available; account sign-in is not verified by this check.',
  newCredential: 'Changing the Claude endpoint requires a newly entered credential for that endpoint.',
  title: 'Account connection guide', configure: 'Connection settings', add: 'Add provider',
  protocol: 'Protocol', anthropic: 'Claude Code / Anthropic-compatible gateway', openai: 'OpenAI-compatible API',
  gateway: 'Claude gateway / Antigravity proxy', gatewayHint: 'Connect an existing Anthropic-compatible gateway. Enter its root URL, gateway credential and exact model IDs. Antigravity sign-in is managed by your proxy; Synodica does not import or refresh its tokens. Existing official providers stay separate.',
  auth: 'Credential header', apiKey: 'API key (x-api-key)', bearer: 'Gateway token (Bearer)',
  rootUrl: 'Gateway root URL', rootHint: 'Use the gateway root (without /v1/messages). Only this provider uses it. Leave empty for the official Claude endpoint.',
  codexTitle: 'Codex / ChatGPT subscription', codex: 'Already signed in to Codex Desktop? On macOS Synodica can detect its bundled engine when codex is absent from PATH. It uses the existing Codex credential store; no token export or second CLI install is needed when that login is available. The Desktop window itself is not controlled by Synodica.',
  googleTitle: 'Google: account login or API key', google: 'For a Google-account subscription, run gemini once and choose Sign in with Google in the browser. For API access without a CLI, add an OpenAI-compatible provider using Google AI Studio and its API key. API billing is separate from a Google AI Pro subscription.',
  kimiTitle: 'Kimi Code membership', kimi: 'Sign in to the Kimi Code Console with your member account → create an API key → configure the matching Kimi Code China/Overseas provider here. This uses the Code membership, not the Moonshot wallet. Kimi CLI itself also supports /login with browser authorization; this app currently uses the Code key connection.',
  claudeTitle: 'Claude official login or gateway', claude: 'Official subscription: use Claude Code’s own sign-in on this backend machine. Official API: enter your Anthropic API key. Gateway / Antigravity: add a separate Claude-compatible provider below; no global Claude settings are changed.',
  codeConsole: 'Open Kimi Code Console', docs: 'Official setup guide', googleApi: 'Google AI Studio API (separate billing)',
  technical: 'Technical details (original)', unavailable: 'Connection check failed. Follow the setup guide below; technical details are available separately.',
} as const
type Text = { [K in keyof typeof en]: string }
const zh: Text = {
  engineReady: '运行引擎可用；本次检查未验证账号登录。',
  newCredential: '更换 Claude 接口地址后，请重新填写该接口专用的密钥；不会复用旧密钥。',
  title: '账号接入说明', configure: '连接设置', add: '添加服务商',
  protocol: '接入协议', anthropic: 'Claude Code／Anthropic 兼容网关', openai: 'OpenAI 兼容接口',
  gateway: 'Claude 中转／Antigravity 代理', gatewayHint: '连接你已有的 Anthropic 兼容网关，填写网关根地址、网关密钥和准确的模型标识。Antigravity 登录由代理管理；星议不导入或刷新其令牌。官方账号与中转服务分别保存。',
  auth: '密钥传递方式', apiKey: '接口密钥（x-api-key）', bearer: '网关令牌（Bearer）',
  rootUrl: '网关根地址', rootHint: '填写网关根地址，不要带 /v1/messages。只对当前服务商生效；留空使用 Claude 官方接口。',
  codexTitle: 'Codex／ChatGPT 订阅', codex: '已经登录 Codex Desktop？在 macOS 上，找不到 PATH 中的 codex 时，星议会识别桌面版自带的运行引擎，并复用已有 Codex 凭据存储。登录可用时，无需导出令牌或再装一份 CLI。星议调用引擎，不操作 Codex Desktop 的窗口。',
  googleTitle: 'Google：账号登录或接口密钥', google: '使用 Google 账号订阅：首次运行 gemini，选择“使用 Google 登录”，再在浏览器完成授权。不想使用命令行：添加 Google AI Studio 的 OpenAI 兼容接口并填写密钥。接口用量与 Google AI Pro 订阅分别计费。',
  kimiTitle: 'Kimi Code 编程会员', kimi: '用会员账号登录 Kimi Code 控制台 → 创建接口密钥 → 在这里配置对应的 Kimi Code 中国区／海外区服务商。使用的是 Code 编程套餐，而非 Moonshot 开放平台余额。Kimi 官方命令行也能通过 /login 在浏览器授权；星议当前接入方式是 Code 密钥。',
  claudeTitle: 'Claude：官方登录或中转', claude: '官方订阅：在运行后台的这台机器上，通过 Claude Code 自带流程登录。官方接口：填写 Anthropic 接口密钥。中转或 Antigravity：在下方单独添加 Claude 兼容服务商，不修改全局 Claude 配置。',
  codeConsole: '打开 Kimi Code 控制台', docs: '官方接入文档', googleApi: 'Google AI Studio 接口（单独计费）',
  technical: '技术详情（原文）', unavailable: '连接检查未通过，请按下方说明配置；原始诊断可单独展开查看。',
}
export function connectionText(locale: Locale): Text { return locale === 'zh-CN' ? zh : en }
