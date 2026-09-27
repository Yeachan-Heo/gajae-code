# @gajae-code/utils

Shared utilities for the gajae-code packages: logging, config and data paths, environment access, formatting, streams, process management, file helpers, and crash reporting.

Everything below is exported from the package root (`@gajae-code/utils`). A few modules are exported as namespaces; see [Namespaces](#namespaces).

## Logger

The logger is exported as the `logger` namespace. By default it writes JSON lines to a rotating file, `gjc.<YYYY-MM-DD>.log` in the logs directory (`~/.gjc/logs`, or `GJC_LOG_DIR`). It writes nothing to stdout or stderr, because console output would corrupt the TUI.

```typescript
import { logger } from "@gajae-code/utils";

logger.info("Server started", { port: 3847 });
logger.warn("Retrying", { attempt: 3 });
logger.error("Connection failed", { error: "ECONNRESET" });
logger.debug("Request details", { url: "https://example.com" });

// Long-running headless services can log to the console instead of the file.
logger.setTransports({ console: true, file: false });
```

- Levels: `error`, `warn`, `info`, `debug`. Each record includes `timestamp`, `level`, `pid`, `message`, and the context fields.
- Rotation: daily files, rotated again at 10 MB, gzipped, and at most 5 kept.
- Records written before the logger finishes loading are buffered, up to 10,000.
- `logger.time(op, fn)`, `logger.startTiming()`, `logger.endTiming()`, and `logger.printTimings()` record nested timing spans.

## Paths (`dirs`)

```typescript
import {
  APP_NAME,
  CONFIG_DIR_NAME,
  getAgentDir,
  getConfigRootDir,
  getEffectiveLogsDir,
  getLogsDir,
  getProjectDir,
  getSessionsDir,
} from "@gajae-code/utils";

APP_NAME; // "gjc"
CONFIG_DIR_NAME; // ".gjc"

getConfigRootDir(); // config root, ~/.gjc by default
getAgentDir(); // agent directory under the config root
getSessionsDir(); // session logs in the agent directory
getLogsDir(); // ~/.gjc/logs
getEffectiveLogsDir(); // where the logger actually writes (honors a trusted GJC_LOG_DIR)
getProjectDir(); // the current project directory (process.cwd() unless setProjectDir() changed it)
```

The module has more path getters for agent state (`getPluginsDir`, `getMemoriesDir`, `getCrashLogPath`, `getMCPConfigPath`, and others). They are all in `src/dirs.ts`.

Environment variables read by `dirs`:

| Variable | Purpose |
|----------|---------|
| `GJC_CONFIG_DIR` | Config directory name (legacy `PI_CONFIG_DIR`) |
| `GJC_CODING_AGENT_DIR` | Agent directory override (legacy `PI_CODING_AGENT_DIR`) |
| `GJC_LOG_DIR` | Log directory override |
| `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | XDG base directories |

## Environment (`env`)

```typescript
import { $env, $flag, $pickenv, parseEnvFile } from "@gajae-code/utils";

const home = $env.HOME;
const apiKey = $pickenv("ANTHROPIC_API_KEY", "OPENAI_API_KEY"); // first non-empty value
const verbose = $flag("GJC_VERBOSE"); // boolean flag, false when unset
const fromFile = parseEnvFile(".env"); // reads and parses the file at this path
```

## Formatting (`format`)

```typescript
import {
  formatAge,
  formatBytes,
  formatCount,
  formatDuration,
  formatNumber,
  formatPercent,
  pluralize,
  truncate,
} from "@gajae-code/utils";

formatDuration(1500); // "1.5s"
formatDuration(123456789); // "1d10h"
formatNumber(12345); // "12K"
formatNumber(1234567); // "1.2M"
formatBytes(1024 * 1024); // "1.0MB"
formatPercent(0.1234); // "12.3%"
truncate("Hello World", 8); // "Hello W…"
formatCount("request", 42); // "42 requests"
formatAge(3661); // "1h ago" (argument in seconds)
pluralize("item", 5); // "items"
```

## Async and streams

```typescript
import { createAbortableStream, readJsonl, readLines, withTimeout } from "@gajae-code/utils";

// Rejects with the message if the promise does not settle within 5 s.
const response = await withTimeout(fetch("https://example.com"), 5000, "request timed out");

// readLines yields each line as bytes; readJsonl yields parsed values.
const body = createAbortableStream(response.body!, AbortSignal.timeout(10_000));
for await (const line of readLines(body)) {
  console.log(new TextDecoder().decode(line));
}
```

`readJsonl`, `readSseJson`, `readSseEvents`, and `parseJsonlLenient` cover JSONL and server-sent event streams.

## Processes

Process helpers are exported through the `ptree` and `procmgr` namespaces. The error classes `AbortError`, `ChildProcess`, `Exception`, and `NonZeroExitError` are also exported at the root.

```typescript
import { procmgr, ptree } from "@gajae-code/utils";

const result = await ptree.exec(["git", "status", "--short"]);
if (result.ok) console.log(result.stdout);

const child = ptree.spawn(["bun", "--version"]);
procmgr.isPidRunning(child.pid);
```

## Files

```typescript
import { globPaths, peekFile, TempDir, tryParseJson } from "@gajae-code/utils";

// Glob relative to cwd (defaults to getProjectDir()), with exclusions.
const sources = await globPaths("src/**/*.ts", { cwd: process.cwd(), exclude: ["**/*.test.ts"] });

// Read only the first bytes of a file.
const header = await peekFile("package.json", 64, bytes => new TextDecoder().decode(bytes));

// A temporary directory that is removed when the scope exits.
await using tmp = await TempDir.create("my-tool-");
console.log(tmp.path());

const parsed = tryParseJson<{ name: string }>("{\"name\":\"gjc\"}"); // null on invalid JSON
```

## Errors

```typescript
import { isDesignedError, isEnoent, markDesignedError, safeErrorDescription, toError } from "@gajae-code/utils";

try {
  await Bun.file("missing.txt").text();
} catch (error) {
  if (isEnoent(error)) console.log("not found");
  console.log(safeErrorDescription(error)); // a string for any thrown value
}

const expected = markDesignedError(new Error("user cancelled"));
isDesignedError(expected); // true
toError("plain string"); // wraps non-Error values in an Error
```

`isEacces`, `isEisdir`, `isEnotdir`, `isEexist`, `isEnotempty`, and `hasFsCode` classify other filesystem errors.

## Other modules

| Module | Main exports |
|--------|--------------|
| `color` | `hexToRgb`, `rgbToHex`, `hsvToRgb`, `adjustHsv` |
| `crash-fingerprint`, `crash-journal`, `crash-redaction` | `computeCrashFingerprint`, `appendCrashEvent`, `redactCrashSecrets` |
| `fetch-retry` | `fetchWithRetry` |
| `frontmatter` | `parseFrontmatter` (returns `{ frontmatter, body }`), `FrontmatterError` |
| `mermaid-ascii` | `renderMermaidAscii` |
| `sanitize-text` | `sanitizeText`, `sanitizeDisplayLine` |
| `snowflake` | `Snowflake` (sortable ID helpers) |
| `tab-spacing` | `getDefaultTabWidth` (3 by default), `setDefaultTabWidth` |
| `type-guards` | `isRecord`, `asRecord`, `toError` |
| `which` | `$which` |

## Namespaces

These modules are exported as namespaces rather than as flat names:

| Namespace | Contents |
|-----------|----------|
| `logger` | Logging and timing spans |
| `postmortem` | Crash recording |
| `procmgr` | Process liveness and exit helpers |
| `prompt` | Prompt helpers |
| `ptree` | `spawn`, `exec`, and the child-process classes |

## Development

```bash
cd packages/utils
bun run check   # Biome + tsc
bun test
```

## License

MIT
