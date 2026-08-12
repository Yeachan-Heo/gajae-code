# async-cancellation-token

> Use `CancellationToken` for graceful shutdown and task cancellation

## Why It Matters

Dropping a `JoinHandle` doesn't cancel the task—it just detaches it. For graceful shutdown, you need explicit cancellation. `tokio_util::sync::CancellationToken` provides a cooperative cancellation mechanism that tasks can check and respond to, enabling clean resource cleanup.

## Bad

```rust
// Dropping handle doesn't stop the task
let handle = tokio::spawn(async {
    loop {
        do_work().await;
    }
});

drop(handle);  // Task continues running in background!

// Using bool flag - not async-aware
let running = Arc::new(AtomicBool::new(true));

tokio::spawn({
    let running = running.clone();
    async move {
        while running.load(Ordering::Relaxed) {
            do_work().await;  // Can't wake up if blocked here
        }
    }
});

running.store(false, Ordering::Relaxed);
// Task won't stop until current do_work() completes
```

## Good

```rust
use tokio_util::sync::CancellationToken;

let token = CancellationToken::new();

let handle = tokio::spawn({
    let token = token.clone();
    async move {
        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    println!("Shutting down gracefully");
                    cleanup().await;
                    break;
                }
                _ = do_work() => {
                    // Work completed
                }
            }
        }
    }
});

// Later: trigger cancellation
token.cancel();
handle.await?;  // Task completes cleanly
```

## CancellationToken API

```rust
use tokio_util::sync::CancellationToken;

// Create token
let token = CancellationToken::new();

// Clone for sharing (cheap Arc-based clone)
let token2 = token.clone();

// Check if cancelled (non-blocking)
if token.is_cancelled() {
    return;
}

// Wait for cancellation (async)
token.cancelled().await;

// Trigger cancellation
token.cancel();

// Child tokens - cancelled when parent is cancelled
let child = token.child_token();
```

## Hierarchical Cancellation

```rust
async fn run_server(shutdown: CancellationToken) {
    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                println!("Server shutting down");
                break;
            }
            result = listener.accept() => {
                let (socket, _) = result?;
                // Each connection gets child token
                let conn_token = shutdown.child_token();
                tokio::spawn(handle_connection(socket, conn_token));
            }
        }
    }
    
    // Child tokens auto-cancelled when we exit
}

async fn handle_connection(socket: TcpStream, token: CancellationToken) {
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                // Connection cleanup
                break;
            }
            data = socket.read() => {
                // Handle data
            }
        }
    }
}
```

## Graceful Shutdown Pattern

```rust
use tokio::signal;

async fn main() -> Result<()> {
    let shutdown = CancellationToken::new();
    
    // Spawn signal handler
    let shutdown_trigger = shutdown.clone();
    tokio::spawn(async move {
        signal::ctrl_c().await.expect("failed to listen for Ctrl+C");
        println!("Received Ctrl+C, initiating shutdown...");
        shutdown_trigger.cancel();
    });
    
    // Run application with shutdown token
    run_app(shutdown).await
}

async fn run_app(shutdown: CancellationToken) -> Result<()> {
    let mut tasks = JoinSet::new();
    
    tasks.spawn(worker_task(shutdown.child_token()));
    tasks.spawn(server_task(shutdown.child_token()));
    
    // Wait for shutdown or task completion
    tokio::select! {
        _ = shutdown.cancelled() => {
            println!("Shutdown requested, waiting for tasks...");
        }
        Some(result) = tasks.join_next() => {
            // A task completed/failed
            result??;
        }
    }
    
    // Wait for remaining tasks with timeout
    tokio::time::timeout(
        Duration::from_secs(30),
        async { while tasks.join_next().await.is_some() {} }
    ).await.ok();
    
    Ok(())
}
```

## DropGuard Pattern

```rust
use tokio_util::sync::CancellationToken;

// Auto-cancel on drop
let token = CancellationToken::new();
let guard = token.clone().drop_guard();

tokio::spawn({
    let token = token.clone();
    async move {
        token.cancelled().await;
        println!("Cancelled!");
    }
});

drop(guard);  // Automatically calls token.cancel()
```

## See Also

- [async-joinset-structured](./async-joinset-structured.md) - Managing multiple tasks
- [async-select-racing](./async-select-racing.md) - select! for cancellation
- [async-tokio-runtime](./async-tokio-runtime.md) - Runtime shutdown
