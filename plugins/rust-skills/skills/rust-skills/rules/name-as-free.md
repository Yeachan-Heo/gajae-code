# name-as-free

> `as_` prefix: free reference conversion

## Why It Matters

Consistent naming helps users understand API cost. `as_` prefix signals a free (O(1), no allocation) conversion that returns a reference. This convention is used throughout the standard library.

## The Convention

| Prefix | Cost | Ownership | Example |
|--------|------|-----------|---------|
| `as_` | Free | `&T -> &U` | `str::as_bytes()` |
| `to_` | Expensive | `&T -> U` | `str::to_lowercase()` |
| `into_` | Variable | `T -> U` | `String::into_bytes()` |

## Examples

```rust
impl MyString {
    // as_ - free reference conversion
    pub fn as_str(&self) -> &str {
        &self.inner
    }
    
    pub fn as_bytes(&self) -> &[u8] {
        self.inner.as_bytes()
    }
}

impl Wrapper<T> {
    // as_ - returns reference to inner
    pub fn as_inner(&self) -> &T {
        &self.inner
    }
    
    pub fn as_inner_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}
```

## Standard Library Examples

```rust
// String
let s = String::from("hello");
let bytes: &[u8] = s.as_bytes();    // Free, returns &[u8]
let str_ref: &str = s.as_str();     // Free, returns &str

// Vec
let v = vec![1, 2, 3];
let slice: &[i32] = v.as_slice();   // Free, returns &[i32]

// Path
let p = PathBuf::from("/home");
let path: &Path = p.as_path();      // Free, returns &Path

// OsString
let os = OsString::from("hello");
let os_str: &OsStr = os.as_os_str(); // Free, returns &OsStr
```

## Bad

```rust
impl MyType {
    // BAD: as_ but allocates
    pub fn as_string(&self) -> String {
        format!("{}", self.value)  // Allocates! Should be to_string()
    }
    
    // BAD: as_ but expensive
    pub fn as_processed(&self) -> &ProcessedData {
        // Actually does expensive computation
    }
}
```

## Good

```rust
impl MyType {
    // GOOD: Free reference
    pub fn as_str(&self) -> &str {
        &self.inner
    }
    
    // GOOD: to_ signals allocation
    pub fn to_string(&self) -> String {
        format!("{}", self.value)
    }
    
    // GOOD: into_ signals ownership transfer
    pub fn into_inner(self) -> Inner {
        self.inner
    }
}
```

## See Also

- [name-to-expensive](name-to-expensive.md) - `to_` prefix for expensive conversions
- [name-into-ownership](name-into-ownership.md) - `into_` prefix for ownership transfer
