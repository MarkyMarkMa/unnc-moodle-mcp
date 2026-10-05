# Usage guide

[简体中文](USAGE.zh.md) · [Project overview](../README.md)

## Installation and updates

Follow [Installation](../README.md#installation) or [Update](../README.md#update). Existing users retain their selected courses, data directory, login session, and confirmation settings. If an older installation has no updater, reinstall the program while preserving all data and configuration. Run setup again only when settings are unconfirmed or you intend to change course selection or storage.

The update command prepares and builds a published ZIP in a separate directory. It verifies the GitHub asset SHA-256 digest and public source manifest before replacing program files. It preserves the installation path and does not edit global Codex configuration or an independently installed skill. Git installations are updated through Git.

The updater retains a `previous` program backup and an `update.json` receipt in the directory printed by the command. Failed replacements are rolled back. Forced termination or power loss may require manual recovery: preserve the update directory, verify the target and backup in `update.json`, and restore the program before clearing stale locks. Never remove locks while an update or synchronization is active.

## Codex skill

Setup offers recommended skill installation on both macOS and Windows. Press Enter to accept or n to skip. To install later, run `npm run install-skill`; an authorized AI deployment can use `npm run install-skill -- --yes`. The installer reports the selected location, installs without school login, and preserves any differing existing skill. See [Connect to Codex](../README.md#connect-to-codex) for destination rules and MCP configuration. MCP tools work without this skill; installing it enables Codex to match the supplied workflow to natural-language requests. Program updates do not overwrite independently installed skills.

## Synchronization modes

| Mode | CLI command | MCP request | Behavior |
|---|---|---|---|
| Full | `npm run sync` | `sync_courses` with `mode: "full"` | Discover resources and check existing files for remote updates. |
| Quick | `npm run sync:quick` | `sync_courses` with `mode: "quick"` | Download unrecorded resources; do not check remote content changes to recorded files. |
| Organize | `npm run organize` | `sync_courses` with `mode: "organize"` | Refresh the local layout using downloaded materials; do not download files. |

All modes maintain readable course and section folders. Quick and organize modes do not report remote deletion. Quick mode does not redownload damaged or missing history files, although intact history can rebuild a missing readable copy. Quick and organize modes cannot be combined with a forced content check.

Synchronization is manual and uses serial, paced operations. Requests initiated by page subresources are not all covered by the same pacing interval. The per-file download limit is 100 MiB; response bodies are buffered.

## Course selection

`npm run courses` lists observed courses. To add courses, ask Codex to show available courses and approve the selection. MCP `select_courses` supports `mode: "add"`; the CLI equivalent is `npm run add -- COURSE_ID ...`. Only observed course IDs are accepted.

`npm run select -- COURSE_ID ...` replaces the selection. `npm run select -- --clear` clears it without deleting local materials. CLI changes require existing MCP processes to restart; changes through the MCP tools apply to that process immediately. For a new semester, use `npm run setup` or update the course selection in Codex.

## Storage

The default data directory is `~/Documents/MoodleSync`. Setup records the confirmed directory and course configuration in `~/Library/Application Support/moodle-mcp/settings.json`.

```text
MoodleSync/
  materials/
    Course name/
      Moodle section/
        Lecture.pdf
    .history/
  _moodle/
    state/
    courses.json
```

Folder resources retain their published name and nested paths. Unnamed sections use `General`. Course names come from the approved course list; section names come from Moodle. Names are not automatically translated or classified.

The readable copy shows the current version, while history retains previous versions. Readable files are independent of history: copy-on-write is used where available, otherwise a full copy consumes additional space. Duplicate names receive readable numeric suffixes. Local edits are preserved, and remote content is saved separately when necessary. Remote removal or deselection does not delete local files.

Organize mode migrates recorded numeric directories into `.history` and updates the manifest. Empty old directories are removed. Interrupted migration can be rerun. Termination between publishing a readable file and committing its state may leave an unrecorded copy; the next run conservatively creates a separate file rather than deleting it. Back up `materials` and `_moodle` before reorganizing important data.

To view the materials directory in Finder, copy the path returned by `get_sync_settings` into **⌘⇧G**.

### Management directory upgrade

Before upgrading to 0.4.5, stop all older MCP and CLI processes on macOS and Windows. On first startup the server moves root-level `state`, default `courses.json`, and directories named `升级备份-YYYYMMDD-HHMMSS` into the visible `_moodle` directory. It updates the saved default course path and retains confirmation. Materials, history and annotations stay in place; no Moodle requests or redownloads are needed. Explicit `MOODLE_COURSES_FILE` overrides and external course files are not relocated. Unrecognized user folders are left alone. Program updater backups remain at the path printed by the updater.

Existing destination entries, symlinks, operation locks or a `.moodle-storage.lock` marker stop migration rather than merging or overwriting data. Ordinary move/settings-write failures roll back moved entries. Power loss or termination may leave a partial migration and the marker: preserve and back up both layouts, stop every MCP/CLI/updater, restore each moved entry to its original root location only when that location is absent, and restore the saved course path if necessary. If both locations contain an entry, do not overwrite either; compare them before recovery. Remove the marker only after the complete old layout is restored, then restart to retry. Never delete the manifest to bypass a conflict. A completed migration is safe to start again.

### Moving the data directory

Changing the configured directory does not migrate files. Stop MCP and CLI operations, back up the old directory, and copy `materials` and `_moodle` together (or legacy `materials`, `state`, and `courses.json`) to the new directory. Retain the original copy, run setup to confirm the new location, restart MCP, and read back settings. Do not move only course files and omit their manifest. Automatic data-directory migration has not been implemented or verified against real materials.

Absolute environment variables can override settings: `MOODLE_DATA_DIR`, `MOODLE_COURSES_FILE`, `MOODLE_SETTINGS_FILE`, and `MOODLE_PROFILE_DIR`. CLI and MCP must use consistent overrides. Course and settings JSON files cannot be placed inside materials, either state directory, or the browser profile, or point to the same file. A changed data directory or course configuration path requires confirmation. `MOODLE_HEADLESS=false` displays browser automation windows.

## Tools

| Tool | Purpose |
|---|---|
| `get_sync_settings` | Read the approved courses, storage paths, and setup status. |
| `check_connection` | Check the dedicated Moodle session without exposing credentials. |
| `list_courses` | Discover enrolled courses, including hidden courses. |
| `select_courses` | Set or add user-approved, observed courses. |
| `confirm_setup` | Confirm the current storage directory and course list. |
| `list_resources` | List resources in a selected course. |
| `download_resource` | Download an observed file or folder resource. |
| `sync_courses` | Run one full, quick, or organize operation. |

Other CLI commands include `npm run settings`, `npm run login`, and `npm run doctor`. `npm run codex-config` prints an MCP configuration block without modifying global configuration.

## Troubleshooting

Inspect `failed`, `skipped`, `needsLogin`, and `stoppedReason` in the operation summary. A successful MCP call does not mean every resource succeeded. Quick-mode skips do not prove remote files are unchanged.

| Result | Action |
|---|---|
| `SETUP_REQUIRED` | Confirm the intended data directory and course selection through setup. |
| `NEEDS_LOGIN` | Run `npm run login` and complete sign-in and MFA personally. |
| `RATE_LIMITED` | Stop the batch and retry later; do not immediately loop. |
| `PROFILE_BUSY` | Check the dedicated browser and other processes; the code does not prove which process caused the failure. |
| `LOCAL_IO` | Check disk space, permissions, and local paths. |
| `STORAGE_CONFLICT` | Preserve both layouts and follow management-directory recovery above. |
| `STATE_INVALID` | Preserve the manifest and history; do not reset them to force a retry. |
| `PARSE_FAILED` | Report the unsupported page structure rather than guessing a download URL. |

Downloads retry transient network or parsing failures at most three times, with bounded delays. Authentication, permissions, and rate limits are not automatically retried. Stale `operation.lock` files may be removed only after confirming the recorded process has stopped.

## Authentication and supported content

The project uses `~/Library/Application Support/moodle-mcp/browser-profile`, a dedicated Chrome profile. It does not read or copy your everyday Chrome credentials. Session files have restricted permissions, which do not constitute encryption. Do not publish this profile, session files, course lists, materials, or private verification records.

File and published folder resources are supported. External links are reported without following them with school credentials. Assignments, forums, quizzes, and other non-file activities are skipped. Special plugins, hidden folder subtrees, video, and ZIP expansion are not guaranteed. HTML lectures are saved as files without executing their scripts during synchronization; opening them later in a browser may execute original scripts or load external assets.

To remove the local session, stop the service and dedicated browser, remove only this project's dedicated profile, and sign out through the school's normal controls as appropriate. Removing local files does not guarantee revocation of other session copies. Do not remove your personal Chrome profile.

## Verification

Run `npm test`. Tests cover configuration, course approval, parser behavior, browser DOM fixtures, update integrity, synchronization, failure handling, and release export. Chrome tests use intercepted requests and synthetic pages. The official MCP client has been tested; other clients and platforms are not claimed as verified.

Maintainer verification has included real course discovery, downloads, and reorganizing 61 existing files without redownloading. Independent public exports pass the same test suite. New accounts, future Moodle layouts, long-term session reliability, power-loss consistency, and automatic directory migration remain outside verified coverage. See [testing records](TESTING.md) and [release procedure](RELEASE.md), currently maintained in Chinese.

## References

[MCP SDK](https://modelcontextprotocol.io/docs/sdk) · [Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) · [Codex MCP](https://developers.openai.com/codex/mcp)

Windows adaptations are experimental; see the [Windows guide](../README.md#windows-experimental). Automatic updating is macOS-only; on Windows use a separate new program directory and preserve settings/materials.
