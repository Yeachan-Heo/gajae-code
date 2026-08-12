# conv-asmut-mutable

> Accept `impl AsMut<T>` for flexible mutable borrowed inputs instead of concrete mutable references

## Why It Matters

`AsMut<T>` is the mutable mirror of `AsRef<T>`. Accepting `impl AsMut<[u8]>` instead of `&mut Vec<u8>` lets callers pass `&mut Vec<u8>`, `&mut [u8]`, or `&mut [u8; N]` arrays without any conversion overhead. This widens the function's usefulness without changing its implementation or runtime cost. Reserve it for genuinely generic write targets — not every `&mut T` parameter needs this treatment.

## Bad

```rust
// Only accepts &mut Vec<u8>; arrays and slices are excluded
fn fill_zeros(buf: &mut Vec<u8>) {
    for b in buf.iter_mut() {
        *b = 0;
    }
}

fn main() {
    let mut data = vec![1u8, 2, 3];
    fill_zeros(&mut data);

    // Compile error — cannot pass &mut [u8; 3] or &mut [u8]
    // let mut arr = [1u8, 2, 3];
    // fill_zeros(&mut arr);
}
```

## Good

```rust
// Accepts Vec<u8>, [u8; N], &mut [u8] — any type that lends &mut [u8]
fn fill_zeros(mut buf: impl AsMut<[u8]>) {
    for b in buf.as_mut().iter_mut() {
        *b = 0;
    }
}

fn verify(mut buf: impl AsMut<[u8]>) -> bool {
    buf.as_mut().iter().all(|&b| b == 0)
}

fn main() {
    let mut vec_buf = vec![1u8, 2, 3];
    fill_zeros(&mut vec_buf);
    assert!(verify(&mut vec_buf));

    let mut arr_buf = [1u8, 2, 3, 4];
    fill_zeros(&mut arr_buf);
    assert!(verify(&mut arr_buf));

    let mut slice_buf = [5u8, 6, 7];
    fill_zeros(slice_buf.as_mut());
    assert!(verify(slice_buf.as_mut()));
}
```

## When Not to Use

- If the function only ever receives `&mut SomeConcreteType`, keep the concrete type — generics add compile time and cognitive overhead for no gain.
- Avoid combining `AsMut` with `AsRef` on the same parameter unless the API genuinely needs both read and write access.
- Don't use `AsMut` as a substitute for a trait that captures domain semantics; name the abstraction properly.

## See Also

- [api-impl-asref](api-impl-asref.md) - the read-only counterpart for borrowed inputs
- [own-slice-over-vec](own-slice-over-vec.md) - prefer `&[T]` over `&Vec<T>` for immutable slices
