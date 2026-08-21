# syntax=docker/dockerfile:1.7-labs
###############################################################################
# gajae-code — pi image
#
# Stages:
#   natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
#   pi-base         — python + bun + natives + /usr/local/bin/gjc shim
#   pi-dev          — pi-base + build toolchain (build-essential, rustup)
#   pi-runtime      — pi-base + pi source + bun install      (DEFAULT, runnable)
#
# Build:
#     docker build -t gajae-code/pi:dev .                          # default = pi-runtime
#     docker build --target pi-base -t gajae-code/pi-base:dev .    # base for derived images
#
# Run:
#     docker run --rm gajae-code/pi:dev --help
#     docker run --rm -it -v "$PWD":/work gajae-code/pi:dev cli    # interactive gjc
#
###############################################################################

ARG BUN_VERSION=1.3.14

############################
# 1) natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /pi

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /pi/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    crates/*/Cargo.toml \
    /pi/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /pi/

# Layer 4 — compile pi-natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps + the workspace
# target dir.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/pi/target \
    set -eux; \
    rustup show; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/pi_natives.linux-*.node /out/

############################

############################
# 2) pi-base — python + bun + natives + gjc shim
#
# Sharable runtime base. `pi-runtime` below uses this stage and overrides
# `PI_ROOT` to `/pi` because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS pi-base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    PI_ROOT=/work/pi \
    PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version


# pi-natives addon: pi's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/pi_natives.linux-*.node /opt/bun/bin/


# `gjc` shim — runs the coding-agent CLI against $PI_ROOT via Bun. Derived
# images override PI_ROOT to point at wherever their pi source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${PI_ROOT:=/work/pi}"' \
    'if [ ! -d "$PI_ROOT/packages/coding-agent" ]; then' \
    '  echo "pi: PI_ROOT=$PI_ROOT does not look like a pi checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$PI_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/gjc \
    && chmod +x /usr/local/bin/gjc

############################
# 4) pi-dev — pi-base + build toolchain for derived development images
############################
FROM pi-base AS pi-dev

ENV CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/data/cache/cargo/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by pi's `rust-toolchain.toml`.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

############################
# 5) pi-runtime — pi-base + pi source + bun install (DEFAULT)
#
# A self-contained, runnable gjc image. `docker run gajae-code/pi:dev --help`
# Just Works without a host checkout.
############################
FROM pi-base AS pi-runtime

ENV PI_ROOT=/pi
WORKDIR /pi

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    /pi/

RUN bun install --frozen-lockfile --ignore-scripts

# Pi source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /pi/

# Regenerate the docs index that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles this on a vanilla install.
RUN bun --cwd=packages/coding-agent run generate-docs-index

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gjc"]
CMD ["--help"]
