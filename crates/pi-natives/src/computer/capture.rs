//! Primary-display screen capture (macOS).
//!
//! # Overview
//! Read-only capture of the current primary display into a PNG plus the
//! [`NormalizedDisplay`] descriptor whose pixel dimensions define the action
//! coordinate space (see [`super::coords`]). The display scale is derived from
//! the captured physical pixel size versus the logical display bounds, so the
//! coordinate contract stays correct on Retina/HiDPI.
//!
//! Capture requires the macOS Screen Recording (TCC) permission. When it is not
//! granted, `CGDisplayCreateImage` returns null and this surfaces
//! [`CaptureError::CaptureFailed`] rather than silently returning a black
//! frame.
//!
//! Implemented with raw CoreGraphics FFI (no extra crates); the buffer is owned
//! Rust memory and every Core Graphics handle is released exactly once.

use std::{
	collections::hash_map::DefaultHasher,
	ffi::c_void,
	fmt,
	hash::{Hash, Hasher},
	sync::atomic::{AtomicU64, Ordering},
};

use crate::computer::coords::NormalizedDisplay;

#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
	x: f64,
	y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
	width:  f64,
	height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
	origin: CgPoint,
	size:   CgSize,
}

type CgDirectDisplayId = u32;
type CgImageRef = *mut c_void;
type CgColorSpaceRef = *mut c_void;
type CgContextRef = *mut c_void;

/// `kCGImageAlphaPremultipliedLast` (1) | `kCGBitmapByteOrder32Big` (4 << 12)
/// yields an RGBA8888 byte layout.
const RGBA_BITMAP_INFO: u32 = 1 | (4 << 12);
const BITS_PER_COMPONENT: usize = 8;
const BYTES_PER_PIXEL: usize = 4;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGMainDisplayID() -> CgDirectDisplayId;
	fn CGDisplayBounds(display: CgDirectDisplayId) -> CgRect;
	fn CGDisplayCreateImage(display: CgDirectDisplayId) -> CgImageRef;
	fn CGDisplayPixelsWide(display: CgDirectDisplayId) -> usize;
	fn CGDisplayPixelsHigh(display: CgDirectDisplayId) -> usize;
	fn CGImageGetWidth(image: CgImageRef) -> usize;
	fn CGImageGetHeight(image: CgImageRef) -> usize;
	fn CGImageRelease(image: CgImageRef);
	fn CGColorSpaceCreateDeviceRGB() -> CgColorSpaceRef;
	fn CGColorSpaceRelease(space: CgColorSpaceRef);
	fn CGBitmapContextCreate(
		data: *mut c_void,
		width: usize,
		height: usize,
		bits_per_component: usize,
		bytes_per_row: usize,
		space: CgColorSpaceRef,
		bitmap_info: u32,
	) -> CgContextRef;
	fn CGContextDrawImage(context: CgContextRef, rect: CgRect, image: CgImageRef);
	fn CGContextRelease(context: CgContextRef);
}

/// Reason a primary-display capture failed.
#[derive(Debug, Clone)]
pub enum CaptureError {
	/// `CGDisplayCreateImage` returned null or a zero-sized image — commonly the
	/// Screen Recording permission is not granted.
	CaptureFailed,
	/// A Core Graphics color space or bitmap context could not be created.
	ContextFailed,
	/// The captured frame could not be PNG-encoded.
	Encode(String),
}

impl fmt::Display for CaptureError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::CaptureFailed => {
				write!(f, "screen capture failed; the Screen Recording permission may not be granted")
			},
			Self::ContextFailed => write!(f, "failed to create a Core Graphics bitmap context"),
			Self::Encode(reason) => write!(f, "failed to encode captured frame as PNG: {reason}"),
		}
	}
}

impl std::error::Error for CaptureError {}

static NEXT_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);

/// A captured primary-display frame.
pub struct CapturedFrame {
	/// Coordinate descriptor for the captured display.
	pub display:       NormalizedDisplay,
	/// PNG-encoded RGBA image bytes.
	pub png:           Vec<u8>,
	/// Stable hash of the display geometry used for stale-display checks.
	pub display_epoch: u64,
	/// Process-local opaque capture id.
	pub capture_id:    u32,
}

/// Capture the current primary display as a PNG plus its coordinate descriptor.
///
/// # Errors
/// Returns [`CaptureError`] when the OS capture call fails (often a missing
/// Screen Recording grant), a bitmap context cannot be created, or PNG encoding
/// fails.
pub fn capture_primary_display() -> Result<CapturedFrame, CaptureError> {
	// SAFETY: pure Core Graphics geometry queries for the active primary display;
	// no image capture occurs before `CGDisplayCreateImage` below.
	let (display_id, display) = unsafe {
		let id = CGMainDisplayID();
		let bounds = CGDisplayBounds(id);
		let pixels_wide = CGDisplayPixelsWide(id);
		let pixels_high = CGDisplayPixelsHigh(id);
		(id, display_descriptor(pixels_wide, pixels_high, bounds))
	};

	let display_epoch = display_epoch(&display);
	let capture_id = next_capture_id();

	// SAFETY: `display_id` is a valid primary-display id. The returned image is
	// released exactly once below regardless of the `frame_from_image` result.
	let image = unsafe { CGDisplayCreateImage(display_id) };
	if image.is_null() {
		return Err(CaptureError::CaptureFailed);
	}

	let result = frame_from_image(image, display, display_epoch, capture_id);

	// SAFETY: `image` is non-null (checked above) and not used after release.
	unsafe { CGImageRelease(image) };
	result
}

