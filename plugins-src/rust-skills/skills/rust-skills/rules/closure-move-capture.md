# closure-move-capture

> Use `move` for closures that outlive the current scope; clone before `move` to keep the original

## Why It Matters

A closure that borrows its environment can only live as long as that environment. When a closure escapes — passed to a new thread, stored in a struct, or returned from a function — it must own its captures and typically must be `'static`. The `move` keyword transfers ownership of every captured variable into the closure. If you need the value in both the closure and the surrounding code, clone it first and move the clone.

## Bad

```rust
fn make_greeter_bad(name: String) -> impl Fn() {
    // `name` is borrowed, but the closure outlives the function frame —
    // the compiler rejects this with a lifetime error.
    // || println!("hello, {name}")  // error: `name` does not live long enough
    move || println!("hello, {name}") // must be move — shown here to illustrate the fix
}

fn spawn_bad() {
    let data = vec![1, 2, 3];
    // Borrowing `data` across a thread boundary is rejected:
    // std::thread::spawn(|| println!("{data:?}")); // error: borrowed value does not live long enough
    let _ = data; // suppress unused warning
}
```

## Good

```rust
fn process(data: &[i32]) -> i32 {
    data.iter().sum()
}

// Return a closure that owns its capture via `move`.
fn make_greeter(name: String) -> impl Fn() {
    move || println!("hello, {name}")
}

// Clone before `move` when you need the value in both places.
fn spawn_and_keep(data: Vec<i32>) -> std::thread::JoinHandle<i32> {
    let data_for_thread = data.clone(); // clone goes into the closure
    let handle = std::thread::spawn(move || process(&data_for_thread));
    // `data` is still available here
    println!("original still owned: {data:?}");
    handle
}

fn demo() {
    let greet = make_greeter(String::from("world"));
    greet(); // prints: hello, world

    let nums = vec![10, 20, 30];
    let handle = spawn_and_keep(nums);
    let sum = handle.join().unwrap();
    assert_eq!(sum, 60);
}
```

## Key Points

- **Thread closures** passed to `std::thread::spawn` must be `'static`, which `move` enables when all captured types are `'static + Send`.
- **Clone selectively:** clone only what the closure needs, not the whole owning struct — see [closure-disjoint-capture](closure-disjoint-capture.md).
- **Async tasks** follow the same rule: `tokio::spawn(async move { … })` takes ownership; clone shared data before the `async move` block.
- A `move` closure can still implement `Fn` or `FnMut` — `move` only controls *how* captures are taken, not how many times the closure can be called.

## See Also

- [async-clone-before-await](async-clone-before-await.md) - clone data before async move blocks
- [own-move-large](own-move-large.md) - move large data instead of cloning
- [closure-disjoint-capture](closure-disjoint-capture.md) - capture only the fields you use
