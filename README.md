<h1 align="center">UNNC Moodle MCP</h1>

<p align="center">
  A local MCP server for downloading and updating Nottingham Moodle course materials in Codex.
</p>

<p align="center">
  <a href="https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases"><strong>Download</strong></a> ·
  <a href="#installation">Installation</a> ·
  <a href="#update">Update</a> ·
  <a href="./docs/README.zh.md">简体中文</a>
</p>

## Overview

Download materials from selected courses, organize them by course and Moodle section, and keep them up to date through Codex. Previous versions and local annotations are preserved.

**Requirements:** macOS, Google Chrome, and [Node.js 24+](https://nodejs.org/). This is an unofficial project for UNNC / Nottingham Moodle. Synchronization is manual; Windows and other Moodle installations have not been verified.

<a id="installation"></a>

## Installation

1. Download the ZIP attachment with the highest version number from [Releases](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases), then extract it to a permanent program directory.
2. Open `scripts/setup.command`. The launcher checks prerequisites, installs dependencies with your confirmation, builds the server, and starts setup.
3. Sign in to Moodle in the dedicated browser, complete MFA, select your courses, and confirm the materials directory.
4. Follow [Connect to Codex](#connect-to-codex), then restart Codex.

Alternatively, run these commands in the extracted program directory:

```sh
npm run doctor
npm ci
npm run build
npm run setup
```

Setup does not download course materials. Once connected, ask Codex:

> Check my Moodle connection and settings, then synchronize my selected courses.

<a id="update"></a>

## Update

Run this command in your existing program directory:

```sh
npm run update
```

The updater downloads the newest published release, installs dependencies, and builds it before replacing the existing program. The installation path, settings, login session, and downloaded materials are retained. A failed replacement rolls back to the previous program.

Reconnect the Moodle MCP server or restart Codex after updating. Then continue synchronization in Codex.

**Reinstalling older versions:** if `npm run update` is unavailable or the installed version cannot be upgraded directly, stop the old MCP server and reinstall using the installation steps above. Preserve the materials directory, `state`, `courses.json`, and existing settings; remove only the program files. If program and data share a directory, back up the data separately before removing it. Use the previous program path where possible; otherwise update the MCP configuration to the new path. Existing materials do not need to be downloaded again.

The updater supports ZIP installations. Git checkouts must be updated through Git. Published prereleases are included in version selection; drafts are excluded. Network failures should be retried after connectivity is restored.

## Connect to Codex

From the program directory, run:

```sh
npm run codex-config
```

Add the printed `[mcp_servers.moodle_local]` block to your Codex MCP configuration, preserving other entries. This command prints configuration; it does not edit it. The server starts with `node /absolute/project/dist/src/server.js`.

Optionally install the supplied skill by copying `skills/unnc-moodle` to `~/.codex/skills/unnc-moodle` (or the skills directory under a custom `CODEX_HOME`). Review an existing skill before replacing it. The supplied skill instructions are in Chinese; the MCP tools accept the same requests in English or Chinese.

Restart Codex, then check `get_sync_settings` and `check_connection`. Downloads require a confirmed materials directory and selected courses. If login has expired, run `npm run login` and complete authentication yourself.

## Usage

| Task | Codex request |
|---|---|
| Synchronize materials | “Synchronize my selected Moodle courses.” |
| Download newly discovered materials | “Run a quick synchronization of my Moodle courses.” |
| Organize existing downloads | “Organize my existing Moodle materials without downloading them again.” |
| Add a course | “Show my Moodle courses so I can select another course to synchronize.” |

Files appear under `materials/Course name/Moodle section/Filename`. Historical versions are stored in `materials/.history`. No teaching categories are inferred or translated. Annotated files and personal notes are retained.

Quick synchronization discovers new files but does not check remote changes to previously recorded files. Full synchronization checks updates. Organize mode refreshes the local folder layout without downloading materials. Additional courses require your approval.

## Documentation

- [Usage, storage, and troubleshooting](docs/USAGE.md) · [中文](docs/USAGE.zh.md)
- [Testing and limitations](docs/TESTING.md) — Chinese maintainer documentation
- [Release process](docs/RELEASE.md) — Chinese maintainer documentation

The server reads only selected courses that your account can access. It does not submit assignments, send messages, or modify school content. Authentication uses a dedicated browser profile; passwords and MFA codes are entered by the user. Keep login sessions, downloaded materials, and personal course configuration out of public repositories.

## License

[MIT](LICENSE). The license covers this project's code, not university materials, branding, or third-party content.
