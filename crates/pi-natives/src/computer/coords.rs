//! Coordinate contract for the native computer-use tool.
//!
//! # Overview
//! The computer-use tool exposes a single *normalized virtual display* to the
//! model: the dimensions of the returned screenshot (in pixels) define the
//! action coordinate space. Every model-supplied `x`/`y` is a pixel in that
//! screenshot. macOS input injection (`CGEvent`) operates in *logical points*,
//! not physical pixels, so on Retina/HiDPI displays a screenshot pixel and a
//! logical point differ by the display scale factor. This module owns the one
//! authoritative transform from screenshot pixels to macOS logical points, plus
//! strict bounds rejection.
//!
//! It is deliberately framework-free (no `CoreGraphics`, no napi) so the
//! coordinate math is unit-testable without a display or granted permissions.
//! The native capture/input backend that produces [`NormalizedDisplay`] values
//! lands in a later slice (see `docs/computer-use/`).
//!
//! # Example
//! ```
//! use pi_natives::computer::coords::NormalizedDisplay;
//!
//! // A 200x100-point Retina display captured at 2x => 400x200 screenshot px.
//! let display = NormalizedDisplay::new(400, 200, 2.0, 2.0, 0.0, 0.0);
//! let point = display.to_logical_point(100.0, 50.0).unwrap();
//! assert!((point.x - 50.0).abs() < 0.5);
//! assert!((point.y - 25.0).abs() < 0.5);
//! ```

use core::fmt;

/// A point in macOS logical (point) coordinate space, suitable for `CGEvent`
/// injection by the native input backend.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalPoint {
	/// Logical X (points), including the display's logical origin.
	pub x: f64,
	/// Logical Y (points), including the display's logical origin.
	pub y: f64,
}

/// Reason a screenshot-space pixel could not be mapped to a logical point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CoordError {
	/// The pixel coordinate is outside the normalized display bounds, or not a
	/// finite number. Side-effecting actions must reject rather than clamp.
	OutOfBounds {
		/// Offending X pixel.
		x:         f64,
		/// Offending Y pixel.
		y:         f64,
		/// Normalized display width in pixels.
		width_px:  u32,
		/// Normalized display height in pixels.
		height_px: u32,
	},
	/// The display descriptor has a non-positive or non-finite scale factor, so
	/// no correct transform exists.
	InvalidScale {
		/// Offending X scale.
		scale_x: f64,
		/// Offending Y scale.
		scale_y: f64,
	},
}

impl fmt::Display for CoordError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match *self {
			Self::OutOfBounds { x, y, width_px, height_px } => write!(
				f,
				"pixel ({x}, {y}) is out of bounds for a {width_px}x{height_px} normalized display"
			),
			Self::InvalidScale { scale_x, scale_y } => {
				write!(f, "invalid display scale ({scale_x}, {scale_y}); must be finite and > 0")
			},
		}
	}
}

impl std::error::Error for CoordError {}

/// Descriptor of the single normalized virtual display whose screenshot pixels
/// define the action coordinate space.
///
/// `scale_x`/`scale_y` are the per-axis ratios of physical screenshot pixels to
/// logical points (typically `1.0` on non-Retina and `2.0` on Retina).
/// `origin_x`/`origin_y` are the display's logical origin, preserved so the
/// transform stays correct for non-zero display origins.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizedDisplay {
	/// Screenshot width in physical pixels.
	pub width_px:  u32,
	/// Screenshot height in physical pixels.
	pub height_px: u32,
	/// Physical-pixels-per-logical-point along X.
	pub scale_x:   f64,
	/// Physical-pixels-per-logical-point along Y.
	pub scale_y:   f64,
	/// Logical origin X of the display (points).
	pub origin_x:  f64,
	/// Logical origin Y of the display (points).
	pub origin_y:  f64,
}

impl NormalizedDisplay {
	/// Construct a descriptor from raw capture geometry.
	#[must_use]
	pub const fn new(
		width_px: u32,
		height_px: u32,
		scale_x: f64,
		scale_y: f64,
		origin_x: f64,
		origin_y: f64,
	) -> Self {
		Self { width_px, height_px, scale_x, scale_y, origin_x, origin_y }
	}

	/// Whether both scale factors are finite and strictly positive.
	#[must_use]
	pub fn has_valid_scale(&self) -> bool {
		self.scale_x.is_finite()
			&& self.scale_x > 0.0
			&& self.scale_y.is_finite()
			&& self.scale_y > 0.0
	}

	/// Whether `(x, y)` is a finite pixel inside `[0, width_px) x [0,
	/// height_px)`.
	#[must_use]
	pub fn contains(&self, x: f64, y: f64) -> bool {
		// `Range::contains` is false for NaN, so non-finite pixels are rejected too.
		(0.0..f64::from(self.width_px)).contains(&x) && (0.0..f64::from(self.height_px)).contains(&y)
	}

