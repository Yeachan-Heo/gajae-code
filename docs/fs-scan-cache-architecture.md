# Filesystem Scan Cache Architecture Contract

This document defines the shared native filesystem scan collector and cache implemented in `crates/pi-natives/src/fs_cache.rs`. It is consumed by glob discovery, fuzzy find, AST candidate discovery, and cached grep.

## Safety policy

The shared scan path has finite per-scan logical retained-capacity and process-cache ownership budgets. The safety controls are parsed strictly before a walker or cache is accessed:

| Variable | Default | Accepted range |
| --- | ---: | ---: |
| `FS_SCAN_MAX_ENTRIES` | `250000` | `1..=1000000` |
| `FS_SCAN_MAX_BYTES` | `67108864` (64 MiB) | `1048576..=536870912` |
| `FS_SCAN_CACHE_MAX_ENTRIES` | `16` | `1..=64` |
| `FS_SCAN_CACHE_MAX_BYTES` | `134217728` (128 MiB) | `0` (disable caching) or `1048576..=2147483648` |

Absent values use the defaults. An explicitly malformed, signed, overflowing, below-minimum, or above-maximum value fails with a bounded `FS_SCAN_CONFIG_INVALID` diagnostic. Zero is rejected for every finite safety limit except `FS_SCAN_CACHE_MAX_BYTES`, where it preserves the established cache-write bypass. There is no unlimited override.

`FS_SCAN_CACHE_TTL_MS` defaults to `1000`; setting it to `0` bypasses cache reads and writes but never disables the per-scan limits. `FS_SCAN_EMPTY_RECHECK_MS` defaults to `200` and controls caller-side stale-negative retries.

## Ownership and consumers

- Collector/cache implementation: `crates/pi-natives/src/fs_cache.rs`
- Native consumers:
  - `crates/pi-natives/src/glob.rs`
  - `crates/pi-natives/src/fd.rs` (`fuzzyFind`)
  - `crates/pi-natives/src/ast.rs`
  - `crates/pi-natives/src/grep.rs` when cached shared discovery is selected
