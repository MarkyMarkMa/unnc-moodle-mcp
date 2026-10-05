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

### To human

1. Download the ZIP attachment with the highest version number from [Releases](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases), then extract it to a permanent program directory.
2. On macOS open `scripts/setup.command`; on Windows open `scripts/setup.cmd` (experimental). The launcher checks prerequisites, installs dependencies with your confirmation, builds the server, and starts setup.
3. Sign in to Moodle in the dedicated browser, complete MFA, select your courses, and choose how to save materials: automatic course/section folders or your existing folders. The final step recommends installing the Codex skill; press Enter to accept or enter n to skip.
4. Follow [Connect to Codex](#connect-to-codex), then restart Codex and choose a [usage mode](#usage).

Setup does not download course materials. Existing-folder mappings are confirmed in Codex before downloading unclassified resources.

### To agent

Open Codex in the extracted program directory and send:

> Help me install and connect this UNNC Moodle MCP. Read the README first, check my environment, and install the project dependencies and bundled skill. Preserve my existing Codex configuration. Ask me to choose courses and the saving mode; I will complete Moodle login and MFA myself. Show me the MCP configuration change for confirmation before applying it. Do not start downloading until I confirm the courses, directories, and any classification rules.

For the agent: locate the downloaded project; if it is absent, guide the user to the ZIP installation above. Check Node.js 24+ and the required browser, then run these commands in the program directory after installation authorization:

```sh
npm run doctor
npm ci
npm run build
```

Have the user run `npm run setup` in an interactive terminal and complete login/MFA. Explain the two saving modes in [Usage](#usage). Unless the user opts out, include skill installation; if setup skipped it and installation is authorized, run `npm run install-skill -- --yes` and check the result. Do not overwrite a conflicting installed skill. Finish [Connect to Codex](#connect-to-codex) separately, preserving other MCP entries; skill installation alone does not connect MCP. After restarting Codex, read settings and login status back before the first synchronization.

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

Restart Codex, then check `get_sync_settings` and `check_connection`. Downloads require a confirmed materials directory and selected courses. If login has expired, ask Codex to open the dedicated login browser using the `login` MCP tool. Complete sign-in and MFA in that browser; Codex verifies the result before continuing. The tool waits up to five minutes. `npm run login` remains a fallback for clients without the tool.

## Usage

Choose either saving mode below. New users choose during setup; existing users can ask Codex to change the mode without reinstalling.

### 1. Create course folders automatically

Choose the automatic course/section mode during setup, then tell Codex:

> Check my Moodle connection and settings, then synchronize my selected courses using automatic course/section folders.

Materials appear under `materials/Course name/Moodle section/Resource title.ext`. Single-file resources use Moodle titles, such as `Seminar 1.pdf` and `Seminar 1 (Solutions).pdf`; folder children retain their filenames and nested structure.

### 2. Use your existing folders

Choose the existing-folder mode during setup and enter the shared root of your course folders. If already installed, tell Codex:

> My course materials are already organized at “PASTE YOUR FOLDER PATH”. Use the existing structure, with lectures in Lecture and seminars in Seminar. First inspect the folders and my selected Moodle resources, then show me the proposed mapping. Save the rules and download only after I confirm. Preserve existing files and notes.

Codex reviews actual resource titles, available page descriptions, and the folders you authorize it to inspect. Confirm or correct the proposed mapping once; saved rules are reused on later synchronizations and after restarting. Different resources within the same Moodle section can go into different folders. Unmatched or ambiguous new resources are skipped for confirmation; after a file is classified, its folder is retained even if the resource is renamed. To correct its classification, confirm an explicit resource assignment.

Target folders must already exist under a shared root. Moving a mapped folder causes a reported failure until the rule is updated. Rules match user-confirmed keywords or specific resources; they do not infer categories from page order or file type, or analyze PDF contents. Existing-folder mode initially has no rules, so unclassified materials are not downloaded.

**Existing files are not automatically adopted or deduplicated.** A newly downloaded file with the same name receives a suffix, which can leave duplicates; original files and annotations are preserved. Changing the output root does not migrate old materials. Historical versions remain in the original `materials/.history`.

After either mode is configured, use these requests:

| Task | Codex request |
|---|---|
| Synchronize materials | “Synchronize my selected Moodle courses.” |
| Download newly discovered materials | “Run a quick synchronization of my Moodle courses.” |
| Organize existing downloads | “Organize my existing Moodle materials without downloading them again.” |
| Add a course | “Show my Moodle courses so I can select another course to synchronize.” |

Quick synchronization discovers new files but does not check remote changes to previously recorded files. Full synchronization checks updates. Organize mode refreshes tracked local copies without downloading materials; it can rename unedited legacy files using Moodle titles, while keeping annotated copies separately. Additional courses require your approval. Check failures and skipped resources before treating a synchronization as complete.

The data root normally contains `materials` and `_moodle`. Course settings, sync state, classification rules and recognized legacy upgrade backups live in `_moodle`, which stays visible for recovery. Stop old MCP/CLI processes before upgrading, reconnect the new server, and read settings back.

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
