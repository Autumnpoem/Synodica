# Getting started with Synodica

[简体中文](../zh-CN/快速开始.md)

Synodica is a shared workspace for reusable AI personas, group conversations and project work. This guide covers version 0.5.3 desktop packages and the source workflow. It does not configure an account or make a model call for you.

Choose **Light**, **Dark** or **System** in the appearance setting. The quota dock and its floating desktop window follow the office's appearance preference when opened from the same office origin.

## Install the desktop app

Use the package for your computer: **Apple silicon Mac**: `Synodica-0.5.3-mac-arm64.dmg`; **64-bit Windows**: `Synodica-0.5.3-win-x64.zip`. Download them from the project's GitHub Releases page when listed. On Mac, open the DMG and drag Synodica to Applications. On Windows, extract the ZIP and run `Synodica.exe`; keep the extracted folder together.

These builds are unsigned; the Mac build is also not notarized. Your operating system may warn you or refuse to open it. Only continue if you trust the source and have checked the release; do not disable or bypass the operating system's security protections. Windows package contents were checked, but Windows hardware operation has not yet been tested. This release targets Apple silicon, not Intel Macs. Windows does not discover a Codex CLI bundled inside ChatGPT/Codex Desktop.

## Run from source instead

Install Node.js 22 or newer and npm, then run:

```sh
git clone https://github.com/Autumnpoem/Synodica.git
cd Synodica
npm ci
npm run pet:install
npm run build
npm start
```

Open the local address printed by the server. The `pet:install` step installs the pinned desktop-pet runtime. Keep `team.json`, `data/`, provider credentials and generated release packages private. To run the native desktop shell from a built checkout, use `npm run desktop`.

### Update an existing source checkout

Stop the running server, open the existing checkout and run:

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

Keep the office data directory and provider credentials in place; do not overwrite private runtime data with a public source checkout. For desktop packages, download the versioned installer listed on the Releases page and follow the platform steps above.

## Connect providers on the machine that runs the office

Open **Settings → Providers** and check which provider entries are available. With the API Key field left empty, Claude Code, Codex and Gemini use the official CLI login already configured for the operating-system user running the backend. Complete the provider's official login on that same computer and user account; on a shared Ubuntu office, that means the Ubuntu service user. Adding a key changes the billing identity to that provider's API path. The app does not import website cookies or turn a website session into API access. The Settings **Import** action imports an agent/persona JSON file; it does not import model accounts or credentials.

For Kimi Code subscriptions, Kimi Open Platform and DeepSeek API keys, follow the relevant [subscription setup guide](../zh-CN/subscriptions/README.md). Save keys only in the matching provider settings field. A subscription and an API key can be different billing paths. Provider status checks do not prove that every model is entitled or that a model call will succeed. See the provider-specific guide before adding credentials; do not paste secrets into a chat.

The account login is used by the execution backend; it does not automatically change every persona's provider. In an employee profile, choose a model from the dropdown, use **Refresh** to request an updated catalog, or choose the custom-ID option and enter an exact model ID yourself. Catalog entries are grouped by source: an upstream CLI listing, a provider's API listing, or models configured in this office. A list is a discovery aid, not proof that the current account has permission, remaining balance or quota, or that a request will succeed. If a catalog needs credentials that are not set up yet, you can enter the model ID manually and configure the matching provider later. **default** means “let the already configured upstream CLI choose its default model”; it does not identify a particular GPT model or make one provider's model a universal replacement for another. For API-key providers, you will usually need to select a concrete model ID. Kimi Code and Kimi Open Platform use separate credentials and endpoints; configure the one that matches your account and intended billing path. The office may show usage as unavailable when a provider has no supported read-only usage source. In particular, Gemini Google subscription usage is not currently available as a live quota report.

## Choose a team and start talking

Open **Settings → Team → Default teams** and choose the **Company** or **Laboratory** preset. For a new employee, enter a name and role; both are required. The prompt/instructions field may be left blank, in which case Synodica creates a starting prompt from the employee's role. You can edit that prompt afterward. Review the model in the profile before saving; the suggested assignment is editable. Presets create reusable personas. Applying them again reuses saved personas rather than replacing names, instructions or model choices. Edit an existing persona from its profile when you want to change its defaults. In a new conversation, select the saved personas you want to include. In a project, write the goal, choose the participating personas, then review the lead and reviewer roles on the board.

