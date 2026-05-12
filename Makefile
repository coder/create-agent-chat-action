.PHONY: fmt fmt-check lint test clean deps all

TS_FILES := $(shell find src -name "*.ts" -type f ! -name "*.test.ts")

all: build fmt lint test

fmt:
	bun run format

fmt-check:
	bun run format:check

lint:
	bun run lint
	bun run typecheck

dist/index.js: $(TS_FILES) package.json node_modules
	bun run build

build: dist/index.js

test:
	bun test

clean:
	rm -rf dist

node_modules: package.json bun.lock
	bun install
	touch node_modules

deps: node_modules
