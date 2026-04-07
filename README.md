```
███████╗██╗  ██╗██╗██╗     ██╗         ███████╗██╗   ██╗███╗   ██╗ ██████╗
██╔════╝██║ ██╔╝██║██║     ██║         ██╔════╝╚██╗ ██╔╝████╗  ██║██╔════╝
███████╗█████╔╝ ██║██║     ██║         ███████╗ ╚████╔╝ ██╔██╗ ██║██║     
╚════██║██╔═██╗ ██║██║     ██║         ╚════██║  ╚██╔╝  ██║╚██╗██║██║     
███████║██║  ██╗██║███████╗███████╗    ███████║   ██║   ██║ ╚████║╚██████╗
╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝    ╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝

Sync local repo-backed agent skills across Codex, Claude Code, Cursor, Gemini, Hermes, and more.
```

`skill-sync` keeps local `SKILL.md` sources installed into agent harnesses as symlinks, with drift checks, source-topology diagnostics, conflict detection, and restoreable backups.

## Why This Exists

`npx skills` is excellent for public and package-based skill workflows.

`skill-sync` solves a different problem:

- Your skills live in local source repos, not `node_modules`
- You want one source of truth per skill repo
- You use multiple harnesses with different skill roots
- You want safe sync, dry runs, machine-readable output, and backups before anything gets clobbered

## What It Does

- Scans one or more projects roots such as `~/_dev`
- Discovers:
  - top-level `SKILL.md`
  - nested `skills/*/SKILL.md`
- Detects installed harness skill roots
- Supports scoped installs for harness-local skills
- Plans drift without changing anything
- Syncs symlinked installs into harnesses
- Warns when the same skill slug appears multiple times in your configured project roots
- Flags malformed or missing skill frontmatter before Codex or another harness silently skips indexing a skill
- Flags recursive harness traversal hazards that tools like OpenCode will try to parse, including nested descendant `SKILL.md` files and missing root skill files
- Refuses to overwrite unmanaged conflicts silently
- Creates harness `skills` backups and restores them later

## Quick Start

Install globally:

```bash
npm install -g @light-merlin-dark/skill-sync
```

Initialize config:

```bash
skill-sync config init
```

Inspect detected harnesses:

```bash
skill-sync harnesses
```

Inspect discovered skill sources:

```bash
skill-sync sources
```

Check drift:

```bash
skill-sync doctor
skill-sync doctor --verbose
```

Execute:

```bash
skill-sync execute
skill-sync sync
# Apply safe changes even if some entries conflict (still exits non-zero)
skill-sync execute --continue-on-conflict
```

Shortcut:

```bash
ss
ss doctor
ss execute
```

## Default Model

By default `skill-sync` uses:

- config and state home: `~/.skill-sync`
- default projects root: `~/_dev`
- symlink-first installs

It complements `npx skills`; it does not replace it.

## Commands

Core:

```bash
skill-sync doctor
skill-sync check
skill-sync execute
skill-sync sync
skill-sync sources
skill-sync harnesses
```

Backups:

```bash
skill-sync backup create
skill-sync backup list
skill-sync backup restore <backup-id>
```

Config:

```bash
skill-sync config init
skill-sync roots list
skill-sync roots add /path/to/projects
skill-sync roots remove /path/to/projects
skill-sync harness list
skill-sync harness add my-tool ~/.my-tool/skills
skill-sync harness remove my-tool
```

Agent-friendly options:

```bash
skill-sync doctor --json
skill-sync execute --dry-run --json
skill-sync backup restore <id> --dry-run
skill-sync doctor --projects-root /path/to/projects --harness codex
skill-sync doctor --home /tmp/fake-home
```

Bare `skill-sync` / `ss` prints a high-signal landing/help view. Human output defaults to a concise summary. Use `--verbose` when you want the full per-entry plan, including orphan install details during `doctor`.

## Supported Harness Model

Built-in harness roots currently include:

| Harness | Global skills root |
| --- | --- |
| Codex | `~/.codex/skills` |
| Agents / Cline / Warp | `~/.agents/skills` |
| Claude Code | `~/.claude/skills` |
| Cursor | `~/.cursor/skills` |
| GitHub Copilot | `~/.copilot/skills` |
| Gemini CLI | `~/.gemini/skills` |
| Antigravity | `~/.gemini/antigravity/skills` |
| Droid / Factory | `~/.factory/skills` |
| Hermes | `~/.hermes/skills` |
| KiloCode | `~/.kilocode/skills` |
| OpenCode | `~/.config/opencode/skills` |
| Plain skills root | `~/.skills` |

