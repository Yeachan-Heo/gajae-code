# name-to-expensive

> Use `to_` prefix for expensive conversions that allocate or compute

## Why It Matters

The `to_` prefix signals "this conversion has a cost"—typically allocation, cloning, or computation. Callers know to consider caching the result or avoiding repeated calls. This contrasts with `as_` (free reference conversion) and `into_` (ownership transfer).

## Bad

```rust
impl Name {
    // Misleading: suggests expensive operation
    fn as_uppercase(&self) -> String {
        self.0.to_uppercase()  // Allocates!
    }
    
    // Misleading: suggests cheap reference
    fn get_string(&self) -> String {
        self.0.clone()  // Allocates!
    }
}
```

## Good

```rust
impl Name {
    // to_ = allocates/computes
    fn to_uppercase(&self) -> String {
        self.0.to_uppercase()
    }
    
    // to_ = creates new value
    fn to_string(&self) -> String {
        self.0.clone()
    }
    
    // as_ = free reference (cheap)
    fn as_str(&self) -> &str {
        &self.0
    }
}
```

## Standard Library Examples

```rust
// to_ methods - all allocate or compute
let s: String = slice.to_vec();           // Allocates Vec
let s: String = "hello".to_string();      // Allocates String
let s: String = "HELLO".to_lowercase();   // Allocates new String
let s: String = path.to_string_lossy().into_owned();  // May allocate

// Contrast with as_ methods - all are free
let slice: &[u8] = s.as_bytes();          // Just reinterpret
let str_ref: &str = string.as_str();      // Just reference
let path: &Path = Path::new("foo");       // Just reference
```

## Conversion Method Prefixes

| Prefix | Cost | Ownership | Example |
|--------|------|-----------|---------|
| `as_` | Free (O(1)) | Borrows `&T` | `as_str()`, `as_bytes()` |
| `to_` | Allocates/Computes | Creates new | `to_string()`, `to_vec()` |
| `into_` | Usually free | Takes ownership | `into_inner()`, `into_vec()` |

## Custom Types

```rust
struct Email(String);

impl Email {
    // Cheap: just returns reference
    fn as_str(&self) -> &str {
        &self.0
    }
    
    // Expensive: allocates
    fn to_lowercase(&self) -> Email {
        Email(self.0.to_lowercase())
    }
    
    // Expensive: allocates
    fn to_display_format(&self) -> String {
        format!("<{}>", self.0)
    }
    
    // Ownership transfer: usually cheap
    fn into_string(self) -> String {
        self.0
    }
}
```

## to_owned() Pattern

```rust
// to_owned() for getting owned version of borrowed data
let borrowed: &str = "hello";
let owned: String = borrowed.to_owned();  // Allocates

let borrowed: &[i32] = &[1, 2, 3];
let owned: Vec<i32> = borrowed.to_owned();  // Allocates

// ToOwned trait
trait ToOwned {
    type Owned;
    fn to_owned(&self) -> Self::Owned;
}
```

## See Also

- [name-as-free](./name-as-free.md) - Free reference conversions
- [name-into-ownership](./name-into-ownership.md) - Ownership transfer
- [own-cow-conditional](./own-cow-conditional.md) - Avoiding unnecessary allocations
