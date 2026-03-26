.PHONY: help install build dev lint test test-unit test-integration pre-publish publish release

help:
	@echo "Available commands:"
	@echo ""
	@echo "Development:"
	@echo "  make install           - Install dependencies"
	@echo "  make build             - Build the CLI"
	@echo "  make dev               - Run the CLI in development mode"
	@echo "  make lint              - Run TypeScript checks"
	@echo "  make test              - Run all tests"
	@echo "  make test-unit         - Run unit tests"
	@echo "  make test-integration  - Run integration tests"
	@echo ""
	@echo "Release:"
	@echo "  make pre-publish       - Lint, test, and build"
	@echo "  make publish           - Publish to npm"
	@echo "  make release           - Auto-bump patch, finalize changelog, lint/test/build, publish, commit, tag, push, and create/update GitHub release"

install:
	bun install

build:
	bun run build

dev:
	bun run dev

lint:
	bun run lint

test:
	bun run test

test-unit:
	bun run test:unit

test-integration:
	bun run test:integration

pre-publish:
	bun run lint
	bun run test
	bun run build

publish:
	npm publish --access public

release:
	@set -euo pipefail; \
		cd /Users/merlin/_dev/skill-sync; \
		if ! command -v gh >/dev/null 2>&1; then \
			echo "ERROR: gh (GitHub CLI) not found in PATH."; \
			exit 1; \
		fi; \
		if ! npm whoami >/dev/null 2>&1; then \
			echo "ERROR: npm publish credentials not available."; \
			exit 1; \
		fi; \
		branch=$$(git rev-parse --abbrev-ref HEAD); \
		if [ "$$branch" != "main" ]; then \
			echo "ERROR: Releases must be cut from main."; \
			exit 1; \
		fi; \
		if [ -n "$$(git status --porcelain)" ]; then \
			old_version=$$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version)"); \
			new_version=$$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); const parts=pkg.version.split('.').map(Number); parts[2] += 1; console.log(parts.join('.'));"); \
			echo "Preparing release $$old_version -> $$new_version"; \
			node -e "const fs=require('fs'); const path='package.json'; const pkg=JSON.parse(fs.readFileSync(path,'utf8')); pkg.version='$$new_version'; fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');"; \
			node -e "const fs=require('fs'); const path='CHANGELOG.md'; const version='$$new_version'; let text=fs.readFileSync(path,'utf8'); if (!/^## Unreleased$$/m.test(text)) { throw new Error('CHANGELOG.md missing ## Unreleased heading'); } text=text.replace(/^## Unreleased$$/m, '## Unreleased\\n\\n## ' + version); fs.writeFileSync(path, text);"; \
			$(MAKE) pre-publish; \
			git add -A; \
			git commit -m "Release skill-sync v$$new_version"; \
		else \
			echo "Working tree clean; releasing existing HEAD"; \
			$(MAKE) pre-publish; \
		fi; \
		VERSION=$$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version)"); \
		tag="v$$VERSION"; \
		if npm view @light-merlin-dark/skill-sync@"$$VERSION" version >/dev/null 2>&1; then \
			echo "ERROR: npm version $$VERSION is already published."; \
			exit 1; \
		fi; \
		npm publish --access public; \
		git push origin HEAD; \
		git fetch --tags origin || true; \
		if git rev-parse "$$tag" >/dev/null 2>&1; then \
			current=$$(git rev-parse "$$tag"); \
			head=$$(git rev-parse HEAD); \
			if [ "$$current" != "$$head" ]; then \
				echo "ERROR: Tag $$tag already exists but points to a different commit."; \
				echo "tag=$$current head=$$head"; \
				exit 1; \
			fi; \
		else \
			git tag -a "$$tag" -m "$$tag"; \
			git push origin "$$tag"; \
		fi; \
		notes_file=$$(mktemp); \
		awk -v v="$$VERSION" 'BEGIN{p=0} $$0 ~ "^##[[:space:]]*"v"[[:space:]]*$$" {p=1;next} p && /^##[[:space:]]*/{exit} p{print}' CHANGELOG.md > "$$notes_file"; \
		if [ ! -s "$$notes_file" ]; then echo "Release $$tag" > "$$notes_file"; fi; \
		if gh release view "$$tag" >/dev/null 2>&1; then \
			echo "Updating GitHub release $$tag"; \
			gh release edit "$$tag" --notes-file "$$notes_file" --title "$$tag"; \
		else \
			echo "Creating GitHub release $$tag"; \
			gh release create "$$tag" --notes-file "$$notes_file" --title "$$tag" --target main; \
		fi; \
		rm -f "$$notes_file"
