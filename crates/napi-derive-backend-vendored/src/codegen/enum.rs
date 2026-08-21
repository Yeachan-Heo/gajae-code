use proc_macro2::{Ident, Literal, Span, TokenStream};
use quote::ToTokens;

use crate::{BindgenResult, NapiEnum, TryToTokens, codegen::js_mod_to_token_stream};

impl TryToTokens for NapiEnum {
	fn try_to_tokens(&self, tokens: &mut TokenStream) -> BindgenResult<()> {
		let register = self.gen_module_register();
		let napi_value_conversion = self.gen_napi_value_map_impl();

		(quote! {
		  #napi_value_conversion
		  #register
		})
		.to_tokens(tokens);

		Ok(())
	}
}

impl NapiEnum {
	fn gen_napi_value_map_impl(&self) -> TokenStream {
		let name = &self.name;
		let name_str = self.name.to_string();
		let mut from_napi_branches = vec![];
		let mut to_napi_branches = vec![];

		self.variants.iter().for_each(|v| {
			let val: Literal = (&v.val).into();
			let v_name = &v.name;

			from_napi_branches.push(quote! { #val => Ok(#name::#v_name) });
			to_napi_branches.push(quote! { #name::#v_name => #val });
		});

		let validate_type = if self.is_string_enum {
			quote! { napi::bindgen_prelude::ValueType::String }
		} else {
			quote! { napi::bindgen_prelude::ValueType::Number }
		};

		let from_napi_value = self.gen_from_napi_value(name, from_napi_branches);
		let to_napi_value = self.gen_to_napi_value(name, to_napi_branches);
		quote! {
		  impl napi::bindgen_prelude::TypeName for #name {
			 fn type_name() -> &'static str {
				#name_str
			 }

			 fn value_type() -> napi::ValueType {
				#validate_type
			 }
		  }

		  impl napi::bindgen_prelude::ValidateNapiValue for #name {
			 unsafe fn validate(
				env: napi::bindgen_prelude::sys::napi_env,
				napi_val: napi::bindgen_prelude::sys::napi_value
			 ) -> napi::bindgen_prelude::Result<napi::sys::napi_value> {
				napi::bindgen_prelude::assert_type_of!(env, napi_val, #validate_type)?;
				Ok(std::ptr::null_mut())
			 }
		  }

		  #from_napi_value

		  #to_napi_value
		}
	}

	fn gen_from_napi_value(
		&self,
		name: &Ident,
		from_napi_branches: Vec<TokenStream>,
	) -> TokenStream {
		if !self.object_from_js {
			return quote! {};
		}

		let name_str = self.name.to_string();
		if self.variants.is_empty() {
			return quote! {
			  impl napi::bindgen_prelude::FromNapiValue for #name {
				 unsafe fn from_napi_value(
					env: napi::bindgen_prelude::sys::napi_env,
					napi_val: napi::bindgen_prelude::sys::napi_value
				 ) -> napi::bindgen_prelude::Result<Self> {
					Err(napi::bindgen_prelude::error!(
					  napi::bindgen_prelude::Status::InvalidArg,
					  "enum `{}` has no variants",
					  #name_str
					))
				 }
			  }
			};
		}

		let from_napi_value = if self.is_string_enum {
			quote! {
			  let val: String = napi::bindgen_prelude::FromNapiValue::from_napi_value(env, napi_val)
			}
		} else {
			quote! {
			  let val = napi::bindgen_prelude::FromNapiValue::from_napi_value(env, napi_val)
			}
		};
		let match_val = if self.is_string_enum {
			quote! { val.as_str() }
		} else {
			quote! { val }
		};
		quote! {
		  impl napi::bindgen_prelude::FromNapiValue for #name {
			 unsafe fn from_napi_value(
				env: napi::bindgen_prelude::sys::napi_env,
				napi_val: napi::bindgen_prelude::sys::napi_value
			 ) -> napi::bindgen_prelude::Result<Self> {
				#from_napi_value.map_err(|e| {
				  napi::bindgen_prelude::error!(
					 e.status,
					 "Failed to convert napi value into enum `{}`. {}",
					 #name_str,
					 e,
				  )
				})?;

				match #match_val {
				  #(#from_napi_branches,)*
				  _ => {
					 Err(napi::bindgen_prelude::error!(
						napi::bindgen_prelude::Status::InvalidArg,
						"value `{:?}` does not match any variant of enum `{}`",
						val,
						#name_str
					 ))
				  }
				}
			 }
		  }
		}
	}

	fn gen_to_napi_value(&self, name: &Ident, to_napi_branches: Vec<TokenStream>) -> TokenStream {
		if !self.object_to_js {
			return quote! {};
		}

		if self.variants.is_empty() {
			return quote! {
			  impl napi::bindgen_prelude::ToNapiValue for #name {
				 unsafe fn to_napi_value(
					env: napi::bindgen_prelude::sys::napi_env,
					val: Self
				 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
					napi::bindgen_prelude::ToNapiValue::to_napi_value(env, ())
				 }
			  }

			  impl napi::bindgen_prelude::ToNapiValue for &#name {
				 unsafe fn to_napi_value(
					env: napi::bindgen_prelude::sys::napi_env,
					val: Self
				 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
					napi::bindgen_prelude::ToNapiValue::to_napi_value(env, ())
				 }
			  }

			  impl napi::bindgen_prelude::ToNapiValue for &mut #name {
				 unsafe fn to_napi_value(
					env: napi::bindgen_prelude::sys::napi_env,
					val: Self
				 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
					napi::bindgen_prelude::ToNapiValue::to_napi_value(env, ())
				 }
			  }
			};
		}

		quote! {
		  impl napi::bindgen_prelude::ToNapiValue for #name {
			 unsafe fn to_napi_value(
				env: napi::bindgen_prelude::sys::napi_env,
				val: Self
			 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
				let val = match val {
				  #(#to_napi_branches,)*
				};

				napi::bindgen_prelude::ToNapiValue::to_napi_value(env, val)
			 }
		  }

		  impl napi::bindgen_prelude::ToNapiValue for &#name {
			 unsafe fn to_napi_value(
				env: napi::bindgen_prelude::sys::napi_env,
				val: Self
			 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
				let val = match val {
				  #(#to_napi_branches,)*
				};

				napi::bindgen_prelude::ToNapiValue::to_napi_value(env, val)
			 }
		  }

		  impl napi::bindgen_prelude::ToNapiValue for &mut #name {
			 unsafe fn to_napi_value(
				env: napi::bindgen_prelude::sys::napi_env,
				val: Self
			 ) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
				let val = match val {
				  #(#to_napi_branches,)*
				};

				napi::bindgen_prelude::ToNapiValue::to_napi_value(env, val)
			 }
		  }
		}
	}

	fn gen_module_register(&self) -> TokenStream {
		if cfg!(test) {
			return quote! {};
		}

		let name_str = self.name.to_string();
		let js_name_lit = Literal::string(&format!("{}\0", &self.js_name));
		let register_name = &self.register_name;

		let mut value_conversions = vec![];
		let mut property_descriptors = vec![];
		let mut value_names = vec![];

		for (idx, variant) in self.variants.iter().enumerate() {
			let name_lit = Literal::string(&format!("{}\0", variant.name));
			let val_lit: Literal = (&variant.val).into();
			let value_var = Ident::new(&format!("__enum_value_{}", idx), Span::call_site());

			value_names.push(value_var.clone());

			// Convert the value first
			value_conversions.push(quote! {
			  let #value_var = napi::bindgen_prelude::ToNapiValue::to_napi_value(env, #val_lit)?;
			});

			// Create property descriptor using the pre-computed value
			property_descriptors.push(quote! {
			  napi::bindgen_prelude::sys::napi_property_descriptor {
				 utf8name: std::ffi::CStr::from_bytes_with_nul_unchecked(#name_lit.as_bytes()).as_ptr(),
				 name: std::ptr::null_mut(),
				 method: None,
				 getter: None,
				 setter: None,
				 value: #value_var,
				 attributes: napi::bindgen_prelude::sys::PropertyAttributes::default,
				 data: std::ptr::null_mut(),
			  }
			});
		}

		let callback_name =
			Ident::new(&format!("__register__enum__{name_str}_callback__"), Span::call_site());

		let js_mod_ident = js_mod_to_token_stream(self.js_mod.as_ref());

		let object_creation = quote! {
		  // Convert all values first, so error handling works correctly
		  #(#value_conversions)*

		  let properties = [
			 #(#property_descriptors),*
		  ];

		  let obj_ptr = napi::bindgen_prelude::create_object_with_properties(env, &properties)?;
		};

		quote! {
		  #[allow(non_snake_case)]
		  #[allow(clippy::all)]
		  unsafe fn #callback_name(env: napi::bindgen_prelude::sys::napi_env) -> napi::bindgen_prelude::Result<napi::bindgen_prelude::sys::napi_value> {
			 use std::ffi::CString;
			 use std::ptr;

			 #object_creation

			 Ok(obj_ptr)
		  }
		  #[cfg(all(not(test), not(target_family = "wasm")))]
		  napi::ctor::declarative::ctor! {
			 #[allow(non_snake_case)]
			 #[allow(clippy::all)]
			 #[ctor(unsafe)]
			 fn #register_name() {
				napi::bindgen_prelude::register_module_export(#js_mod_ident, #js_name_lit, #callback_name);
			 }
		  }
		  #[allow(non_snake_case)]
		  #[allow(clippy::all)]
		  #[cfg(all(not(test), target_family = "wasm"))]
		  #[no_mangle]
		  extern "C" fn #register_name() {
			 napi::bindgen_prelude::register_module_export(#js_mod_ident, #js_name_lit, #callback_name);
		  }
		}
	}
}

