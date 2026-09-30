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
	@echo "Release preparation:"
	@echo "  make pre-publish       - Types, tests, build, and package dry-run"
	@echo "  make publish/release   - Disabled pending an approved publishing path"

install:
	npm ci

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
	npm run prepublishOnly

publish release:
	@echo "ERROR: Publication is disabled pending a separately approved publishing path. Run make pre-publish for local checks."
	@exit 1
