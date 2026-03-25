# Changelog

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