#[cfg(test)]
mod tests {
	use proc_macro2::Span;
	use syn::Ident;

	use crate::{NapiEnum, NapiEnumValue, NapiEnumVariant};

	fn enum_for(is_string_enum: bool) -> NapiEnum {
		let (a, b) = if is_string_enum {
			(NapiEnumValue::String("a".to_string()), NapiEnumValue::String("b".to_string()))
		} else {
			(NapiEnumValue::Number(1), NapiEnumValue::Number(2))
		};
		NapiEnum {
			name: Ident::new("TestEnum", Span::call_site()),
			js_name: "TestEnum".to_string(),
			variants: vec![
				NapiEnumVariant {
					name:     Ident::new("A", Span::call_site()),
					val:      a,
					comments: vec![],
				},
				NapiEnumVariant {
					name:     Ident::new("B", Span::call_site()),
					val:      b,
					comments: vec![],
				},
			],
			js_mod: None,
			comments: vec![],
			skip_typescript: false,
			register_name: Ident::new("TestEnum", Span::call_site()),
			is_string_enum,
			object_from_js: true,
			object_to_js: true,
		}
	}

	fn rendered(is_string_enum: bool) -> String {
		enum_for(is_string_enum)
			.gen_napi_value_map_impl()
			.to_string()
	}

