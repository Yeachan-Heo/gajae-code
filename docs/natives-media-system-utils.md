# Natives media + system utilities

This document covers the media/system/conversion exports in `@gajae-code/natives`: image processing, HTML conversion, clipboard access, token counting, macOS appearance/power helpers, ProjFS helpers, and work profiling.

## Implementation files

- `crates/pi-natives/src/image.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/projfs_overlay.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

> Note: there is no `crates/pi-natives/src/work.rs`; work profiling is implemented in `prof.rs` and fed by instrumentation in `task.rs`.

## JS API ↔ Rust export/module mapping

| JS export                                           | Rust N-API export              | Rust module         |
| --------------------------------------------------- | ------------------------------ | ------------------- |
| `PhotonImage.parse(bytes)`                          | `PhotonImage::parse`           | `image.rs`          |
| `PhotonImage#resize(width, height, filter)`         | `PhotonImage::resize`          | `image.rs`          |
| `PhotonImage#encode(format, quality)`               | `PhotonImage::encode`          | `image.rs`          |
| `encodeSixel(bytes, targetWidthPx, targetHeightPx)` | `encode_sixel`                 | `image.rs`          |
| `htmlToMarkdown(html, options?)`                    | `html_to_markdown`             | `html.rs`           |
| `copyToClipboard(text)`                             | `copy_to_clipboard`            | `clipboard.rs`      |
| `readImageFromClipboard()`                          | `read_image_from_clipboard`    | `clipboard.rs`      |
| `countTokens(input, encoding?)`                     | `count_tokens`                 | `tokens.rs`         |
| `detectMacOSAppearance()`                           | `detect_mac_os_appearance`     | `appearance.rs`     |
| `MacAppearanceObserver.start(callback)`             | `MacAppearanceObserver::start` | `appearance.rs`     |
| `MacOSPowerAssertion.start(options?)`               | `MacOSPowerAssertion::start`   | `power.rs`          |
| `projfsOverlayProbe/start/stop`                     | ProjFS exports                 | `projfs_overlay.rs` |
| `getWorkProfile(lastSeconds)`                       | `get_work_profile`             | `prof.rs`           |

## Data format boundaries and conversions

### Image (`image`)

- **JS input boundary**: `Uint8Array` encoded image bytes for `PhotonImage.parse` and `encodeSixel`.
- **Rust decode boundary**: bytes are copied/read, format is guessed with `ImageReader::with_guessed_format()`, then decoded to `DynamicImage`.
- **In-memory state**: `PhotonImage` stores `Arc<DynamicImage>`.
- **Output boundary**:
  - `PhotonImage#encode(format, quality)` returns a promise for encoded bytes (`Vec<u8>` in Rust; generated TS currently declares `Promise<Array<number>>`).
  - `encodeSixel(...)` returns a SIXEL escape string synchronously.

Format IDs:

- `0`: PNG
- `1`: JPEG
- `2`: WebP
- `3`: GIF

Encoding behavior:

- JPEG uses the provided `quality` with `JpegEncoder::new_with_quality`.
- WebP uses the `webp` crate encoder with `quality` as `f32` in the same 0..=100 range.
- PNG/GIF ignore `quality`.
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

### Tokens (`tokens`)

- `countTokens(input, encoding?)` accepts a single string or an array of strings.
- Arrays return one aggregate token count; encoding work is parallelized in Rust.
- Default encoding is `O200kBase`; `Cl100kBase` remains exported as a compatibility alias that routes to `o200k_base` (the cl100k BPE table is not embedded in default builds).
- The implementation uses ordinary encoding, not special-token handling.

### macOS appearance and power helpers

- `detectMacOSAppearance()` returns `"dark"`, `"light"`, or `null` on non-macOS.
- `MacAppearanceObserver.start(callback)` returns a handle with `stop()`; on macOS it uses distributed notifications plus a 2-second polling fallback, and on non-macOS it is a no-op observer.
- `MacOSPowerAssertion.start(options?)` returns a handle with `stop()`; on macOS it acquires an IOKit assertion, and on other platforms it is a no-op handle.

### Windows ProjFS helpers

- `projfsOverlayProbe()` reports whether ProjFS APIs are available.
- `projfsOverlayStart(lowerRoot, projectionRoot)` starts an overlay.
- `projfsOverlayStop(projectionRoot)` stops an overlay session.

These helpers are platform-specific; availability must be checked before relying on overlay behavior.

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

1. `PhotonImage.parse(bytes)` schedules a blocking decode task (`image.decode`).
2. On success, a native `PhotonImage` handle exists in JS.
3. `resize(...)` creates a new native handle (`image.resize`); old and new handles can coexist.
4. `encode(...)` schedules `image.encode` and materializes bytes without mutating image dimensions.
5. `encodeSixel(...)` decodes, optionally resizes to exact target dimensions with Lanczos3, and returns SIXEL text synchronously.

Failure transitions:

- Format detection/decode failure rejects parse promise or throws from SIXEL encoding.
- Encode failure rejects encode promise.
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
- ProjFS helpers are Windows-specific and should be gated by `projfsOverlayProbe()`.
