# doc-hidden-setup

> Use `# ` prefix to hide example setup code

## Why It Matters

Doc examples often require setup code (imports, struct initialization, mock data) that distracts from the main point. The `# ` prefix hides lines from rendered documentation while keeping them in the compiled test, showing users only the relevant code.

This keeps examples focused and readable while ensuring they still compile and run.

## Bad

```rust
/// Processes a batch of items.
///
/// # Examples
///
/// ```
/// use my_crate::{Processor, Config, Item};
/// use std::sync::Arc;
/// 
/// let config = Config {
///     batch_size: 100,
///     timeout_ms: 5000,
///     retry_count: 3,
/// };
/// let processor = Processor::new(Arc::new(config));
/// let items = vec![
///     Item::new("a"),
///     Item::new("b"),
///     Item::new("c"),
/// ];
/// 
/// // This is the actual example - buried after 15 lines of setup
/// let results = processor.process_batch(&items)?;
/// assert!(results.all_succeeded());
/// # Ok::<(), my_crate::Error>(())
/// ```
pub fn process_batch(&self, items: &[Item]) -> Result<Results, Error> {
    // ...
}
```

## Good

```rust
/// Processes a batch of items.
///
/// # Examples
///
/// ```
/// # use my_crate::{Processor, Config, Item, Error};
/// # use std::sync::Arc;
/// # let config = Config { batch_size: 100, timeout_ms: 5000, retry_count: 3 };
/// # let processor = Processor::new(Arc::new(config));
/// # let items = vec![Item::new("a"), Item::new("b"), Item::new("c")];
/// let results = processor.process_batch(&items)?;
/// assert!(results.all_succeeded());
/// # Ok::<(), Error>(())
/// ```
pub fn process_batch(&self, items: &[Item]) -> Result<Results, Error> {
    // ...
}
```

Users see only:

```rust
let results = processor.process_batch(&items)?;
assert!(results.all_succeeded());
```

## What to Hide

| Hide | Show |
|------|------|
| `use` statements | Core API usage |
| Type definitions | Method calls |
| Mock/test data setup | Key parameters |
| Error handling boilerplate | Return value handling |
| `Ok(())` return | Assertions (sometimes) |

## Pattern: Hiding Multi-Line Setup

```rust
/// # Examples
///
/// ```
/// # use my_crate::{Client, Request};
/// # fn main() -> Result<(), Box<dyn std::error::Error>> {
/// # let client = Client::builder()
/// #     .timeout(30)
/// #     .retry(3)
/// #     .build()?;
/// let response = client.send(Request::get("/users"))?;
/// println!("Status: {}", response.status());
/// # Ok(())
/// # }
/// ```
```

## Pattern: Showing Setup When Relevant

Sometimes setup IS the point—don't hide it:

```rust
/// Creates a new client with custom configuration.
///
/// # Examples
///
/// ```
/// use my_crate::Client;
///
/// // Configuration IS the example - show it
/// let client = Client::builder()
///     .base_url("https://api.example.com")
///     .timeout_secs(30)
///     .max_retries(3)
///     .build()?;
/// # Ok::<(), my_crate::Error>(())
/// ```
```

## Pattern: `ignore` and `no_run`

For examples that shouldn't run in tests:

```rust
/// # Examples
///
/// ```no_run
/// # use my_crate::Server;
/// // This would actually start a server - don't run in tests
/// let server = Server::bind("0.0.0.0:8080").await?;
/// server.run().await?;
/// # Ok::<(), my_crate::Error>(())
/// ```

/// ```ignore
/// // Pseudocode or incomplete example
/// let magic = do_something_undefined();
/// ```
```

## See Also

- [doc-examples-section](./doc-examples-section.md) - Writing examples
- [doc-question-mark](./doc-question-mark.md) - Using `?` in examples
- [test-doctest-examples](./test-doctest-examples.md) - Doctests as tests
