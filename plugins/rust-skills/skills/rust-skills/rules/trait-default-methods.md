# trait-default-methods

> Define a trait in terms of a few required methods plus defaulted ones built on top of them

## Why It Matters

A trait with only required methods places the full implementation burden on every consumer. Providing default method bodies — as `std::iter::Iterator` does, building `map`, `filter`, `fold`, and dozens more on a single required `next` — means implementors write only the essential logic and receive the rest for free. Defaults also act as documentation: they show the canonical relationship between methods. Implementors can still override a default for performance (e.g., `Iterator::count` overridden by `std::vec::IntoIter` to avoid iterating) without changing the observable contract.

## Bad

```rust
// Every implementor must manually implement all three methods,
// even though two of them are mechanical compositions of the first.
trait Summarise {
    fn sentences(&self) -> Vec<String>;
    fn first_sentence(&self) -> Option<String>;  // always just sentences().into_iter().next()
    fn word_count(&self) -> usize;               // always sentences().join(" ").split_whitespace().count()
}

struct Article { body: String }

impl Summarise for Article {
    fn sentences(&self) -> Vec<String> {
        self.body.split('.').map(str::trim).map(str::to_owned).collect()
    }
    // Duplicated logic — must be kept in sync across every implementor.
    fn first_sentence(&self) -> Option<String> {
        self.sentences().into_iter().next()
    }
    fn word_count(&self) -> usize {
        self.sentences().join(" ").split_whitespace().count()
    }
}
```

## Good

```rust
trait Summarise {
    // ----- Required: the only thing implementors must provide -----
    fn sentences(&self) -> Vec<String>;

    // ----- Defaulted: free for all implementors -----
    fn first_sentence(&self) -> Option<String> {
        self.sentences().into_iter().next()
    }

    fn word_count(&self) -> usize {
        self.sentences().join(" ").split_whitespace().count()
    }

    fn is_empty(&self) -> bool {
        self.sentences().is_empty()
    }
}

// Minimal impl — one method, three come for free.
struct Article { body: String }

impl Summarise for Article {
    fn sentences(&self) -> Vec<String> {
        self.body
            .split('.')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

// Override a default for performance when the default is provably slower.
struct PreSplit { parts: Vec<String> }

impl Summarise for PreSplit {
    fn sentences(&self) -> Vec<String> {
        self.parts.clone()
    }

    // Override: the parts are already split — no need to join and re-split.
    fn word_count(&self) -> usize {
        self.parts.iter().flat_map(|s| s.split_whitespace()).count()
    }
}

fn print_summary(item: &impl Summarise) {
    if item.is_empty() {
        println!("(empty)");
        return;
    }
    if let Some(first) = item.first_sentence() {
        println!("first: {first}");
    }
    println!("words: {}", item.word_count());
}

fn demo() {
    let a = Article { body: "Rust is fast. Rust is safe. Rust is fun.".to_owned() };
    print_summary(&a);

    let p = PreSplit { parts: vec!["hello world".to_owned(), "foo bar baz".to_owned()] };
    print_summary(&p);
}
```

## Key Points

- Keep required methods to the **minimum orthogonal set**: ideally one or two.
- Default implementations must only call other methods on `Self`, not external state.
- An override changes performance but must preserve the same observable semantics.
- Document which methods are required vs defaulted in the trait's module-level doc comment.
- The pattern is explicitly encouraged by the Rust API Guidelines under "Implement common traits from std" and is central to `std::iter::Iterator`, `std::io::Read`, and `std::io::Write`.

## See Also

- [api-extension-trait](api-extension-trait.md) - add methods to foreign types via extension traits
- [trait-associated-type-vs-generic](trait-associated-type-vs-generic.md) - choose between associated types and generic parameters
- [trait-blanket-impl](trait-blanket-impl.md) - give behaviour to every type meeting a bound
