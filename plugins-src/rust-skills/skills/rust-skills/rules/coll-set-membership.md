# coll-set-membership

> Use `HashSet`/`BTreeSet` for membership tests and dedup, not linear `Vec::contains`

## Why It Matters

`Vec::contains` is O(n) per call. When you check membership for m items against a list of n items in a loop, the total cost is O(n × m) — quadratic. A `HashSet` reduces each check to O(1) average, making the same loop O(n + m). Use `BTreeSet` when you also need sorted iteration or range queries. Keep a `Vec` only when order matters, duplicates are intentional, or the collection is so small (say, ≤ 8 items) that the overhead of hashing outweighs the savings.

Deduplication follows the same rule: collecting into a `HashSet` is one line and O(n), while repeatedly removing duplicates from a sorted `Vec` is more code and no faster.

## Bad

```rust
fn find_common(all_users: &[String], active_ids: &[String]) -> Vec<String> {
    let mut common = Vec::new();
    for user in all_users {
        // O(n) per iteration → O(n * m) total
        if active_ids.contains(user) {
            common.push(user.clone());
        }
    }
    common
}

fn deduplicate(items: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        // O(n) per item — quadratic overall
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}
```

## Good

```rust
use std::collections::{BTreeSet, HashSet};

// O(n + m): build the set once, then test each user in O(1).
fn find_common(all_users: &[String], active_ids: &[String]) -> Vec<String> {
    let active: HashSet<&String> = active_ids.iter().collect();
    all_users
        .iter()
        .filter(|u| active.contains(u))
        .cloned()
        .collect()
}

// Dedup while preserving order: track seen items in a HashSet.
fn deduplicate_ordered(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::with_capacity(items.len());
    items.into_iter().filter(|s| seen.insert(s.clone())).collect()
}

// Dedup into a sorted, unique collection — use BTreeSet.
fn unique_sorted(items: Vec<String>) -> Vec<String> {
    items.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

fn main() {
    let users = vec!["alice".to_string(), "bob".to_string(), "carol".to_string()];
    let active = vec!["bob".to_string(), "carol".to_string(), "dave".to_string()];
    println!("{:?}", find_common(&users, &active)); // ["bob", "carol"]

    let raw = vec!["x".to_string(), "y".to_string(), "x".to_string(), "z".to_string()];
    println!("{:?}", deduplicate_ordered(raw)); // ["x", "y", "z"]
}
```

## Which to Use

| Requirement | Choose |
|---|---|
| Fast membership test, no ordering needed | `HashSet<T>` |
| Membership test + sorted iteration | `BTreeSet<T>` |
| Tiny set (≤ 8 items) | `Vec<T>` with `.contains` may be fine |
| Keep duplicates or care about insertion order | `Vec<T>` |

**Tip:** when building a `HashSet` that will be queried many times, call `HashSet::with_capacity(n)` upfront to avoid rehashing. See `mem-with-capacity`.

## See Also

- [coll-map-choice](coll-map-choice.md) - choosing between `HashMap`, `BTreeMap`, and `IndexMap`
- [perf-ahash](perf-ahash.md) - swap in a faster hasher for non-adversarial sets
