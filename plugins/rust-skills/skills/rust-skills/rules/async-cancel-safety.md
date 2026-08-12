# async-cancel-safety

> Ensure futures used in `tokio::select!` branches are cancellation-safe

## Why It Matters

`tokio::select!` polls multiple futures concurrently and, the moment one branch completes, it **drops every other branch** — including any state those futures held. A future that was halfway through reading bytes into a local buffer, or halfway through draining a channel into a `Vec`, loses that progress silently. This is not a compiler error; it compiles fine and the bug only surfaces under concurrent load. Tokio documents which of its primitives are cancellation-safe; everything else must be treated with care.

## Bad

```rust
use tokio::io::{AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

// Non-cancel-safe: `read_exact` owns an internal buffer inside the future.
// If select! drops this branch, the partially-read bytes are gone.
async fn bad_example(stream: &mut BufReader<TcpStream>, rx: &mut mpsc::Receiver<u8>) {
    let mut buf = [0u8; 1024];
    tokio::select! {
        // BUG: if the `recv` branch fires first, the bytes already read
        // into buf inside `read_exact` are silently discarded
        result = stream.read_exact(&mut buf) => {
            println!("read {} bytes", result.unwrap());
        }
        msg = rx.recv() => {
            println!("got message: {:?}", msg);
        }
    }
}
```

## Good

```rust
use tokio::io::{AsyncReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

// Cancel-safe: the buffer lives OUTSIDE the select loop.
// If the recv branch fires, buf retains whatever was already read,
// and the next iteration continues filling it.
async fn good_example(
    stream: &mut BufReader<TcpStream>,
    rx: &mut mpsc::Receiver<u8>,
) -> std::io::Result<()> {
    let mut buf = [0u8; 1024];
    let mut filled = 0;

    loop {
        tokio::select! {
            n = stream.read(&mut buf[filled..]) => {
                // `read` (not `read_exact`) is cancel-safe: it either
                // reads some bytes or returns immediately with 0.
                filled += n?;
                if filled == buf.len() {
                    println!("buffer full: {:?}", &buf[..]);
                    filled = 0;
                }
            }
            msg = rx.recv() => {
                println!("got message: {:?}", msg);
            }
        }
    }
}
```

## What Is and Is Not Cancel-Safe

| Operation | Cancel-safe? | Notes |
|---|---|---|
| `mpsc::Receiver::recv()` | Yes | drops nothing on cancel |
| `broadcast::Receiver::recv()` | Yes | position tracked in receiver |
| `watch::Receiver::changed()` | Yes | no data consumed on cancel |
| `oneshot::Receiver` | Yes | message remains in channel |
| `tokio::time::sleep` | Yes | timer resets cleanly |
| `AsyncRead::read()` | Yes | partial reads surfaced to caller |
| `AsyncRead::read_exact()` | **No** | partially filled buffer is lost |
| `AsyncRead::read_to_end()` | **No** | accumulation is inside the future |
| `Mutex::lock()` | Yes | lock not acquired if dropped |
| collecting into a `Vec` inside a future | **No** | partial state is inside the future |

## Patterns for Non-Cancel-Safe Operations

1. **Move state outside `select!`** — keep the accumulation buffer or partial result as a local variable in the surrounding scope, not inside the future passed to `select!`.

2. **Use a pinned future held across iterations** — pin the future once and reuse it:

```rust
use std::pin::pin;
use tokio::io::AsyncReadExt;

async fn pinned_read_example<R: AsyncReadExt + Unpin>(mut reader: R) {
    let mut buf = vec![0u8; 64];
    // pin the future so it survives across select iterations
    let read_fut = pin!(reader.read_to_end(&mut buf));
    // ... use read_fut inside select! across multiple iterations
    // When the future completes it won't be cancelled mid-way
    let _ = read_fut.await;
}
```

3. **Use `tokio_util::io::poll_read_buf`** or similar cancel-safe adapters from `tokio-util`.

4. **Wrap in a `JoinHandle`** — spawn the operation as a task; the task keeps running even if `select!` drops the handle, and the handle itself is cancel-safe.

## See Also

- [async-select-racing](async-select-racing.md) - use `tokio::select!` for racing/timeouts
- [async-bounded-channel](async-bounded-channel.md) - use bounded channels for backpressure
- [async-no-lock-await](async-no-lock-await.md) - never hold locks across `.await`
