// Vendored from oh-my-pi (MIT) crates/pi-natives/src/svg.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Local modifications: bounded SVGZ
// handling, image/DTD preflight, cell-aligned output, and fixture tests.
//! Safe SVG rasterization for terminal image previews.
//!
//! SVGs are parsed without loading file-backed image resources, capped to a
//! caller-provided canvas, and encoded as PNG for terminal graphics protocols.

use std::{
	io::Read,
	sync::{Arc, LazyLock},
};

use flate2::read::GzDecoder;
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use resvg::{tiny_skia, usvg};

use crate::task;

const MAX_RENDER_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_SVG_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_SVG_ELEMENTS: usize = 20_000;
const MAX_SVG_NESTING_DEPTH: usize = 256;
const MAX_SVG_ATTRIBUTES_PER_ELEMENT: usize = 64;

static FONT_DB: LazyLock<Arc<usvg::fontdb::Database>> = LazyLock::new(|| {
	let mut database = usvg::fontdb::Database::new();
	database.load_system_fonts();
	Arc::new(database)
});

/// Rasterize bounded SVG/SVGZ bytes into a PNG without resolving local files.
///
/// DTD/entity declarations and SVG image elements are rejected rather than
/// allowing unbounded expansion or silently returning an incomplete preview.
///
/// Conversion runs on the native blocking pool so parsing and rendering do not
/// stall the JavaScript event loop.
///
/// When both cell dimensions are provided, the PNG is padded on a transparent
/// canvas to whole terminal cells without embedding or decoding another image.
///
/// # Errors
/// Returns an error for invalid SVG data, mismatched/zero cell dimensions,
/// zero/oversized limits, allocation failure, or PNG encoding failure.
#[napi(js_name = "rasterizeSvg")]
pub fn rasterize_svg(
	input: Uint8Array,
	max_width_px: u32,
	max_height_px: u32,
	cell_width_px: Option<u32>,
	cell_height_px: Option<u32>,
) -> task::Promise<Uint8Array> {
	if input.len() > MAX_SVG_SOURCE_BYTES {
		return task::blocking("svg.rasterize", (), |_| {
			Err(napi::Error::from_reason(format!(
				"SVG source exceeds the {MAX_SVG_SOURCE_BYTES}-byte limit"
			)))
		});
	}
	let input = input.to_vec();
	task::blocking("svg.rasterize", (), move |_| {
		rasterize_svg_sync_with_cells(
			&input,
			max_width_px,
			max_height_px,
			cell_width_px,
			cell_height_px,
		)
		.map(Uint8Array::from)
	})
}

#[cfg(test)]
fn rasterize_svg_sync(input: &[u8], max_width_px: u32, max_height_px: u32) -> Result<Vec<u8>> {
	rasterize_svg_sync_with_cells(input, max_width_px, max_height_px, None, None)
}

