# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 1.63s | 945 | 1.0ms | 258 |

**Top 10:** `update` 43.9%, `write` 10.6%, `stringify` 6.0%, `byteLength` 5.6%, `gc` 4.4%, `(module)` 4.1%, `parse` 4.0%, `readSync` 3.9%, `node:net` 3.3%, `anonymous` 3.2%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 43.9% | 720.4ms | 43.9% | 720.4ms | `update` | `[native code]` |
| 10.6% | 174.8ms | 10.6% | 174.8ms | `write` | `[native code]` |
| 6.0% | 99.8ms | 6.0% | 99.8ms | `stringify` | `[native code]` |
| 5.6% | 92.0ms | 5.6% | 92.0ms | `byteLength` | `[native code]` |
| 4.4% | 72.8ms | 4.4% | 72.8ms | `gc` | `[native code]` |
| 4.1% | 68.7ms | 4.1% | 68.7ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/beautiful-mermaid/src/ascii/pathfinder.ts:104` |
| 4.0% | 66.4ms | 4.0% | 66.4ms | `parse` | `[native code]` |
| 3.9% | 64.0ms | 3.9% | 64.0ms | `readSync` | `[native code]` |
| 3.3% | 54.7ms | 3.3% | 54.7ms | `node:net` | `node:net:3` |
| 3.2% | 53.5ms | 7.9% | 129.6ms | `anonymous` | `[native code]` |
| 3.0% | 49.5ms | 3.0% | 49.5ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js` |
| 1.6% | 26.6ms | 1.6% | 26.6ms | `toString` | `[native code]` |
| 0.5% | 9.4ms | 0.5% | 9.4ms | `copy` | `[native code]` |
| 0.4% | 8.0ms | 0.4% | 8.0ms | `indexOf` | `[native code]` |
| 0.3% | 4.9ms | 0.3% | 4.9ms | `dlopen` | `[native code]` |
| 0.2% | 3.4ms | 0.4% | 6.9ms | `openSync` | `[native code]` |
| 0.2% | 3.4ms | 0.2% | 3.4ms | `RegExp` | `[native code]` |
| 0.2% | 3.4ms | 0.2% | 3.4ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:323` |
| 0.1% | 3.1ms | 0.1% | 3.1ms | `Hash` | `[native code]` |
| 0.1% | 3.0ms | 0.2% | 4.7ms | `statSync` | `[native code]` |
| 0.1% | 2.6ms | 0.3% | 5.2ms | `writeSync` | `[native code]` |
| 0.1% | 1.8ms | 0.1% | 1.8ms | `stringSplitFast` | `[native code]` |
| 0.1% | 1.8ms | 0.1% | 1.8ms | `add` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts:1785` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `resolve` | `[native code]` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:59` |
| 0.1% | 1.7ms | 0.3% | 6.0ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7867` |
| 0.1% | 1.7ms | 0.8% | 13.3ms | `from` | `[native code]` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `materializeResidentValueSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `get` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js:64` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `async #tryInitSessionFileFromSidecar` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `_string` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:9` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `applyOwnerOnlyPathSecurity` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `FileSessionStorageWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `spawnSync` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `Segmenter` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `cpuUsage` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `checkBox` | `internal:util/inspect` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `defineProperty` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `partitionBytes` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts` |
| 0.0% | 1.3ms | 85.5% | 1.40s | `(anonymous)` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `digest` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `createFileCommitMarkerCheckedSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `removeResidentCacheTreeNoFollow` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `openVerifiedResidentCacheDirectory` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/gjc-runtime/workflow-manifest.ts:169` |
| 0.0% | 1.3ms | 4.9% | 80.5ms | `require` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `_installLazyMethods` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:31` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:84` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/whitespace-control.js` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `never` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `regExpMatchFast` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7829` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/streaming-output.ts:930` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `writer` | `[native code]` |
| 0.0% | 1.2ms | 5.5% | 90.7ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:324` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:299` |
| 0.0% | 1.1ms | 12.2% | 200.8ms | `async write` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:304` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 85.5% | 1.40s | 0.0% | 1.3ms | `(anonymous)` | `[native code]` |
| 84.3% | 1.38s | 0.0% | 0us | `processTicksAndRejections` | `[native code]` |
| 55.0% | 901.7ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7655` |
| 54.8% | 898.8ms | 0.0% | 0us | `#scanBoundedTranscriptForFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7815` |
| 51.0% | 836.5ms | 0.0% | 0us | `scanTranscriptLinesBounded` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1551` |
| 49.9% | 819.0ms | 0.0% | 0us | `consume` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1484` |
| 43.9% | 720.4ms | 43.9% | 720.4ms | `update` | `[native code]` |
| 22.7% | 372.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7821` |
| 22.7% | 372.3ms | 0.0% | 0us | `updateBoundedTranscriptHash` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1382` |
| 19.9% | 326.4ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7864` |
| 19.8% | 325.0ms | 0.0% | 0us | `computeLineDigest` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts:693` |
| 12.2% | 200.8ms | 0.0% | 0us | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:366` |
| 12.2% | 200.8ms | 0.0% | 1.1ms | `async write` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:304` |
| 10.6% | 174.8ms | 0.0% | 0us | `async (anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:307` |
| 10.6% | 174.8ms | 10.6% | 174.8ms | `write` | `[native code]` |
| 7.9% | 129.6ms | 3.2% | 53.5ms | `anonymous` | `[native code]` |
| 6.0% | 99.8ms | 6.0% | 99.8ms | `stringify` | `[native code]` |
| 6.0% | 99.0ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js:1` |
| 5.8% | 95.4ms | 0.0% | 0us | `serialize` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:302` |
| 5.6% | 93.0ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7825` |
| 5.6% | 92.0ms | 5.6% | 92.0ms | `byteLength` | `[native code]` |
| 5.5% | 90.7ms | 0.0% | 1.2ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:324` |
| 5.2% | 85.4ms | 0.0% | 0us | `bound require` | `[native code]` |
| 4.9% | 80.5ms | 0.0% | 1.3ms | `require` | `[native code]` |
| 4.4% | 72.8ms | 4.4% | 72.8ms | `gc` | `[native code]` |
| 4.1% | 68.7ms | 4.1% | 68.7ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/beautiful-mermaid/src/ascii/pathfinder.ts:104` |
| 4.0% | 67.1ms | 0.0% | 0us | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:349` |
| 4.0% | 66.4ms | 4.0% | 66.4ms | `parse` | `[native code]` |
| 3.9% | 64.0ms | 3.9% | 64.0ms | `readSync` | `[native code]` |
| 3.7% | 61.0ms | 0.0% | 0us | `scanTranscriptLinesBounded` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1547` |
| 3.3% | 54.7ms | 3.3% | 54.7ms | `node:net` | `node:net:3` |
| 3.0% | 49.5ms | 3.0% | 49.5ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js` |
| 2.2% | 36.2ms | 0.0% | 0us | `memorySample` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:232` |
| 1.8% | 30.7ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7663` |
| 1.8% | 29.9ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:8` |
| 1.6% | 26.6ms | 1.6% | 26.6ms | `toString` | `[native code]` |
| 1.5% | 26.1ms | 0.0% | 0us | `#buildBoundedFirstOpenSidecars` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8178` |
| 1.5% | 24.9ms | 0.0% | 0us | `async (anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:306` |
| 1.1% | 18.5ms | 0.0% | 0us | `async runWorker` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:821` |
| 1.1% | 18.3ms | 0.0% | 0us | `recordFirstOpenGcRequest` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6543` |
| 1.1% | 18.1ms | 0.0% | 0us | `async settledMemorySample` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:245` |
| 0.9% | 15.5ms | 0.0% | 0us | `init` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:22` |
| 0.9% | 15.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7958` |
| 0.8% | 13.3ms | 0.1% | 1.7ms | `from` | `[native code]` |
| 0.7% | 11.5ms | 0.0% | 0us | `async openNext` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:865` |
| 0.7% | 11.5ms | 0.0% | 0us | `async (anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:871` |
| 0.7% | 11.5ms | 0.0% | 0us | `async open` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17462` |
| 0.7% | 11.5ms | 0.0% | 0us | `async runWorker` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:882` |
| 0.6% | 10.5ms | 0.0% | 0us | `render` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:493` |
| 0.6% | 10.1ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.5% | 9.4ms | 0.5% | 9.4ms | `copy` | `[native code]` |
| 0.5% | 9.2ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/agent/src/compaction/utils.ts:185` |
| 0.5% | 8.7ms | 0.0% | 0us | `internal:streams/transform` | `internal:streams/transform:2` |
| 0.5% | 8.7ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.5% | 8.7ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 0.4% | 8.0ms | 0.0% | 0us | `async open` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17476` |
| 0.4% | 8.0ms | 0.4% | 8.0ms | `indexOf` | `[native code]` |
| 0.4% | 8.0ms | 0.0% | 0us | `consume` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1470` |
| 0.4% | 7.9ms | 0.0% | 0us | `getHandlebars` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:237` |
| 0.4% | 7.9ms | 0.0% | 0us | `compile` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:485` |
| 0.4% | 6.9ms | 0.2% | 3.4ms | `openSync` | `[native code]` |
| 0.4% | 6.6ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/lib/index.js:8` |
| 0.3% | 6.3ms | 0.0% | 0us | `canonicalizeTrustedPath` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/managed-session-scope.ts:406` |
| 0.3% | 6.0ms | 0.1% | 1.7ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7867` |
| 0.3% | 5.3ms | 0.0% | 0us | `consume` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1480` |
| 0.3% | 5.2ms | 0.1% | 2.6ms | `writeSync` | `[native code]` |
| 0.3% | 4.9ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/index.js:16` |
| 0.3% | 4.9ms | 0.0% | 0us | `loadFromCandidates` | `/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/loader-state.js:215` |
| 0.3% | 4.9ms | 0.0% | 0us | `loadNative` | `/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/loader-state.js:544` |
| 0.3% | 4.9ms | 0.3% | 4.9ms | `dlopen` | `[native code]` |
| 0.2% | 4.7ms | 0.1% | 3.0ms | `statSync` | `[native code]` |
| 0.2% | 4.6ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7689` |
| 0.2% | 4.0ms | 0.0% | 0us | `consume` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1494` |
| 0.2% | 3.4ms | 0.2% | 3.4ms | `RegExp` | `[native code]` |
| 0.2% | 3.4ms | 0.2% | 3.4ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:323` |
| 0.2% | 3.4ms | 0.0% | 0us | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:332` |
| 0.1% | 3.1ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/agent/src/compaction/compaction.ts:770` |
| 0.1% | 3.1ms | 0.0% | 0us | `createHash` | `node:crypto:201` |
| 0.1% | 3.1ms | 0.0% | 0us | `Hash` | `node:crypto:178` |
| 0.1% | 3.1ms | 0.1% | 3.1ms | `Hash` | `[native code]` |
| 0.1% | 3.0ms | 0.0% | 0us | `openBufferedWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1815` |
| 0.1% | 3.0ms | 0.0% | 0us | `openFirstOpenSidecarWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6565` |
| 0.1% | 3.0ms | 0.0% | 0us | `bound strict` | `[native code]` |
| 0.1% | 3.0ms | 0.0% | 0us | `scanTranscriptLinesBounded` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1568` |
| 0.1% | 3.0ms | 0.0% | 0us | `statSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1668` |
| 0.1% | 3.0ms | 0.0% | 0us | `map` | `[native code]` |
| 0.1% | 3.0ms | 0.0% | 0us | `readRangeSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1625` |
| 0.1% | 2.8ms | 0.0% | 0us | `#prepareResidentTextStoreTransition` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6957` |
| 0.1% | 2.8ms | 0.0% | 0us | `#newResidentTextStoreCandidate` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6879` |
| 0.1% | 2.7ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:18` |
| 0.1% | 2.7ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.1% | 2.7ms | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.1% | 2.7ms | 0.0% | 0us | `node:events` | `node:events:9` |
| 0.1% | 2.6ms | 0.0% | 0us | `#appendBytes` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1096` |
| 0.1% | 2.6ms | 0.0% | 0us | `#flushPending` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1080` |
| 0.1% | 2.6ms | 0.0% | 0us | `writeFirstOpenSidecarBytes` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6575` |
| 0.1% | 2.6ms | 0.0% | 0us | `writeBytesSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1105` |
| 0.1% | 2.6ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7886` |
| 0.1% | 2.6ms | 0.0% | 0us | `#writeToKernel` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1070` |
| 0.1% | 2.6ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:508` |
| 0.1% | 2.6ms | 0.0% | 0us | `_number` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:307` |
| 0.1% | 2.6ms | 0.0% | 0us | `ZodNumber` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` |
| 0.1% | 2.5ms | 0.0% | 0us | `ret` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/compiler.js:517` |
| 0.1% | 2.5ms | 0.0% | 0us | `compileInput` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/compiler.js:508` |
| 0.1% | 2.5ms | 0.0% | 0us | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:340` |
| 0.1% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:22` |
| 0.1% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/code-gen.js:15` |
| 0.1% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/javascript-compiler.js:16` |
| 0.1% | 1.8ms | 0.0% | 0us | `format` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:134` |
| 0.1% | 1.8ms | 0.1% | 1.8ms | `stringSplitFast` | `[native code]` |
| 0.1% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7861` |
| 0.1% | 1.8ms | 0.1% | 1.8ms | `add` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts:1785` |
| 0.1% | 1.7ms | 0.0% | 0us | `#buildBoundedFirstOpenSidecars` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8083` |
| 0.1% | 1.7ms | 0.0% | 0us | `canonicalizeTrustedPath` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/managed-session-scope.ts:403` |
| 0.1% | 1.7ms | 0.0% | 0us | `bound resolve` | `[native code]` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `resolve` | `[native code]` |
| 0.1% | 1.7ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:131` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:59` |
| 0.1% | 1.7ms | 0.0% | 0us | `async sweepResidentCacheRoot` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:564` |
| 0.1% | 1.7ms | 0.0% | 0us | `openVerifiedResidentCacheDirectory` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:178` |
| 0.1% | 1.7ms | 0.0% | 0us | `readResidentCacheOwnerSnapshot` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:284` |
| 0.1% | 1.7ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/marked/lib/marked.esm.js:14` |
| 0.1% | 1.7ms | 0.0% | 0us | `getRegex` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/marked/lib/marked.esm.js:13` |
| 0.1% | 1.7ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:2` |
| 0.1% | 1.7ms | 0.0% | 0us | `inspectTranscriptHeaderBounded` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:3599` |
| 0.1% | 1.7ms | 0.0% | 0us | `async open` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17481` |
| 0.1% | 1.7ms | 0.0% | 0us | `#prepareResidentTextStoreTransition` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6958` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `materializeResidentValueSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` |
| 0.1% | 1.7ms | 0.0% | 0us | `#preparedResidentTransitionFromSource` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6906` |
| 0.1% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:58` |
| 0.1% | 1.7ms | 0.0% | 0us | `ZodObject` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `get` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js:64` |
| 0.1% | 1.7ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/auth-broker/wire-schemas.ts:141` |
| 0.1% | 1.7ms | 0.0% | 0us | `bound clone` | `[native code]` |
| 0.1% | 1.7ms | 0.0% | 0us | `clone` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js:262` |
| 0.1% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:738` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #initSessionFile` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8380` |
| 0.1% | 1.7ms | 0.0% | 0us | `async open` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17502` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #tryInitSessionFileFromSidecar` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7349` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #initSessionFile` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8388` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `async #tryInitSessionFileFromSidecar` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` |
| 0.1% | 1.7ms | 0.0% | 0us | `get ReadStream` | `node:fs:578` |
| 0.1% | 1.7ms | 0.0% | 0us | `internal:fs/streams` | `internal:fs/streams:2` |
| 0.1% | 1.7ms | 0.0% | 0us | `node:stream` | `node:stream:2` |
| 0.1% | 1.7ms | 0.0% | 0us | `internal:stream` | `internal:stream:48` |
| 0.1% | 1.7ms | 0.0% | 0us | `async runWorker` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:898` |
| 0.1% | 1.7ms | 0.0% | 0us | `async measurePhase` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:595` |
| 0.1% | 1.7ms | 0.0% | 0us | `#resolveEntry` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12653` |
| 0.1% | 1.7ms | 0.0% | 0us | `async measurePhase` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:592` |
| 0.1% | 1.7ms | 0.0% | 0us | `#coldIndexDigestValid` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12335` |
| 0.1% | 1.7ms | 0.0% | 0us | `getEntry` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:16161` |
| 0.1% | 1.7ms | 0.0% | 0us | `#findColdEntryIndex` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12389` |
| 0.1% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:900` |
| 0.1% | 1.7ms | 0.0% | 0us | `_null` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:438` |
| 0.1% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:651` |
| 0.1% | 1.7ms | 0.1% | 1.7ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js` |
| 0.1% | 1.7ms | 0.0% | 0us | `ZodNull` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` |
| 0.1% | 1.7ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/providers/openai-responses-server-schema.ts:244` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #acquireBoundedFirstOpenLock` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7598` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #initSessionFile` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8393` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7605` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #acquireBoundedFirstOpenLock` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7590` |
| 0.1% | 1.7ms | 0.0% | 0us | `acquireExclusiveLockSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1527` |
| 0.1% | 1.7ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7628` |
| 0.1% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js:1685` |
| 0.1% | 1.6ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/providers/anthropic-messages-server-schema.ts:177` |
| 0.1% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:1029` |
| 0.1% | 1.6ms | 0.0% | 0us | `literal` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:1043` |
| 0.1% | 1.6ms | 0.0% | 0us | `ZodLiteral` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `_string` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:9` |
| 0.0% | 1.6ms | 0.0% | 0us | `string` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:290` |
| 0.0% | 1.6ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/modes/theme/theme.ts:920` |
| 0.0% | 1.5ms | 0.0% | 0us | `secureOwnerOnlyFileDescriptor` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:668` |
| 0.0% | 1.5ms | 0.0% | 0us | `FileSessionStorageWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1022` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `applyOwnerOnlyPathSecurity` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 0us | `#buildBoundedFirstOpenSidecars` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8201` |
| 0.0% | 1.5ms | 0.0% | 0us | `#scanBoundedTranscriptForFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7814` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `FileSessionStorageWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` |
| 0.0% | 1.4ms | 0.0% | 0us | `residentCacheProcessStartTimeMs` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:207` |
| 0.0% | 1.4ms | 0.0% | 0us | `writeResidentCacheOwnerToken` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:314` |
| 0.0% | 1.4ms | 0.0% | 0us | `openVerifiedResidentCacheInstanceDir` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:621` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `spawnSync` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/tui/src/utils.ts:173` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `Segmenter` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/source-map.js:6` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/lib/source-map-generator.js:9` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `cpuUsage` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 0us | `fsyncFirstOpenSidecarWriter` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6591` |
| 0.0% | 1.4ms | 0.0% | 0us | `#scanBoundedTranscriptForFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7999` |
| 0.0% | 1.4ms | 0.0% | 0us | `recordFirstOpenPhase` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6520` |
| 0.0% | 1.4ms | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:35` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `checkBox` | `internal:util/inspect` |
| 0.0% | 1.4ms | 0.0% | 0us | `node:util` | `node:util:2` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:18` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `defineProperty` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:22` |
| 0.0% | 1.3ms | 0.0% | 0us | `async runWorker` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:818` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `partitionBytes` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:14` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `digest` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 0us | `dispose` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:1234` |
| 0.0% | 1.3ms | 0.0% | 0us | `#releaseResidentTextStore` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7163` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `createFileCommitMarkerCheckedSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` |
| 0.0% | 1.3ms | 0.0% | 0us | `async #tryBoundedFirstOpen` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7671` |
| 0.0% | 1.3ms | 0.0% | 0us | `disposeVerifiedResidentCacheInstanceDir` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:422` |
| 0.0% | 1.3ms | 0.0% | 0us | `createSessionCommitMarkerCheckedSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:781` |
| 0.0% | 1.3ms | 0.0% | 0us | `#withSessionPersistenceFenceSync` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:10088` |
| 0.0% | 1.3ms | 0.0% | 0us | `#disposeResidentTextStore` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7072` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `removeResidentCacheTreeNoFollow` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` |
| 0.0% | 1.3ms | 0.0% | 0us | `async close` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:14111` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:10486` |
| 0.0% | 1.3ms | 0.0% | 0us | `openVerifiedResidentCacheInstanceDir` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:605` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `openVerifiedResidentCacheDirectory` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/gjc-runtime/workflow-manifest.ts:169` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/base.js:15` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:8` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.runtime.js:12` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/helpers.js:34` |
| 0.0% | 1.3ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/usage.ts:83` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:92` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `_installLazyMethods` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:31` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js:8` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js:11` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:28` |
| 0.0% | 1.3ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/utils/discovery/gemini.ts:15` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:84` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/whitespace-control.js` |
| 0.0% | 1.3ms | 0.0% | 0us | `accept` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/visitor.js:72` |
| 0.0% | 1.2ms | 0.0% | 0us | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/auth-broker/wire-schemas.ts:24` |
| 0.0% | 1.2ms | 0.0% | 0us | `strict` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:757` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `never` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js` |
| 0.0% | 1.2ms | 0.0% | 0us | `lex` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:297` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `regExpMatchFast` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `parse` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:320` |
| 0.0% | 1.2ms | 0.0% | 0us | `parseWithoutProcessing` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:53` |
| 0.0% | 1.2ms | 0.0% | 0us | `lex` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:526` |
| 0.0% | 1.2ms | 0.0% | 0us | `parse` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:59` |
| 0.0% | 1.2ms | 0.0% | 0us | `next` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:491` |
| 0.0% | 1.2ms | 0.0% | 0us | `#buildBoundedFirstOpenSidecars` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8173` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7829` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(module)` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/streaming-output.ts:930` |
| 0.0% | 1.2ms | 0.0% | 0us | `getSessionMemoryStats` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:14304` |
| 0.0% | 1.2ms | 0.0% | 0us | `async runWorker` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:907` |
| 0.0% | 1.2ms | 0.0% | 0us | `loadAssertionError` | `node:assert:28` |
| 0.0% | 1.2ms | 0.0% | 0us | `refresh` | `internal:util/colors:18` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:assert/assertion_error` | `internal:assert/assertion_error:2` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:util/colors` | `internal:util/colors:24` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `writer` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `node:assert` | `node:assert:588` |
| 0.0% | 1.2ms | 0.0% | 0us | `node:assert/strict` | `node:assert/strict:3` |
| 0.0% | 1.2ms | 0.0% | 0us | `assign` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `WriteStream` | `internal:fs/streams:244` |
| 0.0% | 1.2ms | 0.0% | 0us | `get` | `node:assert:70` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async generateTranscript` | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:299` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/propagation-api.js:10` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:59` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/source-map.js:7` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/lib/source-map-consumer.js:9` |

