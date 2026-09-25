// Vendored from oh-my-pi (MIT) crates/pi-natives/src/mermaid/flowchart/shapes/rounded.rs @ a85bd5228d9f0f619deade1db78fa49420a721e1
// Local modifications: attribution header only.
// Vendored from oh-my-pi (MIT)
// crates/pi-natives/src/mermaid/flowchart/shapes/rounded.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Local modifications: attribution
// header only.
use super::{
	ShapeDimensions, ShapeRenderOptions, ShapeRenderer,
	corners::corners,
	rectangle::{box_attachment_point, box_dimensions, render_box},
};
use crate::mermaid::{
	canvas::{Canvas, DrawingCoord},
	flowchart::{Dir, NodeShape},
};

/// Rounded rectangular node renderer.
pub struct Rounded;

impl ShapeRenderer for Rounded {
	fn dimensions(&self, label: &str, opts: &ShapeRenderOptions) -> ShapeDimensions {
		box_dimensions(label, opts)
	}

	fn render(&self, label: &str, dims: &ShapeDimensions, opts: &ShapeRenderOptions) -> Canvas {
		render_box(label, dims, corners(NodeShape::Rounded, opts.use_ascii), opts.use_ascii)
	}

	fn attachment_point(
		&self,
		dir: Dir,
		dims: &ShapeDimensions,
		base: DrawingCoord,
	) -> DrawingCoord {
		box_attachment_point(dir, dims, base)
	}
}
