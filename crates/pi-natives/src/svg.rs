// Vendored from oh-my-pi (MIT) crates/pi-natives/src/svg.rs @ a85bd5228d9f0f619deade1db78fa49420a721e1
// Local modifications: attribution header and fixture-based dimensions/SHA-256 tests only.
//! Safe SVG rasterization for terminal image previews.
//!
//! SVGs are parsed without loading file-backed image resources, capped to a
//! caller-provided canvas, and encoded as PNG for terminal graphics protocols.

use std::sync::{Arc, LazyLock};

use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use resvg::{tiny_skia, usvg};

use crate::task;

const MAX_RENDER_PIXELS: u64 = 16 * 1024 * 1024;

static FONT_DB: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
	let mut database = usvg::fontdb::Database::new();
	database.load_system_fonts();
	Arc::new(database)
});

/// Rasterize SVG/SVGZ bytes into a bounded PNG without resolving local files.
///
/// Conversion runs on the native blocking pool so parsing and rendering do not
/// stall the JavaScript event loop.
///
/// # Errors
/// Returns an error for invalid SVG data, zero/oversized limits, allocation
/// failure, or PNG encoding failure.
#[napi(js_name = "rasterizeSvg")]
pub fn rasterize_svg(
	input: Uint8Array,
	max_width_px: u32,
	max_height_px: u32,
) -> task::Promise<Uint8Array> {
	let input = input.to_vec();
	task::blocking("svg.rasterize", (), move |_| {
		rasterize_svg_sync(&input, max_width_px, max_height_px).map(Uint8Array::from)
	})
}

fn rasterize_svg_sync(input: &[u8], max_width_px: u32, max_height_px: u32) -> Result<Vec<u8>> {
	if max_width_px == 0 || max_height_px == 0 {
		return Err(napi::Error::from_reason("SVG render limits must be greater than zero"));
	}
	if u64::from(max_width_px) * u64::from(max_height_px) > MAX_RENDER_PIXELS {
		return Err(napi::Error::from_reason(format!(
			"SVG render limits exceed the {MAX_RENDER_PIXELS}-pixel safety cap"
		)));
	}

	let mut options = usvg::Options { fontdb: Arc::clone(&FONT_DB), ..usvg::Options::default() };
	// Repository-controlled SVGs must not read arbitrary host files through an
	// <image href="…"> reference. Embedded data URLs retain the default
	// resolver.
	options.image_href_resolver.resolve_string = Box::new(|_, _| None);
	let tree = usvg::Tree::from_data(input, &options)
		.map_err(|error| napi::Error::from_reason(format!("Failed to parse SVG: {error}")))?;
	let source = tree.size();
	let scale = (max_width_px as f32 / source.width())
		.min(max_height_px as f32 / source.height())
		.min(1.0);
	let width = (source.width() * scale).ceil().max(1.0) as u32;
	let height = (source.height() * scale).ceil().max(1.0) as u32;
	let mut pixmap = tiny_skia::Pixmap::new(width, height)
		.ok_or_else(|| napi::Error::from_reason("Failed to allocate SVG render surface"))?;
	resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
	pixmap
		.encode_png()
		.map_err(|error| napi::Error::from_reason(format!("Failed to encode SVG preview: {error}")))
}

#[cfg(test)]
mod tests {
	use sha2::{Digest, Sha256};

	use super::*;

	#[test]
	fn rasterizes_svg_at_intrinsic_size() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>"#;
		let png = rasterize_svg_sync(svg, 100, 100).expect("SVG should rasterize");
		let image = image::load_from_memory(&png).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (12, 7));
	}

	#[test]
	fn rasterizes_fixture_to_stable_png() {
		let svg = include_bytes!("../../../packages/natives/test/fixtures/svg/geometry.svg");
		let png = rasterize_svg_sync(svg, 2048, 2048).expect("fixture should rasterize");
		let image = image::load_from_memory(&png).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (17, 11));
		let hash = format!("{:x}", Sha256::digest(&png));
		assert_eq!(hash, "de47f937636d8b90e8a27cef076d772cf3e622a9bacd12f321630e78e6d3b528");
	}

	#[test]
	fn rejects_unbounded_render_surface() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>"#;
		let error = rasterize_svg_sync(svg, 8192, 8192).expect_err("oversized canvas should fail");
		assert!(error.reason.contains("safety cap"));
	}
}
