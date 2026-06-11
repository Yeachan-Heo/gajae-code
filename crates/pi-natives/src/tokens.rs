//! Token counting via tiktoken-rs.
//!
//! Two encodings are exposed at the API level:
//!
//!   - `O200kBase` — GPT-4o / o1 / GPT-5 (the modern `OpenAI` default).
//!   - `Cl100kBase` — compatibility alias; routes to `o200k_base` in default
//!     builds (the cl100k BPE table is no longer embedded).
//!
//! `o200k_base` is the default. Anthropic doesn't publish their tokenizer, so
//! o200k is an approximation for Claude (within ~5–10% across English/code
//! text). It is closer to current frontier models' actual segmentation and is
//! the right default for budget estimates.
//!
//! Only the o200k BPE table is embedded in the binary; the encoder is built
//! once on first use and reused thereafter. Counting is exact for o200k only;
//! treat results as a model-family estimate elsewhere and keep conservative
//! reserve padding at context-changing decisions.

use std::sync::LazyLock;

use napi::bindgen_prelude::Either;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::{CoreBPE, o200k_base};

/// Tokenizer encoding to use.
#[napi(string_enum)]
pub enum Encoding {
	/// GPT-4o / o1 / GPT-5 (default).
	O200kBase,
	/// Compatibility alias: routes to `o200k_base` in default builds. The
	/// cl100k BPE table is not embedded; callers needing true cl100k counts
	/// must use an external tokenizer.
	Cl100kBase,
}

static O200K: LazyLock<CoreBPE> =
	LazyLock::new(|| o200k_base().expect("failed to initialize o200k_base BPE tables"));

fn encoder(encoding: Option<Encoding>) -> &'static CoreBPE {
	match encoding.unwrap_or(Encoding::O200kBase) {
		// Cl100kBase is a compatibility alias for o200k in default builds.
		Encoding::O200kBase | Encoding::Cl100kBase => &O200K,
	}
}

/// Count tokens in `input`.
///
/// `input` may be a single string or an array of strings; an array returns
/// the sum across all elements (encoded in parallel via rayon). Always
/// returns a single token total — use this for any aggregate budget question
/// without paying a per-element napi crossing.
///
/// Uses ordinary encoding (no special-token handling), which is the right
/// choice for measuring user/model content rather than wire-protocol tokens.
/// Always counts with `o200k_base` in default builds (`Cl100kBase` is a
/// compatibility alias). Exact for o200k only.
#[napi]
pub fn count_tokens(input: Either<String, Vec<String>>, encoding: Option<Encoding>) -> u32 {
	let bpe = encoder(encoding);
	match input {
		Either::A(text) => bpe.encode_ordinary(&text).len() as u32,
		Either::B(texts) => texts
			.par_iter()
			.map(|s| bpe.encode_ordinary(s).len() as u32)
			.sum(),
	}
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn counts_tokens_o200k() {
		let n = count_tokens(Either::A("hello world".to_string()), None);
		assert!(n >= 1 && n <= 4, "unexpected token count: {n}");
	}

	#[test]
	fn cl100k_aliases_to_o200k() {
		let text = "fn main() { println!(\"hello\"); } // 안녕하세요 world";
		let o200k = count_tokens(Either::A(text.to_string()), Some(Encoding::O200kBase));
		let cl100k = count_tokens(Either::A(text.to_string()), Some(Encoding::Cl100kBase));
		assert_eq!(o200k, cl100k, "Cl100kBase must route to the o200k encoder");
	}

	#[test]
	fn array_input_sums() {
		let parts = vec!["hello".to_string(), "world".to_string()];
		let sum = count_tokens(Either::B(parts.clone()), None);
		let manual: u32 = parts
			.iter()
			.map(|s| count_tokens(Either::A(s.clone()), None))
			.sum();
		assert_eq!(sum, manual);
	}
}
