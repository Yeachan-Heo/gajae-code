### Fixed

- ACP prompts whose inline images exceed the 256 KiB SDK frame cap are no longer rejected: the ACP agent stages each image losslessly through the private `turn.image.*` uploads in sub-cap chunks and references the staged IDs in `turn.prompt`. Staged images are discarded when the prompt is cancelled or fails before the host consumes them; oversized prompt text is still rejected up front.
