# own-lifetime-elision

> Rely on lifetime elision rules; add explicit lifetimes only when required

## Why It Matters

Rust's lifetime elision rules handle most common borrowing patterns automatically. Adding explicit lifetimes where they're not needed clutters code without adding clarity. However, understanding when elision applies helps you know when explicit lifetimes are truly necessary.

## Bad

```rust
// Unnecessary explicit lifetimes - elision handles these
fn first_word<'a>(s: &'a str) -> &'a str {
    s.split_whitespace().next().unwrap_or("")
}

fn get_name<'a>(person: &'a Person) -> &'a str {
    &person.name
}

impl<'a> Display for Wrapper<'a> {
    fn fmt<'b>(&'b self, f: &'b mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
```

## Good

```rust
// Let elision do its job
fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}

fn get_name(person: &Person) -> &str {
    &person.name
}

impl Display for Wrapper<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
```

## The Three Elision Rules

1. **Each input reference gets its own lifetime:**
   ```rust
   fn foo(x: &str, y: &str) 
   // becomes
   fn foo<'a, 'b>(x: &'a str, y: &'b str)
   ```

2. **One input reference → output gets same lifetime:**
   ```rust
   fn foo(x: &str) -> &str
   // becomes  
   fn foo<'a>(x: &'a str) -> &'a str
   ```

3. **Method with `&self`/`&mut self` → output gets self's lifetime:**
   ```rust
   fn foo(&self, x: &str) -> &str
   // becomes
   fn foo<'a, 'b>(&'a self, x: &'b str) -> &'a str
   ```

## When Explicit Lifetimes ARE Required

```rust
// Multiple input references, output could come from either
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

// Struct holding references
struct Parser<'input> {
    source: &'input str,
    position: usize,
}

// Multiple distinct lifetimes needed
struct Context<'s, 'c> {
    source: &'s str,
    cache: &'c mut Cache,
}

// Static lifetime for constants
fn get_default() -> &'static str {
    "default"
}
```

## Anonymous Lifetime `'_`

Use `'_` to let the compiler infer while being explicit about the presence of a lifetime:

```rust
// In struct definitions
impl Iterator for Parser<'_> {
    type Item = Token;
    fn next(&mut self) -> Option<Self::Item> { ... }
}

// In function signatures where it adds clarity
fn parse(input: &str) -> Result<Ast<'_>, Error> { ... }

// Especially useful in trait bounds
fn process(data: &impl AsRef<str>) -> Cow<'_, str> { ... }
```

## Common Patterns

```rust
// ✅ Elision works
fn trim(s: &str) -> &str { s.trim() }
fn first(v: &[i32]) -> Option<&i32> { v.first() }
fn name(&self) -> &str { &self.name }

// ❌ Elision fails - multiple inputs, ambiguous output
fn pick(a: &str, b: &str, first: bool) -> &str // Error!

// ✅ Fixed with explicit lifetime
fn pick<'a>(a: &'a str, b: &'a str, first: bool) -> &'a str {
    if first { a } else { b }
}
```

## See Also

- [own-borrow-over-clone](./own-borrow-over-clone.md) - Prefer borrowing to avoid ownership issues
- [api-impl-asref](./api-impl-asref.md) - Generic borrowing with AsRef
