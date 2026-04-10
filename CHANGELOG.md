# Changelog

## Unreleased

## 0.3.6 (2026-04-10)
- Switch Codex installs from `SKILL.md` wrapper symlinks to full materialized skill directories so repo-backed `_dev` skills are discoverable in Codex IDE without depending on symlinked `SKILL.md` support
- Materialize `~/.agents/skills` installs whenever Codex is selected, and route shared Codex-visible skills through that bridge instead of duplicating them under both `~/.agents/skills` and `~/.codex/skills`
- Preserve full Codex skill package contents during sync (for example sibling files like `agents/openai.yaml`) and stop cache-bust from mutating canonical `_dev` source files once Codex installs are materialized
- Add `stabilize` command to run a safe end-to-end remediation flow (`repair-sources` + sync plan + cache-bust) with dry-run default and `--execute` apply mode
- Add `codex-audit` command to verify Codex install integrity (symlink + YAML validity + disabled-by-config checks) and optionally repair invalid/stale `~/.codex/config.toml` `skills.config` entries
- Extend `codex-audit` to parse the active Codex session skill snapshot and report runtime visibility gaps (skills installed on disk but missing from the live Codex skill list)
- Extend `codex-audit` again to probe Codex's live `skills/list` workspace visibility via the app-server, so SkillSync can detect skills that are installed on disk but still invisible in the IDE's Plugins > Skills list
- Treat stale Codex runtime snapshots as uncertain (non-failing) by default, add `--strict-runtime` and `--runtime-max-age-hours`, and scope install-integrity failures to SkillSync-managed Codex entries
- Detect Codex thread snapshot/install drift explicitly: when a missing runtime skill was installed or updated after snapshot capture, report it as `runtime-snapshot-drift` and fail audit/stabilize so stale per-thread skill seeds are not marked healthy
- Detect Codex root-recognition gaps explicitly: when missing managed skills reappear only after supplying `perCwdExtraUserRoots`, report that as a failing workspace-visibility issue instead of a healthy install
- Add `stabilize --fix-codex-config` so Codex `skills.config` drift repair can run in the same end-to-end remediation flow
- Make `stabilize` include the same Codex workspace visibility probe, so a "stable" result now requires both install integrity and actual IDE discoverability for the current workspace
- Detect cross-harness top-level symlink fanout (for example one harness linking directly into another harness root) as a traversal hazard in `doctor`
- Surface high duplicate source fanout for a single slug as an explicit warning (`fanout-high`) to make mirror cleanup actionable before harness indexing drifts
- Expand cache-bust coverage to touch harness roots, installed entry paths, and source skill targets so Codex/harness watchers pick up installs without restart
- Expand Codex cache-bust targets to include `state_5.sqlite`, `session_index.jsonl`, and the active thread rollout file (when `CODEX_THREAD_ID` is set) to improve no-restart refresh behavior
- Fix Codex runtime snapshot selection to prioritize parsed snapshot capture timestamps over touched file mtimes, so `codex-audit` does not treat cache-busted stale session files as the latest runtime state
- Fix Codex thread snapshot matching to use rollout filename thread ids instead of loose content substring matching, preventing cross-thread false positives during runtime visibility audits
- Add `SKILL_SYNC_SKIP_CODEX_APP_SERVER=1` for controlled environments and tests that need to skip the live Codex app-server workspace probe
- Resolve harness wrapper `SKILL.md` symlinks back to canonical source paths during discovery so duplicate/fanout diagnostics stop flagging normal mirror installs as source collisions
- Skip non-owning harness mirrors when deriving harness-root fallback sources, keeping local-only/vendor scope semantics stable
- Make `clean` scan harness roots directly (including unmanaged entries), so top-level directory symlink pollution is detected even when state tracking is stale or missing
- Treat unmanaged top-level directory symlinks at desired install paths as auto-repairable wrapper drift instead of hard conflicts

## 0.3.5 (2026-04-08)
- Discover skill repos nested one level under configured project roots (for example `_dev/db/db-cli` and `_dev/services/*`) so canonical `_dev` skills are not silently missed when container directories are used
- Ignore hidden and known noise nested directories (`.claude`, `node_modules`, `.git`, `.worktrees`, `.refactor-backups`) during nested repo discovery to prevent accidental fallback/pollution sources

## 0.3.4 (2026-04-07)
- Enforce wrapper-directory installs for managed skills across harnesses (`<skill>/SKILL.md` symlink) so top-level harness entries are no longer directory symlinks
- Add execute-time cleanup for unmanaged top-level harness symlinks that point to directories, preventing recurring parser recursion/pollution patterns
- Tighten wrapper health checks so copied `SKILL.md` files are repaired back to canonical symlinks instead of being treated as fully synced
- Switch frontmatter parsing to a strict YAML parser and treat invalid YAML as a blocking source error (for example unquoted `description:` text containing `: `)
- Add regression coverage that blocks `execute` when a skill would install but still fail Codex/OpenCode YAML parsing

