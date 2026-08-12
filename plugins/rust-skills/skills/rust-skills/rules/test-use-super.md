# test-use-super

> Use `use super::*;` in test modules to access parent module items

## Why It Matters

The test module is a child of the module being tested. `use super::*` imports all items from the parent module, including private ones. This gives tests access to both public API and internal implementation details for thorough testing.

## Bad

```rust
// Verbose imports
#[cfg(test)]
mod tests {
    use crate::my_module::public_function;
    use crate::my_module::MyStruct;
    // Can't access private items this way!
    
    #[test]
    fn test_function() {
        let result = public_function();
        // ...
    }
}
```

## Good

```rust
// src/my_module.rs
pub struct PublicStruct { ... }
struct PrivateStruct { ... }  // Private

pub fn public_function() -> i32 { ... }
fn private_helper() -> i32 { ... }  // Private

#[cfg(test)]
mod tests {
    use super::*;  // Imports everything from parent
    
    #[test]
    fn test_public_struct() {
        let s = PublicStruct::new();
        // ...
    }
    
    #[test]
    fn test_private_struct() {
        let s = PrivateStruct::new();  // Can access private!
        // ...
    }
    
    #[test]
    fn test_private_helper() {
        assert_eq!(private_helper(), 42);  // Can test private!
    }
}
```

## Selective Imports

```rust
#[cfg(test)]
mod tests {
    // When you want to be explicit
    use super::{parse, ParseError, Token};
    
    // Or import all plus test utilities
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    
    #[test]
    fn test_parse() { ... }
}
```

## Nested Modules

```rust
mod outer {
    pub fn outer_fn() -> i32 { 1 }
    
    mod inner {
        pub fn inner_fn() -> i32 { 2 }
        
        #[cfg(test)]
        mod tests {
            use super::*;           // Gets inner's items
            use super::super::*;    // Gets outer's items
            
            #[test]
            fn test_inner() {
                assert_eq!(inner_fn(), 2);
                assert_eq!(outer_fn(), 1);
            }
        }
    }
}
```

## With External Dependencies

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    // Test-only dependencies
    use proptest::prelude::*;
    use mockall::predicate::*;
    
    proptest! {
        #[test]
        fn test_property(s: String) {
            let result = process(&s);
            prop_assert!(result.is_ok());
        }
    }
}
```

## See Also

- [test-cfg-test-module](./test-cfg-test-module.md) - Test module structure
- [test-integration-dir](./test-integration-dir.md) - Integration tests
- [proj-pub-crate-internal](./proj-pub-crate-internal.md) - Visibility modifiers
