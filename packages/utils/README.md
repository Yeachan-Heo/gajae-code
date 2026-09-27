# @gajae-code/utils

Shared utilities for Gajae-Code packages. Provides logging, path management, crash reporting, formatting, and other common utilities used across the monorepo.

## Installation

```bash
bun add @gajae-code/utils
```

## Quick Start

```typescript
import { logger, getProjectDir, formatDuration, formatNumber } from "@gajae-code/utils";

// Configure logger (e.g., for headless services)
logger.setTransports({ console: true });

logger.info("Application started", { version: "1.0.0" });
logger.debug("Debug info", { context: "auth" });

// Path utilities
const projectDir = getProjectDir();
console.log("Project directory:", projectDir);

// Formatting helpers
console.log(formatDuration(1500));      // "1.5s"
console.log(formatNumber(1234567));     // "1,234,567"
```

## Modules

### Logger (`logger`)

Centralized logging with file rotation. **No console output by default** — writing to stdout/stderr would corrupt the TUI rendering. Exported as a namespace.

```typescript
import { logger } from "@gajae-code/utils";

// Default: rotating file at ~/.gjc/logs/gjc.<DATE>.log
logger.info("Server started", { port: 3847 });

// For headless services (auth broker, etc.) that need console output
logger.setTransports({ console: true });

// Log levels: "error" | "warn" | "info" | "debug"
logger.error("Connection failed", { error: err.message });
logger.warn("Retrying", { attempt: 3 });
logger.debug("Request details", { url, headers });
```

**Key features:**
- Automatic log rotation (daily, max 30 files)
- JSON structured logging with `pid`, `timestamp`, `level`
- Buffered logs before initialization (capped at 10,000 entries)
- AsyncLocalStorage context for correlation IDs

### Paths & Directories (`dirs`)

Centralized path helpers for config directories with XDG compliance.

```typescript
import {
  getConfigDir,
  getLogsDir,
  getProjectDir,
  getSessionDir,
  getTmpDir,
  CONFIG_DIR_NAME,
  APP_NAME,
  getEffectiveLogsDir,
} from "@gajae-code/utils";

// ~/.gjc (or XDG-compliant location)
const configDir = getConfigDir();

// ~/.gjc/logs
const logsDir = getLogsDir();

// Project-specific directory
const projectDir = getProjectDir(); // e.g., /home/user/project/.gjc

// Temporary directory
const tmpDir = getTmpDir();
```

**Environment variables:**
| Variable | Purpose |
|----------|---------|
| `GJC_CONFIG_DIR` | Override config root (legacy: `PI_CONFIG_DIR`) |
| `GJC_CODING_AGENT_DIR` | Override agent directory |
| `XDG_DATA_HOME` | XDG data directory (Linux) |
| `XDG_STATE_HOME` | XDG state directory (Linux) |
| `XDG_CACHE_HOME` | XDG cache directory (Linux) |

### Async Utilities (`async`)

```typescript
import { withTimeout } from "@gajae-code/utils";

// Wrap a promise with timeout
const result = await withTimeout(fetchData(), 5000, "Operation timed out");

// With abort signal
const result = await withTimeout(promise, 3000, "Timeout", signal);
```

### Crash Reporting (`crash-fingerprint`, `crash-journal`, `crash-redaction`)

Structured crash reporting with fingerprinting and PII redaction.

```typescript
import {
  computeCrashFingerprint,
  appendCrashEvent,
  redactCrashSecrets,
} from "@gajae-code/utils";

try {
  await riskyOperation();
} catch (error) {
  // Generate stable fingerprint for deduplication
  const fingerprint = computeCrashFingerprint(error);
  console.log("Crash fingerprint:", fingerprint); // e.g., "a1b2c3d4"

  // Record to crash journal
  await appendCrashEvent({
    fingerprint,
    message: error.message,
    stack: error.stack,
    provenance: "product",
    timestamp: Date.now(),
  });

  // Redact sensitive data before sending
  const safeReport = redactCrashSecrets(error.stack);
}
```

### Environment (`env`, `env-file`)

Environment variable parsing with validation and `.env` file support.

```typescript
import {
  parseEnvFile,
  parseShellEnvFile,
  isValidEnvName,
  $pickenv,
  $pickflag,
} from "@gajae-code/utils";

// Parse .env file
const env = parseEnvFile(await fs.readFile(".env", "utf-8"));

// Parse shell-style .env
const shellEnv = parseShellEnvFile(".env");

// Validate env name
if (isValidEnvName("MY_VAR")) { /* ... */ }

// Pick from Bun.env with fallback
const apiKey = $pickenv("ANTHROPIC_API_KEY", "OPENAI_API_KEY");
```

### Formatting (`format`)

```typescript
import {
  formatDuration,
  formatNumber,
  formatBytes,
  formatPercent,
  truncate,
  formatCount,
  formatAge,
  pluralize,
} from "@gajae-code/utils";

formatDuration(1500);           // "1.5s"
formatDuration(123456789);      // "1d 10h"
formatNumber(1234567);          // "1,234,567"
formatBytes(1024 * 1024);       // "1.00 MB"
formatPercent(0.1234);          // "12.34%"
truncate("Hello World", 8);     // "Hello…"
formatCount("request", 42);     // "42 requests"
formatAge(3661);                // "1h 1m"
pluralize("item", 5);           // "items"
```

