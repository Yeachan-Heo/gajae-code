/**
 * PDF content extraction using mupdf.
 *
 * Extracts text boxes (with position, font size, bold) and vector line
 * segments (table borders) from each page. Uses mupdf's native WASM
 * engine for fast parsing, and reads raw content streams for vector graphics.
 *
 * Coordinate system: PDF native (origin = bottom-left, Y increases upward).
 */
import type { ImageRegion, PageContent } from "./types.js";
/**
 * Render an image region from a PDF page as a PNG buffer.
 * Uses mupdf's DrawDevice to render just the cropped area at 2x resolution.
 */
export declare function renderImageRegion(input: Uint8Array, region: ImageRegion): Uint8Array;
/**
 * Extract text boxes and vector segments from all pages of a PDF buffer.
 */
export declare function extractPages(input: Uint8Array): Promise<PageContent[]>;
