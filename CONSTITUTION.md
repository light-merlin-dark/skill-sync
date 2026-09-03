# SkillSync Progressive Disclosure Constitution

**Status:** Normative product specification.

SkillSync manages local, repo-backed agent skills across multiple harnesses.
Its central rule is:

> Canonical availability does not imply global startup visibility.

A skill may exist, remain resolvable, and keep its canonical resources without
being listed in every agent session. The global skill surface is a compact
routing layer; projects explicitly declare their own entrypoints; specialist
leaves are disclosed only when a relevant entrypoint routes to them.

## 1. Product boundary

SkillSync owns five things:

1. discovery of canonical `SKILL.md` sources under user-configured roots;
2. validation of source metadata and route graphs;
3. deterministic planning of harness and project projections;
4. drift-safe installation, backup, cleanup, and restore;
5. measurable startup-index budgets and migration coverage.

SkillSync does not infer product membership from directory names, parse prose
as configuration, copy leaf instructions into project guidance, or replace a
public skill package manager. It manages local sources already present on disk.

## 2. Two independent axes

Every skill has two independent policy axes.

### Visibility

- `global`: broadly useful in unrelated projects and eligible for compatible
  user-level harness roots.
- `project`: an ecosystem or product entrypoint projected only into repositories
  that declare it.
- `routed`: a specialist leaf absent from startup indexes and resolved through
  an explicit route from another skill.
- `unclassified`: no visibility decision exists. Under strict mode this is a
  blocking error, never an alias for `global`.

### Harness targeting

Harness targeting answers where a visible skill can be represented: Codex,
Claude Code, Cursor, Gemini, Hermes, a custom harness, or another supported
adapter. It does not answer whether the skill belongs globally or in a project.

A project skill can target several harnesses without becoming global. A global
skill can target only one harness when its implementation is harness-native.

## 3. Canonical source contract

Visibility metadata lives in standards-compatible YAML frontmatter beneath the
`metadata` mapping:

```yaml
---
name: framework
description: Route work in the Framework ecosystem to the correct specialist.
metadata:
  skill-sync.visibility: project
  skill-sync.routes: framework-admin,framework-billing
  skill-sync.install-on: agents,codex
---
```

Supported fields:

| Field | Value | Meaning |
| --- | --- | --- |
| `skill-sync.visibility` | `global`, `project`, or `routed` | Startup visibility class |
| `skill-sync.routes` | comma-separated canonical slugs | Direct route targets |
| `skill-sync.install-on` | comma-separated harness ids | Harness allowlist |
| `skill-sync.deprecated-by` | one canonical slug | Replacement for a retired slug |

Values remain strings for compatibility with skill consumers that preserve but
do not interpret vendor metadata. Legacy top-level scope fields are migration
inputs, not the target format.

## 4. Discovery is explicit

Fresh installations have no implicit source root. Users add roots explicitly:

```bash
skill-sync config init
skill-sync roots add ~/Projects
```

This avoids assuming a username, home layout, repository convention, or product
topology. Built-in harness roots may use documented home-relative conventions;
all source roots and custom harness roots remain configurable.

Within a configured root, SkillSync discovers repository-root and nested skill
layouts according to its documented source rules. It prefers canonical project
sources over managed harness mirrors and reports unresolved duplicate slugs.

## 5. Project membership is declarative

A repository opts into entrypoints through `.agents/skill-sync.yaml`:

```yaml
version: 1
entrypoints:
  - framework
```

The manifest is the machine-readable authority for membership. A short project
guidance section should state the semantic boundary without copying a leaf
catalog:

```markdown
## Skill entrypoints

- Framework work uses `$framework`; it routes to specialist instructions.
```

Generated projection state lives under `.agents/skills/` and should be ignored
by the consuming repository. The manifest and guidance are committed; generated
copies are not.

Rules:

1. only `project` skills may be declared as project entrypoints;
2. a `routed` leaf cannot be declared directly to bypass its router;
3. a missing or ambiguous entrypoint is a blocking diagnostic;
4. unsupported project adapters fail closed and never fall back to global
   installation.

## 6. Routing is progressive disclosure

An entrypoint is a compact router, not an embedded manual. Its metadata names
direct leaves or narrower routers. SkillSync validates the graph before any
mutation:

- every target must resolve to one canonical slug;
- cycles are invalid;
- deprecated slugs must resolve to a live replacement;
- route resolution returns the canonical skill directory and `SKILL.md` path;
- relative resources remain owned by the canonical directory.

Example:

```bash
skill-sync resolve framework-billing --json
```

The result is schema-versioned and identifies the route parent that made the
leaf reachable. SkillSync does not copy the leaf globally merely to make
resolution convenient.

## 7. Projection model

Global skills are planned against compatible user-level harness roots. Project
entrypoints are planned against the declaring repository through a supported
project adapter. Routed leaves are not projected into startup indexes.

Adapters must define their native representation explicitly. A new adapter is
accepted only when it has a fail-closed test proving that unsupported project
projection cannot widen into a global install.

