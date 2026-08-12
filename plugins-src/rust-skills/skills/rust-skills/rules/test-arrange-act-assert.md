# test-arrange-act-assert

> Structure tests with clear Arrange, Act, Assert sections

## Why It Matters

The AAA pattern makes tests readable and maintainable. Each section has a clear purpose: set up test data, execute the code under test, verify the results. This structure helps identify what's being tested and makes tests easier to debug when they fail.

## Bad

```rust
#[test]
fn test_user() {
    assert_eq!(User::new("alice", "alice@example.com").unwrap().name(), "alice");
    assert!(User::new("", "email@example.com").is_err());
    let u = User::new("bob", "bob@example.com").unwrap();
    assert!(u.validate());
    assert_eq!(u.email(), "bob@example.com");
}
// Multiple concerns, hard to understand, hard to debug
```

## Good

```rust
#[test]
fn new_user_has_correct_name() {
    // Arrange
    let name = "alice";
    let email = "alice@example.com";
    
    // Act
    let user = User::new(name, email).unwrap();
    
    // Assert
    assert_eq!(user.name(), "alice");
}

#[test]
fn user_creation_fails_with_empty_name() {
    // Arrange
    let name = "";
    let email = "email@example.com";
    
    // Act
    let result = User::new(name, email);
    
    // Assert
    assert!(result.is_err());
    assert!(matches!(result, Err(UserError::EmptyName)));
}
```

## With Comments

```rust
#[test]
fn order_total_includes_tax() {
    // Arrange
    let mut order = Order::new();
    order.add_item(Item::new("Widget", 100.00));
    order.add_item(Item::new("Gadget", 50.00));
    let tax_rate = 0.10;
    
    // Act
    let total = order.calculate_total(tax_rate);
    
    // Assert
    let expected = (100.00 + 50.00) * 1.10;
    assert_eq!(total, expected);
}
```

## Complex Arrange

```rust
#[test]
fn search_returns_matching_documents() {
    // Arrange
    let mut index = SearchIndex::new();
    index.add_document(Document::new(1, "rust programming"));
    index.add_document(Document::new(2, "python programming"));
    index.add_document(Document::new(3, "rust web development"));
    
    let query = Query::new("rust");
    
    // Act
    let results = index.search(&query);
    
    // Assert
    assert_eq!(results.len(), 2);
    assert!(results.iter().any(|d| d.id == 1));
    assert!(results.iter().any(|d| d.id == 3));
}
```

## Async Tests

```rust
#[tokio::test]
async fn fetch_user_returns_user_data() {
    // Arrange
    let client = TestClient::new();
    let user_id = 42;
    
    // Act
    let result = client.fetch_user(user_id).await;
    
    // Assert
    assert!(result.is_ok());
    let user = result.unwrap();
    assert_eq!(user.id, user_id);
}
```

## Helper Functions

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    // Arrange helpers
    fn create_test_user() -> User {
        User::new("test", "test@example.com").unwrap()
    }
    
    fn create_order_with_items(items: &[(&str, f64)]) -> Order {
        let mut order = Order::new();
        for (name, price) in items {
            order.add_item(Item::new(name, *price));
        }
        order
    }
    
    // Assert helpers
    fn assert_order_total(order: &Order, expected: f64) {
        let total = order.calculate_total(0.0);
        assert!((total - expected).abs() < 0.01);
    }
    
    #[test]
    fn order_total_sums_items() {
        // Arrange
        let order = create_order_with_items(&[
            ("A", 10.0),
            ("B", 20.0),
        ]);
        
        // Act & Assert
        assert_order_total(&order, 30.0);
    }
}
```

## See Also

- [test-descriptive-names](./test-descriptive-names.md) - Test naming
- [test-fixture-raii](./test-fixture-raii.md) - Test setup/teardown
- [test-mock-traits](./test-mock-traits.md) - Mocking dependencies
