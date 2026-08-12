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

Release preparation and publication are separate. Commit the intended package
version and changelog on `main`; do not let release automation manufacture or
commit source changes. `make release` then requires local `main` to match
`origin/main`, dispatches the exact commit to `.github/workflows/publish.yml`,
waits for the trusted-publishing gate, verifies the public registry version, and
only then creates the matching Git tag and GitHub release.

The npm package owner must configure that workflow as the package's trusted
GitHub publisher. Do not add an npm write token to repository secrets.

The normative behavior is defined in [CONSTITUTION.md](./CONSTITUTION.md).

## Pull requests

Keep changes focused and include:

- the user-visible behavior change;
- targeted test evidence;
- any compatibility or migration impact;
- documentation and changelog updates when the public contract changes.

Do not include machine-local acceptance evidence in a pull request. Reproduce
the behavior with anonymized fixtures instead.
