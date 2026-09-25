// Vendored from oh-my-pi (MIT) crates/pi-natives/src/html.rs @ a85bd5228d9f0f619deade1db78fa49420a721e1
// Local modifications: convert JsString with a private helper until crate::js is available; preserve existing task and converter behavior.

//! HTML to Markdown conversion.

use html_to_markdown_rs::{
	ConversionOptions, PreprocessingOptions, PreprocessingPreset, WarningKind, convert,
};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::task;

fn html_to_rust_string(html: JsString) -> Result<String> {
	html
		.into_utf8()
		.and_then(|value| value.as_str().map(str::to_owned))
}

/// Options for HTML to Markdown conversion.
#[napi(object)]
#[derive(Debug, Default)]
pub struct HtmlToMarkdownOptions {
	/// Remove navigation elements, forms, headers, footers.
	pub clean_content: Option<bool>,
	/// Skip images during conversion.
	pub skip_images:   Option<bool>,
}

/// Convert HTML source to Markdown with optional preprocessing.
///
/// # Errors
/// Returns an error if the conversion fails or the worker task aborts.
#[napi]
pub fn html_to_markdown(
	html: JsString,
	options: Option<HtmlToMarkdownOptions>,
) -> Result<task::Promise<String>> {
	let html = html_to_rust_string(html)?;
	let options = options.unwrap_or_default();
	let clean_content = options.clean_content.unwrap_or(false);
	let skip_images = options.skip_images.unwrap_or(false);

	Ok(task::blocking("html_to_markdown", (), move |_| {
		let conversion_opts = ConversionOptions {
			skip_images,
			preprocessing: PreprocessingOptions {
				enabled:           clean_content,
				preset:            PreprocessingPreset::Aggressive,
				remove_navigation: true,
				remove_forms:      true,
			},
			tier_strategy: html_to_markdown_rs::TierStrategy::Tier2,
			..Default::default()
		};

		let result = convert(html.as_str(), Some(conversion_opts))
			.map_err(|err| Error::from_reason(format!("Conversion error: {err}")))?;
		if let Some(warning) = result
			.warnings
			.iter()
			.find(|warning| warning.kind == WarningKind::DepthLimitExceeded)
		{
			return Err(Error::from_reason(format!("Conversion error: {}", warning.message)));
		}
		Ok(result.content.unwrap_or_default())
	}))
}
