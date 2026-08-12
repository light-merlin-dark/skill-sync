---
name: skill-sync
description: Sync local repo-backed agent skills across installed harnesses such
  as Codex, Claude Code, Cursor, Gemini, Hermes, Grok, and related tools. Use
  when a user wants one source of truth for local SKILL.md files, needs drift
  checks or backup/restore for harness skill roots, or wants to inspect which
  harnesses and skills are currently detected.
metadata:
  skill-sync.visibility: global
---

# Skill Sync

Use `skill-sync` as the default interface for local skill-harness maintenance.

## Progressive Disclosure

Before changing whether a skill is global, project-scoped, or routed behind an
entrypoint, read the repository's `CONSTITUTION.md`. Harness targeting and
project visibility are separate decisions. Project membership comes only from
`.agents/skill-sync.yaml`; project `AGENTS.md` names the declared entrypoints.
Never work around a missing project adapter by fanning an entrypoint out
globally.

Constitutional defaults on this machine are strict visibility, a 4,000-token
global index ceiling, and a 500-token ordinary-project ceiling. A new source
must be explicitly classified before sync can install it.

## Core Workflow
1. Inspect harness detection and discovered skill sources.
2. Run a doctor pass before making changes.
3. Create a backup before risky cleanup or restore work.
4. Execute or restore.
5. Verify the resulting symlinks or restored content.

Start with:

```bash
skill-sync harnesses
skill-sync sources
skill-sync doctor
skill-sync doctor --verbose
skill-sync audit visibility
```

Apply changes:

```bash
skill-sync execute
skill-sync sync
skill-sync execute --skill <slug>   # preferred for one project/skill
skill-sync execute --project <repo>
```

Or explicitly:

```bash
skill-sync execute
```

Declare or resolve on demand:

```bash
skill-sync project add <entrypoint> --root <repo>
skill-sync project doctor --root <repo>
skill-sync resolve <routed-slug> --json
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
skill-sync doctor --json
skill-sync sources --json
skill-sync harnesses --json
skill-sync execute --json
```

Bare `skill-sync` prints a high-signal landing/help view. Default human output is concise. Add `--verbose` when you need the full per-entry plan and orphan listing.

## Safety Rules

- Prefer `doctor` before `execute`.
- For a project-local release, use `doctor --skill <slug>` then
  `execute --skill <slug>`. Targeted mode never prunes unrelated managed
  entries and does not inherit unrelated source conflicts.
- `execute` applies all non-conflicting changes by default. Conflicting entries are skipped but still reported (exit code 3 signals remaining issues).
- In strict mode, unclassified or over-budget plans are blocked before any
  mutation; do not disable the gate to make a plan pass.
- Divergent harness-native skills with disjoint local-only destinations are
  valid and do not block global execution.
- If `doctor` reports a `conflict` due to an existing *unmanaged* install (common case: a skill folder already exists in a harness root like `~/.hermes/skills/<skill>`), resolve by either:
  - removing the unmanaged directory/file and re-running `execute`, or
  - restoring via `skill-sync backup restore <backup-id>`.
  Do not leave mixed symlink + real directories behind.
- Use `--home` for isolated testing against a fake home directory.
- Use `--projects-root` when you need to constrain discovery to a specific source tree.
- Project-root sources are authoritative. Harness-installed skills act as fallback sources when no project-root source exists for the same slug.
- Add new visibility metadata beneath the Agent Skills-standard `metadata` map:
  `skill-sync.visibility`, `skill-sync.routes`, `skill-sync.install-on`, and
  `skill-sync.deprecated-by`. Values are strings; route/install lists are
  comma-separated. Top-level legacy keys are migration inputs, not the target
  format.
- Commit `.agents/skill-sync.yaml` and the matching `## Skill entrypoints`
  guidance. Treat `.agents/skills/` as generated local projection state.
