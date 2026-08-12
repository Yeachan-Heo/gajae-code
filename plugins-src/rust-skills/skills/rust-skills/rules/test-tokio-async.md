# test-tokio-async

> Use `#[tokio::test]` for async tests

## Why It Matters

Async functions can't be called directly—they need a runtime to drive them. `#[tokio::test]` provides a Tokio runtime for your test, handling setup automatically. This is simpler than manually creating a runtime and essential for testing async code.

## Bad

```rust
// Won't compile - async fn can't be called without runtime
#[test]
async fn test_async_function() {  // Error!
    let result = fetch_data().await;
    assert!(result.is_ok());
}

// Manual runtime - verbose and error-prone
#[test]
fn test_async_function() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let result = fetch_data().await;
        assert!(result.is_ok());
    });
}
```

## Good

```rust
#[tokio::test]
async fn test_async_function() {
    let result = fetch_data().await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_concurrent_operations() {
    let (a, b) = tokio::join!(
        fetch_user(1),
        fetch_user(2),
    );
    assert!(a.is_ok());
    assert!(b.is_ok());
}
```

## Runtime Configuration

```rust
// Multi-threaded runtime (default)
#[tokio::test]
async fn test_default_runtime() {
    // Uses multi-thread runtime
}

// Single-threaded (current_thread)
#[tokio::test(flavor = "current_thread")]
async fn test_single_threaded() {
    // Simpler, deterministic
}

// With specific thread count
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_with_workers() {
    // Exactly 2 worker threads
}

// With time control
#[tokio::test(start_paused = true)]
async fn test_with_time_control() {
    // Time starts paused for deterministic testing
    tokio::time::advance(Duration::from_secs(60)).await;
}
```

## Testing Timeouts

```rust
use tokio::time::{timeout, Duration};

#[tokio::test]
async fn test_operation_completes_in_time() {
    let result = timeout(
        Duration::from_secs(5),
        slow_operation()
    ).await;
    
    assert!(result.is_ok(), "Operation timed out");
}

#[tokio::test]
async fn test_timeout_triggers() {
    let result = timeout(
        Duration::from_millis(100),
        never_completes()
    ).await;
    
    assert!(result.is_err(), "Expected timeout");
}
```

## Testing Channels

```rust
use tokio::sync::mpsc;

#[tokio::test]
async fn test_channel_communication() {
    let (tx, mut rx) = mpsc::channel(10);
    
    tokio::spawn(async move {
        tx.send("hello").await.unwrap();
        tx.send("world").await.unwrap();
    });
    
    assert_eq!(rx.recv().await, Some("hello"));
    assert_eq!(rx.recv().await, Some("world"));
    assert_eq!(rx.recv().await, None);
}
```

## Testing with Mocks

```rust
use mockall::*;

#[automock]
#[async_trait::async_trait]
trait Database {
    async fn get_user(&self, id: u64) -> Option<User>;
}

#[tokio::test]
async fn test_with_mock_database() {
    let mut mock = MockDatabase::new();
    mock.expect_get_user()
        .with(eq(42))
        .returning(|_| Some(User { id: 42, name: "Alice".into() }));
    
    let service = UserService::new(mock);
    let user = service.find_user(42).await;
    
    assert_eq!(user.unwrap().name, "Alice");
}
```

## See Also

- [async-tokio-runtime](./async-tokio-runtime.md) - Runtime configuration
- [test-mock-traits](./test-mock-traits.md) - Mocking async traits
- [test-fixture-raii](./test-fixture-raii.md) - Async test cleanup
