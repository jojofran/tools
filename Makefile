SHELL := /bin/zsh

CLAUDESETTINGS_FOLDER := claude-settings-ui
CCCONFIG_FOLDER        := cc-connect-config-ui
CC_CONNECT_DIR         := $(HOME)/Documents/Code/cc-connect
DIST_DIR               := dist

# ──────────────────────────────────────────────
# Install — npm dependencies for all projects
# ──────────────────────────────────────────────

.PHONY: install
install: install-claude-settings install-cc-config         ## Install all dependencies

.PHONY: install-claude-settings
install-claude-settings:                                   ## Install claude-settings-ui deps
	cd $(CLAUDESETTINGS_FOLDER) && npm install

.PHONY: install-cc-config
install-cc-config:                                         ## Install cc-connect-config-ui deps
	cd $(CCCONFIG_FOLDER) && npm install

.PHONY: install-all
install-all: install install-cc-connect                    ## Install everything (including cc-connect source)

.PHONY: install-cc-connect
install-cc-connect:                                        ## Build & install cc-connect from source
	cd $(CC_CONNECT_DIR) && make build && \
	cp cc-connect /usr/local/lib/node_modules/cc-connect/bin/cc-connect && \
	cp cc-connect /usr/local/bin/

# ──────────────────────────────────────────────
# Development
# ──────────────────────────────────────────────

.PHONY: dev
dev: dev-claude-settings dev-cc-config                     ## Start all dev servers

.PHONY: dev-claude-settings
dev-claude-settings:                                       ## Start claude-settings-ui server
	cd $(CLAUDESETTINGS_FOLDER) && npm run dev

.PHONY: dev-cc-config
dev-cc-config:                                             ## Start cc-connect-config-ui server
	cd $(CCCONFIG_FOLDER) && npm run dev

.PHONY: electron-claude-settings
electron-claude-settings:                                  ## Launch claude-settings-ui in Electron
	cd $(CLAUDESETTINGS_FOLDER) && npm run electron

.PHONY: electron-cc-config
electron-cc-config:                                        ## Launch cc-connect-config-ui in Electron
	cd $(CCCONFIG_FOLDER) && npm run electron

# ──────────────────────────────────────────────
# Build — package distributables
# ──────────────────────────────────────────────

.PHONY: build
build: build-claude-settings build-cc-config               ## Build all distributables

.PHONY: build-claude-settings
build-claude-settings:                                     ## Build claude-settings-ui DMG+ZIP
	cd $(CLAUDESETTINGS_FOLDER) && npm run dist

.PHONY: build-cc-config
build-cc-config:                                           ## Build cc-connect-config-ui DMG+ZIP
	cd $(CCCONFIG_FOLDER) && npm run dist

# ──────────────────────────────────────────────
# Release — tag and publish to GitHub
# ──────────────────────────────────────────────

.PHONY: release
release: check-clean                                       ## Build & create GitHub Release (tag from package.json)
	$(eval VERSION := $(shell node -p "require('./$(CLAUDESETTINGS_FOLDER)/package.json').version"))
	$(eval TAG := v$(VERSION))
	git tag $(TAG)
	git push origin $(TAG)

.PHONY: check-clean
check-clean:
	@if ! git diff-index --quiet HEAD --; then \
		echo "Error: working tree not clean. Commit or stash first."; \
		exit 1; \
	fi

# ──────────────────────────────────────────────
# Utility
# ──────────────────────────────────────────────

.PHONY: restart-cc-connect
restart-cc-connect:                                       ## Restart cc-connect daemon
	./scripts/restart-cc-connect.sh

.PHONY: check-cc-config
check-cc-config:                                          ## Verify cc-connect-config-ui setup
	cd $(CCCONFIG_FOLDER) && node scripts/install-check.js

.PHONY: setup-cc-config
setup-cc-config:                                          ## Full cc-connect-config-ui setup
	cd $(CCCONFIG_FOLDER) && npm run setup

.PHONY: clean
clean:                                                     ## Clean all build artifacts
	rm -rf $(CLAUDESETTINGS_FOLDER)/$(DIST_DIR)
	rm -rf $(CCCONFIG_FOLDER)/$(DIST_DIR)

.PHONY: help
help:                                                      ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
