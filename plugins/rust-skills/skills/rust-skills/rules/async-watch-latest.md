# async-watch-latest

> Use `watch` channel for sharing the latest value with multiple observers

## Why It Matters

`watch` is optimized for scenarios where receivers only care about the most recent value, not the history of changes. Unlike `broadcast`, slow receivers don't lag—they simply skip intermediate values. This is perfect for configuration, state, or status that should always reflect the current situation.

## Bad

```rust
// Using broadcast when only latest value matters
let (tx, _) = broadcast::channel::<Config>(100);

// Receivers might process stale configs if they're slow
// And they waste time processing intermediate values

// Using mpsc with buffered stale values
let (tx, mut rx) = mpsc::channel::<Status>(100);
// Receiver might process outdated statuses
```

## Good

```rust
use tokio::sync::watch;

let (tx, rx) = watch::channel(Config::default());

// Multiple observers
let rx1 = rx.clone();
let rx2 = rx.clone();

// Observer 1: waits for changes
tokio::spawn(async move {
    let mut rx = rx1;
    while rx.changed().await.is_ok() {
        let config = rx.borrow();
        apply_config(&*config);
    }
});

// Observer 2: also sees all changes
tokio::spawn(async move {
    let mut rx = rx2;
    while rx.changed().await.is_ok() {
        let config = rx.borrow();
        log_config_change(&*config);
    }
});

// Update the value
tx.send(Config::new())?;
```

## watch Semantics

```rust
use tokio::sync::watch;

let (tx, mut rx) = watch::channel("initial");

// Immediate read - no waiting
assert_eq!(*rx.borrow(), "initial");

// Wait for change
tx.send("updated")?;
rx.changed().await?;
assert_eq!(*rx.borrow(), "updated");

// Multiple rapid updates - receiver sees latest
tx.send("v1")?;
tx.send("v2")?;
tx.send("v3")?;
rx.changed().await?;
assert_eq!(*rx.borrow(), "v3");  // Skipped v1, v2
```

## Configuration Reload Pattern

```rust
use tokio::sync::watch;
use std::sync::Arc;

struct AppConfig {
    log_level: Level,
    max_connections: usize,
}

async fn config_watcher(tx: watch::Sender<Arc<AppConfig>>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        
        if let Ok(new_config) = reload_config_from_disk() {
            // Only notifies if value actually changed
            tx.send_if_modified(|current| {
                if *current != new_config {
                    *current = Arc::new(new_config);
                    true
                } else {
                    false
                }
            });
        }
    }
}

async fn worker(mut config_rx: watch::Receiver<Arc<AppConfig>>) {
    loop {
        tokio::select! {
            _ = config_rx.changed() => {
                let config = config_rx.borrow().clone();
                reconfigure(&config);
            }
            _ = do_work() => {}
        }
    }
}
```

## State Machine Updates

```rust
#[derive(Clone, PartialEq)]
enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

struct Connection {
    state_tx: watch::Sender<ConnectionState>,
    state_rx: watch::Receiver<ConnectionState>,
}

impl Connection {
    async fn wait_connected(&mut self) -> Result<(), Error> {
        loop {
            let state = self.state_rx.borrow().clone();
            match state {
                ConnectionState::Connected => return Ok(()),
                ConnectionState::Error(e) => return Err(Error::Connection(e)),
                _ => {
                    self.state_rx.changed().await?;
                }
            }
        }
    }
}
```

## Borrow vs Clone

```rust
use tokio::sync::watch;

let (tx, rx) = watch::channel(vec![1, 2, 3]);

// borrow() returns Ref - must not hold across await
{
    let data = rx.borrow();
    println!("{:?}", *data);
}  // Ref dropped here

// For use across await, clone the data
let data = rx.borrow().clone();
some_async_operation().await;
use_data(&data);  // Safe

// Or use borrow_and_update() to mark as seen
let data = rx.borrow_and_update().clone();
```

## watch vs broadcast vs mpsc

| Feature | watch | broadcast | mpsc |
|---------|-------|-----------|------|
| Receivers | Multiple | Multiple | Single |
| Message delivery | Latest only | All messages | All messages |
| Slow receiver | Skips to latest | Lags/misses | Backpressure |
| Clone required | No | Yes | No |
| Best for | Config, status | Events | Work queues |

## See Also

- [async-broadcast-pubsub](./async-broadcast-pubsub.md) - When history matters
- [async-mpsc-queue](./async-mpsc-queue.md) - Work queue patterns
- [async-cancellation-token](./async-cancellation-token.md) - Related pattern
