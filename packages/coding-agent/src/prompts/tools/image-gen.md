Generates or edits images.

<instruction>
- `subject` is required: the main subject, described in detail. The tool assembles the final prompt as "subject, action, scene. composition. lighting. style." — use the structured fields rather than packing everything into `subject`:
  - `action`: what the subject is doing
  - `scene`: location or environment
  - `composition`: camera angle and framing
  - `lighting`: lighting setup
  - `style`: artistic style
- `text`: text to render in the image. For important text you SHOULD add "sharp, legible, correctly spelled"; keep text short.
- `aspect_ratio` / `image_size`: output shape controls.
- `output_format`: `png`, `jpeg`, `webp`, `gif`, or `svg`. The default is `webp`. SVG is one image and is saved only when the bytes are an SVG document. A PNG is a failure.
- `quality`: `low`, `medium`, `high`, or `auto`.
- `background`: `transparent`, `opaque`, or `auto`. Transparent output must be `png` or `webp`.
- `complexity`: `low`, `medium`, or `high`.
- `count`: 1 to 10 images. SVG stays at 1.
- `output_compression`: 0 to 100, for `jpeg` and `webp` only.
- `frame_count` and `frame_duration_ms`: GIF only. Frame count is 2 to 16. Frame delay is 20 to 655350 milliseconds.
- For edits: pass `changes` and the source images via `input`. The request sends those source images. It has no markup field and no mask.
- `input`: array of `{path}` or `{data, mime_type}` entries. When using multiple `input` images, you SHOULD describe each image's role directly in `subject`, e.g. `Image 1` for composition reference, `Image 2` for lighting reference, `Image 3` for background.
</instruction>
