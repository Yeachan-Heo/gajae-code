# test-fixture-raii

> Use RAII pattern (Drop trait) for automatic test cleanup

## Why It Matters

Tests often need setup and teardown—creating temp files, starting servers, setting environment variables. Using RAII (Resource Acquisition Is Initialization) with Drop ensures cleanup happens automatically, even if the test panics. This prevents test pollution and resource leaks.

## Bad

```rust
#[test]
fn test_with_temp_file() {
    let path = "/tmp/test_file.txt";
    std::fs::write(path, "test data").unwrap();
    
    let result = process_file(path);
    
    std::fs::remove_file(path).unwrap();  // Might not run if test panics!
    assert!(result.is_ok());
}

#[test]
fn test_with_env_var() {
    std::env::set_var("MY_VAR", "test_value");
    
    let result = read_config();
    
    std::env::remove_var("MY_VAR");  // Might not run if test panics!
    assert!(result.is_ok());
}
```

## Good

```rust
use tempfile::NamedTempFile;

#[test]
fn test_with_temp_file() {
    // Arrange - file deleted automatically when `file` drops
    let file = NamedTempFile::new().unwrap();
    std::fs::write(file.path(), "test data").unwrap();
    
    // Act
    let result = process_file(file.path());
    
    // Assert - file cleaned up even if assertion panics
    assert!(result.is_ok());
}

// Custom RAII guard for environment variables
struct EnvGuard {
    key: String,
    original: Option<String>,
}

impl EnvGuard {
    fn set(key: &str, value: &str) -> Self {
        let original = std::env::var(key).ok();
        // SAFETY: env::set_var is unsafe since the 2024 edition (env writes are
        // not thread-safe); env-touching tests should run single-threaded.
        unsafe { std::env::set_var(key, value) };
        EnvGuard {
            key: key.to_string(),
            original,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        // SAFETY: see EnvGuard::set — restored on the same single-threaded test
        match &self.original {
            Some(v) => unsafe { std::env::set_var(&self.key, v) },
            None => unsafe { std::env::remove_var(&self.key) },
        }
    }
}

#[test]
fn test_with_env_var() {
    let _guard = EnvGuard::set("MY_VAR", "test_value");
    
    let result = read_config();
    
    assert!(result.is_ok());
}  // MY_VAR automatically restored
```

## Common RAII Patterns

```rust
// Temporary directory
use tempfile::TempDir;

#[test]
fn test_with_temp_dir() {
    let dir = TempDir::new().unwrap();
    let file_path = dir.path().join("test.txt");
    std::fs::write(&file_path, "data").unwrap();
    
    // dir and all contents deleted on drop
}

// Server guard
struct TestServer {
    handle: std::thread::JoinHandle<()>,
    shutdown: std::sync::mpsc::Sender<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        // Wait for server to stop
    }
}

// Database transaction rollback
struct TestTransaction<'a> {
    conn: &'a mut Connection,
}

impl Drop for TestTransaction<'_> {
    fn drop(&mut self) {
        self.conn.execute("ROLLBACK").unwrap();
    }
}
```

## scopeguard Crate

```rust
use scopeguard::defer;

#[test]
fn test_with_defer() {
    let path = "/tmp/test_file.txt";
    std::fs::write(path, "data").unwrap();
    
    defer! {
        std::fs::remove_file(path).ok();
    }
    
    // Test logic here
    // File removed when scope exits
}
```

## See Also

- [test-arrange-act-assert](./test-arrange-act-assert.md) - Test structure
- [test-tokio-async](./test-tokio-async.md) - Async test cleanup
- [test-mock-traits](./test-mock-traits.md) - Mocking with RAII
