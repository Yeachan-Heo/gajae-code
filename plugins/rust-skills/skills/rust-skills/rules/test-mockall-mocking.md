# test-mockall-mocking

> Use mockall for trait mocking

## Why It Matters

Unit tests should isolate the code under test from external dependencies (databases, APIs, file systems). Mockall generates mock implementations of traits, allowing you to control and verify behavior without real dependencies.

## Setup

```toml
# Cargo.toml
[dev-dependencies]
mockall = "0.12"
```

## Basic Usage

```rust
use mockall::automock;

#[automock]
trait Database {
    fn get_user(&self, id: u64) -> Option<User>;
    fn save_user(&self, user: &User) -> Result<(), Error>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::predicate::*;
    
    #[test]
    fn test_get_user() {
        let mut mock = MockDatabase::new();
        
        mock.expect_get_user()
            .with(eq(42))
            .returning(|_| Some(User { id: 42, name: "Alice".into() }));
        
        let service = UserService::new(mock);
        let user = service.find_user(42);
        
        assert_eq!(user.unwrap().name, "Alice");
    }
}
```

## Expectations

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_save_calls() {
        let mut mock = MockDatabase::new();
        
        // Expect exactly one call
        mock.expect_save_user()
            .times(1)
            .returning(|_| Ok(()));
        
        // Expect call with specific argument
        mock.expect_get_user()
            .with(eq(42))
            .returning(|_| Some(User::default()));
        
        // Expect multiple calls
        mock.expect_get_user()
            .times(3..)  // At least 3 times
            .returning(|_| None);
        
        // Expectations are verified on drop
    }
}
```

## Predicates

```rust
use mockall::predicate::*;

mock.expect_process()
    .with(eq(42))                    // Exact match
    .returning(|_| Ok(()));

mock.expect_validate()
    .with(function(|s: &str| s.len() > 5))  // Custom predicate
    .returning(|_| true);

mock.expect_search()
    .withf(|query, limit| {           // Multiple args
        query.len() < 100 && *limit <= 1000
    })
    .returning(|_, _| vec![]);
```

## Sequences

```rust
use mockall::Sequence;

#[test]
fn test_ordered_calls() {
    let mut seq = Sequence::new();
    let mut mock = MockDatabase::new();
    
    mock.expect_connect()
        .times(1)
        .in_sequence(&mut seq)
        .returning(|| Ok(()));
    
    mock.expect_query()
        .times(1)
        .in_sequence(&mut seq)
        .returning(|_| Ok(vec![]));
    
    mock.expect_disconnect()
        .times(1)
        .in_sequence(&mut seq)
        .returning(|| Ok(()));
}
```

## Return Values

```rust
// Fixed value
mock.expect_count().returning(|| 42);

// Based on input
mock.expect_double().returning(|x| x * 2);

// Different values per call
mock.expect_next()
    .times(3)
    .returning(|| 1)
    .returning(|| 2)
    .returning(|| 3);

// Return owned values
mock.expect_get_name()
    .returning(|| "Alice".to_string());
```

## Mocking External Traits

```rust
// For traits you don't own
#[cfg_attr(test, mockall::automock)]
trait HttpClient {
    fn get(&self, url: &str) -> Result<Response, Error>;
}

// In production
struct RealHttpClient;
impl HttpClient for RealHttpClient {
    fn get(&self, url: &str) -> Result<Response, Error> { /* ... */ }
}

// In tests
#[cfg(test)]
fn mock_client() -> MockHttpClient {
    let mut mock = MockHttpClient::new();
    mock.expect_get()
        .returning(|_| Ok(Response::new(200, "OK")));
    mock
}
```

## Async Mocking

```rust
#[automock]
#[async_trait]
trait AsyncDatabase {
    async fn fetch(&self, id: u64) -> Option<Data>;
}

#[tokio::test]
async fn test_async() {
    let mut mock = MockAsyncDatabase::new();
    
    mock.expect_fetch()
        .returning(|_| Some(Data::default()));
    
    let result = mock.fetch(1).await;
    assert!(result.is_some());
}
```

## Design for Testability

```rust
// Accept trait, not concrete type
struct Service<D: Database> {
    db: D,
}

impl<D: Database> Service<D> {
    fn new(db: D) -> Self {
        Self { db }
    }
}

// Tests use mock
#[test]
fn test_service() {
    let mock = MockDatabase::new();
    let service = Service::new(mock);
}

// Production uses real implementation
fn main() {
    let db = PostgresDatabase::connect();
    let service = Service::new(db);
}
```

## See Also

- [test-mock-traits](./test-mock-traits.md) - Mock trait design
- [test-proptest-properties](./test-proptest-properties.md) - Property testing
- [test-arrange-act-assert](./test-arrange-act-assert.md) - Test structure
