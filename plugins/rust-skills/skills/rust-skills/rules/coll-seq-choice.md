# coll-seq-choice

> Default to `Vec`; use `VecDeque` for queue/deque behaviour; avoid `LinkedList`

## Why It Matters

`Vec<T>` is a contiguous growable array — the right sequence type for almost every use case. Contiguous layout means the CPU prefetcher works in your favour and each element is a single pointer dereference away. `VecDeque<T>` is a ring buffer with O(1) amortised push and pop at **both** ends; reach for it when you need a FIFO queue or a sliding window. `LinkedList<T>` is heap-allocated per node and pointer-chased on every access; in practice it is almost always slower than `Vec` or `VecDeque` for real workloads, and the standard library itself discourages its use.

## Bad

```rust
fn process_queue(items: Vec<String>) {
    let mut queue = items;
    while !queue.is_empty() {
        // O(n): every element shifts left after removal.
        let item = queue.remove(0);
        println!("processing: {item}");
    }
}

fn main() {
    process_queue(vec![
        "first".to_string(),
        "second".to_string(),
        "third".to_string(),
    ]);
}
```

`remove(0)` on a `Vec` is O(n) because it must shift every remaining element. A loop of n items becomes O(n²).

## Good

```rust
use std::collections::VecDeque;

fn process_queue(items: impl IntoIterator<Item = String>) {
    // VecDeque: O(1) pop_front — the right tool for a FIFO queue.
    let mut queue: VecDeque<String> = items.into_iter().collect();
    while let Some(item) = queue.pop_front() {
        println!("processing: {item}");
    }
}

fn sliding_window_max(values: &[i32], k: usize) -> Vec<i32> {
    // VecDeque also shines as a fixed-size sliding window.
    let mut window: VecDeque<i32> = VecDeque::with_capacity(k);
    let mut result = Vec::with_capacity(values.len().saturating_sub(k) + 1);

    for &v in values {
        window.push_back(v);
        if window.len() > k {
            window.pop_front();
        }
        if window.len() == k {
            result.push(*window.iter().max().unwrap());
        }
    }
    result
}

fn main() {
    process_queue(["alpha".to_string(), "beta".to_string(), "gamma".to_string()]);

    let maxima = sliding_window_max(&[3, 1, 2, 5, 4], 3);
    println!("{maxima:?}"); // [3, 5, 5]
}
```

## Which to Use

| Requirement | Choose |
|---|---|
| General-purpose growable list | `Vec<T>` |
| FIFO queue, deque, or sliding window | `VecDeque<T>` |
| Need O(1) split/splice at arbitrary positions | consider `VecDeque<T>` or rethink the design |
| Linked list (almost never) | `LinkedList<T>` — only if profiling proves it faster |

**Conversion:** `Vec` and `VecDeque` convert cheaply into each other via `From`/`Into` when you need to switch representation.

## See Also

- [mem-with-capacity](mem-with-capacity.md) - pre-allocate with `with_capacity` when size is known
- [perf-drain-reuse](perf-drain-reuse.md) - drain a collection to reuse its allocation
- [coll-map-choice](coll-map-choice.md) - choosing the right map type
