# macro-proc-error-spans

> Report proc-macro errors as spanned compile errors, never by panicking

## Why It Matters

A `panic!`, `.unwrap()`, or `.expect()` inside a proc-macro produces an opaque compiler message — "proc macro panicked" — with no source location. The user sees no indication of which part of their code triggered the error. Returning a `syn::Error` converted to a token stream instead gives a diagnostic that points directly at the offending span, exactly like an ordinary compiler error.

## Bad

```rust
use proc_macro::TokenStream;
use syn::{parse_macro_input, Data, DeriveInput};

#[proc_macro_derive(MyTrait)]
pub fn derive_my_trait(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);

    let fields = match input.data {
        Data::Struct(ref s) => &s.fields,
        _ => panic!("MyTrait can only be derived on structs"), // WRONG
    };

    // `.unwrap()` here gives "called `Option::unwrap()` on a `None` value"
    // with no location info in user code.
    let first = fields.iter().next().unwrap();
    let name = first.ident.as_ref().unwrap();

    quote::quote! {
        impl MyTrait for #name {}
    }
    .into()
}
```

```text
error: proc macro panicked
  --> src/main.rs:3:10
   |
 3 | #[derive(MyTrait)]
   |          ^^^^^^^
   |
   = help: message: MyTrait can only be derived on structs
```

## Good

```rust
use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{parse_macro_input, spanned::Spanned, Data, DeriveInput, Error};

#[proc_macro_derive(MyTrait)]
pub fn derive_my_trait(input: TokenStream) -> TokenStream {
    derive_my_trait_inner(input).unwrap_or_else(|e| e.to_compile_error().into())
}

fn derive_my_trait_inner(input: TokenStream) -> Result<TokenStream, Error> {
    let input = parse_macro_input!(input as DeriveInput);

    let fields = match &input.data {
        Data::Struct(s) => &s.fields,
        Data::Enum(e) => {
            return Err(Error::new_spanned(
                &input.ident,
                "MyTrait can only be derived on structs, not enums",
            ));
        }
        Data::Union(u) => {
            return Err(Error::new_spanned(
                &input.ident,
                "MyTrait can only be derived on structs, not unions",
            ));
        }
    };

    let first = fields.iter().next().ok_or_else(|| {
        Error::new_spanned(&input.ident, "MyTrait requires at least one field")
    })?;

    let field_name = first.ident.as_ref().ok_or_else(|| {
        // Attach the error to the field's span, not the struct name.
        Error::new_spanned(first, "MyTrait requires named fields")
    })?;

    let struct_name = &input.ident;
    Ok(quote! {
        impl MyTrait for #struct_name {
            fn first_field_name() -> &'static str {
                stringify!(#field_name)
            }
        }
    }
    .into())
}
```

```text
error: MyTrait requires named fields
  --> src/main.rs:7:5
   |
 7 |     u8,   // tuple struct field
   |     ^^
```

## Key Points

- Wrap proc-macro logic in a `fn(...) -> Result<TokenStream2, syn::Error>` helper and convert at the entry point with `.unwrap_or_else(|e| e.to_compile_error().into())`.
- Use `Error::new_spanned(tokens, "message")` to attach the error to a specific part of the input AST.
- Use `Error::new(span, "message")` when you only have a `Span`, not a token.
- Combine multiple errors with `Error::combine` rather than returning early, so the user sees all problems at once.
- Error messages: lowercase, no trailing punctuation (consistent with Rust compiler style).

## See Also

- [macro-proc-syn-quote](macro-proc-syn-quote.md) - parsing with syn, quoting with quote
- [err-thiserror-lib](err-thiserror-lib.md) - idiomatic library error types
