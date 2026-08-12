# coll-binaryheap

> Use `BinaryHeap` for a priority queue or repeated max-extraction

## Why It Matters

`std::collections::BinaryHeap<T>` is a max-heap with O(log n) `push` and `pop` (extract-max) and O(1) `peek`. When you repeatedly need the largest (or smallest) element from a growing or shrinking set, it beats sorting a `Vec` after every insertion — sorting is O(n log n) each time, while a heap amortises that cost to O(log n) per operation. For a **min-heap**, wrap your values in `std::cmp::Reverse<T>`; the heap's ordering flips, and the smallest value is extracted first.

## Bad

```rust
fn top_priority_task(tasks: &mut Vec<(u32, String)>) -> Option<String> {
    if tasks.is_empty() {
        return None;
    }
    // O(n) scan to find the max, then O(n) shift to remove it — O(n) per call.
    let max_idx = tasks
        .iter()
        .enumerate()
        .max_by_key(|(_, (p, _))| *p)
        .map(|(i, _)| i)?;
    Some(tasks.remove(max_idx).1)
}

fn main() {
    let mut tasks = vec![
        (3, "low priority".to_string()),
        (10, "urgent".to_string()),
        (7, "medium priority".to_string()),
    ];
    // Repeated calls become O(n²) overall.
    while let Some(task) = top_priority_task(&mut tasks) {
        println!("running: {task}");
    }
}
```

## Good

```rust
use std::cmp::Reverse;
use std::collections::BinaryHeap;

#[derive(Eq, PartialEq, Ord, PartialOrd)]
struct Task {
    priority: u32, // higher = more urgent
    name: String,
}

fn run_scheduler(tasks: impl IntoIterator<Item = (u32, &'static str)>) {
    // BinaryHeap: O(log n) push and pop — max-priority task extracted first.
    let mut heap: BinaryHeap<Task> = tasks
        .into_iter()
        .map(|(priority, name)| Task {
            priority,
            name: name.to_string(),
        })
        .collect();

    while let Some(task) = heap.pop() {
        println!("running [priority={}]: {}", task.priority, task.name);
    }
}

fn top_k_largest(values: &[i32], k: usize) -> Vec<i32> {
    // Min-heap of size k using Reverse<i32>: keeps the k largest elements.
    let mut min_heap: BinaryHeap<Reverse<i32>> = BinaryHeap::with_capacity(k + 1);
    for &v in values {
        min_heap.push(Reverse(v));
        if min_heap.len() > k {
            min_heap.pop(); // discard the current minimum
        }
    }
    // Drain from min to max for a sorted result.
    let mut result: Vec<i32> = min_heap.into_iter().map(|Reverse(v)| v).collect();
    result.sort_unstable_by(|a, b| b.cmp(a));
    result
}

fn main() {
    run_scheduler([
        (3, "low priority task"),
        (10, "urgent task"),
        (7, "medium priority task"),
        (10, "equally urgent task"),
    ]);
    // Output order: urgent, equally urgent, medium, low

    let top3 = top_k_largest(&[4, 1, 9, 2, 7, 5, 8], 3);
    println!("top 3: {top3:?}"); // [9, 8, 7]
}
```

## Max-heap vs Min-heap at a glance

| Want | How |
|---|---|
| Largest item first (max-heap) | `BinaryHeap<T>` directly |
| Smallest item first (min-heap) | `BinaryHeap<Reverse<T>>` |
| Peek without removing | `.peek()` — O(1) |
| Drain in sorted order | `.into_sorted_vec()` — O(n log n) |

**Note:** `BinaryHeap` does not support efficient arbitrary removal or priority updates. If you need those, consider a third-party crate like `keyed_priority_queue` or restructure with lazy deletion.

## See Also

- [coll-seq-choice](coll-seq-choice.md) - choosing between `Vec`, `VecDeque`, and `LinkedList`
- [perf-iter-over-index](perf-iter-over-index.md) - prefer iterators over manual indexing when draining results
