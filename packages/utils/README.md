# @gajae-code/utils

Shared utilities for Gajae-Code packages. Provides logging, path management, async helpers, crash reporting, and other common utilities used across the monorepo.

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

Centralized logging with file rotation. **No console output by default** — writing to stdout/stderr would corrupt the TUI rendering.

```typescript
import { logger, setTransports, LogLevel } from "@gajae-code/utils";

// Default: rotating file at ~/.gjc/logs/gjc.<DATE>.log
logger.info("Server started", { port: 3847 });

// For headless services (auth broker, etc.) that need console output
setTransports({ console: true });

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
import { sleep, timeout, retry, raceWithTimeout } from "@gajae-code/utils";

// Sleep
await sleep(1000); // 1 second

// Timeout wrapper
const result = await timeout(fetchData(), 5000); // throws after 5s

// Retry with exponential backoff
const data = await retry(
  () => fetchData(),
  { maxAttempts: 3, baseDelay: 1000, maxDelay: 10000 }
);

// Race with timeout
const result = await raceWithTimeout(promise, 3000);
```

### Crash Reporting (`crash-fingerprint`, `crash-journal`, `crash-redaction`)

Structured crash reporting with fingerprinting and PII redaction.

```typescript
import {
  createCrashFingerprint,
  CrashJournal,
  redactCrash,
} from "@gajae-code/utils";

try {
  await riskyOperation();
} catch (error) {
  // Generate stable fingerprint for deduplication
  const fingerprint = createCrashFingerprint(error);
  console.log("Crash fingerprint:", fingerprint); // e.g., "a1b2c3d4"

  // Record to crash journal
  const journal = new CrashJournal(getLogsDir());
  await journal.record({
    fingerprint,
    error,
    context: { version: "1.0.0", platform: process.platform },
  });

  // Redact sensitive data before sending
  const safeReport = redactCrash(error, {
    // Custom redaction rules
    redactKeys: ["apiKey", "token", "password"],
  });
}
```

### Environment (`env`, `env-file`)

Environment variable parsing with validation and `.env` file support.

```typescript
import {
  getEnv,
  parseEnvFile,
  loadEnvFile,
} from "@gajae-code/utils";

// Get validated env var
const apiKey = getEnv("ANTHROPIC_API_KEY"); // throws if missing

// Parse .env file
const env = parseEnvFile(await fs.readFile(".env", "utf-8"));

// Load .env into process.env
loadEnvFile(".env.local");
```

### Formatting (`format`, `formatDuration`, `formatNumber`, `formatPercent`)

```typescript
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatCost,
  formatBytes,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@gajae-code/utils";

formatDuration(1500);           // "1.5s"
formatDuration(123456789);      // "1d 10h"
formatNumber(1234567);          // "1,234,567"
formatPercent(0.1234);          // "12.34%"
formatCost(0.001234);           // "$0.0012"
formatBytes(1024 * 1024);       // "1.00 MB"
truncateToWidth("Hello World", 8); // "Hello…"
wrapTextWithAnsi("Long text...", 40); // wrapped lines
```

### Stream Utilities (`stream`, `abortable`)

```typescript
import {
  createAbortableStream,
  once,
  untilAborted,
  pipeline,
} from "@gajae-code/utils";

// Abortable stream
const { stream, abort } = createAbortableStream();
abort(); // triggers abort signal

// Wait for single event
const event = await once(emitter, "data");

// Stream until aborted
for await (const chunk of untilAborted(stream, signal)) {
  process(chunk);
}
```

### Process Management (`procmgr`, `ptree`)

```typescript
import { spawn, ProcessTree } from "@gajae-code/utils";

// Spawn with proper signal handling
const child = spawn("bun", ["run", "script.ts"], {
  stdio: "inherit",
  signal: AbortSignal.timeout(30000),
});

// Process tree utilities
const tree = new ProcessTree();
tree.addChild(parentPid, childPid);
const descendants = tree.getDescendants(rootPid);
```

### Glob & File Utilities (`glob`, `peek-file`, `temp`)

```typescript
import { glob, peekFile, createTempDir, createTempFile } from "@gajae-code/utils";

// Fast glob matching
const files = await glob("src/**/*.ts", { cwd: projectDir });

// Peek at file without reading entirely
const firstLines = await peekFile("large.log", 100);

// Temporary files/dirs (auto-cleanup)
const tempDir = await createTempDir("my-app-");
const tempFile = await createTempFile({ prefix: "upload-", suffix: ".tmp" });
```

### Text & Sanitization (`sanitize-text`, `frontmatter`, `tab-spacing`)

```typescript
import {
  sanitizeText,
  parseFrontmatter,
  replaceTabs,
  truncateToWidth,
} from "@gajae-code/utils";

// Sanitize for TUI rendering (replaces tabs, truncates)
const safe = sanitizeText(userInput, { maxWidth: 80 });

// Parse YAML frontmatter
const { data, content } = parseFrontmatter("---\ntitle: Test\n---\nBody");

// Replace tabs with spaces
const expanded = replaceTabs("col1\tcol2", 4);

// Truncate preserving ANSI codes
const truncated = truncateToWidth(chalk.red("Error: ") + "message", 20);
```

### Error Handling (`safe-error`, `error-classification`)

```typescript
import { SafeError, classifyError, isRetryable } from "@gajae-code/utils";

// Wrap unknown errors safely
const safe = SafeError.wrap(unknownError);
console.log(safe.message); // Always a string

// Classify errors for retry logic
const classification = classifyError(error);
if (isRetryable(classification)) {
  await retry(operation);
}
```

### Miscellaneous

| Module | Purpose |
|--------|---------|
| `snowflake` | Unique ID generation |
| `which` | Find executable in PATH |
| `mime` | MIME type detection |
| `header-value` | HTTP header parsing |
| `hook-fetch` | Fetch with hooks |
| `json` | JSON utilities (JSON5/JSONL) |
| `broken-pipe` | Handle SIGPIPE gracefully |
| `color` | Color utilities |
| `type-guards` | Runtime type checks |

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