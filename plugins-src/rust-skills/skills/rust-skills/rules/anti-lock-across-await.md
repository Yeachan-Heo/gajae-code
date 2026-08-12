# anti-lock-across-await

> Don't hold locks across await points

## Why It Matters

Holding a `Mutex` or `RwLock` guard across an `.await` causes the lock to be held while the task is suspended. Other tasks waiting for the lock block indefinitely. With `std::sync::Mutex`, this is even worse—it can deadlock the entire runtime.

## Bad

```rust
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;

// DEADLOCK RISK: std::sync::Mutex held across await
async fn bad_std_mutex(data: &Mutex<Vec<i32>>) {
    let mut guard = data.lock().unwrap();
    do_async_work().await;  // Lock held during await!
    guard.push(42);
}

// BLOCKS OTHER TASKS: tokio Mutex held across await
async fn bad_async_mutex(data: &AsyncMutex<Vec<i32>>) {
    let mut guard = data.lock().await;
    slow_network_call().await;  // Lock held for entire call!
    guard.push(42);
}
```

## Good

```rust
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;

// Release lock before await
async fn good_approach(data: &Mutex<Vec<i32>>) {
    let value = {
        let guard = data.lock().unwrap();
        guard.last().copied()  // Extract what you need
    };  // Lock released here
    
    let result = do_async_work(value).await;
    
    {
        let mut guard = data.lock().unwrap();
        guard.push(result);
    }
}

// Minimize lock scope with async mutex
async fn good_async_mutex(data: &AsyncMutex<Vec<i32>>, item: i32) {
    // Quick lock, quick release
    data.lock().await.push(item);
    
    // Async work without lock
    let result = slow_network_call().await;
    
    // Quick lock again
    data.lock().await.push(result);
}
```

## Pattern: Clone Before Await

```rust
async fn process(data: &AsyncMutex<Config>) -> Result<()> {
    // Clone inside lock scope
    let config = data.lock().await.clone();
    
    // Now use config freely across awaits
    let result = fetch_data(&config.url).await?;
    process_result(&config, result).await?;
    
    Ok(())
}
```

## Pattern: Restructure to Avoid Lock

```rust
// Instead of locking a shared map
struct Service {
    data: AsyncMutex<HashMap<String, Data>>,
}

// Use channels or owned data
struct BetterService {
    // Each task owns its data via channels
    sender: mpsc::Sender<Request>,
}

impl BetterService {
    async fn request(&self, key: String) -> Data {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Request { key, respond: tx }).await?;
        rx.await?
    }
}
```

## What Can Cross Await

| Type | Safe Across Await? |
|------|--------------------|
| `std::sync::Mutex` guard | **NO** - can deadlock |
| `std::sync::RwLock` guard | **NO** - can deadlock |
| `tokio::sync::Mutex` guard | Allowed but blocks tasks |
| `tokio::sync::RwLock` guard | Allowed but blocks tasks |
| Owned values | Yes |
| `Arc<T>` | Yes |
| References | Depends on lifetime |

## Detection

```toml
# Cargo.toml
[lints.clippy]
await_holding_lock = "deny"
await_holding_refcell_ref = "deny"
```

## See Also

- [async-no-lock-await](./async-no-lock-await.md) - Async lock patterns
- [async-clone-before-await](./async-clone-before-await.md) - Clone pattern
- [own-mutex-interior](./own-mutex-interior.md) - Mutex usage