### Stream Utilities (`stream`, `abortable`)

```typescript
import {
  readLines,
  readJsonl,
  parseJsonlLenient,
  createAbortableStream,
  once,
  untilAborted,
} from "@gajae-code/utils";

// Read lines from stream
for await (const line of readLines(stream)) {
  console.log(line);
}

// Read JSONL
for await (const obj of readJsonl(stream)) {
  process(obj);
}

// Abortable stream
const { stream: abortable, abort } = createAbortableStream(sourceStream);
abort(); // triggers abort signal

// Wait for single event
const event = await once(emitter, "data");

// Stream until aborted
for await (const chunk of untilAborted(stream, signal)) {
  process(chunk);
}
```

### Process Management (`ptree`, `procmgr`)

```typescript
import { spawn, exec, ChildProcess, AbortError } from "@gajae-code/utils";
import { isPidRunning, onProcessExit } from "@gajae-code/utils";

// Spawn with proper signal handling
const child = spawn("bun", ["run", "script.ts"], {
  stdio: "inherit",
  signal: AbortSignal.timeout(30000),
});

// Execute and get result
const result = await exec(["bun", "run", "build"]);

// Process utilities
if (await isPidRunning(pid)) {
  await onProcessExit(pid);
}
```

### Glob & File Utilities (`glob`, `peek-file`, `temp`)

```typescript
import { globPaths, loadGitignorePatterns } from "@gajae-code/utils";
import { peekFile, peekFileSync } from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";

// Fast glob matching with gitignore support
const files = await globPaths("src/**/*.ts", { cwd: projectDir });

// Peek at file without reading entirely
const firstBytes = await peekFile("large.log", 1024, header => header);

// Temporary directory (auto-cleanup on scope exit)
using tempDir = new TempDir("my-app-");
console.log(tempDir.path);
```

### Text & Sanitization (`sanitize-text`, `frontmatter`, `tab-spacing`)

```typescript
import { sanitizeText, sanitizeDisplayLine } from "@gajae-code/utils";
import { parseFrontmatter, FrontmatterError } from "@gajae-code/utils";
import { getDefaultTabWidth, setDefaultTabWidth } from "@gajae-code/utils";

// Sanitize for display (no tabs, safe for TUI)
const safe = sanitizeText(userInput);

// Sanitize single display line
const line = sanitizeDisplayLine(userInput);

// Parse YAML frontmatter
const { data, content } = parseFrontmatter("---\ntitle: Test\n---\nBody");

// Tab width configuration
console.log(getDefaultTabWidth()); // 3
setDefaultTabWidth(4);
```

### Error Handling (`safe-error`, `error-classification`, `fs-error`)

```typescript
import { safeErrorDescription } from "@gajae-code/utils";
import { isDesignedError, markDesignedError } from "@gajae-code/utils";
import { isFsError, isEnoent, isEacces } from "@gajae-code/utils";

// Safe error description for unknown values
const desc = safeErrorDescription(unknownError);

// Mark/identify designed errors
const error = markDesignedError(new Error("expected"));
if (isDesignedError(error)) { /* ... */ }

// File system error classification
if (isEnoent(err)) { /* file not found */ }
if (isEacces(err)) { /* permission denied */ }
```

### Miscellaneous Utilities

| Module | Key Exports |
|--------|-------------|
| `color` | `hexToRgb`, `rgbToHex`, `hsvToRgb`, `adjustHsv` |
| `fetch-retry` | `fetchWithRetry`, `isRetryableError`, `extractRetryHint` |
| `fs-error` | `isFsError`, `isEnoent`, `isEacces`, `isEisdir` |
| `header-value` | `sanitizeHeaderComponent` |
| `hook-fetch` | `hookFetch`, `FetchHandler` |
| `json` | `tryParseJson` |
| `mermaid-ascii` | `renderMermaidAscii`, `extractMermaidBlocks` |
| `mime` | `parseImageMetadata`, `readImageMetadata` |
| `peek-file` | `peekFile`, `peekFileSync` |
| `safe-stderr` | `safeStderrWrite` |
| `snowflake` | `Snowflake` (unique ID generator) |
| `type-guards` | `isRecord`, `asRecord`, `toError` |
| `which` | `$which` (find executable) |
| `broken-pipe` | `isBrokenPipeError`, `createProcessStdoutEpipeClassifier` |

### Namespace Exports

These modules are exported as namespaces — access their members via dot notation:

```typescript
import { logger, postmortem, procmgr, prompt, ptree } from "@gajae-code/utils";

// logger: logger.info(), logger.setTransports(), logger.error(), ...
// postmortem: postmortem.record(), postmortem.CrashJournal, ...
// procmgr: procmgr.isPidRunning(), procmgr.onProcessExit()
// prompt: prompt.*, ...
// ptree: ptree.spawn(), ptree.exec(), ptree.ChildProcess, ...
```

### Additional Exports

- `structuredCloneJSON` — Deep clone with fallback to JSON
- `postmortem` namespace — Crash reporting internals
- `prompt` namespace — Prompt utilities

## Testing

```bash
# Run all tests
bun test

# Run specific test
bun test test/logger.test.ts
```

## Contributing

This package follows the monorepo conventions:
- Run `bun run check` before committing
- Add tests for new utilities
- Update this README when adding new exports

## License

MIT