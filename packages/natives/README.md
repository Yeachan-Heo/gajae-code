# @gajae-code/natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Glob-based file/directory discovery with gitignore support (pure TypeScript via `globPaths`)
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { grep, find, encodeSixel } from "@gajae-code/natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px)
const sequence = encodeSixel(pngBytes, widthPx, heightPx);
```

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

## Architecture

```
crates/pi-natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Stable JS/types loader files
  index.js               # Loads the host addon
  index.d.ts             # Generated public API types
packages/natives-*/      # Optional per-platform prebuilt addon packages
  native/pi_natives.<platform>-<arch>-modern.node   # x64 modern ISA (AVX2)
  native/pi_natives.<platform>-<arch>-baseline.node # x64 baseline ISA
  native/pi_natives.<platform>-<arch>.node          # non-x64 build artifact
```
