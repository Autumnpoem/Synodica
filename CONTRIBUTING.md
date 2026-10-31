# Contributing to Synodica

Use Node.js 22 or newer. Run `npm ci`, `npm run pet:install`, then `npm run dev`.

Before opening a pull request, run `npm run typecheck`, `npm test`, `npm run test:client` and `npm run build`. Include a screenshot for visual changes and meaningful regression coverage for behavior changes.

Keep edits scoped. Preserve existing offices, provider credentials, endpoints, permissions and user-customized personas. Never commit team.json, data/, environment files, generated release packages or authentication material. Backend responses containing the team must pass through publicTeam().

The interface supports English and Simplified Chinese. Translations live in shared/i18n.ts and shared/locale-zh-CN.ts. Source changes should retain upstream copyright and third-party notices. See CODE_OF_CONDUCT.md for participation expectations.

Contributions to original Synodica code are offered under the project's PolyForm Noncommercial 1.0.0 terms. Preserve NOTICE, the upstream MIT license and third-party notices. Noncommercial learning, modification and sharing are welcome; do not describe these terms as an OSI-approved open-source license.
