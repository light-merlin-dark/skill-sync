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
	@echo "  make publish           - Refuse direct local publishing; releases use GitHub OIDC"
	@echo "  make release           - Publish exact clean main through GitHub OIDC, then tag and create the GitHub release"

install:
	npm install

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
	@echo "ERROR: Direct local npm publishing is disabled. Prepare a clean release commit and run make release."
	@exit 1

release:
	@set -euo pipefail; \
		if ! command -v gh >/dev/null 2>&1; then \
			echo "ERROR: gh (GitHub CLI) not found in PATH."; \
			exit 1; \
		fi; \
		branch=$$(git rev-parse --abbrev-ref HEAD); \
		if [ "$$branch" != "main" ]; then \
			echo "ERROR: Releases must be cut from main."; \
			exit 1; \
		fi; \
		if [ -n "$$(git status --porcelain)" ]; then \
			echo "ERROR: Release source must already be committed and clean."; \
			exit 1; \
		fi; \
		git fetch origin main --tags; \
		head=$$(git rev-parse HEAD); \
		remote=$$(git rev-parse origin/main); \
		if [ "$$head" != "$$remote" ]; then \
			echo "ERROR: Local main must exactly match origin/main."; \
			echo "local=$$head remote=$$remote"; \
			exit 1; \
		fi; \
		VERSION=$$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version)"); \
		tag="v$$VERSION"; \
		published=$$(npm view @light-merlin-dark/skill-sync@"$$VERSION" version 2>/dev/null || true); \
		published_head=$$(npm view @light-merlin-dark/skill-sync@"$$VERSION" gitHead 2>/dev/null || true); \
		if [ -n "$$published" ]; then \
			if [ "$$published" != "$$VERSION" ] || [ "$$published_head" != "$$head" ]; then \
				echo "ERROR: Published $$tag does not identify the current release commit."; \
				echo "published=$$published published_head=$$published_head local=$$head"; \
				exit 1; \
			fi; \
			echo "npm already serves $$tag from this exact commit; resuming finalization"; \
		else \
			echo "Dispatching $$tag from $$head through npm trusted publishing"; \
			gh workflow run publish.yml --ref main -f version="$$VERSION" -f commit="$$head"; \
			run_id=""; \
			for attempt in $$(seq 1 20); do \
				run_id=$$(gh run list --workflow publish.yml --commit "$$head" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // empty'); \
				if [ -n "$$run_id" ]; then break; fi; \
				sleep 2; \
			done; \
			if [ -z "$$run_id" ]; then \
				echo "ERROR: Could not identify the dispatched publish run."; \
				exit 1; \
			fi; \
			gh run watch "$$run_id" --exit-status; \
			for attempt in $$(seq 1 30); do \
				published=$$(npm view @light-merlin-dark/skill-sync@"$$VERSION" version 2>/dev/null || true); \
				published_head=$$(npm view @light-merlin-dark/skill-sync@"$$VERSION" gitHead 2>/dev/null || true); \
				if [ "$$published" = "$$VERSION" ] && [ "$$published_head" = "$$head" ]; then break; fi; \
				sleep 2; \
			done; \
			if [ "$$published" != "$$VERSION" ] || [ "$$published_head" != "$$head" ]; then \
				echo "ERROR: Registry verification did not converge on $$tag from $$head."; \
				exit 1; \
			fi; \
		fi; \
		if git rev-parse "$$tag" >/dev/null 2>&1; then \
			current=$$(git rev-parse "$$tag"); \
			if [ "$$current" != "$$head" ]; then \
				echo "ERROR: Tag $$tag already exists but points to a different commit."; \
				echo "tag=$$current head=$$head"; \
				exit 1; \
			fi; \
		else \
			git tag -a "$$tag" -m "$$tag"; \
			git push origin "$$tag"; \
		fi; \
		notes=$$(awk -v v="$$VERSION" 'BEGIN{p=0} $$0 ~ "^##[[:space:]]*"v"[[:space:]]*" {p=1;next} p && /^##[[:space:]]*/{exit} p{print}' CHANGELOG.md); \
		if [ -z "$$notes" ]; then notes="Release $$tag"; fi; \
		if gh release view "$$tag" >/dev/null 2>&1; then \
			echo "Updating GitHub release $$tag"; \
			gh release edit "$$tag" --notes "$$notes" --title "$$tag"; \
		else \
			echo "Creating GitHub release $$tag"; \
			gh release create "$$tag" --notes "$$notes" --title "$$tag" --target "$$head"; \
		fi
