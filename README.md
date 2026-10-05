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

**Requirements:** macOS + Google Chrome, or experimental Windows + Microsoft Edge, and [Node.js 24+](https://nodejs.org/). This is an unofficial project for UNNC / Nottingham Moodle. Synchronization is manual. Windows + Edge has experimental adaptations, pending real Windows validation; other Moodle installations have not been verified.

<a id="installation"></a>

## Installation

1. Download the ZIP attachment with the highest version number from [Releases](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases), then extract it to a permanent program directory.
2. On macOS open `scripts/setup.command`; on Windows open `scripts/setup.cmd` (experimental). The launcher checks prerequisites, installs dependencies with your confirmation, builds the server, and starts setup.
3. Sign in to Moodle in the dedicated browser, complete MFA, select your courses, and confirm the materials directory. Choose automatic course/section folders or your existing folder structure; existing-folder mappings are then confirmed in Codex. The final step recommends installing the Codex skill; press Enter to accept or enter n to skip.
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

Stop all old Moodle MCP/CLI processes before updating. On first startup, version 0.4.5 moves legacy management files into `_moodle` beside `materials`; see [storage migration and recovery](docs/USAGE.md#management-directory-upgrade). Reconnect the Moodle MCP server or restart Codex after updating. Then continue synchronization in Codex. Program updates preserve separately installed skills; run `npm run install-skill` if you previously skipped installation.

**Reinstalling older versions:** if `npm run update` is unavailable or the installed version cannot be upgraded directly, stop the old MCP server and reinstall using the installation steps above. Preserve the materials directory, `_moodle` (or legacy `state` and `courses.json`), and existing settings; remove only the program files. If program and data share a directory, back up the data separately before removing it. Use the previous program path where possible; otherwise update the MCP configuration to the new path. Existing materials do not need to be downloaded again.

The updater supports ZIP installations. Git checkouts must be updated through Git. Published prereleases are included in version selection; drafts are excluded. Network failures should be retried after connectivity is restored.

## Connect to Codex

From the program directory, run:

```sh
npm run codex-config
```

Add the printed `[mcp_servers.moodle_local]` block to your Codex MCP configuration, preserving other entries. This command prints configuration; it does not edit it. The server starts with `node /absolute/project/dist/src/server.js`.

Setup offers the recommended skill installation on macOS and Windows. Existing users can run `npm run install-skill` separately; it does not require school login. The installer uses `~/.agents/skills/unnc-moodle`, reuses an existing legacy `~/.codex/skills/unnc-moodle`, or uses `CODEX_HOME/skills/unnc-moodle` when configured. Identical installations are left alone; differing or unsafe existing skills are not overwritten. Back up a differing skill outside the skills directory and review it before replacing it. A skill conflict does not undo completed MCP setup. The supplied skill instructions are in Chinese; the MCP tools accept the same requests in English or Chinese.

For AI-assisted deployment, include the skill step unless the user opts out: after authorization, run `npm run install-skill -- --yes`, check its output, and finish MCP configuration separately. Installing the skill does not connect MCP. Users can then simply say “Synchronize my Moodle courses”; explicit `$unnc-moodle` invocation is optional.

Restart Codex, then check `get_sync_settings` and `check_connection`. Downloads require a confirmed materials directory and selected courses. If login has expired, run `npm run login` and complete authentication yourself.

## Usage

| Task | Codex request |
|---|---|
| Synchronize materials | “Synchronize my selected Moodle courses.” |
| Download newly discovered materials | “Run a quick synchronization of my Moodle courses.” |
| Organize existing downloads | “Organize my existing Moodle materials without downloading them again.” |
| Add a course | “Show my Moodle courses so I can select another course to synchronize.” |

The data root normally contains `materials` and `_moodle`. Course configuration, sync state and recognized legacy upgrade backups live in `_moodle`, which stays visible for recovery on both macOS and Windows. In automatic mode files appear under `materials/Course name/Moodle section/Resource title.ext`. Single-file resources use the Moodle title to distinguish, for example, Seminar 1 and Seminar 1 (Solutions); folder children retain their filenames. Historical versions are stored in `materials/.history`. Existing-folder mode uses user-confirmed category rules, rather than inferring categories from file order or type. Annotated files and personal notes are retained.

Quick synchronization discovers new files but does not check remote changes to previously recorded files. Full synchronization checks updates. Organize mode refreshes the local folder layout without downloading materials. Additional courses require your approval.

## Documentation

- [Usage, storage, and troubleshooting](docs/USAGE.md) · [中文](docs/USAGE.zh.md)
- [Testing and limitations](docs/TESTING.md) — Chinese maintainer documentation
- [Release process](docs/RELEASE.md) — Chinese maintainer documentation

The server reads only selected courses that your account can access. It does not submit assignments, send messages, or modify school content. Authentication uses a dedicated browser profile; passwords and MFA codes are entered by the user. Keep login sessions, downloaded materials, and personal course configuration out of public repositories.

## Style references

The following projects guide this project's documentation and presentation style:

- [Magenta CLI](https://github.com/Minions-Land/Magenta-CLI): distinct Installation and Update sections, prominent commands, and actionable upgrade guidance.
- [Levis](https://github.com/CatVinci-Studio/Levis): an English landing page with visible language switching, concise introductions, and consistent multilingual documentation.

Future documentation changes should follow these conventions: formal, concise wording; two primary entry points for installation and updates; and equivalent English and Chinese instructions. Commands and support claims must reflect this project's verified implementation.

## License

[MIT](LICENSE). The license covers this project's code, not university materials, branding, or third-party content.

## Windows (experimental)

Use Node.js 24+ and Microsoft Edge, without WSL. Open `scripts/setup.cmd` or run the npm installation commands in PowerShell / CMD. Generate correctly escaped MCP paths with `npm run codex-config`. The same setup wizard offers skill installation; its paths and standalone command are described above.

Settings and the dedicated Edge profile live under `%LOCALAPPDATA%/moodle-mcp`, falling back to `AppData/Local` under the user directory. Materials default to `Documents/MoodleSync`. Paste the materials path from `get_sync_settings` into File Explorer. Windows permissions depend on the user directory ACL; POSIX mode flags do not provide equivalent macOS protection.

Automatic updating remains macOS-only. On Windows stop MCP and dedicated Edge, keep the old program directory, install/build in a new program directory, update the MCP entry, and recheck settings. Preserve configuration and materials.

The shared core and manifest schema remain unchanged. Real Windows installation, school login/MFA, file locking, long paths, ACL, and synchronization still require validation. Deep paths can encounter Windows path limits. macOS test results do not establish Windows support.

Windows uses a new dedicated `edge-profile` directory. Existing Windows Chrome profiles are preserved and are not imported; sign in again with Edge. Course settings and materials remain unchanged. If you explicitly set `MOODLE_PROFILE_DIR`, point it at a new dedicated Edge directory rather than the old Chrome profile. macOS retains its Chrome profile.

## Use your existing folders

Tell Codex: “Use my existing course folders, put lectures in Lecture and seminars in Seminar, show me the mapping before saving.” Codex reads approved Moodle resources and their available descriptions, inspects the folders you authorize, and saves confirmed literal keyword rules or individual resource assignments through `configure_organization`. Rules persist under `_moodle/routing.json` and take effect without restarting MCP. Setup offers both folder modes; choosing existing folders initially leaves rules empty so nothing unclassified is downloaded.

A shared existing root can contain multiple course folders. Targets must already exist beneath it. Unmatched or ambiguous resources are skipped and reported for confirmation. Explicit resource assignments override keywords; once classified, a downloaded resource retains its folder even if renamed. To correct a classification, confirm an explicit resource assignment. Keywords are case-insensitive substrings of title, available description, Moodle section and filename; no PDF content analysis or automatic semantic classification is performed.

Existing files are not adopted as synchronized copies; same-name collisions receive a suffix. Notes and annotations are preserved. Moving a mapped folder causes a reported failure until its rule is updated. Historical downloads remain in the original `materials/.history`; choosing a different output root does not migrate old files. Stop old MCP/CLI processes before upgrading, reconnect the new server, and read settings back. Use organize mode to rename tracked, unedited legacy files from their old generic names without downloading content; modified copies are retained separately.