#[must_use]
pub fn current_display_epoch() -> u64 {
	let display = current_display_descriptor();
	display_epoch(&display)
}

/// Convert a non-null `CGImage` into a [`CapturedFrame`]. Does not release
/// `image`; the caller owns its lifetime.
fn frame_from_image(
	image: CgImageRef,
	display: NormalizedDisplay,
	display_epoch: u64,
	capture_id: u32,
) -> Result<CapturedFrame, CaptureError> {
	// SAFETY: `image` is non-null per the caller's check.
	let (width, height) = unsafe { (CGImageGetWidth(image), CGImageGetHeight(image)) };
	if width == 0 || height == 0 {
		return Err(CaptureError::CaptureFailed);
	}

	let bytes_per_row = width * BYTES_PER_PIXEL;
	let mut buffer = vec![0u8; bytes_per_row * height];

	// SAFETY: device RGB color space; released on every path below.
	let space = unsafe { CGColorSpaceCreateDeviceRGB() };
	if space.is_null() {
		return Err(CaptureError::ContextFailed);
	}

	// SAFETY: `buffer` is exactly `bytes_per_row * height` bytes, matching the
	// dimensions/stride passed here; `space` is non-null.
	let context = unsafe {
		CGBitmapContextCreate(
			buffer.as_mut_ptr().cast::<c_void>(),
			width,
			height,
			BITS_PER_COMPONENT,
			bytes_per_row,
			space,
			RGBA_BITMAP_INFO,
		)
	};
	if context.is_null() {
		// SAFETY: `space` is non-null and released exactly once here.
		unsafe { CGColorSpaceRelease(space) };
		return Err(CaptureError::ContextFailed);
	}

	let rect = CgRect {
		origin: CgPoint { x: 0.0, y: 0.0 },
		size:   CgSize { width: width as f64, height: height as f64 },
	};
	// SAFETY: `context` and `image` are non-null; `rect` matches the buffer the
	// context was created over, so the draw stays in bounds.
	unsafe { CGContextDrawImage(context, rect, image) };

	// SAFETY: both handles are non-null and released exactly once; not used after.
	unsafe {
		CGContextRelease(context);
		CGColorSpaceRelease(space);
	}

	let png = encode_png(&buffer, width as u32, height as u32)?;

	Ok(CapturedFrame { display, png, display_epoch, capture_id })
}

/// Scale = physical pixels / logical points, defaulting to `1.0` when the
/// logical extent is not positive.
fn derive_scale(pixels: f64, logical: f64) -> f64 {
	if logical > 0.0 { pixels / logical } else { 1.0 }
}

fn current_display_descriptor() -> NormalizedDisplay {
	// SAFETY: pure Core Graphics geometry queries for the active primary display;
	// no image capture or Screen Recording permission is involved.
	unsafe {
		let display_id = CGMainDisplayID();
		let bounds = CGDisplayBounds(display_id);
		display_descriptor(CGDisplayPixelsWide(display_id), CGDisplayPixelsHigh(display_id), bounds)
	}
}

fn display_descriptor(width: usize, height: usize, bounds: CgRect) -> NormalizedDisplay {
	let scale_x = derive_scale(width as f64, bounds.size.width);
	let scale_y = derive_scale(height as f64, bounds.size.height);
	NormalizedDisplay::new(
		width as u32,
		height as u32,
		scale_x,
		scale_y,
		bounds.origin.x,
		bounds.origin.y,
	)
}

fn display_epoch(display: &NormalizedDisplay) -> u64 {
	let mut hasher = DefaultHasher::new();
	display.width_px.hash(&mut hasher);
	display.height_px.hash(&mut hasher);
	display.scale_x.to_bits().hash(&mut hasher);
	display.scale_y.to_bits().hash(&mut hasher);
	display.origin_x.to_bits().hash(&mut hasher);
	display.origin_y.to_bits().hash(&mut hasher);
	hasher.finish()
}

fn next_capture_id() -> u32 {
	let id = NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed);
	((id - 1) % u64::from(u32::MAX) + 1) as u32
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, CaptureError> {
	use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};

	let mut out = Vec::new();
	PngEncoder::new(&mut out)
		.write_image(rgba, width, height, ExtendedColorType::Rgba8)
		.map_err(|err| CaptureError::Encode(err.to_string()))?;
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::capture_primary_display;

	/// Exercises the real OS capture path, so it is ignored by default and run
	/// explicitly (`cargo test -p pi-natives --ignored`) on a macOS host with
	/// Screen Recording granted.
	#[test]
	#[ignore = "captures the real primary display; needs macOS + Screen Recording grant"]
	fn captures_non_uniform_primary_display() {
		let frame = capture_primary_display()
			.expect("capture should succeed when Screen Recording is granted");
		assert!(frame.display.width_px > 0 && frame.display.height_px > 0);

		let decoded = image::load_from_memory(&frame.png).expect("captured bytes decode as PNG");
		assert_eq!(decoded.width(), frame.display.width_px);
		assert_eq!(decoded.height(), frame.display.height_px);

		let rgba = decoded.to_rgba8();
		let first = rgba.pixels().next().copied();
		let non_uniform = rgba.pixels().any(|pixel| Some(*pixel) != first);
		assert!(
			non_uniform,
			"captured frame is uniform (black/blank) — Screen Recording likely not granted"
		);

		std::fs::write("/tmp/computer-capture-evidence.png", &frame.png).ok();
	}
}
