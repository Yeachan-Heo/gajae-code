/**
 * Table grid detection from vector segments and text boxes.
 *
 * Ported from @oharato/pdf2md-ts with TypeScript types and without
 * CJK-specific borderless table heuristics. The core algorithm:
 *
 * 1. Classify segments as horizontal or vertical lines
 * 2. Group horizontal Y-lines into table groups (split by vertical gaps)
 * 3. For each group:
 *    a. Full grid (H+V lines): build cells from grid intersections,
 *       place text via raycasting
 *    b. H-line only (no V lines): infer columns from text X positions
 * 4. Prune empty rows/cols
 *
 * Coordinate system: PDF native (bottom-left origin, Y increases upward).
 */
import type { Segment, TableGrid, TextBox } from "./types.js";
export interface GridResult {
    grids: TableGrid[];
    consumedIds: string[];
}
/**
 * Detect all table grids on a single page from its text boxes and segments.
 */
export declare function resolveTableGrids(pageNumber: number, textBoxes: TextBox[], segments: Segment[]): GridResult;