	/// Map a screenshot-space pixel to a macOS logical point.
	///
	/// # Errors
	/// Returns [`CoordError::InvalidScale`] when the descriptor's scale is not
	/// finite and positive, or [`CoordError::OutOfBounds`] when `(x, y)` is not
	/// a finite pixel inside the display bounds.
	pub fn to_logical_point(&self, x: f64, y: f64) -> Result<LogicalPoint, CoordError> {
		if !self.has_valid_scale() {
			return Err(CoordError::InvalidScale { scale_x: self.scale_x, scale_y: self.scale_y });
		}
		if !self.contains(x, y) {
			return Err(CoordError::OutOfBounds {
				x,
				y,
				width_px: self.width_px,
				height_px: self.height_px,
			});
		}
		Ok(LogicalPoint { x: self.origin_x + x / self.scale_x, y: self.origin_y + y / self.scale_y })
	}
}

#[cfg(test)]
mod tests {
	use super::{CoordError, NormalizedDisplay};

	/// Logical points must match the expected value well within the 0.5-point
	/// accuracy tolerance the plan requires.
	const TOLERANCE: f64 = 0.5;

	fn assert_close(actual: f64, expected: f64) {
		assert!((actual - expected).abs() < TOLERANCE, "expected ~{expected}, got {actual}");
	}

	#[test]
	fn identity_scale_zero_origin() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 0.0, 0.0);
		let p = display.to_logical_point(40.0, 60.0).unwrap();
		assert_close(p.x, 40.0);
		assert_close(p.y, 60.0);
	}

	#[test]
	fn retina_scale_halves_pixels() {
		let display = NormalizedDisplay::new(400, 200, 2.0, 2.0, 0.0, 0.0);
		let p = display.to_logical_point(100.0, 50.0).unwrap();
		assert_close(p.x, 50.0);
		assert_close(p.y, 25.0);
	}

	#[test]
	fn fractional_scale() {
		let display = NormalizedDisplay::new(300, 150, 1.5, 1.5, 0.0, 0.0);
		let p = display.to_logical_point(150.0, 75.0).unwrap();
		assert_close(p.x, 100.0);
		assert_close(p.y, 50.0);
	}

	#[test]
	fn non_zero_origin_is_preserved() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 10.0, 20.0);
		let p = display.to_logical_point(5.0, 5.0).unwrap();
		assert_close(p.x, 15.0);
		assert_close(p.y, 25.0);
	}

	#[test]
	fn anisotropic_scale_per_axis() {
		let display = NormalizedDisplay::new(200, 100, 2.0, 1.0, 0.0, 0.0);
		let p = display.to_logical_point(100.0, 40.0).unwrap();
		assert_close(p.x, 50.0);
		assert_close(p.y, 40.0);
	}

	#[test]
	fn top_left_edge_is_inside() {
		let display = NormalizedDisplay::new(100, 100, 2.0, 2.0, 0.0, 0.0);
		assert!(display.to_logical_point(0.0, 0.0).is_ok());
	}

	#[test]
	fn bottom_right_inclusive_pixel_is_inside() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 0.0, 0.0);
		assert!(display.to_logical_point(99.0, 99.0).is_ok());
	}

	#[test]
	fn width_height_pixel_is_out_of_bounds() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 0.0, 0.0);
		assert!(matches!(display.to_logical_point(100.0, 0.0), Err(CoordError::OutOfBounds { .. })));
		assert!(matches!(display.to_logical_point(0.0, 100.0), Err(CoordError::OutOfBounds { .. })));
	}

	#[test]
	fn negative_pixel_is_out_of_bounds() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 0.0, 0.0);
		assert!(matches!(display.to_logical_point(-1.0, 10.0), Err(CoordError::OutOfBounds { .. })));
	}

	#[test]
	fn non_finite_pixel_is_out_of_bounds() {
		let display = NormalizedDisplay::new(100, 100, 1.0, 1.0, 0.0, 0.0);
		assert!(matches!(
			display.to_logical_point(f64::NAN, 10.0),
			Err(CoordError::OutOfBounds { .. })
		));
		assert!(matches!(
			display.to_logical_point(10.0, f64::INFINITY),
			Err(CoordError::OutOfBounds { .. })
		));
	}

	#[test]
	fn invalid_scale_is_rejected() {
		for (sx, sy) in [(0.0, 1.0), (1.0, -2.0), (f64::NAN, 1.0)] {
			let display = NormalizedDisplay::new(100, 100, sx, sy, 0.0, 0.0);
			assert!(matches!(
				display.to_logical_point(10.0, 10.0),
				Err(CoordError::InvalidScale { .. })
			));
		}
	}

	#[test]
	fn invalid_scale_takes_priority_over_bounds() {
		let display = NormalizedDisplay::new(100, 100, 0.0, 1.0, 0.0, 0.0);
		assert!(matches!(
			display.to_logical_point(999.0, 999.0),
			Err(CoordError::InvalidScale { .. })
		));
	}
}