fn rasterize_svg_sync_with_cells(
	input: &[u8],
	max_width_px: u32,
	max_height_px: u32,
	cell_width_px: Option<u32>,
	cell_height_px: Option<u32>,
) -> Result<Vec<u8>> {
	if max_width_px == 0 || max_height_px == 0 {
		return Err(napi::Error::from_reason("SVG render limits must be greater than zero"));
	}
	if u64::from(max_width_px) * u64::from(max_height_px) > MAX_RENDER_PIXELS {
		return Err(napi::Error::from_reason(format!(
			"SVG render limits exceed the {MAX_RENDER_PIXELS}-pixel safety cap"
		)));
	}
	let cell_size = match (cell_width_px, cell_height_px) {
		(None, None) => None,
		(Some(width), Some(height)) if width > 0 && height > 0 => Some((width, height)),
		_ => {
			return Err(napi::Error::from_reason(
				"SVG cell dimensions must both be greater than zero",
			));
		},
	};
	let decompressed = decompress_svgz_bounded(input)?;
	let svg = decompressed.as_deref().unwrap_or(input);
	validate_svg_source(svg)?;

	let mut options = usvg::Options { fontdb: Arc::clone(&FONT_DB), ..usvg::Options::default() };
	// Image elements are rejected by preflight so previews cannot silently omit
	// their authored content. Keep both resolvers disabled as defense in depth.
	options.image_href_resolver.resolve_string = Box::new(|_, _| None);
	options.image_href_resolver.resolve_data = Box::new(|_, _, _| None);
	let tree = usvg::Tree::from_data(svg, &options)
		.map_err(|error| napi::Error::from_reason(format!("Failed to parse SVG: {error}")))?;
	let source = tree.size();
	let scale = (max_width_px as f32 / source.width())
		.min(max_height_px as f32 / source.height())
		.min(1.0);
	let content_width = ((source.width() * scale).ceil().max(1.0) as u32).min(max_width_px);
	let content_height = ((source.height() * scale).ceil().max(1.0) as u32).min(max_height_px);
	let (width, height) = if let Some((cell_width, cell_height)) = cell_size {
		let width = content_width
			.div_ceil(cell_width)
			.checked_mul(cell_width)
			.ok_or_else(|| napi::Error::from_reason("Padded SVG width exceeds the render limit"))?;
		let height = content_height
			.div_ceil(cell_height)
			.checked_mul(cell_height)
			.ok_or_else(|| napi::Error::from_reason("Padded SVG height exceeds the render limit"))?;
		if width > max_width_px || height > max_height_px {
			return Err(napi::Error::from_reason("Padded SVG canvas exceeds the render limits"));
		}
		(width, height)
	} else {
		(content_width, content_height)
	};
	if u64::from(width) * u64::from(height) > MAX_RENDER_PIXELS {
		return Err(napi::Error::from_reason(format!(
			"SVG render limits exceed the {MAX_RENDER_PIXELS}-pixel safety cap"
		)));
	}
	let mut pixmap = tiny_skia::Pixmap::new(width, height)
		.ok_or_else(|| napi::Error::from_reason("Failed to allocate SVG render surface"))?;
	let x = (width - content_width) / 2;
	let y = (height - content_height) / 2;
	let transform = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, x as f32, y as f32);
	resvg::render(&tree, transform, &mut pixmap.as_mut());
	pixmap
		.encode_png()
		.map_err(|error| napi::Error::from_reason(format!("Failed to encode SVG preview: {error}")))
}

fn decompress_svgz_bounded(input: &[u8]) -> Result<Option<Vec<u8>>> {
	if !input.starts_with(&[0x1f, 0x8b]) {
		return Ok(None);
	}
	let mut output = Vec::new();
	GzDecoder::new(input)
		.take((MAX_SVG_SOURCE_BYTES + 1) as u64)
		.read_to_end(&mut output)
		.map_err(|error| {
			napi::Error::from_reason(format!("Failed to decompress SVGZ source: {error}"))
		})?;
	if output.len() > MAX_SVG_SOURCE_BYTES {
		return Err(napi::Error::from_reason(format!(
			"SVG source exceeds the {MAX_SVG_SOURCE_BYTES}-byte limit"
		)));
	}
	Ok(Some(output))
}

