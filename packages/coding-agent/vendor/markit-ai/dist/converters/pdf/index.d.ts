/**
 * PDF to Markdown converter.
 *
 * Uses mupdf (native WASM) for fast PDF parsing and a custom pipeline for
 * table detection via vector line extraction + raycasting.
 *
 * Pipeline:
 *   1. Extract text boxes + vector segments + image regions per page (mupdf)
 *   2. Detect column layout (single vs multi-column)
 *   3. Per column: detect table grids from segments (grid detection + raycasting)
 *   4. Render diagrams as PNG files (if output directory provided)
 *   5. Render tables as markdown tables, free text as paragraphs/headings
 */
import type { ConversionResult, Converter, StreamInfo } from "../../types.js";
export declare class PdfConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
}