- The uncached directory-grep path remains streaming and does not materialize a shared scan snapshot.
- Coding-agent mutation invalidation: `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

A successful shared scan is one immutable `Arc<Vec<GlobMatch>>`. Cache hits and callers share that allocation; they do not clone the full vector or its path strings.

## Cache key partitioning

Each snapshot is keyed by all traversal and metadata dimensions:

- canonicalized root directory
- `include_hidden`
- `use_gitignore`
- `skip_node_modules`
- `follow_links`
- scan detail (`Minimal` or `Full`)

Consumers with different symlink-following or metadata requirements therefore cannot alias each other's snapshots.

Current native consumers deliberately use different symlink policies:

| Consumer | `follow_links` |
| --- | --- |
| glob discovery | `false` |
| fuzzy find (`fd.rs`) | `true` |
| AST candidate discovery | `false` |
| cached grep discovery | `false` |

Fuzzy find therefore never shares a snapshot with those non-following consumers, even when root, hidden-file, ignore, `node_modules`, and detail settings otherwise match. Any new consumer must treat `follow_links` as a required cache-partition dimension rather than inheriting another consumer's snapshot.

## Bounded collection

`ignore::WalkBuilder` visitors admit candidates through one per-scan mutex-owned collector. Visitor-local unbounded vectors and post-walk flattening are prohibited.

Admission is transactional:

1. Compute a conservative path charge from the borrowed relative path before attempting to allocate its owned string.
2. Reserve the logical entry and path bytes, then precharge the requested vector-capacity growth under the collector lock using checked arithmetic.
3. Request geometric vector growth only when the requested target fits the configured logical entry and retained-capacity budgets. Live provisional slot claims prevent concurrent visitors from spending the same capacity.
4. Allocate the normalized forward-slash path fallibly while retaining the collector lock. This serializes ownership transfer and avoids an extra lock round-trip on the small-directory hot path.
5. Reconcile the actual vector and string capacities returned by the allocator. Commit only while the collector has no terminal error and those retained capacities fit the budget. A failed candidate rolls back its logical/path/slot claims; capacity still owned by the vector remains charged until the failed collector is discarded.

The first configuration, cancellation, arithmetic, reservation, or budget error is write-once. Once present, later visitors cannot commit. The whole collector is discarded after walker join, so callers, callbacks, AST reads, and the cache never receive a prefix. Successful entries are sorted in place before the vector becomes immutable.

Retained snapshot accounting includes vector capacity and every path string's capacity, not only logical lengths. `try_reserve_exact` avoids deliberate speculative over-allocation, but Rust permits the allocator to return more capacity than requested. The collector can observe and reject that excess only after the allocation returns; vector reallocation can also transiently own both the old and new buffers. `FS_SCAN_MAX_BYTES` therefore strictly bounds the accounted retained capacity of a successful snapshot, not allocator metadata, transient heap allocation, or process RSS at the allocation instant. The scan budget covers collector-owned entries; consumer-derived allocations such as AST parse trees, grep result payloads, callback queues, and fuzzy-score buffers remain separate ownership domains.

## Cache publication and eviction

The cache is one short-held mutex state containing immutable snapshots, total retained bytes, entry count, and a global generation. Filesystem scans run outside this lock.

- A normal miss captures the generation, scans, and publishes only if that generation is still current.
- Competing normal misses adopt an already-published, non-expired snapshot instead of replacing it.
- `force_rescan` advances the generation and removes its key before scanning. `store=false` never publishes; `store=true` publishes only if no later force or invalidation won.
- An in-flight stale-generation scan still returns its complete snapshot to its own caller but cannot repopulate the cache.
- Path and full invalidation advance the generation and remove/account snapshots atomically.
- TTL expiry removes and subtracts a snapshot without advancing the generation. Normal scans timestamp candidates at completion and reject an expired same-generation winner before adoption, preventing an older long-running miss from resurrecting a stale snapshot.
- Generation overflow clears the cache and permanently disables publication rather than wrapping.
- Oldest whole snapshots are evicted until both key-count and retained-byte caps fit. A snapshot that cannot fit by itself is returned uncached. `FS_SCAN_CACHE_MAX_BYTES=0` bypasses cache reads and writes while retaining per-scan limits.

These rules make invalidation and competing publication linearizable without holding the cache lock across filesystem I/O.

## Scan behavior

Roots are resolved relative to the current working directory, must be existing directories, and are canonicalized when possible. `.git` is always skipped. `node_modules` is pruned when requested. Traversal honors each consumer's hidden, ignore, symlink, and metadata-detail options, and completed snapshots are path-sorted.

Public cache usage remains opt-in. A normal cache hit within TTL returns its age. On an empty tool-specific result older than `FS_SCAN_EMPTY_RECHECK_MS`, glob, fuzzy find, or cached grep may perform one forced rescan to reduce stale negatives. This retry is separate from ordinary cache-hit behavior.

## Invalidation contract

`invalidateFsScanCache(path?)` removes snapshots whose roots overlap the target path, or clears all snapshots when no path is supplied. Relative paths resolve against the current working directory. For deleted paths, invalidation canonicalizes the nearest existing parent and reattaches the missing suffix when possible.

Every successful coding-agent write, edit, delete, rename, or move must call the centralized invalidation helpers. Renames invalidate both old and new paths.

## Adding a consumer

A new shared-scan consumer must:

1. Define stable values for every cache-key dimension, including `follow_links` and detail level.
2. Apply tool-specific filtering or scoring after snapshot retrieval.
3. Treat collection failure as an operation error; it must not expose partial results or side effects.
4. Use `force_rescan(..., store=false, ...)` when cache is disabled.
5. Add mutation invalidation for any new write path.
6. Keep per-call TTL controls out of the public contract.

## Known boundaries

- State is process-local and is not persisted across restarts.
- The cache stores complete scan snapshots, not final tool results.
- Per-scan limits bound each concurrent shared scan; they are not a process-wide admission controller.
- `FS_SCAN_MAX_BYTES` is a logical successful-snapshot retained-capacity budget, not a hard allocator-footprint, transient-allocation, or RSS ceiling.
- Uncached directory grep is intentionally streaming and does not use this collector/cache ownership model.