fn validate_svg_source(input: &[u8]) -> Result<()> {
	if input.len() > MAX_SVG_SOURCE_BYTES {
		return Err(napi::Error::from_reason(format!(
			"SVG source exceeds the {MAX_SVG_SOURCE_BYTES}-byte limit"
		)));
	}

	let mut element_count = 0;
	let mut depth: usize = 0;
	let mut index = 0;
	while index < input.len() {
		let Some(offset) = input[index..].iter().position(|byte| *byte == b'<') else {
			break;
		};
		let lt = index + offset;
		if input[lt..].starts_with(b"<!--") {
			index = skip_markup(input, lt + 4, b"-->", "comment")?;
			continue;
		}
		if input[lt..].starts_with(b"<![CDATA[") {
			index = skip_markup(input, lt + 9, b"]]>", "CDATA section")?;
			continue;
		}
		if input[lt..].starts_with(b"<?") {
			index = skip_markup(input, lt + 2, b"?>", "processing instruction")?;
			continue;
		}
		if input[lt..].starts_with(b"<!") {
			return Err(napi::Error::from_reason("SVG DTD and entity declarations are not supported"));
		}

		let mut cursor = lt + 1;
		let closing = input.get(cursor) == Some(&b'/');
		if closing {
			cursor += 1;
		}
		let name_start = cursor;
		while cursor < input.len()
			&& !is_xml_space(input[cursor])
			&& !matches!(input[cursor], b'/' | b'>')
		{
			cursor += 1;
		}
		if cursor == name_start {
			index = lt + 1;
			continue;
		}
		let name = &input[name_start..cursor];
		if !closing {
			element_count += 1;
			if element_count > MAX_SVG_ELEMENTS {
				return Err(napi::Error::from_reason(format!(
					"SVG source exceeds the {MAX_SVG_ELEMENTS}-element limit"
				)));
			}
			let local_name = name.rsplit(|byte| *byte == b':').next().unwrap_or(name);
			if local_name.eq_ignore_ascii_case(b"image") || local_name.eq_ignore_ascii_case(b"feImage")
			{
				return Err(napi::Error::from_reason(
					"SVG image elements are not supported by the raster previewer",
				));
			}
		}

		let mut quote = None;
		let mut attributes = 0;
		while cursor < input.len() {
			let byte = input[cursor];
			if let Some(delimiter) = quote {
				if byte == delimiter {
					quote = None;
				}
			} else if byte == b'\'' || byte == b'"' {
				quote = Some(byte);
			} else if byte == b'=' && !closing {
				attributes += 1;
				if attributes > MAX_SVG_ATTRIBUTES_PER_ELEMENT {
					return Err(napi::Error::from_reason(format!(
						"SVG elements may not have more than {MAX_SVG_ATTRIBUTES_PER_ELEMENT} attributes"
					)));
				}
			} else if byte == b'>' {
				break;
			}
			cursor += 1;
		}
		if cursor == input.len() {
			return Err(napi::Error::from_reason("Malformed SVG start tag"));
		}
		if closing {
			depth = depth.saturating_sub(1);
		} else {
			let mut tag_end = cursor;
			while tag_end > lt && is_xml_space(input[tag_end - 1]) {
				tag_end -= 1;
			}
			if tag_end == lt || input[tag_end - 1] != b'/' {
				depth += 1;
				if depth > MAX_SVG_NESTING_DEPTH {
					return Err(napi::Error::from_reason(format!(
						"SVG source exceeds the {MAX_SVG_NESTING_DEPTH}-element nesting limit"
					)));
				}
			}
		}
		index = cursor + 1;
	}
	Ok(())
}

fn skip_markup(input: &[u8], start: usize, terminator: &[u8], name: &str) -> Result<usize> {
	input[start..]
		.windows(terminator.len())
		.position(|window| window == terminator)
		.map(|offset| start + offset + terminator.len())
		.ok_or_else(|| napi::Error::from_reason(format!("Unterminated SVG {name}")))
}

const fn is_xml_space(byte: u8) -> bool {
	matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
}

