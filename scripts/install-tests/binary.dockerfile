# Test binary build from local source
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl ca-certificates unzip build-essential && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
ENV PATH="/root/.cargo/bin:$PATH"

# Copy local repo
WORKDIR /repo
COPY . .

# Install the toolchain pinned by rust-toolchain.toml
RUN rustup toolchain install && rustup show active-toolchain

# Build native addon and binary
RUN bun install --frozen-lockfile
RUN bun --cwd=packages/natives run build
RUN cd packages/coding-agent && bun run build

# Install binary to PATH
RUN mkdir -p /root/.local/bin && \
    cp packages/coding-agent/dist/gjc /root/.local/bin/
ENV PATH="/root/.local/bin:$PATH"

# Verify
RUN HOME=/tmp/gjc-home XDG_DATA_HOME=/tmp/gjc-xdg gjc --version