## Function Details

### `update`
`[native code]` | Self: 43.9% (720.4ms) | Total: 43.9% (720.4ms) | Samples: 476

**Called by:**
- `updateBoundedTranscriptHash` (249)
- `computeLineDigest` (214)
- `#buildBoundedFirstOpenSidecars` (13)

### `write`
`[native code]` | Self: 10.6% (174.8ms) | Total: 10.6% (174.8ms) | Samples: 119

**Called by:**
- `async (anonymous)` (119)

### `stringify`
`[native code]` | Self: 6.0% (99.8ms) | Total: 6.0% (99.8ms) | Samples: 67

**Called by:**
- `serialize` (64)
- `(anonymous)` (3)

### `byteLength`
`[native code]` | Self: 5.6% (92.0ms) | Total: 5.6% (92.0ms) | Samples: 62

**Called by:**
- `async generateTranscript` (45)
- `async (anonymous)` (17)

### `gc`
`[native code]` | Self: 4.4% (72.8ms) | Total: 4.4% (72.8ms) | Samples: 37

**Called by:**
- `memorySample` (14)
- `recordFirstOpenGcRequest` (12)
- `async settledMemorySample` (11)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/beautiful-mermaid/src/ascii/pathfinder.ts:104` | Self: 4.1% (68.7ms) | Total: 4.1% (68.7ms) | Samples: 1

### `parse`
`[native code]` | Self: 4.0% (66.4ms) | Total: 4.0% (66.4ms) | Samples: 44

**Called by:**
- `(anonymous)` (44)

### `readSync`
`[native code]` | Self: 3.9% (64.0ms) | Total: 3.9% (64.0ms) | Samples: 42

**Called by:**
- `scanTranscriptLinesBounded` (40)
- `readRangeSync` (2)

### `node:net`
`node:net:3` | Self: 3.3% (54.7ms) | Total: 3.3% (54.7ms) | Samples: 1

### `anonymous`
`[native code]` | Self: 3.2% (53.5ms) | Total: 7.9% (129.6ms) | Samples: 12

**Called by:**
- `require` (34)
- `node:crypto` (2)
- `node:util` (1)
- `loadAssertionError` (1)
- `node:stream` (1)
- `node:fs/promises` (1)
- `get ReadStream` (1)
- `internal:assert/assertion_error` (1)
- `internal:stream` (1)
- `internal:validators` (1)
- `internal:streams/transform` (1)
- `internal:fs/streams` (1)
- `internal:streams/duplex` (1)
- `node:assert/strict` (1)
- `internal:streams/lazy_transform` (1)
- `node:events` (1)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `internal:assert/assertion_error` (1)
- `node:events` (1)
- `(anonymous)` (1)
- `internal:streams/transform` (1)
- `internal:streams/duplex` (1)
- `internal:util/inspect` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:util/colors` (1)
- `(anonymous)` (1)
- `node:stream` (1)
- `internal:stream` (1)
- `internal:validators` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:fs/streams` (1)
- `(anonymous)` (1)
- `node:assert` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:streams/lazy_transform` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js` | Self: 3.0% (49.5ms) | Total: 3.0% (49.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `toString`
`[native code]` | Self: 1.6% (26.6ms) | Total: 1.6% (26.6ms) | Samples: 18

**Called by:**
- `(anonymous)` (18)

### `copy`
`[native code]` | Self: 0.5% (9.4ms) | Total: 0.5% (9.4ms) | Samples: 7

**Called by:**
- `consume` (4)
- `consume` (3)

### `indexOf`
`[native code]` | Self: 0.4% (8.0ms) | Total: 0.4% (8.0ms) | Samples: 6

**Called by:**
- `consume` (6)

### `dlopen`
`[native code]` | Self: 0.3% (4.9ms) | Total: 0.3% (4.9ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `openSync`
`[native code]` | Self: 0.2% (3.4ms) | Total: 0.4% (6.9ms) | Samples: 2

**Called by:**
- `openSync` (2)
- `openVerifiedResidentCacheDirectory` (1)
- `acquireExclusiveLockSync` (1)

**Calls:**
- `openSync` (2)

### `RegExp`
`[native code]` | Self: 0.2% (3.4ms) | Total: 0.2% (3.4ms) | Samples: 2

**Called by:**
- `getRegex` (1)
- `(anonymous)` (1)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:323` | Self: 0.2% (3.4ms) | Total: 0.2% (3.4ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `Hash`
`[native code]` | Self: 0.1% (3.1ms) | Total: 0.1% (3.1ms) | Samples: 2

**Called by:**
- `Hash` (2)

### `statSync`
`[native code]` | Self: 0.1% (3.0ms) | Total: 0.2% (4.7ms) | Samples: 2

**Called by:**
- `statSync` (2)
- `statSync` (1)

**Calls:**
- `statSync` (1)

### `writeSync`
`[native code]` | Self: 0.1% (2.6ms) | Total: 0.3% (5.2ms) | Samples: 2

**Called by:**
- `writeSync` (2)
- `#writeToKernel` (2)

**Calls:**
- `writeSync` (2)

### `stringSplitFast`
`[native code]` | Self: 0.1% (1.8ms) | Total: 0.1% (1.8ms) | Samples: 1

**Called by:**
- `format` (1)

### `add`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts:1785` | Self: 0.1% (1.8ms) | Total: 0.1% (1.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `resolve`
`[native code]` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `bound resolve` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:59` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7867` | Self: 0.1% (1.7ms) | Total: 0.3% (6.0ms) | Samples: 1

**Called by:**
- `consume` (4)

**Calls:**
- `stringify` (3)

### `from`
`[native code]` | Self: 0.1% (1.7ms) | Total: 0.8% (13.3ms) | Samples: 1

**Called by:**
- `async runWorker` (7)
- `(module)` (1)

**Calls:**
- `async openNext` (7)

### `materializeResidentValueSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `map` (1)

### `get`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js:64` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async #tryInitSessionFileFromSidecar`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `async #tryInitSessionFileFromSidecar` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js` | Self: 0.1% (1.7ms) | Total: 0.1% (1.7ms) | Samples: 1

**Called by:**
- `init` (1)

### `_string`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:9` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `string` (1)

### `applyOwnerOnlyPathSecurity`
`[native code]` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `secureOwnerOnlyFileDescriptor` (1)

### `FileSessionStorageWriter`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `openBufferedWriter` (1)

### `spawnSync`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `residentCacheProcessStartTimeMs` (1)

### `Segmenter`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `cpuUsage`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `recordFirstOpenPhase` (1)

### `checkBox`
`internal:util/inspect` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `defineProperty`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `partitionBytes`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `async runWorker` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (1.3ms) | Total: 85.5% (1.40s) | Samples: 1

**Called by:**
- `processTicksAndRejections` (910)
- `require` (4)
- `(anonymous)` (4)
- `bound require` (3)
- `refresh` (1)

**Calls:**
- `async #tryBoundedFirstOpen` (602)
- `async generateTranscript` (137)
- `async generateTranscript` (61)
- `async generateTranscript` (45)
- `async #tryBoundedFirstOpen` (16)
- `memorySample` (11)
- `async settledMemorySample` (11)
- `async runWorker` (7)
- `(anonymous)` (4)
- `async #tryBoundedFirstOpen` (3)
- `dlopen` (3)
- `(module)` (3)
- `async runWorker` (3)
- `async generateTranscript` (2)
- `async generateTranscript` (2)
- `async generateTranscript` (2)
- `async close` (1)
- `WriteStream` (1)
- `async #initSessionFile` (1)
- `async generateTranscript` (1)
- `async runWorker` (1)
- `async runWorker` (1)
- `async sweepResidentCacheRoot` (1)
- `async #tryBoundedFirstOpen` (1)
- `async runWorker` (1)

### `digest`
`[native code]` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `createFileCommitMarkerCheckedSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `createSessionCommitMarkerCheckedSync` (1)

### `removeResidentCacheTreeNoFollow`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `disposeVerifiedResidentCacheInstanceDir` (1)

### `openVerifiedResidentCacheDirectory`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `openVerifiedResidentCacheInstanceDir` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/gjc-runtime/workflow-manifest.ts:169` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

### `require`
`[native code]` | Self: 0.0% (1.3ms) | Total: 4.9% (80.5ms) | Samples: 1

**Called by:**
- `bound require` (39)

**Calls:**
- `anonymous` (34)
- `(anonymous)` (4)

### `_installLazyMethods`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:31` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:84` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/whitespace-control.js` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `accept` (1)

### `never`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `strict` (1)

### `regExpMatchFast`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `next` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7829` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `consume` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/streaming-output.ts:930` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

### `writer`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:324` | Self: 0.0% (1.2ms) | Total: 5.5% (90.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (61)

**Calls:**
- `serialize` (60)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:299` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async write`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:304` | Self: 0.0% (1.1ms) | Total: 12.2% (200.8ms) | Samples: 1

**Called by:**
- `async generateTranscript` (137)

**Calls:**
- `async (anonymous)` (119)
- `async (anonymous)` (17)

### `recordFirstOpenGcRequest`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6543` | Self: 0.0% (0us) | Total: 1.1% (18.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (10)
- `scanTranscriptLinesBounded` (2)

**Calls:**
- `gc` (12)

### `ZodNull`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `_null` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:651` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:92` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `_installLazyMethods` (1)

### `clone`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js:262` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `bound clone` (1)

**Calls:**
- `ZodObject` (1)

### `bound resolve`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `canonicalizeTrustedPath` (1)

**Calls:**
- `resolve` (1)

### `#preparedResidentTransitionFromSource`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6906` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `#prepareResidentTextStoreTransition` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js:1` | Self: 0.0% (0us) | Total: 6.0% (99.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 5.2% (85.4ms) | Samples: 0

**Called by:**
- `getHandlebars` (6)
- `(anonymous)` (5)
- `canonicalizeTrustedPath` (4)
- `loadFromCandidates` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (39)
- `(anonymous)` (3)

### `next`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:491` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `lex` (1)

**Calls:**
- `regExpMatchFast` (1)

### `loadNative`
`/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/loader-state.js:544` | Self: 0.0% (0us) | Total: 0.3% (4.9ms) | Samples: 0

**Called by:**
- `(module)` (3)

**Calls:**
- `loadFromCandidates` (3)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async openNext`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:865` | Self: 0.0% (0us) | Total: 0.7% (11.5ms) | Samples: 0

**Called by:**
- `from` (7)

**Calls:**
- `async (anonymous)` (7)

### `openVerifiedResidentCacheInstanceDir`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:605` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `#newResidentTextStoreCandidate` (1)

**Calls:**
- `openVerifiedResidentCacheDirectory` (1)

### `writeFirstOpenSidecarBytes`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6575` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `writeBytesSync` (2)

### `updateBoundedTranscriptHash`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1382` | Self: 0.0% (0us) | Total: 22.7% (372.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (249)

**Calls:**
- `update` (249)

### `serialize`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:302` | Self: 0.0% (0us) | Total: 5.8% (95.4ms) | Samples: 0

**Called by:**
- `async generateTranscript` (60)
- `async generateTranscript` (2)
- `async generateTranscript` (2)

**Calls:**
- `stringify` (64)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/code-gen.js:15` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7825` | Self: 0.0% (0us) | Total: 5.6% (93.0ms) | Samples: 0

**Called by:**
- `consume` (62)

**Calls:**
- `parse` (44)
- `toString` (18)

### `Hash`
`node:crypto:178` | Self: 0.0% (0us) | Total: 0.1% (3.1ms) | Samples: 0

**Called by:**
- `createHash` (2)

**Calls:**
- `Hash` (2)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/lib/index.js:8` | Self: 0.0% (0us) | Total: 0.4% (6.6ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `refresh`
`internal:util/colors:18` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `internal:util/colors` (1)

**Calls:**
- `(anonymous)` (1)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:340` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `serialize` (2)

### `openVerifiedResidentCacheInstanceDir`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:621` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `#newResidentTextStoreCandidate` (1)

**Calls:**
- `writeResidentCacheOwnerToken` (1)

### `getEntry`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:16161` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `#resolveEntry` (1)

### `async open`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17476` | Self: 0.0% (0us) | Total: 0.4% (8.0ms) | Samples: 0

**Called by:**
- `async open` (5)

**Calls:**
- `canonicalizeTrustedPath` (4)
- `canonicalizeTrustedPath` (1)

### `statSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1668` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `inspectTranscriptHeaderBounded` (1)
- `getSessionMemoryStats` (1)

**Calls:**
- `statSync` (2)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:349` | Self: 0.0% (0us) | Total: 4.0% (67.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (45)

**Calls:**
- `byteLength` (45)

### `createSessionCommitMarkerCheckedSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:781` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `createFileCommitMarkerCheckedSync` (1)

### `createHash`
`node:crypto:201` | Self: 0.0% (0us) | Total: 0.1% (3.1ms) | Samples: 0

**Called by:**
- `computeLineDigest` (2)

**Calls:**
- `Hash` (2)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/tui/src/utils.ts:173` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `Segmenter` (1)

### `internal:util/colors`
`internal:util/colors:24` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `refresh` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:59` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `#findColdEntryIndex`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12389` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `#resolveEntry` (1)

**Calls:**
- `#coldIndexDigestValid` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:508` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `init` (2)

**Calls:**
- `init` (2)

### `get`
`node:assert:70` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `assign` (1)

**Calls:**
- `loadAssertionError` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/agent/src/compaction/utils.ts:185` | Self: 0.0% (0us) | Total: 0.5% (9.2ms) | Samples: 0

**Calls:**
- `render` (7)

### `get ReadStream`
`node:fs:578` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `canonicalizeTrustedPath`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/managed-session-scope.ts:403` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async open` (1)

**Calls:**
- `bound resolve` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/providers/openai-responses-server-schema.ts:244` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `_null` (1)

### `FileSessionStorageWriter`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1022` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `openBufferedWriter` (1)

**Calls:**
- `secureOwnerOnlyFileDescriptor` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:18` | Self: 0.0% (0us) | Total: 0.1% (2.7ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `ZodObject`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `clone` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7958` | Self: 0.0% (0us) | Total: 0.9% (15.3ms) | Samples: 0

**Called by:**
- `consume` (10)

**Calls:**
- `recordFirstOpenGcRequest` (10)

### `ZodNumber`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `_number` (2)

**Calls:**
- `init` (2)

### `bound strict`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `strict` (1)
- `bound clone` (1)

### `parseWithoutProcessing`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:53` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `parse` (1)

**Calls:**
- `parse` (1)

### `async runWorker`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:818` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `partitionBytes` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7821` | Self: 0.0% (0us) | Total: 22.7% (372.3ms) | Samples: 0

**Called by:**
- `consume` (249)

**Calls:**
- `updateBoundedTranscriptHash` (249)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:10486` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `#withSessionPersistenceFenceSync` (1)

**Calls:**
- `createSessionCommitMarkerCheckedSync` (1)

### `ZodLiteral`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:41` | Self: 0.0% (0us) | Total: 0.1% (1.6ms) | Samples: 0

**Called by:**
- `literal` (1)

**Calls:**
- `init` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/base.js:15` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `getHandlebars`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:237` | Self: 0.0% (0us) | Total: 0.4% (7.9ms) | Samples: 0

**Called by:**
- `compile` (6)

**Calls:**
- `bound require` (6)

### `accept`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/visitor.js:72` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `compileInput` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/javascript-compiler.js:16` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.js:22` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:366` | Self: 0.0% (0us) | Total: 12.2% (200.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (137)

**Calls:**
- `async write` (137)

### `init`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/core.js:22` | Self: 0.0% (0us) | Total: 0.9% (15.5ms) | Samples: 0

**Called by:**
- `ZodNumber` (2)
- `(anonymous)` (2)
- `ZodObject` (1)
- `(anonymous)` (1)
- `ZodLiteral` (1)
- `ZodNull` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `dispose`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:1234` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `#disposeResidentTextStore` (1)

**Calls:**
- `disposeVerifiedResidentCacheInstanceDir` (1)

### `render`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:493` | Self: 0.0% (0us) | Total: 0.6% (10.5ms) | Samples: 0

**Called by:**
- `(module)` (7)
- `(module)` (1)

**Calls:**
- `compile` (6)
- `ret` (2)

### `canonicalizeTrustedPath`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/managed-session-scope.ts:406` | Self: 0.0% (0us) | Total: 0.3% (6.3ms) | Samples: 0

**Called by:**
- `async open` (4)

**Calls:**
- `bound require` (4)

### `async #acquireBoundedFirstOpenLock`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7598` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #acquireBoundedFirstOpenLock` (1)

**Calls:**
- `acquireExclusiveLockSync` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/modes/theme/theme.ts:920` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Calls:**
- `string` (1)

### `#scanBoundedTranscriptForFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7815` | Self: 0.0% (0us) | Total: 54.8% (898.8ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (600)

**Calls:**
- `scanTranscriptLinesBounded` (559)
- `scanTranscriptLinesBounded` (39)
- `scanTranscriptLinesBounded` (2)

### `#scanBoundedTranscriptForFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7999` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `fsyncFirstOpenSidecarWriter` (1)

### `processTicksAndRejections`
`[native code]` | Self: 0.0% (0us) | Total: 84.3% (1.38s) | Samples: 0

**Calls:**
- `(anonymous)` (910)

### `writeBytesSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1105` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `writeFirstOpenSidecarBytes` (2)

**Calls:**
- `#appendBytes` (2)

### `async #initSessionFile`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8393` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `async #tryBoundedFirstOpen` (1)

### `async settledMemorySample`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:245` | Self: 0.0% (0us) | Total: 1.1% (18.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (11)

**Calls:**
- `gc` (11)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/agent/src/compaction/compaction.ts:770` | Self: 0.0% (0us) | Total: 0.1% (3.1ms) | Samples: 0

**Calls:**
- `render` (1)
- `format` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/marked/lib/marked.esm.js:14` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `getRegex` (1)

### `loadFromCandidates`
`/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/loader-state.js:215` | Self: 0.0% (0us) | Total: 0.3% (4.9ms) | Samples: 0

**Called by:**
- `loadNative` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:8` | Self: 0.0% (0us) | Total: 1.8% (29.9ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/auth-broker/wire-schemas.ts:141` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `bound strict` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:131` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.5% (8.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `async generateTranscript`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:332` | Self: 0.0% (0us) | Total: 0.2% (3.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `serialize` (2)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.1% (2.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `compile`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:485` | Self: 0.0% (0us) | Total: 0.4% (7.9ms) | Samples: 0

**Called by:**
- `render` (6)

**Calls:**
- `getHandlebars` (6)

### `internal:fs/streams`
`internal:fs/streams:2` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `openFirstOpenSidecarWriter`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6565` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `#scanBoundedTranscriptForFirstOpen` (1)
- `#buildBoundedFirstOpenSidecars` (1)

**Calls:**
- `openBufferedWriter` (2)

### `#scanBoundedTranscriptForFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7814` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `openFirstOpenSidecarWriter` (1)

### `async close`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:14111` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `#releaseResidentTextStore` (1)

### `readResidentCacheOwnerSnapshot`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:284` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async sweepResidentCacheRoot` (1)

**Calls:**
- `openVerifiedResidentCacheDirectory` (1)

### `lex`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:297` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `parse` (1)

**Calls:**
- `lex` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/source-map.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `ret`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/compiler.js:517` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `render` (2)

**Calls:**
- `compileInput` (2)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:738` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `inspectTranscriptHeaderBounded`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:3599` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async open` (1)

**Calls:**
- `statSync` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/utils/discovery/gemini.ts:15` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `_number` (1)

### `#prepareResidentTextStoreTransition`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6958` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `#preparedResidentTransitionFromSource` (1)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (0us) | Total: 0.5% (8.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `async measurePhase`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:595` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async measurePhase` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `defineProperty` (1)

### `#releaseResidentTextStore`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7163` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `async close` (1)

**Calls:**
- `#disposeResidentTextStore` (1)

### `#buildBoundedFirstOpenSidecars`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8178` | Self: 0.0% (0us) | Total: 1.5% (26.1ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (13)

**Calls:**
- `update` (13)

### `#resolveEntry`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12653` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `getEntry` (1)

**Calls:**
- `#findColdEntryIndex` (1)

### `string`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:290` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `_string` (1)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7663` | Self: 0.0% (0us) | Total: 1.8% (30.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (16)

**Calls:**
- `#buildBoundedFirstOpenSidecars` (13)
- `#buildBoundedFirstOpenSidecars` (1)
- `#buildBoundedFirstOpenSidecars` (1)
- `#buildBoundedFirstOpenSidecars` (1)

### `#buildBoundedFirstOpenSidecars`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8083` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `scanTranscriptLinesBounded` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/propagation-api.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/usage.ts:83` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `_number` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7886` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `consume` (2)

**Calls:**
- `writeFirstOpenSidecarBytes` (2)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js:1685` | Self: 0.0% (0us) | Total: 0.1% (1.6ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `RegExp` (1)

### `consume`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1480` | Self: 0.0% (0us) | Total: 0.3% (5.3ms) | Samples: 0

**Called by:**
- `scanTranscriptLinesBounded` (4)

**Calls:**
- `copy` (4)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7605` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #initSessionFile` (1)

**Calls:**
- `async #tryBoundedFirstOpen` (1)

### `#prepareResidentTextStoreTransition`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6957` | Self: 0.0% (0us) | Total: 0.1% (2.8ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (2)

**Calls:**
- `#newResidentTextStoreCandidate` (2)

### `writeResidentCacheOwnerToken`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:314` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `openVerifiedResidentCacheInstanceDir` (1)

**Calls:**
- `residentCacheProcessStartTimeMs` (1)

### `async (anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:871` | Self: 0.0% (0us) | Total: 0.7% (11.5ms) | Samples: 0

**Called by:**
- `async openNext` (7)

**Calls:**
- `async open` (7)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/helpers.js:34` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#flushPending`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1080` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `#appendBytes` (2)

**Calls:**
- `#writeToKernel` (2)

### `consume`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1470` | Self: 0.0% (0us) | Total: 0.4% (8.0ms) | Samples: 0

**Called by:**
- `scanTranscriptLinesBounded` (6)

**Calls:**
- `indexOf` (6)

### `async (anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:306` | Self: 0.0% (0us) | Total: 1.5% (24.9ms) | Samples: 0

**Called by:**
- `async write` (17)

**Calls:**
- `byteLength` (17)

### `internal:assert/assertion_error`
`internal:assert/assertion_error:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:900` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async measurePhase` (1)

**Calls:**
- `getEntry` (1)

### `node:stream`
`node:stream:2` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.1% (2.7ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `secureOwnerOnlyFileDescriptor`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:668` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `FileSessionStorageWriter` (1)

**Calls:**
- `applyOwnerOnlyPathSecurity` (1)

### `async #initSessionFile`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8388` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #initSessionFile` (1)

**Calls:**
- `async #tryInitSessionFileFromSidecar` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/natives/native/index.js:16` | Self: 0.0% (0us) | Total: 0.3% (4.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `loadNative` (3)

### `async open`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17481` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async open` (1)

**Calls:**
- `inspectTranscriptHeaderBounded` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars.runtime.js:12` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/providers/anthropic-messages-server-schema.ts:177` | Self: 0.0% (0us) | Total: 0.1% (1.6ms) | Samples: 0

**Calls:**
- `literal` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/source-map.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async sweepResidentCacheRoot`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:564` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `readResidentCacheOwnerSnapshot` (1)

### `#appendBytes`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1096` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `writeBytesSync` (2)

**Calls:**
- `#flushPending` (2)

### `async runWorker`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:821` | Self: 0.0% (0us) | Total: 1.1% (18.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `memorySample` (3)

### `async runWorker`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:898` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `async measurePhase` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:22` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async #initSessionFile`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8380` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async open` (1)

**Calls:**
- `async #initSessionFile` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/index.js:28` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `residentCacheProcessStartTimeMs`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:207` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `writeResidentCacheOwnerToken` (1)

**Calls:**
- `spawnSync` (1)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7628` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `async #acquireBoundedFirstOpenLock` (1)

### `consume`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1484` | Self: 0.0% (0us) | Total: 49.9% (819.0ms) | Samples: 0

**Called by:**
- `scanTranscriptLinesBounded` (546)

**Calls:**
- `(anonymous)` (249)
- `(anonymous)` (217)
- `(anonymous)` (62)
- `(anonymous)` (10)
- `(anonymous)` (4)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7864` | Self: 0.0% (0us) | Total: 19.9% (326.4ms) | Samples: 0

**Called by:**
- `consume` (217)

**Calls:**
- `computeLineDigest` (216)
- `digest` (1)

### `recordFirstOpenPhase`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6520` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `fsyncFirstOpenSidecarWriter` (1)

**Calls:**
- `cpuUsage` (1)

### `#buildBoundedFirstOpenSidecars`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8201` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `openFirstOpenSidecarWriter` (1)

### `getSessionMemoryStats`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:14304` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `statSync` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/lib/source-map-generator.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7671` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `#withSessionPersistenceFenceSync` (1)

### `parse`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:59` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `compileInput` (1)

**Calls:**
- `parseWithoutProcessing` (1)

### `acquireExclusiveLockSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1527` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #acquireBoundedFirstOpenLock` (1)

**Calls:**
- `openSync` (1)

### `assign`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `node:assert` (1)

**Calls:**
- `get` (1)

### `node:util`
`node:util:2` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `async runWorker`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:907` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `map` (1)

### `scanTranscriptLinesBounded`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1551` | Self: 0.0% (0us) | Total: 51.0% (836.5ms) | Samples: 0

**Called by:**
- `#scanBoundedTranscriptForFirstOpen` (559)

**Calls:**
- `consume` (546)
- `consume` (6)
- `consume` (4)
- `consume` (3)

### `consume`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1494` | Self: 0.0% (0us) | Total: 0.2% (4.0ms) | Samples: 0

**Called by:**
- `scanTranscriptLinesBounded` (3)

**Calls:**
- `copy` (3)

### `map`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `async runWorker` (1)
- `#preparedResidentTransitionFromSource` (1)

**Calls:**
- `getSessionMemoryStats` (1)
- `materializeResidentValueSync` (1)

### `_number`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:307` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `ZodNumber` (2)

### `_null`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js:438` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodNull` (1)

### `computeLineDigest`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts:693` | Self: 0.0% (0us) | Total: 19.8% (325.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (216)

**Calls:**
- `update` (214)
- `createHash` (2)

### `internal:util/inspect`
`internal:util/inspect:35` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `checkBox` (1)

### `parse`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:320` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `parseWithoutProcessing` (1)

**Calls:**
- `lex` (1)

### `#disposeResidentTextStore`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7072` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `#releaseResidentTextStore` (1)

**Calls:**
- `dispose` (1)

### `#buildBoundedFirstOpenSidecars`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:8173` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `readRangeSync` (1)

### `lex`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/parser.js:526` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `lex` (1)

**Calls:**
- `next` (1)

### `loadAssertionError`
`node:assert:28` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `get` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/source-map/lib/source-map-consumer.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `format`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/prompt.ts:134` | Self: 0.0% (0us) | Total: 0.1% (1.8ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `stringSplitFast` (1)

### `WriteStream`
`internal:fs/streams:244` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `writer` (1)

### `fsyncFirstOpenSidecarWriter`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6591` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `#scanBoundedTranscriptForFirstOpen` (1)

**Calls:**
- `recordFirstOpenPhase` (1)

### `async (anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:307` | Self: 0.0% (0us) | Total: 10.6% (174.8ms) | Samples: 0

**Called by:**
- `async write` (119)

**Calls:**
- `write` (119)

### `async runWorker`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:882` | Self: 0.0% (0us) | Total: 0.7% (11.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `from` (7)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:1029` | Self: 0.0% (0us) | Total: 0.1% (1.6ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `init` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/ai/src/auth-broker/wire-schemas.ts:24` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `bound strict` (1)

### `node:assert/strict`
`node:assert/strict:3` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `disposeVerifiedResidentCacheInstanceDir`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:422` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `dispose` (1)

**Calls:**
- `removeResidentCacheTreeNoFollow` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.6% (10.1ms) | Samples: 0

**Calls:**
- `anonymous` (2)

### `node:assert`
`node:assert:588` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `assign` (1)

### `async #acquireBoundedFirstOpenLock`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7590` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `async #acquireBoundedFirstOpenLock` (1)

### `scanTranscriptLinesBounded`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1547` | Self: 0.0% (0us) | Total: 3.7% (61.0ms) | Samples: 0

**Called by:**
- `#scanBoundedTranscriptForFirstOpen` (39)
- `#buildBoundedFirstOpenSidecars` (1)

**Calls:**
- `readSync` (40)

### `memorySample`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:232` | Self: 0.0% (0us) | Total: 2.2% (36.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (11)
- `async runWorker` (3)

**Calls:**
- `gc` (14)

### `node:events`
`node:events:9` | Self: 0.0% (0us) | Total: 0.1% (2.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7861` | Self: 0.0% (0us) | Total: 0.1% (1.8ms) | Samples: 0

**Called by:**
- `consume` (1)

**Calls:**
- `add` (1)

### `async open`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17462` | Self: 0.0% (0us) | Total: 0.7% (11.5ms) | Samples: 0

**Called by:**
- `async (anonymous)` (7)

**Calls:**
- `async open` (5)
- `async open` (1)
- `async open` (1)

### `(module)`
`/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts:2` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Calls:**
- `from` (1)

### `scanTranscriptLinesBounded`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:1568` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `#scanBoundedTranscriptForFirstOpen` (2)

**Calls:**
- `recordFirstOpenGcRequest` (2)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7689` | Self: 0.0% (0us) | Total: 0.2% (4.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `#prepareResidentTextStoreTransition` (2)
- `#prepareResidentTextStoreTransition` (1)

### `openBufferedWriter`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1815` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `openFirstOpenSidecarWriter` (2)

**Calls:**
- `FileSessionStorageWriter` (1)
- `FileSessionStorageWriter` (1)

### `bound clone`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `bound strict` (1)

**Calls:**
- `clone` (1)

### `compileInput`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/compiler.js:508` | Self: 0.0% (0us) | Total: 0.1% (2.5ms) | Samples: 0

**Called by:**
- `ret` (2)

**Calls:**
- `accept` (1)
- `parse` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#newResidentTextStoreCandidate`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:6879` | Self: 0.0% (0us) | Total: 0.1% (2.8ms) | Samples: 0

**Called by:**
- `#prepareResidentTextStoreTransition` (2)

**Calls:**
- `openVerifiedResidentCacheInstanceDir` (1)
- `openVerifiedResidentCacheInstanceDir` (1)

### `literal`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:1043` | Self: 0.0% (0us) | Total: 0.1% (1.6ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `ZodLiteral` (1)

### `openVerifiedResidentCacheDirectory`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts:178` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `readResidentCacheOwnerSnapshot` (1)

**Calls:**
- `openSync` (1)

### `#withSessionPersistenceFenceSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:10088` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `async #tryBoundedFirstOpen` (1)

**Calls:**
- `(anonymous)` (1)

### `async measurePhase`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts:592` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async runWorker` (1)

**Calls:**
- `async measurePhase` (1)

### `async #tryBoundedFirstOpen`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7655` | Self: 0.0% (0us) | Total: 55.0% (901.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (602)

**Calls:**
- `#scanBoundedTranscriptForFirstOpen` (600)
- `#scanBoundedTranscriptForFirstOpen` (1)
- `#scanBoundedTranscriptForFirstOpen` (1)

### `readRangeSync`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1625` | Self: 0.0% (0us) | Total: 0.1% (3.0ms) | Samples: 0

**Called by:**
- `#coldIndexDigestValid` (1)
- `#buildBoundedFirstOpenSidecars` (1)

**Calls:**
- `readSync` (2)

### `internal:stream`
`internal:stream:48` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `getRegex`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/marked/lib/marked.esm.js:13` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `RegExp` (1)

### `#coldIndexDigestValid`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:12335` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `#findColdEntryIndex` (1)

**Calls:**
- `readRangeSync` (1)

### `#writeToKernel`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts:1070` | Self: 0.0% (0us) | Total: 0.1% (2.6ms) | Samples: 0

**Called by:**
- `#flushPending` (2)

**Calls:**
- `writeSync` (2)

### `async open`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:17502` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async open` (1)

**Calls:**
- `async #initSessionFile` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/base.js:14` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async #tryInitSessionFileFromSidecar`
`/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts:7349` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `async #initSessionFile` (1)

**Calls:**
- `async #tryInitSessionFileFromSidecar` (1)

### `(anonymous)`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:58` | Self: 0.0% (0us) | Total: 0.1% (1.7ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `get` (1)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 0.5% (8.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `strict`
`/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js:757` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `bound strict` (1)

**Calls:**
- `never` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 87.1% | 1.42s | `[native code]` |
| 4.1% | 68.7ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/beautiful-mermaid/src/ascii/pathfinder.ts` |
| 3.3% | 54.7ms | `node:net` |
| 3.0% | 49.5ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/elkjs/lib/elk.bundled.js` |
| 0.5% | 8.4ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/bench/session-scenario-matrix.ts` |
| 0.3% | 6.5ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-manager.ts` |
| 0.2% | 3.9ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/classic/schemas.js` |
| 0.1% | 2.8ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/session-storage.ts` |
| 0.1% | 2.7ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/blob-store.ts` |
| 0.1% | 1.8ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/internal/session-memory-sidecar.ts` |
| 0.1% | 1.7ms | `/Users/bellman/Documents/Workspace/gajae-code/packages/utils/src/snowflake.ts` |
| 0.1% | 1.7ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/util.js` |
| 0.1% | 1.7ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/schemas.js` |
| 0.0% | 1.6ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/zod/v4/core/api.js` |
| 0.0% | 1.4ms | `internal:util/inspect` |
| 0.0% | 1.3ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/gjc-runtime/workflow-manifest.ts` |
| 0.0% | 1.3ms | `/Users/bellman/Documents/Workspace/gajae-code/node_modules/handlebars/dist/cjs/handlebars/compiler/whitespace-control.js` |
| 0.0% | 1.2ms | `/Users/bellman/Documents/Workspace/gajae-code.gajae-code-worktrees/research-stress-test-ed9b2716/packages/coding-agent/src/session/streaming-output.ts` |
