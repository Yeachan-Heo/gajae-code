# name-types-camel

> Use `UpperCamelCase` for types, traits, and enum names

## Why It Matters

Rust's naming conventions are enforced by the compiler and linter. Consistent naming makes code immediately recognizable—you know `HttpClient` is a type, `send_request` is a function. Violating conventions triggers warnings and makes code harder to read.

## Bad

```rust
// Lowercase types - compiler warns
struct http_client { ... }  // warning: type `http_client` should have an upper camel case name
trait serializable { ... }  // warning
enum response_type { ... }  // warning

// Screaming case for types
struct HTTP_CLIENT { ... }  // Not idiomatic
```

## Good

```rust
// UpperCamelCase for all types
struct HttpClient { ... }
trait Serializable { ... }
enum ResponseType { ... }

// Compound words
struct TcpConnection { ... }
struct IoError { ... }
struct FileReader { ... }

// Generic types
struct HashMap<K, V> { ... }
struct Result<T, E> { ... }
```

## Acronyms

```rust
// Treat acronyms as words (capitalize first letter only)
struct HttpServer { ... }      // Not HTTPServer
struct JsonParser { ... }      // Not JSONParser
struct Uuid { ... }            // Not UUID
struct TcpStream { ... }       // Not TCPStream

// Exception: Two-letter acronyms can be all caps
struct IOError { ... }         // Acceptable
struct IoError { ... }         // Also acceptable (preferred)
```

## Type Aliases

```rust
// Type aliases also use UpperCamelCase
type Result<T> = std::result::Result<T, Error>;
type BoxedFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
```

## See Also

- [name-variants-camel](./name-variants-camel.md) - Enum variant naming
- [name-funcs-snake](./name-funcs-snake.md) - Function naming
- [name-acronym-word](./name-acronym-word.md) - Acronym handling