## 0.3.3 (2026-04-07)
- Add `cache-bust` command to force harness reload watchers without restarting apps by touching installed skill files
- Add Codex-specific cache-bust targets (`~/.codex/config.toml` and `~/.codex/.codex-global-state.json`) to trigger refresh behavior seen in live sessions
- Add regression coverage for Codex cache busting so installed skill metadata updates are picked up deterministically

## 0.3.2 (2026-04-07)
- Surface broken nested `skills/<slug>/SKILL.md` symlinks as blocking source errors instead of silently skipping them during discovery
- Add `repair-sources` command to restore broken nested skill files from `SKILL.md.pre-migration-backup` snapshots (with dry-run support)
- Expand diagnostics so `doctor`/`check` explicitly report broken nested skill links that can trigger parser failures in harnesses like OpenCode

## 0.3.1
- Treat vendor harness roots as local-only by default while keeping shared roots like `~/.agents/skills` and `~/.skills` portable unless frontmatter overrides the scope
- Add built-in harness detection for OpenCode (`~/.config/opencode/skills`, with `~/.opencode/skills` as a legacy fallback) and KiloCode (`~/.kilocode/skills`)
- Make `doctor` surface recursive harness traversal hazards that OpenCode-style scanners hit: nested descendant `SKILL.md` files, missing root `SKILL.md`, and symlink-loop style traversal errors
- Add regression coverage for vendor-local harness mirroring, OpenCode/KiloCode detection, and recursive harness pollution

## 0.3.0 (2025-04-06)
- **Always skip repo-root SKILL.md files** — top-level skill files at the project root are now treated as pollution warnings regardless of whether the repo has `node_modules` etc. This prevents CLIs (opencode, codex, etc.) from traversing entire project trees when following symlinks
- **Add `clean` command** — detects and removes polluted symlinks that point to entire project directories instead of scoped `skills/<slug>/` subdirectories
- **Harness-root pollution resolution** — when a harness symlink target is a project root, skill-sync now resolves to the nested `skills/<slug>/` subdirectory if one exists
- Updated `doctor` warnings to explain why repo-root skills are skipped and how to fix them

## 0.2.0
- Detect and skip repo-root `SKILL.md` files in polluted repos (repos containing `node_modules`, `.worktrees`, or `.refactor-backups`) to prevent agents from discovering spurious skills through broad symlinks — nested `skills/<slug>/SKILL.md` sources are unaffected and always safe
- Add `--continue-on-conflict` flag to `execute` and `sync` commands: applies non-conflicting changes and exits non-zero when conflicts remain
- Move skill-sync's own `SKILL.md` into `skills/skill-sync/` subdirectory as a canonical example of the nested pattern
- Remove one-time migration script and dead code (`copyMaterialized`, `pruneStateForRoots`)

## 0.1.6
- Make `doctor` flag malformed or missing skill frontmatter so Codex-indexing failures are surfaced before sync looks healthy
- Read the CLI version from `package.json` so `skill-sync --version` stays aligned with the shipped package

## 0.1.5
- Make `make -n release` a true dry run by avoiding recursive `make` inside the release recipe

## 0.1.4
- Make bare `skill-sync` / `ss` show a high-signal landing/help view instead of mutating
- Add `doctor` as the high-signal diagnostic command and `execute` as the explicit mutating command; keep `check` and `sync` as compatibility aliases
- Discover harness-installed skills as fallback sources, while keeping project-root sources authoritative for the same slug
- Add frontmatter-based install scoping so harness-native skills can stay local-only or target specific harness ids instead of syncing everywhere
- Tighten symlink-first behavior by repairing matching copied installs instead of treating them as fully healthy
- Align CLI `--version` output with the package version
- Harden `make release` so patch releases can auto-bump version/changelog, publish, commit, tag, push, and refresh the GitHub release in one path

## 0.1.3
- Makefile release: robust GitHub release notes generation via `--notes-file` and correct escaping of `awk $0`.

## 0.1.2
- Report installed “orphan” skills during `skill-sync check` (helps explain why a harness skill UI didn’t update)
- Add `make release` target (pre-publish → npm publish → git tag + push → GitHub release create/update)
- Minor: manager skill naming support (codex-style capitalized display)

## 0.1.1
- Add source-topology diagnostics for duplicate skill slugs in configured project roots
- Surface resolved duplicates as warnings and unresolved duplicates as blocking errors in `check` and `sources`
- Limit backups to `SKILL.md` snapshots plus manifest/state metadata
- Fix backup traversal loops when harness installs point through chained symlinks

## 0.1.0
- Initial release of `skill-sync`
- Source discovery for top-level and nested `SKILL.md`
- Harness discovery, drift checks, sync, backup, and restore
- Agent-friendly JSON output and dry-run support
