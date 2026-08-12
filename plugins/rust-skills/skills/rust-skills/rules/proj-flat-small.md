# proj-flat-small

> Keep small projects flat

## Why It Matters

Over-organizing small projects adds navigation overhead without benefit. A project with 5-10 files doesn't need nested directories. Start flat, add structure only when complexity demands it.

## Bad

```
src/
├── core/
│   └── mod.rs           # Just re-exports
├── domain/
│   ├── mod.rs
│   └── models/
│       ├── mod.rs
│       └── user.rs      # 50 lines
├── infrastructure/
│   ├── mod.rs
│   └── database/
│       ├── mod.rs
│       └── connection.rs # 30 lines
├── application/
│   ├── mod.rs
│   └── services/
│       └── mod.rs       # Empty
└── main.rs
```

## Good

```
src/
├── main.rs
├── lib.rs
├── config.rs
├── database.rs
├── user.rs
└── error.rs
```

## When to Add Structure

| File Count | Structure |
|------------|-----------|
| < 10 files | Flat in `src/` |
| 10-20 files | Group by feature |
| 20+ files | Feature folders with submodules |

## Progressive Structuring

### Stage 1: Flat

```
src/
├── main.rs
├── config.rs
├── user.rs
└── database.rs
```

### Stage 2: Logical Groups

```
src/
├── main.rs
├── config.rs
├── user.rs
├── order.rs        # Getting bigger
├── order_item.rs   # Related to order
└── database.rs
```

### Stage 3: Feature Folders

```
src/
├── main.rs
├── config.rs
├── user.rs
├── order/          # Now complex enough
│   ├── mod.rs
│   ├── model.rs
│   └── item.rs
└── database.rs
```

## Signs You Need More Structure

- Files exceed 300-500 lines
- Related files are hard to identify
- You're adding `_` prefixes for grouping (`user_model.rs`, `user_service.rs`)
- New team members get lost
- Same concepts repeated in file names

## Signs of Over-Structure

- Folders with 1-2 files
- `mod.rs` files that only re-export
- Deep nesting for simple concepts
- More lines in module declarations than code

## Example: CLI Tool

```
src/
├── main.rs         # Argument parsing, entry point
├── commands.rs     # CLI subcommands
├── config.rs       # Configuration loading
└── output.rs       # Formatting, printing
```

Not:

```
src/
├── cli/
│   └── commands/
│       └── mod.rs
├── config/
│   └── mod.rs
└── presentation/
    └── output/
        └── mod.rs
```

## See Also

- [proj-mod-by-feature](./proj-mod-by-feature.md) - Feature organization
- [proj-lib-main-split](./proj-lib-main-split.md) - Lib/main separation
- [proj-mod-rs-dir](./proj-mod-rs-dir.md) - Multi-file modules