#[cfg(test)]
mod tests {
	use std::io::Write;

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
	fn pads_svg_to_cell_boundaries_without_rasterizing_an_embedded_image() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"><rect width="13" height="7" fill="red"/></svg>"#;
		let png = rasterize_svg_sync_with_cells(svg, 18, 18, Some(9), Some(18))
			.expect("SVG should rasterize into a cell-aligned canvas");
		let image = image::load_from_memory(&png)
			.expect("result should be PNG")
			.to_rgba8();
		assert_eq!(image.dimensions(), (18, 18));
		assert_eq!(image.get_pixel(2, 5).0, [255, 0, 0, 255]);
		assert_eq!(image.get_pixel(14, 11).0, [255, 0, 0, 255]);
		assert_eq!(image.get_pixel(1, 5).0, [0, 0, 0, 0]);
		assert_eq!(image.get_pixel(15, 11).0, [0, 0, 0, 0]);
	}

	#[test]
	fn rounds_exact_width_limit_before_cell_padding() {
		let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="162" height="18"><rect width="162" height="18" fill="red"/></svg>"#;
		let png = rasterize_svg_sync_with_cells(svg, 90, 18, Some(9), Some(9))
			.expect("exact-limit SVG should rasterize into a cell-aligned canvas");
		let image = image::load_from_memory(&png).expect("result should be PNG");
		assert_eq!((image.width(), image.height()), (90, 18));
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

	#[test]
	fn rejects_embedded_images_instead_of_returning_a_partial_preview() {
		// The shared rasterizer must not report success after silently dropping
		// authored content.
		let svg = "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:π=\"http://www.w3.org/2000/svg\" width=\"12\" height=\"7\"><π:image href=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\" width=\"12\" height=\"7\"/><rect x=\"0\" y=\"0\" width=\"12\" height=\"7\" fill=\"red\"/></svg>".as_bytes();
		let error =
			rasterize_svg_sync(svg, 100, 100).expect_err("embedded SVG images are unsupported");
		assert!(error.reason.contains("image elements are not supported"));
	}

	#[test]
	fn rejects_dtd_entity_expansion_before_xml_parsing() {
		let svg = br#"<!DOCTYPE svg [<!ENTITY image "<image href='data:image/png;base64,AA=='/>">]><svg xmlns="http://www.w3.org/2000/svg">&image;</svg>"#;
		let error = rasterize_svg_sync(svg, 100, 100).expect_err("DTD and entities are unsupported");
		assert!(error.reason.contains("DTD and entity declarations"));
	}

	#[test]
	fn rejects_excessive_attribute_counts_before_xml_parsing() {
		let attributes = (0..=MAX_SVG_ATTRIBUTES_PER_ELEMENT)
			.map(|index| format!("data-{index}=\"x\""))
			.collect::<Vec<_>>()
			.join(" ");
		let svg = format!("<svg {attributes}/>");
		let error =
			rasterize_svg_sync(svg.as_bytes(), 100, 100).expect_err("attribute count is bounded");
		assert!(error.reason.contains("more than 64 attributes"));
	}

	#[test]
	fn rejects_excessive_element_counts_before_xml_parsing() {
		let elements = "<rect/>".repeat(MAX_SVG_ELEMENTS);
		let svg = format!("<svg>{elements}</svg>");
		let error =
			rasterize_svg_sync(svg.as_bytes(), 100, 100).expect_err("element count is bounded");
		assert!(
			error
				.reason
				.contains(&format!("{MAX_SVG_ELEMENTS}-element limit"))
		);
	}

	#[test]
	fn rejects_excessive_element_nesting_before_xml_parsing() {
		let nested = "<g>".repeat(MAX_SVG_NESTING_DEPTH);
		let closing = "</g>".repeat(MAX_SVG_NESTING_DEPTH);
		let svg = format!("<svg>{nested}<rect/>{closing}</svg>");
		let error =
			rasterize_svg_sync(svg.as_bytes(), 100, 100).expect_err("element nesting is bounded");
		assert!(
			error
				.reason
				.contains(&format!("{MAX_SVG_NESTING_DEPTH}-element nesting limit"))
		);
	}

	#[test]
	fn rejects_oversized_svg_source_before_xml_parsing() {
		let svg = vec![b'x'; MAX_SVG_SOURCE_BYTES + 1];
		let error = rasterize_svg_sync(&svg, 100, 100).expect_err("source size is bounded");
		assert!(error.reason.contains("byte limit"));
	}

	#[test]
	fn bounds_svgz_decompression_before_xml_parsing() {
		let oversized_svg = vec![b'x'; MAX_SVG_SOURCE_BYTES + 1];
		let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
		encoder
			.write_all(&oversized_svg)
			.expect("SVGZ source should compress");
		let compressed = encoder.finish().expect("SVGZ stream should finish");
		let error = rasterize_svg_sync(&compressed, 100, 100)
			.expect_err("decompressed source size is bounded");
		assert!(error.reason.contains("byte limit"));
	}
}
