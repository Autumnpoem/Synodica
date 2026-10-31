# Third-party notices

Synodica includes or uses the third-party work listed below. Each entry names what is used,
where it comes from, and the license it is used under.

## OpenGrokBot (upstream project)

- Original author: Mahmoud Amr (FortuneCode).
- License: MIT; the complete original copyright and license are preserved in `licenses/OpenGrokBot-MIT.txt`.
- Synodica is derived from OpenGrokBot. Its added original contributions use PolyForm Noncommercial 1.0.0; the upstream MIT rights remain unchanged.

## Other installed dependencies

Runtime and desktop dependencies retain their own licenses, including Electron, React, Express and the Claude Agent SDK. Bundled dependency license files are distributed with those packages. The Synodica license does not replace their licenses or provider service terms.

## dsh-model-meter 0.6.1 (adapted code)

- Source: https://github.com/Lirunhua/dsh-model-meter
- Pinned commit: `5aee9ac17840e9dae61ae207ffb0a04c1f7ac2db` (package version 0.6.1)
- License: MIT
- Used in:
  - `shared/usage.ts`: parts of the quota/balance response parsing and decimal handling are adapted
    from `providers.js`.
  - `server/usagemeter.ts`: request handling (bounded response body, redirect refusal, per-account
    de-duplication) follows the approach of `providers.js`.
- Changes: rewritten in TypeScript, reduced to the providers and fields Synodica shows, and
  connected to Synodica's own provider configuration. No DeepSeek Harness plugin code, client
  bundle, or assets are included.

```
MIT License

Copyright (c) 2026 Model Meter contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## dsh-pet 0.3.8 (used unmodified, installed separately)

- Source: npm package `dsh-pet@0.3.8`
  (https://registry.npmjs.org/dsh-pet/-/dsh-pet-0.3.8.tgz, integrity pinned in
  `scripts/pet-install.mjs`)
- Author: PC2005-cloud
- License: MIT (Copyright 2026 PC2005-cloud)
- Use: the original runtime and animations are installed by `npm run pet:install` into
  `pet-runtime/node_modules/` and run without modification. No file of the package is copied into
  this repository; the package's own `LICENSE` file is installed with it and is the authoritative
  license text.