Start with a direct conversation to learn how a selected persona responds. A direct message stays exclusive to its member for the reply round. In a group, one explicit `@Name` also directs the round exclusively to that member. They can still mention a colleague for discussion, but the colleague will not join the current round. If you do not mention anyone, the office's group mode decides whether a dispatcher selects 1–3 relevant members, everyone takes part in the opening round (with file-writing members serialized to protect the shared folder), or the first member takes the turn.

To invite the whole group in chat, use `@everyone` or an explicit request such as “Everyone, please weigh in on this plan.” The invitation includes unmuted group members, up to 12. Each invited reply may use that member's normal provider usage; a skip is not agreement.

`@everyone` is a group opening round: replies may run concurrently when safe, but employees with file-writing tools are serialized so they do not write to the same working folder at once. A single `@Name` still makes that round exclusive to the named employee; other members do not join it.

You can attach an image with the attachment button, or drag or paste it into the composer. Only images attached to the current user message are passed to the selected provider/model for this reply round. When the model is known not to support images, Synodica says so. If support is unknown, or a CLI cannot read the image, the employee must report that it could not view the image instead of pretending to have seen it.

For project work, create a project, describe the outcome and choose participating personas. In **Settings → General → Plan discussion**, choose **Auto**, **On** or **Off** and set the participant limit (default 6, range 1–12). **Auto** enables discussion when the project includes a built-in Company or Laboratory persona; custom-only projects retain their existing flow. **On** and **Off** override the automatic choice.

For file organization, give the employee the **Read** and **Write** tools in its profile and choose a provider whose file tools are available for that work. Codex Desktop's Computer Use plugin and its desktop-only access are not inherited by Synodica's Claude SDK, Codex CLI, Gemini CLI or API backends; desktop Computer Use is not currently connected. Likewise, Word, PDF and spreadsheet-specific skills from a provider's desktop app are not automatically inherited. Ask the employee to organize files only within the workspace and tools you configured.

Click **Kickoff** to plan. The decision owner first drafts the plan. Then each eligible, unmuted participant other than the decision owner and critic gets one read-only turn, up to the configured limit. The critic reviews the plan next, and the lead decides what proceeds. Original objection claims and reasons stay on the project board; the lead records each as accepted, rejected, unresolved or needs your decision, with a reason. A skipped reply does not mean agreement; even a skipped turn uses one model turn and may consume provider usage. Errors from one participant do not stop the remaining participants.

The board shows who participated and why someone was omitted. A role that cannot be held read-only is omitted from this planning pass. For example, a write-capable Gemini CLI profile can still be used in ordinary chat and implementation, but it is not made read-only automatically or invited to this planning pass. If an objection is marked **Needs your decision**, choose a disposition, enter your reason and press **Start**; planning waits for you. Unresolved objections remain visible in the project context.

If discussion is stopped, **Resume** asks only participants who have not answered. A correction creates a new instruction revision; results arriving from the old discussion are discarded, and the new plan pass uses the correction.

While work is running, use **Stop/Correct** (or the correction control shown for the active work) to interrupt and add an instruction. A small correction can continue the same work; a scope-changing correction waits for you to resume or kick off a new plan. The correction is kept with the project, and old work is not silently replayed.

For a first team discussion in a group, try:

> Everyone, independently identify one material risk in this proposal, or say “No objection.” For each risk, give the claim, evidence or label it as a hypothesis, why it matters, and a concrete mitigation. Do not claim consensus.

For a project plan, put this in the project brief and click **Kickoff**:

> Build a small command-line tool that safely renames files in one folder. State assumptions, propose the smallest plan with owners, dependencies and testable acceptance criteria, then wait for my review before implementation.

For a recorded objection decision, enter a concrete reason in its board form. For example:

> Accept O-1 because the migration can be rolled back after each batch; add a rollback check to the acceptance criteria.

Choose **Accept**, **Reject** or **Keep unresolved** to match your decision. If the lead marked the issue as needing your decision, finish that form and press **Start** to continue.

## Share one office with a phone

