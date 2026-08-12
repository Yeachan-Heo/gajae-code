# async-select-racing

> Use `select!` to race futures and handle the first to complete

## Why It Matters

Sometimes you need the first result from multiple futures—timeout vs operation, cancellation vs work, or competing alternatives. `tokio::select!` lets you race futures and handle whichever completes first, while properly cancelling the others.

## Bad

```rust
// Can't express "whichever finishes first"
async fn fetch_with_fallback() -> Data {
    match fetch_primary().await {
        Ok(data) => data,
        Err(_) => fetch_fallback().await.unwrap(),  // Sequential, not racing
    }
}

// Manual timeout is error-prone
async fn fetch_with_timeout() -> Option<Data> {
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(5) {
            return None;
        }
        // How do we check timeout while awaiting?
    }
}
```

## Good

```rust
use tokio::select;

async fn fetch_with_timeout() -> Result<Data, Error> {
    select! {
        result = fetch_data() => result,
        _ = tokio::time::sleep(Duration::from_secs(5)) => {
            Err(Error::Timeout)
        }
    }
}

async fn fetch_with_fallback() -> Data {
    select! {
        result = fetch_primary() => {
            match result {
                Ok(data) => data,
                Err(_) => fetch_fallback().await.unwrap()
            }
        }
        _ = tokio::time::sleep(Duration::from_secs(1)) => {
            // Primary too slow, use fallback
            fetch_fallback().await.unwrap()
        }
    }
}
```

## select! Syntax

```rust
select! {
    // Pattern = future => handler
    result = async_operation() => {
        // Handle result
        println!("Got: {:?}", result);
    }
    
    // Can bind with pattern matching
    Ok(data) = fallible_operation() => {
        process(data);
    }
    
    // Conditional branches with if guards
    msg = channel.recv(), if should_receive => {
        handle_message(msg);
    }
    
    // else branch for when all futures are disabled
    else => {
        println!("All branches disabled");
    }
}
```

## Cancellation Behavior

```rust
async fn select_example() {
    select! {
        _ = operation_a() => {
            println!("A completed first");
            // operation_b() is dropped/cancelled
        }
        _ = operation_b() => {
            println!("B completed first");
            // operation_a() is dropped/cancelled
        }
    }
}

// Futures are cancelled at their next .await point
// For immediate cancellation, futures must be cancel-safe
```

## Biased Selection

```rust
// By default, select! randomly picks when multiple are ready
// Use biased mode for deterministic priority
select! {
    biased;  // Check branches in order
    
    msg = high_priority.recv() => handle_high(msg),
    msg = low_priority.recv() => handle_low(msg),
}

// Without biased, both channels have equal chance
// when both have messages ready
```

## Loop with select!

```rust
async fn event_loop(
    mut commands: mpsc::Receiver<Command>,
    shutdown: CancellationToken,
) {
    loop {
        select! {
            _ = shutdown.cancelled() => {
                println!("Shutting down");
                break;
            }
            Some(cmd) = commands.recv() => {
                process_command(cmd).await;
            }
            else => {
                // commands channel closed
                break;
            }
        }
    }
}
```

## Racing Multiple of Same Type

```rust
// Race multiple servers for fastest response
async fn fastest_response(servers: &[String]) -> Result<Response> {
    let futures = servers.iter()
        .map(|s| fetch_from(s))
        .collect::<Vec<_>>();
    
    // select! requires static branches, use select_all for dynamic
    let (result, _index, _remaining) = 
        futures::future::select_all(futures).await;
    
    result
}
```

## Common Patterns

```rust
// Timeout
select! {
    result = operation() => result,
    _ = sleep(Duration::from_secs(5)) => Err(Timeout),
}

// Cancellation
select! {
    result = operation() => result,
    _ = cancel_token.cancelled() => Err(Cancelled),
}

// Interval with cancellation
let mut interval = tokio::time::interval(Duration::from_secs(1));
loop {
    select! {
        _ = shutdown.cancelled() => break,
        _ = interval.tick() => {
            do_periodic_work().await;
        }
    }
}
```

## See Also

- [async-cancellation-token](./async-cancellation-token.md) - Cancellation patterns
- [async-join-parallel](./async-join-parallel.md) - All futures, not racing
- [async-bounded-channel](./async-bounded-channel.md) - Channel operations in select