Canonical sources remain canonical. Materialization or wrapper links are
managed projections, not new authorities. Full skill packages preserve sibling
resources such as `agents/`, `scripts/`, `references/`, and assets where the
harness requires materialization.

## 8. Budgets are policy, not heuristics

Fresh installations default to:

- strict visibility enabled;
- a 4,000-token estimated global skill-index ceiling;
- a 500-token estimated project-entrypoint ceiling.

Budgets are configurable, but enforcement is deterministic. When strict mode is
active, an unclassified skill blocks before mutation. Disabling the gate is an
explicit operator decision, not an automatic fallback.

**A budget overage is directional.** The ceiling bounds what an agent reads at
startup, and that estimate is a property of the discovered source set: no
install, repair or removal is an input to it. So an overage withholds the
actions that would materialize *more* startup surface — new installs — and lets
repairs and removals proceed. Removals are how the condition clears; refusing
them protects nothing.

Refusing an entire plan on an overage was the prior behaviour and it was wrong
in a way that hid itself. Measured 2026-09-03: a single-skill `execute` was
refused because unrelated skills exceeded the ceiling, and the withheld action
was replacing a stale copy with a link whose name and description were
byte-identical — provably the same estimate before and after. One harness root
served a three-week-old skill as a result, while every run reported success.

Index estimates measure startup metadata, not task-triggered skill bodies. The
purpose is to keep routing choices relevant while preserving on-demand depth.

## 9. Plans and machine-readable output

Every mutating workflow has a dry-run plan. Plans are:

- schema-versioned;
- content-hashed;
- stable for identical sources, manifests, configuration, and harness state;
- explicit about additions, repairs, removals, conflicts, and diagnostics.

JSON output must be complete even when it exceeds ordinary pipe-buffer sizes.
Commands set their exit status without terminating before stdout drains.

Exit behavior distinguishes healthy state, actionable drift, and blocking
conflict. Consumers must not parse human prose to recover plan semantics.

## 10. Migration coverage

Before reducing an existing flat namespace, create a baseline ledger. Every
baseline slug must end in one of these states:

- still global;
- declared by at least one project;
- reachable from a global or declared project router;
- deliberately deprecated with a resolvable replacement.

Migration is accepted only at 100% ledger reachability. A smaller startup index
is not a success if capabilities silently disappear.

Classification ledgers are explicit, hash-guarded migration inputs. Automatic
semantic guesses may assist review, but descriptions changing must never change
visibility by themselves.

## 11. Safety and rollback

SkillSync follows these mutation rules:

1. doctor before execute;
2. backup before broad cleanup or migration;
3. never overwrite an unmanaged conflict silently;
4. apply independent non-conflicting changes while reporting remaining
   conflicts;
5. preserve canonical sources during projection cleanup;
6. make restore possible from a value-free manifest and captured skill state;
7. keep complete JSON and deterministic plan evidence for automation.

Targeted operations may manage one skill or project without pruning unrelated
state. Broad verification is a final acceptance gate after the source is
frozen, not an inner-loop action after every edit.

## 12. Public portability

SkillSync is an open-source product. Public source, tests, examples, changelogs,
and package contents must not contain:

- maintainer-specific absolute paths or usernames;
- private repository, customer, host, or product inventories;
- local session, backup, quarantine, or incident identifiers;
- machine-specific acceptance ledgers;
- credentials or credential-bearing generated artifacts.

Use fixture-owned temporary paths, `$HOME`, `~/Projects`, or `/path/to/...` in
public material. Machine-local evidence belongs in ignored files outside the
Git and npm surfaces. CI must enforce this boundary.

## 13. Acceptance gates

A release that changes visibility or projection is accepted only when all of the
following pass:

1. fresh config contains no implicit source root and enables strict visibility;
2. unclassified sources fail closed under strict mode;
3. global and project budgets block before mutation;
4. project manifests project only their declared entrypoints;
5. routed leaves resolve without startup installation;
6. route cycles and missing targets fail validation;
7. unsupported adapters do not create a global fallback;
8. baseline reachability is 100% when a baseline is configured;
9. plans are deterministic and JSON remains parseable above 64 KiB;
10. backup and restore work in an isolated home;
11. public-hygiene checks and package-content inspection pass;
12. GitHub source, release tag, changelog, package version, and npm dist-tag
    identify the same release.

## 14. Rejected designs

- **Install everything globally.** It makes canonical storage synonymous with
  startup relevance and recreates namespace pollution.
- **Infer project membership from paths.** Directory layouts are conventions,
  not authority.
- **Parse project guidance as configuration.** Prose is not a deterministic
  state machine.
- **Copy every routed leaf into every project.** It creates drift and defeats
  progressive disclosure.
- **Silently relax strict mode.** A convenient fallback that widens visibility
  is a policy defect.
- **Make product defaults match one maintainer's workstation.** Open-source
  defaults must be safe and useful without private topology.

These rules are constitutional because they prevent recurrence: a future sync,
new skill, or new harness must not be able to rebuild a flat global namespace by
accident.
