# Filesystem Scan Cache Architecture Contract

This document defines the current contract for the shared filesystem scan cache implemented in Rust (`crates/pi-natives/src/fs_cache.rs`) and consumed by native discovery/search APIs exposed to `packages/coding-agent`.

## What this cache is

The cache stores full directory-scan entry lists (`GlobMatch[]`) keyed by scan scope and traversal policy, then lets higher-level operations (glob filtering, fuzzy scoring, grep file selection) run against those cached entries.

Primary goals:

- avoid repeated filesystem walks for repeated discovery/search calls
- keep consistency across `glob`, `fuzzyFind`, and `grep` when they share the same scan policy
- allow explicit staleness recovery for empty results and explicit invalidation after file mutations

## Ownership and public surface

- Cache implementation and policy: `crates/pi-natives/src/fs_cache.rs`
- Native consumers:
  - `crates/pi-natives/src/glob.rs`
  - `crates/pi-natives/src/fd.rs` (`fuzzyFind`)
  - `crates/pi-natives/src/grep.rs`
- JS binding/export:
  - `packages/natives/native/index.js` (`invalidateFsScanCache`)
  - `packages/natives/native/index.d.ts` (glob and grep option/result types)
- Coding-agent mutation invalidation helpers:
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

## Cache key partitioning (hard contract)

Each entry is keyed by:

- canonicalized `root` directory path
- `include_hidden` boolean
- `use_gitignore` boolean
- `skip_node_modules` boolean

Implications:

- Hidden and non-hidden scans do **not** share entries.
- Gitignore-respecting and ignore-disabled scans do **not** share entries.
- Scans that prune `node_modules` do **not** share entries with scans that include it.
- Consumers must pass stable semantics for hidden/gitignore/node_modules behavior; changing any flag creates a different cache partition.

## Scan collection behavior

Cache population uses a deterministic walker (`ignore::WalkBuilder`) configured by `include_hidden`, `use_gitignore`, and `skip_node_modules`:

- `follow_links(false)`
- sorted by file path
- `.git` is always skipped
- `node_modules` is pruned at traversal time when `skip_node_modules=true`
- entry file type + `mtime` are captured via `symlink_metadata`

Search roots are resolved by `resolve_search_path`:

- relative paths are resolved against current cwd
- target must be an existing directory
- root is canonicalized when possible

## Freshness and eviction policy

Global policy (environment-overridable):

- `FS_SCAN_CACHE_TTL_MS` (default `1000`)
- `FS_SCAN_EMPTY_RECHECK_MS` (default `200`)
- `FS_SCAN_CACHE_MAX_ENTRIES` (default `16`)

Behavior:

- `get_or_scan(...)`
  - if TTL is `0`: bypass cache entirely, always fresh scan (`cache_age_ms = 0`)
  - on cache hit within TTL: return cached entries + non-zero `cache_age_ms`
  - on expired hit: evict key, rescan, store fresh entry
- max entry enforcement is oldest-first eviction by `created_at`

## Empty-result fast recheck (separate from normal hits)

Normal cache hit:

- a cache hit inside TTL returns cached entries and does nothing else.

Empty-result fast recheck:

- this is a **caller-side** policy using `ScanResult.cache_age_ms`
- if filtered/query result is empty and cached scan age is at least `empty_recheck_ms()`, caller performs one `force_rescan(...)` and retries
- intended to reduce stale-negative results when files were recently added but cache is still within TTL

Current consumers:

- `glob`: rechecks when filtered matches are empty and scan age exceeds threshold
- `fuzzyFind` (`fd.rs`): rechecks only when query is non-empty and scored matches are empty
- `grep`: rechecks when selected candidate file list is empty

## Consumer defaults and cache usage

Cache is opt-in on all exposed APIs (`cache?: boolean`, default `false`).

Current defaults in native APIs:

- `glob`: `hidden=false`, `gitignore=true`, `cache=false`, and `node_modules` included only when the pattern mentions `node_modules`
- `fuzzyFind`: `hidden=false`, `gitignore=true`, `cache=false`, and `node_modules` is skipped
- `grep`: `hidden=true`, `gitignore=true`, `cache=false`, and `node_modules` included only when the glob mentions `node_modules`

Coding-agent callers today:

- High-volume mention candidate discovery enables cache:
  - `packages/coding-agent/src/utils/file-mentions.ts`
  - profile: `hidden=true`, `gitignore=true`, `includeNodeModules=true`, `cache=true`
- Tool-level `grep` integration currently disables scan cache (`cache: false`):
  - `packages/coding-agent/src/tools/search.ts`

## Invalidation contract

Native invalidation entrypoint:

- `invalidateFsScanCache(path?: string)`
  - with `path`: remove cache entries whose root is a prefix of target path
  - without path: clear all scan cache entries

Path handling details:

- relative invalidation paths are resolved against cwd
- invalidation attempts canonicalization
- if target does not exist (e.g., delete), fallback canonicalizes parent and reattaches filename when possible
- this preserves invalidation behavior for create/delete/rename where one side may not exist

## Coding-agent mutation flow responsibilities

Coding-agent code must invalidate after successful filesystem mutations.

Central helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` (invalidates both sides when paths differ)

Current mutation tool callsites:

- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/edit/modes/patch.ts` (patch flow; uses all three helpers)
- `packages/coding-agent/src/edit/modes/replace.ts` (replace flow)
- `packages/coding-agent/src/hashline/execute.ts` (hashline flow)

Rule: if a flow mutates filesystem content or location and bypasses these helpers, cache staleness bugs are expected.

## Adding a new cache consumer safely

When introducing cache use in a new scanner/search path:

1. **Use stable scan policy inputs**
   - decide hidden/gitignore/node_modules semantics first
   - pass them consistently to `get_or_scan`/`force_rescan` so cache partitions are intentional

2. **Treat cache data as pre-filtered only by traversal policy**
   - apply tool-specific filtering (glob patterns, type filters, scoring) after retrieval
   - never assume cached entries already reflect your higher-level filters

3. **Implement empty-result fast recheck only for stale-negative risk**
   - use `scan.cache_age_ms >= empty_recheck_ms()`
   - retry once with `force_rescan(..., store=true, ...)`
   - keep this path separate from normal cache-hit logic

4. **Respect no-cache mode explicitly**
   - when caller disables cache, call `force_rescan(..., store=false, ...)`
   - do not populate shared cache in a no-cache request path

5. **Wire mutation invalidation for any new write path**
   - after successful write/edit/delete/rename, call the coding-agent invalidation helper
   - for rename/move, invalidate both old and new paths

6. **Do not add per-call TTL knobs**
   - current contract is global policy only (env-configured), no per-request TTL override

## Known boundaries

- Cache scope is process-local in-memory (`DashMap`), not persisted across process restarts.
- Cache stores scan entries, not final tool results.
- `glob`/`fuzzyFind`/`grep` share scan entries only when key dimensions (`root`, `hidden`, `gitignore`, `skip_node_modules`) match.
- `.git` is always excluded at scan collection time regardless of caller options.
