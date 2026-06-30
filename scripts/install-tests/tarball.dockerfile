# Test tarball install (simulates npm publish flow)
# Uses verdaccio as local registry to test full publish/install cycle
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl ca-certificates unzip jq procps build-essential && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Rust (needed to build native addon)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:$PATH"

# Install Node.js (needed for verdaccio and npm)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install verdaccio (local npm registry)
RUN npm install -g verdaccio

# Copy local repo
WORKDIR /repo
COPY . .

# Build the project
RUN bun install --frozen-lockfile
RUN bun --cwd=packages/natives run build

# Create verdaccio config (allow anonymous publish)
RUN mkdir -p /root/.config/verdaccio && cat > /root/.config/verdaccio/config.yaml <<'EOF'
storage: /verdaccio/storage
auth:
  htpasswd:
    file: /verdaccio/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@gajae-code/*':
    access: $all
    publish: $all
    unpublish: $all
  '**':
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
publish:
  allow_offline: true
security:
  api:
    legacy: true
log: { type: stdout, format: pretty, level: warn }
EOF

# Create storage and htpasswd
RUN mkdir -p /verdaccio/storage && touch /verdaccio/htpasswd

# Create .npmrc with auth token
RUN echo '//localhost:4873/:_authToken="fake-token"' > /root/.npmrc

# Create script to resolve workspace:* versions and publish
RUN cat > /repo/scripts/publish-local.sh <<'SCRIPT'
#!/bin/bash
set -e

REGISTRY="http://localhost:4873"
PACKAGES=(utils ai natives-darwin-arm64 natives-darwin-x64 natives-linux-arm64 natives-linux-x64 natives-win32-x64 natives tui stats agent coding-agent gajae-code)

# Build version maps from local workspaces and the root catalog.
jq '.workspaces.catalog // {}' /repo/package.json > /tmp/catalog-versions.json
echo '{}' > /tmp/workspace-versions.json
for pkg in "${PACKAGES[@]}"; do
    name=$(jq -r '.name' "packages/$pkg/package.json")
    version=$(jq -r '.version' "packages/$pkg/package.json")
    jq --arg name "$name" --arg version "$version" '. + {($name): $version}' /tmp/workspace-versions.json > /tmp/workspace-versions.next.json
    mv /tmp/workspace-versions.next.json /tmp/workspace-versions.json
    echo "Found $name@$version"
done
stage_native_platform_artifacts() {
    local pkg="$1"
    local prefix=""
    case "$pkg" in
        natives-darwin-arm64) prefix="pi_natives.darwin-arm64" ;;
        natives-darwin-x64) prefix="pi_natives.darwin-x64" ;;
        natives-linux-arm64) prefix="pi_natives.linux-arm64" ;;
        natives-linux-x64) prefix="pi_natives.linux-x64" ;;
        natives-win32-x64) prefix="pi_natives.win32-x64" ;;
        *) return 0 ;;
    esac

    rm -rf native
    mkdir -p native
    shopt -s nullglob
    local artifacts=("/repo/packages/natives/native/${prefix}"*.node)
    shopt -u nullglob
    if [ "${#artifacts[@]}" -eq 0 ]; then
        rmdir native
        if [ "$pkg" = "natives-linux-x64" ]; then
            echo "Expected linux-x64 native artifact matching ${prefix}*.node"
            exit 1
        fi
        return 0
    fi
    cp "${artifacts[@]}" native/
}


# Resolve workspace:* and catalog: specs in each package.json and publish
for pkg in "${PACKAGES[@]}"; do
    echo ""
    echo "=== Publishing packages/$pkg ==="
    cd "/repo/packages/$pkg"
    
    # Backup original
    cp package.json package.json.bak
    
    # Replace workspace:* with local package versions and catalog: with root catalog versions.
    jq --slurpfile workspace /tmp/workspace-versions.json --slurpfile catalog /tmp/catalog-versions.json '
        def resolve_spec($name; $value):
            if ($value | type) != "string" then $value
            elif $value == "workspace:*" or ($value | startswith("workspace:")) then ($workspace[0][$name] // $value)
            elif $value == "catalog:" or ($value | startswith("catalog:")) then ($catalog[0][$name] // $value)
            else $value
            end;
        def rewrite_field($field):
            if (.[$field] | type) == "object" then
                .[$field] |= with_entries(.value = resolve_spec(.key; .value))
            else .
            end;
        rewrite_field("dependencies") |
        rewrite_field("devDependencies") |
        rewrite_field("peerDependencies") |
        rewrite_field("optionalDependencies")
    ' package.json > package.json.tmp && mv package.json.tmp package.json
    stage_native_platform_artifacts "$pkg"
    
    # Show what we're publishing
    echo "Dependencies:"
    jq '.dependencies | to_entries[] | select((.value | type) == "string" and (.value | test("^(@gajae-code|workspace|catalog)")))' package.json 2>/dev/null || true
    
    # Publish
    npm publish --registry "$REGISTRY"
    
    # Restore original
    mv package.json.bak package.json
    
    cd /repo
done

echo ""
echo "=== All packages published ==="
SCRIPT
RUN chmod +x /repo/scripts/publish-local.sh

# Start verdaccio and publish all packages
RUN verdaccio --config /root/.config/verdaccio/config.yaml &>/dev/null & \
    sleep 3 && \
    /repo/scripts/publish-local.sh && \
    pkill -f verdaccio

# Clean install in fresh directory
WORKDIR /test
RUN verdaccio --config /root/.config/verdaccio/config.yaml &>/dev/null & \
    sleep 3 && \
    bun add gajae-code --registry http://localhost:4873 && \
    pkill -f verdaccio

# Verify the installed package works
ENV PATH="/test/node_modules/.bin:$PATH"
RUN gjc --version
