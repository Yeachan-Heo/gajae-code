# async-oneshot-response

> Use `oneshot` channel for request-response patterns

## Why It Matters

When one task needs to send a request and wait for exactly one response, `oneshot` is the perfect fit. It's a single-use channel optimized for this pattern—no buffering, no clone overhead. Combined with `mpsc`, it enables clean actor-style message passing.

## Bad

```rust
// Using mpsc for single response - wasteful
let (tx, mut rx) = mpsc::channel::<Response>(1);
send_request().await;
let response = rx.recv().await.unwrap();
// Channel persists, could accidentally receive more

// Using shared state - complex
let result = Arc::new(Mutex::new(None));
send_request(result.clone()).await;
while result.lock().await.is_none() {
    tokio::time::sleep(Duration::from_millis(10)).await;  // Polling!
}
```

## Good

```rust
use tokio::sync::oneshot;

let (tx, rx) = oneshot::channel::<Response>();

// Send request with reply channel
send_request(Request { data, reply: tx }).await;

// Wait for response
let response = rx.await?;

// Channel is consumed - can't accidentally reuse
```

## Request-Response Pattern

```rust
use tokio::sync::{mpsc, oneshot};

enum Request {
    Get {
        key: String,
        reply: oneshot::Sender<Option<Value>>,
    },
    Set {
        key: String,
        value: Value,
        reply: oneshot::Sender<bool>,
    },
}

// Service handler
async fn service(mut rx: mpsc::Receiver<Request>) {
    let mut store = HashMap::new();
    
    while let Some(req) = rx.recv().await {
        match req {
            Request::Get { key, reply } => {
                let value = store.get(&key).cloned();
                let _ = reply.send(value);  // Ignore if receiver dropped
            }
            Request::Set { key, value, reply } => {
                store.insert(key, value);
                let _ = reply.send(true);
            }
        }
    }
}

// Client
async fn get_value(tx: &mpsc::Sender<Request>, key: &str) -> Option<Value> {
    let (reply_tx, reply_rx) = oneshot::channel();
    
    tx.send(Request::Get {
        key: key.to_string(),
        reply: reply_tx,
    }).await.ok()?;
    
    reply_rx.await.ok()?
}
```

## With Timeout

```rust
use tokio::time::{timeout, Duration};

async fn request_with_timeout(
    tx: &mpsc::Sender<Request>,
    key: &str,
) -> Result<Value, Error> {
    let (reply_tx, reply_rx) = oneshot::channel();
    
    tx.send(Request::Get {
        key: key.to_string(),
        reply: reply_tx,
    }).await.map_err(|_| Error::ServiceDown)?;
    
    timeout(Duration::from_secs(5), reply_rx)
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::ServiceDown)?
        .ok_or(Error::NotFound)
}
```

## Error Handling

```rust
use tokio::sync::oneshot;

let (tx, rx) = oneshot::channel::<String>();

// Sender dropped without sending
drop(tx);
match rx.await {
    Ok(value) => println!("Got: {}", value),
    Err(oneshot::error::RecvError { .. }) => {
        println!("Sender dropped");
    }
}

// Receiver dropped before send
let (tx, rx) = oneshot::channel::<String>();
drop(rx);
match tx.send("hello".to_string()) {
    Ok(()) => println!("Sent"),
    Err(value) => println!("Receiver dropped, value: {}", value),
}
```

## Closed Detection

```rust
// Check if receiver is still waiting
let (tx, rx) = oneshot::channel::<i32>();

// In producer
if tx.is_closed() {
    println!("Receiver already gone, skip expensive computation");
} else {
    let result = expensive_computation();
    tx.send(result).ok();
}

// Async wait for close
let tx_clone = tx.clone();  // Note: can't actually clone, just showing concept
tokio::select! {
    _ = tx.closed() => println!("Receiver dropped"),
    result = compute() => { tx.send(result).ok(); }
}
```

## Response Type Wrapper

```rust
// Standardize request-response pattern
struct RpcRequest<Req, Res> {
    request: Req,
    reply: oneshot::Sender<Res>,
}

impl<Req, Res> RpcRequest<Req, Res> {
    fn new(request: Req) -> (Self, oneshot::Receiver<Res>) {
        let (tx, rx) = oneshot::channel();
        (RpcRequest { request, reply: tx }, rx)
    }
    
    fn respond(self, response: Res) {
        let _ = self.reply.send(response);
    }
}

// Usage
let (req, rx) = RpcRequest::new(GetUser { id: 42 });
tx.send(req).await?;
let user = rx.await?;
```

## See Also

- [async-mpsc-queue](./async-mpsc-queue.md) - Pair with oneshot for request-response
- [async-bounded-channel](./async-bounded-channel.md) - Channel sizing
- [async-select-racing](./async-select-racing.md) - Timeout patterns
