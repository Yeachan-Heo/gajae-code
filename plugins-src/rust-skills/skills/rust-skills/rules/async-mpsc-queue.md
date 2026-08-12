# async-mpsc-queue

> Use `mpsc` channels for async message queues between tasks

## Why It Matters

`tokio::sync::mpsc` (multi-producer, single-consumer) is the workhorse channel for async Rust. It provides async send/receive, backpressure via bounded capacity, and efficient cloning of senders. It's the default choice for task-to-task communication.

## Bad

```rust
use std::sync::mpsc;  // Wrong! Blocks the async runtime

let (tx, rx) = std::sync::mpsc::channel();

tokio::spawn(async move {
    tx.send("hello").unwrap();  // Might block
});

tokio::spawn(async move {
    let msg = rx.recv().unwrap();  // BLOCKS the executor thread!
});
```

## Good

```rust
use tokio::sync::mpsc;

let (tx, mut rx) = mpsc::channel::<String>(100);

tokio::spawn(async move {
    tx.send("hello".to_string()).await.unwrap();
});

tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
        println!("Received: {}", msg);
    }
});
```

## Sender Cloning

```rust
use tokio::sync::mpsc;

let (tx, mut rx) = mpsc::channel::<Event>(100);

// Multiple producers
for i in 0..10 {
    let tx = tx.clone();  // Cheap clone
    tokio::spawn(async move {
        tx.send(Event { source: i }).await.unwrap();
    });
}

// Drop original sender so channel closes when all clones dropped
drop(tx);

// Consumer
while let Some(event) = rx.recv().await {
    process(event);
}
// Loop exits when all senders dropped
```

## Message Handler Pattern

```rust
use tokio::sync::mpsc;

enum Command {
    Get { key: String, reply: oneshot::Sender<Option<Value>> },
    Set { key: String, value: Value },
    Delete { key: String },
}

async fn run_store(mut commands: mpsc::Receiver<Command>) {
    let mut store = HashMap::new();
    
    while let Some(cmd) = commands.recv().await {
        match cmd {
            Command::Get { key, reply } => {
                let _ = reply.send(store.get(&key).cloned());
            }
            Command::Set { key, value } => {
                store.insert(key, value);
            }
            Command::Delete { key } => {
                store.remove(&key);
            }
        }
    }
}

// Usage
async fn client(tx: mpsc::Sender<Command>) -> Option<Value> {
    let (reply_tx, reply_rx) = oneshot::channel();
    
    tx.send(Command::Get { 
        key: "foo".to_string(), 
        reply: reply_tx 
    }).await.unwrap();
    
    reply_rx.await.unwrap()
}
```

## Graceful Shutdown

```rust
async fn worker(mut rx: mpsc::Receiver<Task>, shutdown: CancellationToken) {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                // Drain remaining messages
                while let Ok(task) = rx.try_recv() {
                    process(task).await;
                }
                break;
            }
            Some(task) = rx.recv() => {
                process(task).await;
            }
            else => break,  // Channel closed
        }
    }
}
```

## WeakSender for Optional Producers

```rust
use tokio::sync::mpsc;

let (tx, mut rx) = mpsc::channel::<Message>(100);
let weak = tx.downgrade();  // Doesn't keep channel alive

tokio::spawn(async move {
    // Strong sender - keeps channel alive
    tx.send("from strong".into()).await.unwrap();
});

tokio::spawn(async move {
    // Weak sender - may fail if strong senders dropped
    if let Some(tx) = weak.upgrade() {
        tx.send("from weak".into()).await.unwrap();
    }
});
```

## Permit Pattern

```rust
// Reserve slot before preparing message
let permit = tx.reserve().await?;

// Now we have guaranteed capacity
let message = expensive_to_create_message();
permit.send(message);  // Never fails

// Useful when message creation is expensive
// and you don't want to create it if channel is full
```

## See Also

- [async-bounded-channel](./async-bounded-channel.md) - Why bounded channels
- [async-oneshot-response](./async-oneshot-response.md) - Request-response with oneshot
- [async-broadcast-pubsub](./async-broadcast-pubsub.md) - Multiple consumers
