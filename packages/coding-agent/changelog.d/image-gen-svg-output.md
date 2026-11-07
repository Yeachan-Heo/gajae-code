### Added

- `generate_image` can ask the OpenAI and Codex image routes for `png`, `jpeg`, `webp`, `gif`, or `svg`, and can set quality, background, complexity, count, compression, and GIF frame timing. The default remains one `webp` image at quality `auto`. SVG asks for one image and does not stream. A PNG is not saved as an SVG, including a PNG whose metadata contains an svg tag. GIF bytes must start with a GIF header.
