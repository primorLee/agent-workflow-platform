# awp-vm-agent Makefile
#
# Targets:
#   build        host arch, linux, static
#   build-all    linux amd64 + arm64 static (for release)
#   test         go test ./...
#   lint         golangci-lint run (requires golangci-lint on PATH)
#   package-*    source-preview gates; all exit 77 before build or staging
#   install-local / uninstall-local also exit 77 in the source preview
#   clean        rm -rf dist/
#
# Version / commit are baked in via -ldflags.

SHELL        := /bin/sh
BINARY       := awp-vm-agent
PKG          := github.com/primorLee/agent-workflow-platform/services/vm-agent
CMD          := ./cmd/awp-vm-agent

VERSION      ?= 0.0.0-dev
COMMIT       := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
DATE         := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS      := -s -w \
                -X main.Version=$(VERSION) \
                -X main.Commit=$(COMMIT) \
                -X main.Date=$(DATE)

GO           ?= go
GOFLAGS      ?=
CGO_ENABLED  := 0
GOOS_LINUX   := linux

DIST         := dist

.PHONY: all build build-linux-amd64 build-linux-arm64 build-all \
        test lint fmt vet tidy clean \
        package-tar package-deb package-rpm package-apk package-all \
        verify-static install-local uninstall-local \
        shellcheck syntax-check

all: build

build:
	@mkdir -p $(DIST)
	CGO_ENABLED=$(CGO_ENABLED) $(GO) build $(GOFLAGS) \
	    -trimpath -ldflags "$(LDFLAGS)" \
	    -o $(DIST)/$(BINARY) $(CMD)

build-linux-amd64:
	@mkdir -p $(DIST)
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS_LINUX) GOARCH=amd64 $(GO) build $(GOFLAGS) \
	    -trimpath -ldflags "$(LDFLAGS)" \
	    -o $(DIST)/$(BINARY)-$(VERSION)-linux-amd64 $(CMD)

build-linux-arm64:
	@mkdir -p $(DIST)
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS_LINUX) GOARCH=arm64 $(GO) build $(GOFLAGS) \
	    -trimpath -ldflags "$(LDFLAGS)" \
	    -o $(DIST)/$(BINARY)-$(VERSION)-linux-arm64 $(CMD)

build-all: build-linux-amd64 build-linux-arm64
	@echo "built: $(DIST)/$(BINARY)-$(VERSION)-linux-{amd64,arm64}"

verify-static:
	@for f in $(DIST)/$(BINARY)-$(VERSION)-linux-*; do \
	    echo "== $$f =="; \
	    file $$f; \
	    if command -v ldd >/dev/null 2>&1; then \
	        ldd $$f 2>&1 | grep -q "not a dynamic executable" || \
	            { echo "ERROR: $$f is not static"; exit 1; }; \
	    fi; \
	done

test:
	$(GO) test -race -count=1 ./...

lint:
	@command -v golangci-lint >/dev/null 2>&1 || \
	    { echo "golangci-lint not installed — see https://golangci-lint.run"; exit 1; }
	golangci-lint run ./...

fmt:
	$(GO) fmt ./...

vet:
	$(GO) vet ./...

tidy:
	$(GO) mod tidy

clean:
	rm -rf $(DIST)

# ---- source-preview packaging gates ----
# No signed binary or tag is published. These targets fail before build,
# staging, download, account, filesystem, or service mutation.

package-tar:
	@echo "package-tar: unsupported until a signed release is published" >&2; exit 77

package-rpm:
	@echo "package-rpm: unsupported until a signed release is published" >&2; exit 77

package-deb:
	@echo "package-deb: unsupported until a signed release is published" >&2; exit 77

package-apk:
	@echo "package-apk: unsupported until a signed release is published" >&2; exit 77

package-all:
	@echo "package-all: unsupported until a signed release is published" >&2; exit 77

# ---- static checks ----
syntax-check:
	@for f in install/install.sh install/one-liner.sh install/uninstall.sh \
	          install/awp-vm-agent.init.d install/openrc/awp-vm-agent \
	          packaging/debian/preinst packaging/debian/postinst packaging/debian/prerm packaging/debian/postrm \
	          packaging/apk/awp-vm-agent.pre-install \
	          packaging/apk/awp-vm-agent.post-install \
	          packaging/apk/awp-vm-agent.pre-deinstall; do \
	    printf 'sh -n %s ... ' "$$f"; \
	    sh -n "$$f" && echo ok || { echo FAIL; exit 1; }; \
	done

shellcheck:
	@command -v shellcheck >/dev/null 2>&1 || { echo "shellcheck not installed"; exit 1; }
	shellcheck -s sh install/install.sh install/one-liner.sh install/uninstall.sh \
	    install/awp-vm-agent.init.d install/openrc/awp-vm-agent \
	    packaging/debian/preinst packaging/debian/postinst packaging/debian/prerm packaging/debian/postrm \
	    packaging/apk/awp-vm-agent.pre-install \
	    packaging/apk/awp-vm-agent.post-install \
	    packaging/apk/awp-vm-agent.pre-deinstall

# ---- source-preview local lifecycle gates ----
install-local:
	@echo "install-local: unsupported; use reviewed install/install.sh with explicit signed inputs" >&2; exit 77

uninstall-local:
	@echo "uninstall-local: unsupported; use reviewed install/uninstall.sh without --purge" >&2; exit 77
