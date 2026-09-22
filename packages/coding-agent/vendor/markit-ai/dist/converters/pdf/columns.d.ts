/**
 * Multi-column layout detection and text box reordering.
 *
 * Many PDFs (legal documents, datasheets, academic papers) use two-column
 * layouts. Without column detection, text boxes are ordered by Y position
 * only, interleaving left and right column content.
 *
 * Algorithm:
 *   1. Collect left edges of all text boxes on the page
 *   2. Find the largest horizontal gap between consecutive left edges
 *   3. If gap > MIN_GAP_RATIO of the text width and both sides have
 *      enough boxes → multi-column detected
 *   4. Assign each text box to a column based on its center X
 *   5. Return columns in reading order (left-to-right, top-to-bottom)
 *
 * This only detects the column structure. The caller is responsible for
 * processing each column's text boxes independently (table detection,
 * rendering, etc.).
 */
import type { TextBox } from "./types.js";
export interface ColumnLayout {
    /** Number of columns detected (1 = single column, 2+ = multi-column). */
    columnCount: number;
    /** Text boxes grouped by column, in reading order (left to right). */
    columns: TextBox[][];
    /** X positions of column boundaries (between columns). */
    boundaries: number[];
}
/**
 * Detect column layout and return text boxes grouped by column.
 *
 * For single-column pages, returns all boxes in one group.
 * For multi-column pages, returns boxes split by column in reading order.
 */
export declare function detectColumns(textBoxes: TextBox[]): ColumnLayout;
