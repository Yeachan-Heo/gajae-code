// Shared input policy must remain independent of file loading, tools and sessions.
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_STAGED_PROMPT_IMAGES = 16;
/** Decoded bytes per `turn.image.append` chunk; its base64 frame stays well under the 256 KiB SDK frame cap. */
export const MAX_PROMPT_IMAGE_CHUNK_BYTES = 96 * 1024;
export const MAX_PASTED_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_PASTED_IMAGE_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PASTED_IMAGE_DIMENSION = 20_000;
export const MAX_PASTED_IMAGE_PIXELS = 40_000_000;
export const MAX_PASTED_IMAGE_DECODED_BYTES = 160 * 1024 * 1024;
