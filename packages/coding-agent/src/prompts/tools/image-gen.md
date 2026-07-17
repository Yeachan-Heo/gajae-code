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
- For edits: pass `changes` (array of edit instructions) and the source image via `input`.
- `input`: array of `{path}` or `{data, mime_type}` entries. When using multiple `input` images, you SHOULD describe each image's role directly in `subject`, e.g. `Image 1` for composition reference, `Image 2` for lighting reference, `Image 3` for background.
</instruction>
