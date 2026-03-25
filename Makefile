.PHONY: help install build dev lint test test-unit test-integration pre-publish publish

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
