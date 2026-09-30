# Contributing to SkillSync

SkillSync is a public MIT-licensed project. Contributions should improve the
portable product, not encode one workstation's topology.

## Development

Requirements:

- Node.js 20 or newer for the distributed CLI;
- Bun for development and tests.

```bash
npm ci
npm run lint
npm test
npm run build
```

## Public-source rules

- Use temporary fixture paths, `$HOME`, `~/Projects`, or `/path/to/...`.
- Do not commit absolute user-home paths, machine inventories, private project
  names, session identifiers, backup locations, credentials, or generated
  secret-bearing artifacts.
- Fresh defaults must be location-independent and fail closed.
- Keep visibility separate from harness targeting.
- Add a regression test before fixing a recurring source, projection, or public
  hygiene defect.
- Do not add a project adapter without a test proving unsupported adapters cannot
  widen project skills into global installs.
- Inspect `npm pack --dry-run --json` before a release.

## Maintainer releases

Release preparation and publication are separate. Run `npm ci`, then
`npm run prepublishOnly` against frozen source and inspect the package dry-run
output. Verify `git diff --exit-code` after committing the intended source.
These local gates replace GitHub Actions; do not add CI workflows.

`make publish` and `make release` currently fail closed. A future publication
requires a separately approved publishing path, with source, version, changelog,
tag, and public registry metadata aligned. Do not substitute a long-lived
registry token. Unreleased fixes remain queued until that publication occurs.

The normative behavior is defined in [CONSTITUTION.md](./CONSTITUTION.md).

## Pull requests

Keep changes focused and include:

- the user-visible behavior change;
- targeted test evidence;
- any compatibility or migration impact;
- documentation and changelog updates when the public contract changes.

Do not include machine-local acceptance evidence in a pull request. Reproduce
the behavior with anonymized fixtures instead.