	#[test]
	fn string_enum_value_type_reports_string() {
		let tokens = rendered(true);
		assert!(tokens.contains("value_type"), "TypeName impl must define value_type: {tokens}");
		assert!(
			tokens.contains("bindgen_prelude :: ValueType :: String"),
			"string enum value_type must report String, got: {tokens}"
		);
	}

	#[test]
	fn numeric_enum_value_type_reports_number() {
		let tokens = rendered(false);
		assert!(tokens.contains("value_type"), "TypeName impl must define value_type: {tokens}");
		assert!(
			tokens.contains("bindgen_prelude :: ValueType :: Number"),
			"numeric enum value_type must report Number, got: {tokens}"
		);
	}

	#[test]
	fn enum_metadata_never_contradicts_validation() {
		for is_string_enum in [true, false] {
			let tokens = rendered(is_string_enum);
			let primitive = if is_string_enum { "String" } else { "Number" };
			assert!(
				!tokens.contains("ValueType :: Object"),
				"enum type metadata must never claim Object while values are primitives: {tokens}"
			);
			let value_type_at = tokens.find("value_type").expect("value_type present");
			let assert_at = tokens
				.find("assert_type_of")
				.expect("assert_type_of present");
			assert!(
				tokens[value_type_at..].contains(primitive),
				"value_type must report {primitive}: {tokens}"
			);
			assert!(
				tokens[assert_at..].contains(primitive),
				"validate must assert {primitive}: {tokens}"
			);
		}
	}
}
