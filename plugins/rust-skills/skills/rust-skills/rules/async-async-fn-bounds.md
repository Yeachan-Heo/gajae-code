# async-async-fn-bounds

> Use `AsyncFn`/`AsyncFnMut`/`AsyncFnOnce` bounds instead of `F: Fn() -> Fut, Fut: Future`

## Why It Matters

The `AsyncFn`, `AsyncFnMut`, and `AsyncFnOnce` traits stabilized in Rust 1.85 (February 2025). They let you express higher-order async function bounds in a single, readable constraint — and, critically, they handle lifetime capture correctly. The old two-generic pattern `F: Fn() -> Fut, Fut: Future<Output = T>` cannot accept `async ||` closures that borrow from their environment, because the future's lifetime is not linked to the closure's call. `AsyncFn` solves this structurally.

## Bad

```rust
use std::future::Future;

// two-generic pattern: verbose, and cannot accept async closures
// that borrow from their environment across the call
async fn retry<F, Fut, T, E>(times: usize, f: F) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut last_err;
    let mut i = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                i += 1;
                if i >= times {
                    return Err(last_err);
                }
            }
        }
    }
}
```

## Good

```rust
// AsyncFn bound: concise, correct lifetime semantics, accepts async closures
async fn retry<F, T, E>(times: usize, f: F) -> Result<T, E>
where
    F: AsyncFn() -> Result<T, E>,
{
    let mut last_err;
    let mut i = 0;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                i += 1;
                if i >= times {
                    return Err(last_err);
                }
            }
        }
    }
}

// callers can pass plain async functions or async closures
async fn fetch_data() -> Result<String, std::io::Error> {
    Ok("data".to_owned())
}

async fn example() {
    // async function reference
    let _ = retry(3, fetch_data).await;

    // async closure (impossible with the old F: Fn() -> Fut pattern
    // when the closure borrows a local across calls)
    let prefix = "prefix".to_owned();
    let _ = retry(3, async || {
        Ok::<_, std::io::Error>(format!("{prefix}-data"))
    })
    .await;
}
```

## The Three Variants

| Bound | Receiver | Use when |
|---|---|---|
| `AsyncFn()` | `&self` | callable multiple times, no mutation |
| `AsyncFnMut()` | `&mut self` | callable multiple times, may mutate captured state |
| `AsyncFnOnce()` | `self` | callable exactly once, may consume captured state |

These mirror `Fn` / `FnMut` / `FnOnce` semantics, so the same rules apply: prefer `AsyncFn` first; fall back to `AsyncFnMut` or `AsyncFnOnce` when needed.

## Key Points

- `AsyncFn()` desugars the bound `F: AsyncFn<(), Output = T>` — the call syntax mirrors `Fn()`.
- Plain `async fn` items (not closures) automatically implement `AsyncFn` when their signature matches.
- `AsyncFn` is in `std::ops` but the traits are brought in scope automatically in the 2024 edition; in older editions you may need `use std::ops::AsyncFn;`.
- The compiler still infers `Send`-ness from the closure body; if you need `Send` futures (Tokio multi-threaded), add `+ Send` to the bound or use a `Send` wrapper.

## See Also

- [async-fn-in-trait](async-fn-in-trait.md) - native async fn in trait definitions
- [async-tokio-runtime](async-tokio-runtime.md) - use Tokio for production async runtime
