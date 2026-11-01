# Synodica 更新记录 / Changelog

按版本记录用户可见的变化。当前项目版本为 **0.5.5**；安装文件与校验值以 [GitHub Releases](https://github.com/Autumnpoem/Synodica/releases) 页面为准。

## 0.5.5 · 2026-11-02

### 中文

- 聊天 Markdown 表格渲染为表头和数据行，增加单元格留白、边框和列对齐；较宽表格在消息内横向滚动，不再挤成竖线文字。保留粗体、行内代码、角色提及与文件按钮，并处理不完整的流式文本。
- 普通用户回复轮次重新提供有界的近期用户问题与纠正，已有续接会话也会收到。最新用户方向优先于冲突的旧方向；同事猜测不能当成用户确认的事实。旧排队轮次不吸收下一条用户请求。
- 咨询、比较和计算问题优先在聊天中直接回答；仅在用户要求文件或分配了交付任务时制作文件。角色专长服务于用户当前问题，允许有依据的异议，减少重复追问和无请求的文档重写。
- 不新增模型调用，不改现有账号、模型绑定或保存的人设。

### English

- Render Markdown chat tables with semantic headers and rows, cell padding, borders and column alignment. Wide tables scroll inside the message. Preserve bold, inline code, mentions and file chips, with readable partial streaming content.
- Replay a bounded set of recent direct user requests and corrections on ordinary user reply turns, including resumed sessions. Newer conflicting directions take precedence; peer speculation is not user-confirmed fact. Older queued rounds do not absorb the next user request.
- Answer advisory comparisons and calculations in chat before creating files; create artifacts only when requested or assigned. Role expertise supports the current question and evidence-based disagreement, rather than diverting it into familiar tasks.
- No additional model calls or changes to saved accounts, model bindings or personas.

### Verification reported for this version

268 server tests and 52 client checks, typecheck and build passed. Focus regressions check resumed-turn replay, queued-message boundaries and bounded excerpts; table regressions render the real React component. Provider inference is not part of these automated checks.

## 0.5.4 · 2026-11-02

### 中文

- 修复输入法中按回车确认英文或候选词时误发送消息的问题；团队忙碌时也不会误触发纠正和中断。
- 输入法组成期间，回车、Tab 和方向键留给输入法，不触发 @ 建议选择。确认后普通回车发送、Shift+回车换行、非输入法状态的 @ 补全保持原行为。

### English

- Prevent Enter used to confirm IME English text or a candidate from sending a message, including accidental corrections while the team is busy.
- Leave composition-time Enter, Tab and arrow keys to the IME instead of @ autocomplete. Ordinary Enter to send, Shift+Enter for a newline and non-composing autocomplete keep their existing behavior.

### Verification reported for this version

48 client checks, TypeScript checks and build passed. Four regression cases execute the actual Composer key handler with composing and native 229 events; browser checks cover ordinary Enter to send and Shift+Enter for a newline. These are simulated IME-event regressions, not an end-to-end OS input-method test.

## 0.5.3 · 2026-11-02

### 中文

- 群聊支持围绕明确提出的问题继续多轮讨论，即使后续消息没有再次生成 `@everyone`。需要至少两名未静音成员，不调用普通路由挑选模型；默认四轮，并受现有消息与单人预算约束。明确停止或否定会结束讨论。
- 普通群聊中的单人 `@名字` 纠正或引用回复可只中断该成员及其待处理审批，其他成员继续工作。目标成员等待当前回复轮次和既有队列结束后再单独回复；私聊与单人点名仍保持独占。多个 `@名字` 按全局范围处理；项目工作流纠正仍作用于整个项目。
- 修复额度驾驶舱遮挡语音、发送和暂停按钮；入口及展开面板会随输入框高度避让，拖动与保存位置也遵守同一边界。
- 本地化讨论结束提示、项目流程提示气泡和侧边栏预览。
- 本版没有新增服务商、模型、权限或认证方式。

### English

- Group conversations can continue an explicit discussion across turns without requiring another generated `@everyone`. At least two unmuted members are required; this path does not invoke ordinary model routing. The default is four replies, subject to existing message and per-agent budgets. Explicit stop or negative instructions end the discussion.
- In ordinary group chat, a single-person `@Name` correction or quoted reply interrupts only that person and required approvals; other members continue. The target waits for the current round and queued work, then replies alone. DMs and single-person mentions remain exclusive. Multiple `@Name` targets use global scope; project-workflow corrections still apply to the whole project.
- Keep the quota launcher and panel above the composer, including multiline input, dragged and restored positions, so microphone, Send and Stop remain reachable.
- Localize discussion end notices, workflow bubbles and sidebar previews.
- No provider, model, permission or authentication options were added.

### Verification reported for this version

259 server tests and 44 client tests passed; TypeScript checks and build passed. A fake-browser flow against the actual server was verified. No live provider inference is claimed.

## 0.5.2 · 2026-11-01

### 中文

- macOS 可在 `PATH` 没有 `codex` 时发现 ChatGPT/Codex Desktop 附带的 CLI；已有 `PATH` 命令优先，不导出登录令牌。Windows 不支持桌面包 CLI 探测。
- 新增独立 Anthropic 兼容网关配置，并提供 Google、Kimi Code 和 Google AI Studio 接入说明。
- 员工资料支持模型目录下拉、刷新和自定义 ID；`default` 使用所选上游 CLI 的默认模型。空提示词按职位生成可编辑初稿。
- `@everyone` 开场轮次最多邀请 12 名未静音成员；普通回复可并发，文件写入成员串行执行。当前消息图片只发送给本轮选用的模型。
- 增加浅色、深色、系统主题和跟随办公室主题的额度浮窗；原版 dsh-pet 可悬浮在桌面应用窗口外，余额操作显示一个缓存账户。
- 补齐设置页中文和布局修复。

### English

- Discover the ChatGPT/Codex Desktop-bundled CLI on macOS when `codex` is absent from `PATH`; prefer an existing `PATH` command and do not export login tokens. Windows discovery is unsupported.
- Add a separate Anthropic-compatible gateway and setup guidance for Google, Kimi Code and Google AI Studio.
- Add employee model catalog selection, refresh and custom IDs; `default` uses the selected upstream CLI default. Blank prompts get an editable role-based draft.
- `@everyone` opens a round for up to 12 unmuted members; ordinary replies can run concurrently while file-writing members are serialized. Current-message images go only to the model selected for that round.
- Add Light, Dark and System themes, a quota window that follows the office theme, and desktop floating support for the original dsh-pet. Balance shows one cached account.
- Complete Chinese settings localization and layout repairs.

### Verification reported for this version

The published release body reports 247 server tests, 37 client checks, typecheck and build passing on Ubuntu and Windows. Native Mac theme behavior was verified and the user confirmed the pet floats outside its window. These checks do not claim live third-party model calls. Desktop packages are unsigned; the Mac build is not notarized; Windows hardware acceptance is outstanding. Gemini subscription live quota, independent DSH chat and Codex Desktop Computer Use are not integrated.

## 0.5.1 · 2026-10-31

### 中文

- 清理个人署名、采用匿名项目提交身份、明确非商用与转载署名要求，并更新请求解析依赖安全补丁。
- 提供公司与实验室默认团队，角色人设、服务商和模型可分别保存、复用和更换。
- 增加开放式规划讨论，保留异议及逐条处理理由；需要用户裁决时，开始和恢复都会等待。
- 支持全员讨论、单人 `@角色`、私聊，以及停止、纠正和恢复。
- 提供中英文界面、科幻应用图标、角色头像、用量与额度浮窗及原版 dsh-pet 动画。
- Mac/Windows 客户端与手机网页可连接同一 Ubuntu 办公室。

### English

- Add reusable Company and Laboratory teams with independently editable personas, providers and models.
- Add cross-role planning discussion with preserved objections, explicit dispositions and user-decision gates on Start and Resume.
- Support bounded everyone rounds, exclusive single mentions and DMs, plus Stop/correct/resume.
- Add English and Chinese UI, a new app identity, role avatars, floating usage panels and original dsh-pet animations.
- Allow desktop clients and mobile browsers to share one Ubuntu-hosted office.

### Verification reported for this version

The published release body reports 203 server tests, 28 client/packaging checks, typecheck and build passing. Browser decision/settings flows and packaged Mac backend startup were checked; provider interaction tests used simulated providers. Windows hardware acceptance remained outstanding. Packages were unsigned and the Mac app was not notarized. Gemini subscription live quota and standalone DSH chat were not integrated.
