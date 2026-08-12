# type-repr-transparent

> Use `#[repr(transparent)]` for newtypes in FFI contexts

## Why It Matters

`#[repr(transparent)]` guarantees a newtype has the same memory layout as its inner type. This is essential for FFI where you need type safety in Rust but must match C ABI layouts. Without it, the compiler may add padding or change layout.

## Bad

```rust
// No layout guarantee - might not match inner type in FFI
struct Handle(u64);

// Passing to C code might fail
extern "C" {
    fn process_handle(h: Handle);  // May not work correctly
}

// Wrapping C type without layout guarantee
struct SafePointer(*mut c_void);
```

## Good

```rust
// Guaranteed same layout as inner type
#[repr(transparent)]
struct Handle(u64);

// Safe for FFI
extern "C" {
    fn process_handle(h: Handle);  // Works - same layout as u64
}

// FFI pointer wrapper
#[repr(transparent)]
struct SafePointer(*mut c_void);

impl SafePointer {
    // Safe Rust API around raw pointer
    pub fn new(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(SafePointer(ptr))
        }
    }
}
```

## What repr(transparent) Guarantees

```rust
use std::mem::{size_of, align_of};

#[repr(transparent)]
struct Meters(f64);

// Same size
assert_eq!(size_of::<Meters>(), size_of::<f64>());

// Same alignment
assert_eq!(align_of::<Meters>(), align_of::<f64>());

// Same ABI - can pass where f64 expected
extern "C" fn measure(distance: Meters) { ... }
```

## With PhantomData

```rust
use std::marker::PhantomData;

// PhantomData is zero-sized, doesn't affect layout
#[repr(transparent)]
struct TypedHandle<T> {
    raw: u64,
    _marker: PhantomData<T>,  // Zero-sized, ignored for layout
}

// Still same layout as u64
assert_eq!(size_of::<TypedHandle<String>>(), size_of::<u64>());
```

## NonZero Wrappers

```rust
use std::num::NonZeroU64;

#[repr(transparent)]
struct NonZeroHandle(NonZeroU64);

// Inherits null-pointer optimization
assert_eq!(size_of::<Option<NonZeroHandle>>(), size_of::<u64>());
```

## FFI Pattern

```rust
mod ffi {
    use std::os::raw::c_int;
    
    #[repr(transparent)]
    pub struct FileDescriptor(c_int);
    
    extern "C" {
        pub fn open(path: *const i8, flags: c_int) -> FileDescriptor;
        pub fn close(fd: FileDescriptor) -> c_int;
        pub fn read(fd: FileDescriptor, buf: *mut u8, len: usize) -> isize;
    }
}

// Safe wrapper
pub struct File {
    fd: ffi::FileDescriptor,
}

impl File {
    pub fn open(path: &str) -> std::io::Result<Self> {
        let c_path = std::ffi::CString::new(path)?;
        let fd = unsafe { ffi::open(c_path.as_ptr(), 0) };
        // ... error handling
        Ok(File { fd })
    }
}
```

## When to Use

| Scenario | Use `#[repr(transparent)]`? |
|----------|----------------------------|
| FFI newtype wrappers | Yes |
| Type-safe handles | Yes |
| NonZero optimization | Yes |
| Pure Rust newtypes | Optional (doesn't hurt) |
| Multi-field structs | N/A (only for single-field) |

## See Also

- [type-newtype-ids](./type-newtype-ids.md) - Newtype pattern
- [type-phantom-marker](./type-phantom-marker.md) - PhantomData usage
- [api-newtype-safety](./api-newtype-safety.md) - Type-safe newtypes
