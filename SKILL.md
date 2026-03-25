---
name: skill-sync
description: Sync local repo-backed agent skills across installed harnesses such as Codex, Claude Code, Cursor, Gemini, Hermes, and related tools. Use when a user wants one source of truth for local SKILL.md files, needs drift checks or backup/restore for harness skill roots, or wants to inspect which harnesses and skills are currently detected.
---

# Skill Sync

Use `skill-sync` as the default interface for local skill-harness maintenance.

## Core Workflow
1. Inspect harness detection and discovered skill sources.
2. Run a dry check before making changes.
3. Create a backup before risky cleanup or restore work.
4. Sync or restore.
5. Verify the resulting symlinks or restored content.

Start with:

```bash
skill-sync harnesses
skill-sync sources
skill-sync check
```

Apply changes:

```bash
skill-sync
```

Or explicitly:

```bash
skill-sync sync
```

## Backup Workflow

Create a backup:

```bash
skill-sync backup create
```

List backups:

```bash
skill-sync backup list
```

Dry-run a restore:

```bash
skill-sync backup restore <backup-id> --dry-run
```

Restore:

```bash
skill-sync backup restore <backup-id>
```

## Agent-Friendly Usage

Use JSON when the output will be consumed by another tool or agent:

```bash
skill-sync check --json
skill-sync sources --json
skill-sync harnesses --json
```

## Safety Rules

- Prefer `check` before `sync`.
- If `check` reports a `conflict` due to an existing *unmanaged* install (common case: a skill folder already exists in a harness root like `~/.hermes/skills/<skill>`), resolve by either:
  - removing the unmanaged directory/file and re-running `sync`, or
  - restoring via `skill-sync backup restore <backup-id>`.
  Do not leave mixed symlink + real directories behind.
- Use `--home` for isolated testing against a fake home directory.
- Use `--projects-root` when you need to constrain discovery to a specific source tree.