You can add more:

```bash
skill-sync harness add codex-beta ~/.codex-beta/skills
```

## Safety Rules

- `doctor` never mutates
- `execute` / `sync` only replace entries the tool owns or missing entries
- unmanaged conflicts are reported, not overwritten
- duplicate `_dev` slugs are surfaced before harness-level sync planning
- malformed skill metadata is surfaced during `doctor`, including missing YAML frontmatter or missing `name:`
- shared harness roots such as `~/.agents/skills` and `~/.skills` can still promote fallback sources when no project-root source exists for the same slug
- vendor harness roots such as Codex, Hermes, Claude Code, Cursor, OpenCode, KiloCode, and similar tool-local folders default to local-only installs unless frontmatter explicitly widens the scope
- harness-native skills can stay local-only via frontmatter instead of being fanned out everywhere
- recursive harness-root pollution is surfaced during `doctor` before OpenCode or another recursive scanner hits duplicate or unreadable descendant skill files
- backups snapshot harness `skills` directories before or after risky changes
- restore can recreate symlinks when the original source still exists
- restore falls back to minimal backed-up `SKILL.md` content when the source no longer exists

## Backup and Restore

Create a backup:

```bash
skill-sync backup create
```

List backups:

```bash
skill-sync backup list
```

Restore one:

```bash
skill-sync backup restore 2026-03-25T13-45-00-000Z
```

Dry run a restore:

```bash
skill-sync backup restore 2026-03-25T13-45-00-000Z --dry-run
```

Backups live under:

```bash
~/.skill-sync/backups/
```

Each backup includes:

- a manifest of harness roots and entries
- original symlink targets when present
- backed-up `SKILL.md` snapshots for restore fallback
- a state snapshot for managed entries

## JSON Output

`skill-sync` is designed for agents first.

Example:

```bash
skill-sync doctor --json
```

Returns structured data for:

- discovered sources
- source warnings and source errors
- selected harness roots
- planned actions
- conflicts
- changes and ok counts

## How Source Discovery Works

For every immediate child repo under each configured projects root, `skill-sync` looks for:

- `<repo>/SKILL.md`
- `<repo>/skills/*/SKILL.md`

It also inspects detected harness roots. Project-root sources win over harness-installed sources when the same slug exists in both places.

Harness-root sources can also declare install scope in frontmatter:

- `skill-sync-scope: local-only` keeps that source on its owning harness only
- vendor harness roots default to this behavior even without explicit frontmatter
- shared roots like `agents` and `skills` stay global by default
- `skill-sync-install-on: [codex, hermes]` limits installs to specific harness ids
- `skill-sync-scope: global` explicitly widens a harness-root source back out to other harnesses

Canonical install names default to:

- `slugify(frontmatter name)` when `name:` exists
- otherwise a folder-derived fallback

You can override install names per source and per harness in `~/.skill-sync/config.json`.

You can also exclude or prefer project paths during discovery:

```json
{
  "discovery": {
    "ignorePathPrefixes": [
      "/Users/you/_dev/some-upstream-clone"
    ],
    "preferPathPrefixes": [
      "/Users/you/_dev/packages/stack"
    ]
  }
}
```

## Local Development

Install dependencies:

```bash
bun install
```

Run the CLI directly:

```bash
bun run src/index.ts doctor
```

Run tests:

```bash
bun test tests/unit tests/integration
```

Build:

```bash
bun run build
```

## Release

Patch release:

```bash
make release
```

This bumps the patch version, moves the `## Unreleased` notes into the new versioned changelog section, runs lint/test/build, publishes to npm, commits the release, pushes `main`, tags the release, and creates or updates the GitHub release.

## Positioning

Use `npx skills` when:

- you are installing public or package-provided skills
- your source of truth is a GitHub repo or package ecosystem workflow

Use `skill-sync` when:

- your source of truth is local repos on disk
- you want symlinked installs into multiple harnesses
- you need backup and restore around those installs

## License

MIT

---

Built by [Robert E. Beckner III (Merlin)](https://rbeckner.com)
