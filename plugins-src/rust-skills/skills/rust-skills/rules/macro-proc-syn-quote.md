# macro-proc-syn-quote

> Build procedural macros with `syn`, `quote`, and `proc-macro2`

## Why It Matters

Writing a proc-macro by hand-parsing `proc_macro::TokenStream` is fragile and verbose. The standard ecosystem trio — `syn` (parsing), `quote` (code generation), and `proc-macro2` (span-aware token types) — gives you a typed AST, readable quasi-quoting, and the ability to unit-test your macro logic outside the compiler.

Enable only the `syn` features you actually use. The `full` feature parses all Rust syntax but adds compile time; `derive` is sufficient for most `#[proc_macro_derive]` implementations.

## Bad

```rust
// Manually iterating tokens to find a struct name — brittle and hard to read.
use proc_macro::TokenStream;

#[proc_macro_derive(Hello)]
pub fn derive_hello(input: TokenStream) -> TokenStream {
    let mut iter = input.into_iter();
    // skip `struct`, grab the next ident... error-prone and breaks on generics
    iter.next(); // "struct"
    let name = iter.next().unwrap().to_string();
    format!("impl Hello for {name} {{ fn hello(&self) {{ println!(\"hello\"); }} }}")
        .parse()
        .unwrap()
}
```

## Good

```toml
# Cargo.toml for the derive crate
[dependencies]
syn  = { version = "2", features = ["derive"] }
quote = "1"
proc-macro2 = "1"
```

```rust
// src/lib.rs
use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::{quote, quote_spanned};
use syn::{parse_macro_input, spanned::Spanned, DeriveInput};

#[proc_macro_derive(Hello)]
pub fn derive_hello(input: TokenStream) -> TokenStream {
    // parse_macro_input! gives a typed DeriveInput or emits a compile error.
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();

    // quote! quasi-quotes Rust tokens; `#name` splices the identifier.
    let expanded = quote! {
        impl #impl_generics Hello for #name #ty_generics #where_clause {
            fn hello(&self) {
                println!("hello from {}", stringify!(#name));
            }
        }
    };

    expanded.into()
}
```

## Using `quote_spanned!` for Better Diagnostics

Attaching generated code to a meaningful span makes errors point at the right location in user code:

```rust
use syn::{spanned::Spanned, Field};
use quote::quote_spanned;

fn require_named_field(field: &Field) -> proc_macro2::TokenStream {
    let span = field.span();
    let name = field.ident.as_ref().expect("named field");

    // Any error from the generated code will point at the field declaration.
    quote_spanned! { span =>
        let _ = &self.#name; // generated access to prove the field exists
    }
}
```

## Unit Testing with `proc-macro2`

Because `proc-macro2::TokenStream` is usable outside the compiler, you can test generation logic in regular `#[test]` functions:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use quote::quote;
    use syn::parse_quote;

    #[test]
    fn generates_impl_for_unit_struct() {
        let input: DeriveInput = parse_quote! { struct Foo; };
        // Call the internal generation function (not the proc_macro entry point).
        let tokens = generate_hello_impl(&input);
        let code = tokens.to_string();
        assert!(code.contains("impl Hello for Foo"));
    }
}
```

## See Also

- [macro-proc-two-crate](macro-proc-two-crate.md) - separating proc-macro and facade crates
- [macro-proc-error-spans](macro-proc-error-spans.md) - reporting errors with spans, not panics
