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
- Plans drift without changing anything
- Syncs symlinked installs into harnesses
- Warns when the same skill slug appears multiple times in your configured project roots
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
skill-sync check
```

Sync:

```bash
skill-sync
```

Shortcut:

```bash
ss
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
skill-sync check
skill-sync
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
skill-sync check --json
skill-sync sync --dry-run --json
skill-sync backup restore <id> --dry-run
skill-sync check --projects-root /path/to/projects --harness codex
skill-sync check --home /tmp/fake-home
```

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
| Plain skills root | `~/.skills` |

You can add more:

```bash
skill-sync harness add codex-beta ~/.codex-beta/skills
```

## Safety Rules

- `check` never mutates
- `sync` only replaces entries the tool owns or missing entries
- unmanaged conflicts are reported, not overwritten
- duplicate `_dev` slugs are surfaced before harness-level sync planning
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
skill-sync check --json
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
bun run src/index.ts check
```

Run tests:

```bash
bun test tests/unit tests/integration
```

Build:

```bash
bun run build
```

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
