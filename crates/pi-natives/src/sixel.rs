// Vendored from oh-my-pi (MIT) crates/pi-natives/src/sixel.rs @ a85bd5228d9f0f619deade1db78fa49420a721e1
// Local modifications: tag the public encoder with profile_region; do not expose upstream decoding without a GJC consumer.

//! SIXEL terminal-image encoding.
//!
//! Decodes an encoded image (PNG, JPEG, WebP, GIF), resizes to the target
//! pixel dimensions, and encodes the result as a SIXEL escape sequence.
//!
//! General-purpose image processing (decode/resize/encode for files and
//! buffers) lives in `Bun.Image` on the JS side; this module exists only
//! because SIXEL is a terminal-display protocol with no equivalent there.

use std::io::Cursor;

use icy_sixel::{EncodeOptions, sixel_encode};
use image::{DynamicImage, ImageReader, imageops::FilterType};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Encode image bytes into a SIXEL escape sequence for terminal rendering.
///
/// The input image is decoded and resized to the requested pixel dimensions
/// before encoding.
///
/// # Errors
/// Returns an error if decoding, resizing, or SIXEL encoding fails.
#[napi]
pub fn encode_sixel(
	bytes: Uint8Array,
	target_width_px: u32,
	target_height_px: u32,
) -> Result<String> {
	let _profile = crate::prof::profile_region("sixel.encode");
	if target_width_px == 0 || target_height_px == 0 {
		return Err(Error::from_reason("Target SIXEL dimensions must be greater than zero"));
	}

	let source = decode_image_from_bytes(bytes.as_ref())?;
	let resized = if source.width() == target_width_px && source.height() == target_height_px {
		source
	} else {
		source.resize_exact(target_width_px, target_height_px, FilterType::Lanczos3)
	};
	let rgba = resized.to_rgba8();
	let options = EncodeOptions::default();
	sixel_encode(rgba.as_raw(), target_width_px as usize, target_height_px as usize, &options)
		.map_err(|err| Error::from_reason(format!("Failed to encode SIXEL: {err}")))
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
	let reader = ImageReader::new(Cursor::new(bytes))
		.with_guessed_format()
		.map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;

	reader
		.decode()
		.map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}
