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
/**
 * Minimum gap as a fraction of the total text width to consider a column
 * boundary. A two-column layout typically has ~50% gap; we use a lower
 * threshold to catch asymmetric columns.
 */
const MIN_GAP_RATIO = 0.15;
/** Minimum number of text boxes on each side of the gap. */
const MIN_BOXES_PER_COLUMN = 4;
/** Minimum gap in absolute points to avoid splitting on small whitespace. */
const MIN_GAP_PTS = 40;
/**
 * Detect column layout and return text boxes grouped by column.
 *
 * For single-column pages, returns all boxes in one group.
 * For multi-column pages, returns boxes split by column in reading order.
 */
export function detectColumns(textBoxes) {
    if (textBoxes.length < MIN_BOXES_PER_COLUMN * 2) {
        return { columnCount: 1, columns: [textBoxes], boundaries: [] };
    }
    // Collect unique left edges (rounded to avoid float noise)
    const lefts = [
        ...new Set(textBoxes.map((tb) => Math.round(tb.bounds.left))),
    ].sort((a, b) => a - b);
    if (lefts.length < 2) {
        return { columnCount: 1, columns: [textBoxes], boundaries: [] };
    }
    const textXMin = lefts[0];
    const textXMax = Math.max(...textBoxes.map((tb) => Math.round(tb.bounds.right)));
    const textWidth = textXMax - textXMin;
    if (textWidth <= 0) {
        return { columnCount: 1, columns: [textBoxes], boundaries: [] };
    }
    // Find the largest gap between consecutive left-edge positions
    let maxGap = 0;
    let gapLeft = 0;
    let gapRight = 0;
    for (let i = 1; i < lefts.length; i++) {
        const gap = lefts[i] - lefts[i - 1];
        if (gap > maxGap) {
            maxGap = gap;
            gapLeft = lefts[i - 1];
            gapRight = lefts[i];
        }
    }
    const gapRatio = maxGap / textWidth;
    if (gapRatio < MIN_GAP_RATIO || maxGap < MIN_GAP_PTS) {
        return { columnCount: 1, columns: [textBoxes], boundaries: [] };
    }
    // Split point is the midpoint of the gap
    const splitX = (gapLeft + gapRight) / 2;
    // Assign boxes to columns based on center X
    const leftCol = [];
    const rightCol = [];
    for (const tb of textBoxes) {
        const cx = (tb.bounds.left + tb.bounds.right) / 2;
        if (cx < splitX) {
            leftCol.push(tb);
        }
        else {
            rightCol.push(tb);
        }
    }
    // Validate both columns have enough content
    if (leftCol.length < MIN_BOXES_PER_COLUMN ||
        rightCol.length < MIN_BOXES_PER_COLUMN) {
        return { columnCount: 1, columns: [textBoxes], boundaries: [] };
    }
    return {
        columnCount: 2,
        columns: [leftCol, rightCol],
        boundaries: [splitX],
    };
}
