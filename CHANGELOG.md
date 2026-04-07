# Changelog

## Unreleased

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
