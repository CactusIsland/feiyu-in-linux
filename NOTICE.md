# Third-party notices

This repository contains both original code and code derived from upstream
open-source projects. The original code is MIT-licensed (see `LICENSE`).

## Aurabot / dsh-aurabot-qq

- Directory: `aurabot-src/`
- License: MIT
- Copyright: Aurabot contributors
- Upstream: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq
- Notes: `aurabot-src/` is included so the deployment can be reproduced
  without guessing which host-plugin version the custom modules target.
  It keeps its own `LICENSE` file.

## dsh-douyin-toolkit / dy-cli

- Referenced by: the Douyin module documentation and deployment notes.
- License: MIT
- Copyright: 2026 SakuraMat0u (original work), 2026 JianHeShui (modifications)
- Not bundled: install it separately and point `DOUYIN_HOME` / `dy-cli` at it.

## douyin-im

- Referenced by: `bridges/dy-im/package.json`
- License: see the package's own license file after `npm install`.
- Not bundled: installed as an npm dependency.

## External services and binaries

NapCat / QQ NT, DeepSeek Harness (DSH), Caddy, Node.js, SQLite, and any model
providers are external dependencies. They are not bundled in this repository
and remain subject to their own licenses and terms of service.

## Persona and assets

`personas/dafeiyu.example.md` is a sanitized example. The character name and
persona are part of this project's configuration; no real account IDs,
phone numbers, cookies, API keys, chat logs, or memories are included.
