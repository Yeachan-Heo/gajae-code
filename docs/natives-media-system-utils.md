# Natives media + system utilities

This document covers the media/system/conversion exports in `@gajae-code/natives`: sixel encoding, HTML conversion, clipboard access, macOS appearance/power helpers, and work profiling.

## Implementation files

- `crates/pi-natives/src/sixel.rs`

> Note: `PhotonImage` was removed from the addon; image decode/transform/encode now runs through `Bun.Image` in TypeScript (`packages/coding-agent/src/utils/image-resize.ts`). `encodeSixel` remains a native export.
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

> Note: there is no `crates/pi-natives/src/work.rs`; work profiling is implemented in `prof.rs` and fed by instrumentation in `task.rs`.

## JS API ↔ Rust export/module mapping

| JS export                                           | Rust N-API export              | Rust module         |
| --------------------------------------------------- | ------------------------------ | ------------------- |
| `encodeSixel(bytes, targetWidthPx, targetHeightPx)` | `encode_sixel`                 | `sixel.rs`          |
| `htmlToMarkdown(html, options?)`                    | `html_to_markdown`             | `html.rs`           |
| `copyToClipboard(text)`                             | `copy_to_clipboard`            | `clipboard.rs`      |
| `readImageFromClipboard()`                          | `read_image_from_clipboard`    | `clipboard.rs`      |
| `detectMacOSAppearance()`                           | `detect_mac_os_appearance`     | `appearance.rs`     |
| `MacAppearanceObserver.start(callback)`             | `MacAppearanceObserver::start` | `appearance.rs`     |
| `MacOSPowerAssertion.start(options?)`               | `MacOSPowerAssertion::start`   | `power.rs`          |
| `isoProbe/isoStart/isoStop`                         | `iso_probe` / `iso_start` / `iso_stop` | `iso.rs`    |
| `getWorkProfile(lastSeconds)`                       | `get_work_profile`             | `prof.rs`           |

## Data format boundaries and conversions

### Image (`image`)

- **JS input boundary**: `Uint8Array` encoded image bytes for `encodeSixel`.
- **Output boundary**:
  - `encodeSixel(...)` returns a SIXEL escape string synchronously.


Encoding behavior:

- Invalid dimensions for SIXEL (`0` width or height) fail with `Target SIXEL dimensions must be greater than zero`.

### HTML conversion (`html`)

- **JS input boundary**: HTML `string` + optional `{ cleanContent?: boolean; skipImages?: boolean }`.
- **Rust conversion boundary**: conversion is scheduled through `task::blocking("html_to_markdown", (), ...)`.
- **Output boundary**: Markdown `string` promise.

Conversion behavior:

- `cleanContent` defaults to `false`.
- When `cleanContent=true`, preprocessing uses `PreprocessingPreset::Aggressive` and hard-removal flags for navigation/forms.
- `skipImages` defaults to `false`.

### Clipboard (`clipboard`)

- `copyToClipboard(text)` is a synchronous native call using `arboard::Clipboard::set_text`.
- `readImageFromClipboard()` runs in `task::blocking("clipboard.read_image", (), ...)`.
- Image read returns `null`/`undefined` when `arboard` reports `ContentNotAvailable`.
- Successful image read re-encodes clipboard RGBA data as PNG and returns `{ data: Uint8Array, mimeType: "image/png" }`.
- Clipboard access or image encoding failures reject/throw as native errors.

There is no current `packages/natives` TS wrapper that emits OSC52, handles Termux, or suppresses native clipboard failures. Any best-effort clipboard policy must live in consumers.

### macOS appearance and power helpers

- `detectMacOSAppearance()` returns `"dark"`, `"light"`, or `null` on non-macOS.
- `MacAppearanceObserver.start(callback)` returns a handle with `stop()`; on macOS it uses distributed notifications plus a 2-second polling fallback, and on non-macOS it is a no-op observer.
- `MacOSPowerAssertion.start(options?)` returns a handle with `stop()`; on macOS it acquires an IOKit assertion, and on other platforms it is a no-op handle.

### Windows ProjFS (through the iso backend)

ProjFS is no longer a standalone export set. It is one backend of the iso overlay API:

- `isoProbe(kind?)` reports whether a backend is available; pass `IsoBackendKind.Projfs` to probe ProjFS specifically.
- `isoStart(...)` / `isoStop(...)` manage an overlay session.
- `isoBackend()` reports the backend actually selected.

The ProjFS implementation lives in the `pi-iso` crate (`crates/pi-iso/src/projfs.rs`), ported out of the former `pi_natives::projfs_overlay`. It is platform-specific; probe before relying on overlay behavior.

### Work profiling (`work`)

- **Collection boundary**: profiling samples are produced by `profile_region(tag)` guards in `task::blocking` and `task::future`.
- **Storage format**: fixed-size circular buffer (`MAX_SAMPLES = 10_000`) storing stack path, duration, and timestamp.
- **Output boundary**: `getWorkProfile(lastSeconds)` returns:
  - `folded`: folded-stack text (flamegraph input)
  - `summary`: markdown table summary
  - `svg`: optional flamegraph SVG
  - `totalMs`, `sampleCount`

## Lifecycle and state transitions

### Image lifecycle

1. `encodeSixel(...)` decodes the input bytes, optionally resizes to exact target dimensions with Lanczos3, and returns SIXEL text synchronously.

Failure transitions:

- Format detection or decode failure throws from SIXEL encoding.
- Invalid SIXEL dimensions throw.

### HTML lifecycle

1. `htmlToMarkdown(html, options)` schedules a blocking conversion task.
2. Conversion runs with defaulted options (`cleanContent=false`, `skipImages=false`) unless specified.
3. Returns markdown string or rejects.

### Clipboard lifecycle

- Text copy constructs an `arboard::Clipboard` and calls `set_text` synchronously.
- Image read constructs an `arboard::Clipboard`, calls `get_image`, encodes PNG on success, maps `ContentNotAvailable` to `None`, and rejects other errors.

### Work profiling lifecycle

1. No explicit start: profiling is active when task helpers execute.
2. Every instrumented task scope records one sample on guard drop.
3. Samples overwrite oldest entries after buffer capacity is reached.
4. `getWorkProfile(lastSeconds)` reads a time window and derives folded/summary/svg artifacts.

Failure transitions:

- SVG generation failure is soft (`svg` omitted/undefined), while folded and summary still return.
- Empty sample windows return empty folded data and no SVG, not an error.

## Unsupported operations and error propagation

### Image

- Unsupported decode input or corrupted bytes: strict failure.
- Invalid SIXEL target dimensions: strict failure.
- No JS fallback path in the natives package.

### HTML

- Conversion errors are strict failures.
- Option omission is defaulting, not failure.

### Clipboard

- Text copy is strict at the native API surface.
- Image read distinguishes "no image" (`null`/`undefined`) from operational failure (rejection).

### Work profiling

- Retrieval is strict for the function call itself.
- Flamegraph SVG generation is nullable/optional.
- Buffer truncation is expected ring-buffer behavior.

## Platform caveats

- Clipboard access depends on OS/session support exposed through `arboard`.
- macOS appearance and power helpers intentionally return no-op/null behavior on unsupported platforms.
- ProjFS is Windows-specific and should be gated by `isoProbe(IsoBackendKind.Projfs)`.