For a shared office, deploy the backend on a server with HTTPS, then connect the Mac/Windows app to that server URL and open the same URL in the phone browser. Sign in with that office's access token. All clients then use the server's conversations, projects, provider logins and account usage. A phone browser login to a model vendor does not log the server into that vendor. Follow [Ubuntu deployment](../zh-CN/Ubuntu部署.md) and [multi-device login guidance](../zh-CN/subscriptions/06-Ubuntu与多端登录位置.md); this guide does not create a public server or URL for you.

## If something does not work

- **Provider is unavailable:** confirm the CLI is installed and logged in as the backend's operating-system user; on Ubuntu also check the service user's `HOME` and `PATH`.
- **Provider check passes but a reply fails:** confirm the persona's selected model and the account's access to it. A status check is not a paid inference test.
- **Quota is missing:** unsupported or unavailable quota data is not the same as zero. Gemini Google subscription quota is not integrated.
- **Pet opens but cannot chat independently:** the bundled dsh-pet runtime provides its visual companion; its standalone chat service is not integrated.
- **Windows does not launch:** the x64 ZIP contents were checked, but Windows hardware acceptance is still pending. Keep the extracted directory intact rather than disabling security controls.
- **A phone shows a different office:** check the server URL and sign-in token. Separate local offices do not merge automatically.

- **Desktop pet and balance:** In the desktop app, set the original dsh-pet's display mode to **Desktop** in its settings to show it outside the app window. Its **Balance** action shows one account from the local usage cache at a time; it does not query the provider again. Open **Usage and quotas** or **Quota summary** from the pet menu for account windows such as five-hour, weekly and monthly limits when the provider reports them. The native Mac theme was verified; the user confirmed the original pet floats outside the app window. Windows hardware remains untested. If the balance says unavailable before a current snapshot exists, refresh Usage and quotas once; the pet itself does not query accounts.

Synodica's original contributions use the source-available [PolyForm Noncommercial 1.0.0 license](../../LICENSE), with attribution in [NOTICE](../../NOTICE). Redistribution must credit Synodica and retain the original repository link, NOTICE and license. Commercial use of those contributions requires permission; the project is not OSI-approved open source. Upstream OpenGrokBot retains separate MIT rights in [licenses/OpenGrokBot-MIT.txt](../../licenses/OpenGrokBot-MIT.txt).


### What is new in 0.5.3

Group discussions can continue across turns when you explicitly ask the group to discuss a point, even if you do not generate another `@everyone` mention. At least two unmuted participants are needed; this path does not call the router to pick a model. The default reply budget is four turns, and message/per-person budgets also apply. The end notice tells you to continue discussion when appropriate. A clear stop or negative response is treated as an instruction to stop, not as a debate prompt. Multiple `@Name` targets use global scope.

In an ordinary group, an `@Name` correction or reply quoting that employee targets only that person and required approvals; other members can continue. The corrected employee waits for the current round and existing reply queue to finish, then gets a single targeted turn instead of starting in parallel. A project-workflow correction still applies to the whole project. A direct employee reply stays exclusive to that employee, and a single `@Name` takes precedence over broad discussion. Invalid targets and forged quote references are rejected; multiple distinct targets do not cancel each other's work.

### What was added in 0.5.2

On macOS, Synodica uses `codex` from `PATH` first; if it is unavailable there, it can discover the CLI bundled with an installed ChatGPT or Codex desktop app. It reuses an available Codex login without exporting tokens or installing a second CLI, and calls the CLI engine rather than the desktop UI. This discovery is not supported on Windows.

An optional Claude Code / Anthropic-compatible gateway can be configured as a separate provider. Choose x-api-key or Bearer authentication, then enter the gateway root, its own credential and exact model IDs. Changing the endpoint origin requires a fresh credential; saved official keys and OAuth tokens are not forwarded. Gateway setup does not modify global Claude settings or sign-ins. Settings also include completed Chinese localization and layout repairs.

These describe available configuration and routing behavior; this guide does not claim that a real gateway, account or model call was verified. See the [gateway guide](../zh-CN/subscriptions/07-Claude中转与Antigravity.md). Google subscription login uses Gemini CLI's official browser flow; Google AI Studio API is a separate no-CLI option with separate billing. Kimi Code membership uses a Code Console API key; Kimi CLI's `/login` OAuth flow is not imported by Synodica.
