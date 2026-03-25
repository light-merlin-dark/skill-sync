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
	@echo "  make release           - Lint/test/build, npm publish, git tag + push, and create/update GitHub release"

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

release: pre-publish
	@set -euo pipefail; \
		cd /Users/merlin/_dev/skill-sync; \
		if [ "$(shell git status --porcelain | wc -l | tr -d ' ')" != "0" ]; then \
			echo "ERROR: Working tree must be clean before release."; \
			echo "Run: git status"; \
			exit 1; \
		fi; \
		if ! command -v gh >/dev/null 2>&1; then \
			echo "ERROR: gh (GitHub CLI) not found in PATH."; \
			exit 1; \
		fi; \
		VERSION=$$(node -p "require('./package.json').version"); \
		tag="v$$VERSION"; \
		npm publish --access public; \
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
		# Extract changelog section for this version (best-effort)
		notes=$$(awk -v v="$$VERSION" 'BEGIN{found=0} /^##[[:space:]]*\$$v[[:space:]]*$$/{found=1;next} /^##[[:space:]]*/{if(found){exit}} {if(found){print}}' CHANGELOG.md); \
		if [ -z "$$notes" ]; then \
			notes="Release $$tag"; \
		fi; \
		if gh release view "$$tag" >/dev/null 2>&1; then \
			echo "Updating GitHub release $$tag"; \
			gh release edit "$$tag" --notes "$$notes" --title "$$tag"; \
		else \
			echo "Creating GitHub release $$tag"; \
			gh release create "$$tag" --notes "$$notes" --title "$$tag" --target main; \
		fi
