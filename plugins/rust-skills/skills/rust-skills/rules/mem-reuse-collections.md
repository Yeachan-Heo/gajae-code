# mem-reuse-collections

> Clear and reuse collections instead of creating new ones in loops

## Why It Matters

Creating new `Vec`, `String`, or `HashMap` instances in hot loops generates significant allocator pressure. Clearing a collection and reusing it keeps the existing capacity, avoiding repeated allocation/deallocation cycles. This is especially impactful for frequently-executed code paths.

## Bad

```rust
fn process_batches(batches: &[Batch]) -> Vec<Result> {
    let mut results = Vec::new();
    
    for batch in batches {
        let mut temp = Vec::new();  // Allocates every iteration
        
        for item in &batch.items {
            temp.push(transform(item));
        }
        
        results.push(aggregate(&temp));
        // temp dropped here, deallocation
    }
    
    results
}

fn format_lines(items: &[Item]) -> String {
    let mut output = String::new();
    
    for item in items {
        let line = format!("{}: {}", item.name, item.value);  // Allocates
        output.push_str(&line);
        output.push('\n');
    }
    
    output
}
```

## Good

```rust
fn process_batches(batches: &[Batch]) -> Vec<Result> {
    let mut results = Vec::with_capacity(batches.len());
    let mut temp = Vec::new();  // Allocate once outside loop
    
    for batch in batches {
        temp.clear();  // Reuse allocation, just reset length
        
        for item in &batch.items {
            temp.push(transform(item));
        }
        
        results.push(aggregate(&temp));
        // temp keeps its capacity for next iteration
    }
    
    results
}

fn format_lines(items: &[Item]) -> String {
    use std::fmt::Write;
    
    let mut output = String::new();
    let mut line = String::new();  // Reusable buffer
    
    for item in items {
        line.clear();
        write!(&mut line, "{}: {}", item.name, item.value).unwrap();
        output.push_str(&line);
        output.push('\n');
    }
    
    output
}
```

## Clear vs Drain vs New

```rust
let mut vec = vec![1, 2, 3, 4, 5];

// clear(): keeps capacity, O(n) for Drop types
vec.clear();
assert_eq!(vec.len(), 0);
assert!(vec.capacity() >= 5);

// drain(): returns iterator, clears after iteration
let drained: Vec<_> = vec.drain(..).collect();

// truncate(): keeps first n elements
vec.truncate(2);

// Creating new: loses all capacity
vec = Vec::new();  // Capacity gone
```

## HashMap Reuse

```rust
use std::collections::HashMap;

fn count_words_per_line(lines: &[&str]) -> Vec<HashMap<String, usize>> {
    let mut results = Vec::with_capacity(lines.len());
    let mut counts = HashMap::new();  // Reuse across iterations
    
    for line in lines {
        counts.clear();  // Keeps bucket allocation
        
        for word in line.split_whitespace() {
            *counts.entry(word.to_string()).or_insert(0) += 1;
        }
        
        results.push(counts.clone());
    }
    
    results
}
```

## BufWriter Pattern

```rust
use std::io::{BufWriter, Write};

fn write_many_records(records: &[Record], mut output: impl Write) -> std::io::Result<()> {
    // BufWriter reuses its internal buffer
    let mut writer = BufWriter::with_capacity(8192, &mut output);
    let mut line = String::with_capacity(256);  // Reusable formatting buffer
    
    for record in records {
        line.clear();
        format_record(record, &mut line);
        writer.write_all(line.as_bytes())?;
        writer.write_all(b"\n")?;
    }
    
    writer.flush()
}
```

## When to Create Fresh

```rust
// When ownership transfer is needed
fn produce_results() -> Vec<Vec<Item>> {
    let mut results = Vec::new();
    
    for batch in batches {
        let processed: Vec<Item> = batch.process();  // Ownership transferred
        results.push(processed);  // Moved into results
    }
    
    results  // Each inner Vec is independent
}

// When thread safety requires it
std::thread::scope(|s| {
    for _ in 0..4 {
        s.spawn(|| {
            let local_buffer = Vec::new();  // Thread-local, can't share
            // ...
        });
    }
});
```

## See Also

- [mem-with-capacity](./mem-with-capacity.md) - Pre-allocating capacity
- [mem-clone-from](./mem-clone-from.md) - Reusing allocations when cloning
- [mem-write-over-format](./mem-write-over-format.md) - Avoiding format! allocations
