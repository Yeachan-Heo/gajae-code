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
function castRaysForTextBox(textBox, segments) {
    const cx = (textBox.bounds.left + textBox.bounds.right) / 2;
    const cy = (textBox.bounds.top + textBox.bounds.bottom) / 2;
    let up = { direction: "up", segmentId: null, distance: Infinity };
    let down = { direction: "down", segmentId: null, distance: Infinity };
    let left = { direction: "left", segmentId: null, distance: Infinity };
    let right = {
        direction: "right",
        segmentId: null,
        distance: Infinity,
    };
    for (const seg of segments) {
        const isH = Math.abs(seg.y1 - seg.y2) < 0.5;
        const isV = Math.abs(seg.x1 - seg.x2) < 0.5;
        if (isH) {
            const minX = Math.min(seg.x1, seg.x2);
            const maxX = Math.max(seg.x1, seg.x2);
            if (cx >= minX && cx <= maxX) {
                const d = seg.y1 - cy;
                if (d >= 0 && d < up.distance)
                    up = { direction: "up", segmentId: seg.id, distance: d };
                const dd = cy - seg.y1;
                if (dd >= 0 && dd < down.distance)
                    down = { direction: "down", segmentId: seg.id, distance: dd };
            }
        }
        if (isV) {
            const minY = Math.min(seg.y1, seg.y2);
            const maxY = Math.max(seg.y1, seg.y2);
            if (cy >= minY && cy <= maxY) {
                const d = cx - seg.x1;
                if (d >= 0 && d < left.distance)
                    left = { direction: "left", segmentId: seg.id, distance: d };
                const rd = seg.x1 - cx;
                if (rd >= 0 && rd < right.distance)
                    right = { direction: "right", segmentId: seg.id, distance: rd };
            }
        }
    }
    return [up, down, left, right];
}
// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
const AXIS_EPSILON = 0.8;
const PAGE_MARGIN = 20;
function uniqueSorted(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const result = [];
    for (const v of sorted) {
        if (result.length === 0 || Math.abs(result[result.length - 1] - v) > 1)
            result.push(v);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Y-line group splitting
// ---------------------------------------------------------------------------
function chainCoversRange(intervals, lowerY, upperY, eps) {
    const sorted = [...intervals].sort((a, b) => a.min - b.min);
    let covered = lowerY;
    for (const iv of sorted) {
        if (iv.min > covered + eps)
            break;
        if (iv.max > covered)
            covered = iv.max;
        if (covered >= upperY - eps)
            return true;
    }
    return false;
}
function countBridgingVLineCols(upperY, lowerY, verticals) {
    const eps = 1.5;
    const byX = new Map();
    for (const seg of verticals) {
        const rx = Math.round(seg.x1);
        if (!byX.has(rx))
            byX.set(rx, []);
        byX
            .get(rx)
            ?.push({ min: Math.min(seg.y1, seg.y2), max: Math.max(seg.y1, seg.y2) });
    }
    let count = 0;
    for (const intervals of byX.values()) {
        if (chainCoversRange(intervals, lowerY, upperY, eps))
            count++;
    }
    return count;
}
function bridgingXSet(upperY, lowerY, verticals) {
    const eps = 1.5;
    const xs = new Set();
    const byX = new Map();
    for (const seg of verticals) {
        const rx = Math.round(seg.x1);
        if (!byX.has(rx))
            byX.set(rx, []);
        byX
            .get(rx)
            ?.push({ min: Math.min(seg.y1, seg.y2), max: Math.max(seg.y1, seg.y2) });
    }
    for (const [rx, intervals] of byX) {
        if (chainCoversRange(intervals, lowerY, upperY, eps))
            xs.add(rx);
    }
    return xs;
}
const MIN_RICH_BRIDGING_COLS = 3;
function splitYLinesIntoGroups(yLines, verticals) {
    if (yLines.length === 0)
        return [];
    const eps = 1.5;
    const allX = verticals.map((s) => Math.round(s.x1));
    const globalXMin = allX.length > 0 ? Math.min(...allX) : 0;
    const globalXMax = allX.length > 0 ? Math.max(...allX) : 0;
    const groups = [];
    let currentGroup = [yLines[0]];
    let prevBridgingCols = -1;
    for (let i = 1; i < yLines.length; i++) {
        const upperY = yLines[i - 1];
        const lowerY = yLines[i];
        const cols = countBridgingVLineCols(upperY, lowerY, verticals);
        if (cols === 0) {
            groups.push(currentGroup);
            currentGroup = [yLines[i]];
            prevBridgingCols = -1;
            continue;
        }
        if (prevBridgingCols >= MIN_RICH_BRIDGING_COLS &&
            cols < MIN_RICH_BRIDGING_COLS) {
            const bxs = bridgingXSet(upperY, lowerY, verticals);
            const isOuterFrameOnly = [...bxs].every((x) => Math.abs(x - globalXMin) <= eps || Math.abs(x - globalXMax) <= eps);
            if (!isOuterFrameOnly) {
                groups.push(currentGroup);
                currentGroup = [yLines[i - 1], yLines[i]];
                prevBridgingCols = cols;
                continue;
            }
        }
        currentGroup.push(yLines[i]);
        prevBridgingCols = cols;
    }
    groups.push(currentGroup);
    return groups;
}
// ---------------------------------------------------------------------------
// Sub-row Y-cluster expansion
// ---------------------------------------------------------------------------
const Y_CLUSTER_GAP = 10;
const MIN_COLS_IN_TOP_CLUSTER = 2;
function assignToYCluster(y, clusters) {
    let closest = 0;
    let closestDist = Math.abs(y - clusters[0]);
    for (let k = 1; k < clusters.length; k++) {
        const d = Math.abs(y - clusters[k]);
        if (d < closestDist) {
            closestDist = d;
            closest = k;
        }
    }
    return closest;
}
function expandSubRowsByYClusters(originalRows, cols, cells, cellBoxes) {
    let addedRows = 0;
    for (let origRow = 0; origRow < originalRows; origRow++) {
        const currentRow = origRow + addedRows;
        const rowCellInfos = [];
        for (let col = 0; col < cols; col++) {
            const cell = cells.find((c) => c.row === currentRow && c.col === col);
            if (!cell)
                continue;
            const boxes = cellBoxes.get(cell);
            if (boxes && boxes.length > 0)
                rowCellInfos.push({ cell, col, boxes });
        }
        if (rowCellInfos.length === 0)
            continue;
        const allMidYs = rowCellInfos.flatMap(({ boxes }) => boxes.map((b) => (b.bounds.top + b.bounds.bottom) / 2));
        const sortedY = [
            ...new Set(allMidYs.map((y) => Math.round(y * 10) / 10)),
        ].sort((a, b) => b - a);
        const clusters = [sortedY[0]];
        for (let i = 1; i < sortedY.length; i++) {
            if (clusters[clusters.length - 1] - sortedY[i] > Y_CLUSTER_GAP) {
                clusters.push(sortedY[i]);
            }
        }
        if (clusters.length < 2)
            continue;
        const colsInTopCluster = new Set();
        const totalNonEmptyCols = new Set();
        for (const { col, boxes } of rowCellInfos) {
            totalNonEmptyCols.add(col);
            if (boxes.some((b) => assignToYCluster((b.bounds.top + b.bounds.bottom) / 2, clusters) ===
                0)) {
                colsInTopCluster.add(col);
            }
        }
        if (colsInTopCluster.size < MIN_COLS_IN_TOP_CLUSTER)
            continue;
        if (colsInTopCluster.size >= totalNonEmptyCols.size)
            continue;
        const sparseColsHaveMultipleBoxes = rowCellInfos.some(({ col, boxes }) => !colsInTopCluster.has(col) && boxes.length > 1);
        if (!sparseColsHaveMultipleBoxes)
            continue;
        const numSubRows = clusters.length;
        const numNewRows = numSubRows - 1;
        for (const cell of cells) {
            if (cell.row > currentRow)
                cell.row += numNewRows;
        }
        for (let subRow = 1; subRow < numSubRows; subRow++) {
            for (let col = 0; col < cols; col++) {
                cells.push({
                    row: currentRow + subRow,
                    col,
                    text: "",
                    rowSpan: 1,
                    colSpan: 1,
                });
            }
        }
        for (const { cell: origCell, col, boxes } of rowCellInfos) {
            const subRowBoxGroups = Array.from({ length: numSubRows }, () => []);
            for (const box of boxes) {
                const cy = (box.bounds.top + box.bounds.bottom) / 2;
                subRowBoxGroups[assignToYCluster(cy, clusters)].push(box);
            }
            cellBoxes.set(origCell, subRowBoxGroups[0]);
            if (subRowBoxGroups[0].length === 0)
                cellBoxes.delete(origCell);
            for (let subRow = 1; subRow < numSubRows; subRow++) {
                if (subRowBoxGroups[subRow].length > 0) {
                    const newCell = cells.find((c) => c.row === currentRow + subRow && c.col === col);
                    if (newCell)
                        cellBoxes.set(newCell, subRowBoxGroups[subRow]);
                }
            }
        }
        addedRows += numNewRows;
    }
    return originalRows + addedRows;
}
// ---------------------------------------------------------------------------
// Cross-column text box splitting
// ---------------------------------------------------------------------------
/**
 * Find which column a horizontal position falls into.
 * Returns -1 if outside the grid.
 */
function findCol(x, xLines) {
    for (let i = 0; i < xLines.length - 1; i++) {
        if (x >= xLines[i] && x <= xLines[i + 1])
            return i;
    }
    return -1;
}
/**
 * When a text box spans across one or more vertical column boundaries,
 * split it into multiple virtual text boxes — one per column — with the
 * text divided proportionally by width.
 *
 * We split at word boundaries closest to the proportional split point
 * so we don't chop words in half.
 */
function splitCrossColumnBoxes(textBoxes, xLines) {
    const result = [];
    const MARGIN = 5; // allow small overlap before considering it cross-column
    for (const tb of textBoxes) {
        const leftCol = findCol(tb.bounds.left + MARGIN, xLines);
        const rightCol = findCol(tb.bounds.right - MARGIN, xLines);
        // Not spanning columns, or outside grid — keep as-is
        if (leftCol < 0 || rightCol < 0 || leftCol === rightCol) {
            result.push(tb);
            continue;
        }
        // Text box spans from leftCol to rightCol — split it
        const totalWidth = tb.bounds.right - tb.bounds.left;
        if (totalWidth <= 0) {
            result.push(tb);
            continue;
        }
        const words = tb.text.split(/\s+/);
        if (words.length <= 1) {
            // Single word spanning columns — just assign to whichever col has more overlap
            result.push(tb);
            continue;
        }
        // For each column boundary crossing, find the best word-boundary split
        let remainingWords = [...words];
        let currentLeft = tb.bounds.left;
        for (let col = leftCol; col <= rightCol && remainingWords.length > 0; col++) {
            const colRight = col < xLines.length - 1 ? xLines[col + 1] : tb.bounds.right;
            const segmentRight = Math.min(colRight, tb.bounds.right);
            if (col === rightCol) {
                // Last column — take all remaining words
                result.push({
                    ...tb,
                    id: `${tb.id}-split${col}`,
                    text: remainingWords.join(" "),
                    bounds: {
                        ...tb.bounds,
                        left: currentLeft,
                        right: tb.bounds.right,
                    },
                });
                remainingWords = [];
            }
            else {
                // Find how many words fit in this column segment proportionally
                const segmentWidth = segmentRight - currentLeft;
                const fractionOfTotal = segmentWidth / totalWidth;
                const approxChars = Math.round(fractionOfTotal * tb.text.length);
                // Walk words to find the split closest to the proportional point
                let charCount = 0;
                let splitIdx = 0;
                for (let w = 0; w < remainingWords.length; w++) {
                    const nextCount = charCount + remainingWords[w].length + (w > 0 ? 1 : 0);
                    if (nextCount > approxChars && splitIdx > 0)
                        break;
                    charCount = nextCount;
                    splitIdx = w + 1;
                }
                if (splitIdx === 0)
                    splitIdx = 1; // take at least one word
                if (splitIdx >= remainingWords.length) {
                    // All remaining words fit here
                    result.push({
                        ...tb,
                        id: `${tb.id}-split${col}`,
                        text: remainingWords.join(" "),
                        bounds: {
                            ...tb.bounds,
                            left: currentLeft,
                            right: segmentRight,
                        },
                    });
                    remainingWords = [];
                }
                else {
                    const partWords = remainingWords.slice(0, splitIdx);
                    result.push({
                        ...tb,
                        id: `${tb.id}-split${col}`,
                        text: partWords.join(" "),
                        bounds: {
                            ...tb.bounds,
                            left: currentLeft,
                            right: segmentRight,
                        },
                    });
                    remainingWords = remainingWords.slice(splitIdx);
                    currentLeft = segmentRight;
                }
            }
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Full grid table (H + V lines)
// ---------------------------------------------------------------------------
function buildCells(rows, cols) {
    const cells = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            cells.push({ row, col, text: "", rowSpan: 1, colSpan: 1 });
        }
    }
    return cells;
}
function buildTableGrid(pageNumber, yLines, xLines, filteredSegments, textBoxes) {
    let rows = yLines.length - 1;
    const cols = xLines.length - 1;
    const cells = buildCells(rows, cols);
    const consumedIds = [];
    const yMin = yLines[yLines.length - 1];
    const yMax = yLines[0];
    const xMin = xLines[0];
    const xMax = xLines[xLines.length - 1];
    // Split text boxes that span multiple columns before placement
    const splitBoxes = splitCrossColumnBoxes(textBoxes, xLines);
    // Track which split piece IDs get placed in cells, so we can consume
    // the original (unsplit) text box IDs too.
    const placedSplitIds = new Set();
    // Look for header text boxes just above the grid.
    // Use the ORIGINAL (unsplit) text boxes for header detection so that
    // wide paragraph text isn't falsely split into column-sized header chunks.
    // Reject boxes wider than 1.5 columns — those are paragraph text, not headers.
    const avgColWidth = (xMax - xMin) / cols;
    const maxHeaderBoxWidth = avgColWidth * 1.5;
    const headerBoxes = textBoxes.filter((tb) => {
        const cy = (tb.bounds.top + tb.bounds.bottom) / 2;
        const cx = (tb.bounds.left + tb.bounds.right) / 2;
        const boxWidth = tb.bounds.right - tb.bounds.left;
        return (cy > yMax &&
            cy <= yMax + 20 &&
            cx >= xMin &&
            cx <= xMax &&
            boxWidth <= maxHeaderBoxWidth);
    });
    if (headerBoxes.length > 0) {
        rows += 1;
        for (const cell of cells)
            cell.row += 1;
        for (let col = 0; col < cols; col++) {
            cells.push({ row: 0, col, text: "", rowSpan: 1, colSpan: 1 });
        }
        for (const tb of headerBoxes) {
            const cx = (tb.bounds.left + tb.bounds.right) / 2;
            const col = xLines.findIndex((lineX, idx) => {
                const next = xLines[idx + 1];
                return next !== undefined && cx >= lineX && cx <= next;
            });
            if (col >= 0 && col < cols) {
                const cell = cells.find((c) => c.row === 0 && c.col === col);
                if (cell) {
                    cell.text =
                        cell.text.length === 0 ? tb.text : `${cell.text} ${tb.text}`;
                    consumedIds.push(tb.id);
                }
            }
        }
    }
    const cellBoxes = new Map();
    for (const tb of splitBoxes) {
        const cx = (tb.bounds.left + tb.bounds.right) / 2;
        const cy = (tb.bounds.top + tb.bounds.bottom) / 2;
        if (cy < yMin || cy > yMax || cx < xMin || cx > xMax)
            continue;
        const rays = castRaysForTextBox(tb, filteredSegments);
        const rayConfidence = rays.filter((r) => r.segmentId !== null).length;
        let row = yLines.findIndex((lineY, idx) => {
            const next = yLines[idx + 1];
            return next !== undefined && cy <= lineY && cy >= next;
        });
        if (row < 0 || row >= (headerBoxes.length > 0 ? rows - 1 : rows))
            continue;
        if (headerBoxes.length > 0)
            row += 1;
        const col = xLines.findIndex((lineX, idx) => {
            const next = xLines[idx + 1];
            return next !== undefined && cx >= lineX && cx <= next;
        });
        if (col < 0 || col >= cols)
            continue;
        if (rayConfidence === 0)
            continue;
        const cell = cells.find((c) => c.row === row && c.col === col);
        if (!cell)
            continue;
        if (!cellBoxes.has(cell))
            cellBoxes.set(cell, []);
        cellBoxes.get(cell)?.push(tb);
        consumedIds.push(tb.id);
        if (tb.id.includes("-split"))
            placedSplitIds.add(tb.id);
    }
    rows = expandSubRowsByYClusters(rows, cols, cells, cellBoxes);
    // Merge text boxes within each cell into cell text
    for (const [cell, boxes] of cellBoxes.entries()) {
        boxes.sort((a, b) => b.bounds.top - a.bounds.top);
        const lines = [];
        let currentLine = [];
        let currentY = boxes[0].bounds.top;
        for (const box of boxes) {
            if (Math.abs(box.bounds.top - currentY) > 5) {
                lines.push(currentLine.join(" "));
                currentLine = [box.text];
                currentY = box.bounds.top;
            }
            else {
                currentLine.push(box.text);
            }
        }
        if (currentLine.length > 0)
            lines.push(currentLine.join(" "));
        cell.text = lines.join("<br>");
    }
    const grid = pruneEmptyRowsAndCols({
        pageNumber,
        rows,
        cols,
        cells,
        warnings: [],
        topY: yLines[0],
        isBorderless: false,
    });
    // Also consume the original (unsplit) text box IDs when any of their
    // split pieces were placed in a cell.
    for (const splitId of placedSplitIds) {
        const origId = splitId.replace(/-split\d+$/, "");
        if (!consumedIds.includes(origId)) {
            consumedIds.push(origId);
        }
    }
    return { grid, consumedIds };
}
// ---------------------------------------------------------------------------
// H-line-only table (inferred columns)
// ---------------------------------------------------------------------------
const COL_GAP_THRESHOLD = 20;
const HONLY_ROW_GAP = 30;
const HONLY_ROW_TOLERANCE = 8;
const MIN_TABLE_HEIGHT = 24;
const MIN_LEFT_SPREAD = 50;
function inferXLinesFromBoxes(textBoxes, xMin, xMax) {
    const centers = textBoxes
        .map((tb) => (tb.bounds.left + tb.bounds.right) / 2)
        .sort((a, b) => a - b);
    if (centers.length === 0)
        return [xMin, xMax];
    const boundaries = [xMin];
    for (let i = 1; i < centers.length; i++) {
        if (centers[i] - centers[i - 1] >= COL_GAP_THRESHOLD) {
            boundaries.push((centers[i - 1] + centers[i]) / 2);
        }
    }
    boundaries.push(xMax);
    return boundaries;
}
function buildHLineOnlyTable(pageNumber, yLines, xMin, xMax, textBoxes, alreadyConsumed) {
    const yMax = yLines[0];
    const yMin = yLines[yLines.length - 1];
    const candidates = textBoxes.filter((tb) => !alreadyConsumed.has(tb.id));
    const BOX_LEFT_TOLERANCE = 30;
    const inRange = candidates.filter((tb) => {
        const cy = (tb.bounds.top + tb.bounds.bottom) / 2;
        return (tb.bounds.left >= xMin - BOX_LEFT_TOLERANCE &&
            tb.bounds.right <= xMax + BOX_LEFT_TOLERANCE &&
            cy >= yMin &&
            cy <= yMax);
    });
    // Extend downward below yMin
    const belowYMin = candidates
        .filter((tb) => {
        const cx = (tb.bounds.left + tb.bounds.right) / 2;
        const cy = (tb.bounds.top + tb.bounds.bottom) / 2;
        return cx >= xMin && cx <= xMax && cy < yMin;
    })
        .sort((a, b) => (b.bounds.top + b.bounds.bottom) / 2 -
        (a.bounds.top + a.bounds.bottom) / 2);
    const extensionBoxes = [];
    let lastY = yMin;
    for (const tb of belowYMin) {
        const cy = (tb.bounds.top + tb.bounds.bottom) / 2;
        if (lastY - cy > HONLY_ROW_GAP)
            break;
        extensionBoxes.push(tb);
        lastY = cy;
    }
    const allBoxes = [...inRange, ...extensionBoxes];
    if (allBoxes.length === 0)
        return null;
    const leftEdges = allBoxes.map((tb) => tb.bounds.left);
    if (Math.max(...leftEdges) - Math.min(...leftEdges) < MIN_LEFT_SPREAD)
        return null;
    const xLines = inferXLinesFromBoxes(allBoxes, xMin, xMax);
    if (xLines.length < 2)
        return null;
    const cols = xLines.length - 1;
    // Build visual rows
    const visualRows = [];
    const sortedBoxes = [...allBoxes].sort((a, b) => {
        const ya = (a.bounds.top + a.bounds.bottom) / 2;
        const yb = (b.bounds.top + b.bounds.bottom) / 2;
        if (Math.abs(ya - yb) > 0.5)
            return yb - ya;
        return a.bounds.left - b.bounds.left;
    });
    for (const box of sortedBoxes) {
        const cy = (box.bounds.top + box.bounds.bottom) / 2;
        const last = visualRows[visualRows.length - 1];
        if (last && Math.abs(last.midY - cy) <= HONLY_ROW_TOLERANCE) {
            last.boxes.push(box);
        }
        else {
            visualRows.push({ midY: cy, boxes: [box] });
        }
    }
    if (visualRows.length === 0)
        return null;
    const cells = [];
    const consumedIds = [];
    for (let rowIdx = 0; rowIdx < visualRows.length; rowIdx++) {
        const vrow = visualRows[rowIdx];
        const colBoxes = new Map();
        for (const box of vrow.boxes) {
            const cx = (box.bounds.left + box.bounds.right) / 2;
            const col = xLines.findIndex((lineX, idx) => {
                const next = xLines[idx + 1];
                return next !== undefined && cx >= lineX && cx <= next;
            });
            if (col >= 0 && col < cols) {
                if (!colBoxes.has(col))
                    colBoxes.set(col, []);
                colBoxes.get(col)?.push(box);
            }
        }
        for (let c = 0; c < cols; c++) {
            const cbs = (colBoxes.get(c) ?? []).sort((a, b) => a.bounds.left - b.bounds.left);
            cells.push({
                row: rowIdx,
                col: c,
                text: cbs.map((b) => b.text).join(" "),
                rowSpan: 1,
                colSpan: 1,
            });
            consumedIds.push(...cbs.map((b) => b.id));
        }
    }
    const contentTopY = visualRows.length > 0 ? visualRows[0].midY : yMax;
    const grid = pruneEmptyRowsAndCols({
        pageNumber,
        rows: visualRows.length,
        cols,
        cells,
        warnings: [],
        topY: contentTopY,
        isBorderless: false,
    });
    return { grid, consumedIds };
}
// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------
function pruneEmptyRowsAndCols(table) {
    const occupiedRows = new Set(table.cells.filter((c) => c.text.trim().length > 0).map((c) => c.row));
    const occupiedCols = new Set(table.cells.filter((c) => c.text.trim().length > 0).map((c) => c.col));
    if (occupiedRows.size === 0)
        return table;
    const rowMap = new Map();
    let newRow = 0;
    for (let r = 0; r < table.rows; r++) {
        if (occupiedRows.has(r))
            rowMap.set(r, newRow++);
    }
    const colMap = new Map();
    let newCol = 0;
    for (let c = 0; c < table.cols; c++) {
        if (occupiedCols.has(c))
            colMap.set(c, newCol++);
    }
    const prunedCells = table.cells
        .filter((c) => occupiedRows.has(c.row) && occupiedCols.has(c.col))
        .map((c) => ({
        ...c,
        row: rowMap.get(c.row) ?? c.row,
        col: colMap.get(c.col) ?? c.col,
    }));
    return { ...table, rows: newRow, cols: newCol, cells: prunedCells };
}
// ---------------------------------------------------------------------------
// Diagram vs table discrimination
// ---------------------------------------------------------------------------
/** Maximum column count for a plausible data table. */
const MAX_TABLE_COLS = 25;
/**
 * Returns true if a grid looks like a vector diagram rather than a data table.
 *
 * Heuristics (any match → diagram):
 *   1. Column count > 25 (diagrams create many X-lines from box edges)
 *   2. Fill ratio < 25% (most cells empty — scattered boxes)
 *   3. Fill < 50% AND duplicate text ratio > 30% (repeating labels in a
 *      diagram layout, e.g. "Hash", "Transaction" appearing in each column)
 *   4. Fill < 50% AND cols >= 6 (moderate sparseness with wide grid)
 */
function isDiagram(grid) {
    const totalCells = grid.rows * grid.cols;
    if (totalCells === 0)
        return true;
    const filled = grid.cells.filter((c) => c.text.trim().length > 0);
    const fillRatio = filled.length / totalCells;
    // Very high column count
    if (grid.cols > MAX_TABLE_COLS)
        return true;
    // Very sparse
    if (fillRatio < 0.25)
        return true;
    // Compute duplicate text ratio among non-trivial cells.
    // Exclude short values (≤3 chars) like "—", "V", "YES", "NO" which
    // naturally repeat in real data tables.
    const substantive = filled.filter((c) => c.text.trim().length > 3);
    const uniqueTexts = new Set(substantive.map((c) => c.text.trim())).size;
    const dupRatio = substantive.length > 2 ? 1 - uniqueTexts / substantive.length : 0;
    // Sparse + highly duplicated substantive text → repeating diagram
    if (fillRatio < 0.5 && dupRatio > 0.3)
        return true;
    // High duplication + wide grid → repeating diagram even at moderate fill
    if (dupRatio > 0.4 && grid.cols >= 6)
        return true;
    // Sparse + wide grid with no substantive text to judge
    if (fillRatio < 0.4 && grid.cols >= 6)
        return true;
    return false;
}
/**
 * Detect all table grids on a single page from its text boxes and segments.
 */
export function resolveTableGrids(pageNumber, textBoxes, segments) {
    const vertical = segments.filter((s) => Math.abs(s.x1 - s.x2) <= AXIS_EPSILON);
    const horizontal = segments.filter((s) => Math.abs(s.y1 - s.y2) <= AXIS_EPSILON);
    // Filter segments to the text's visible area
    const textYValues = textBoxes.flatMap((t) => [t.bounds.bottom, t.bounds.top]);
    const textYMin = textYValues.length > 0 ? Math.min(...textYValues) - PAGE_MARGIN : -Infinity;
    const textYMax = textYValues.length > 0 ? Math.max(...textYValues) + PAGE_MARGIN : Infinity;
    const textXValues = textBoxes.flatMap((t) => [t.bounds.left, t.bounds.right]);
    const textXMin = textXValues.length > 0 ? Math.min(...textXValues) - 100 : -Infinity;
    const textXMax = textXValues.length > 0 ? Math.max(...textXValues) + 100 : Infinity;
    const filteredH = horizontal.filter((s) => s.y1 >= textYMin &&
        s.y1 <= textYMax &&
        s.x1 <= textXMax &&
        s.x2 >= textXMin);
    const hMaxX2 = filteredH.length > 0 ? Math.max(...filteredH.map((s) => s.x2)) : textXMax;
    const vSegXMax = Math.max(textXMax, hMaxX2 + PAGE_MARGIN);
    const filteredV = vertical.filter((s) => {
        const segMin = Math.min(s.y1, s.y2);
        const segMax = Math.max(s.y1, s.y2);
        return (segMax >= textYMin &&
            segMin <= textYMax &&
            s.x1 >= textXMin &&
            s.x1 <= vSegXMax);
    });
    const allYLines = uniqueSorted(filteredH.flatMap((s) => [s.y1, s.y2])).sort((a, b) => b - a);
    if (allYLines.length < 2) {
        return { grids: [], consumedIds: [] };
    }
    const filteredSegments = [...filteredH, ...filteredV];
    const yGroups = splitYLinesIntoGroups(allYLines, filteredV);
    const grids = [];
    const gridConsumedIds = [];
    // Flat set for the alreadyConsumed check in H-line-only tables
    const allConsumedIds = [];
    for (const yLines of yGroups) {
        if (yLines.length < 2)
            continue;
        const yMin = yLines[yLines.length - 1];
        const yMax = yLines[0];
        const groupVerticals = filteredV.filter((s) => {
            const segMin = Math.min(s.y1, s.y2);
            const segMax = Math.max(s.y1, s.y2);
            return segMin < yMax - 1.5 && segMax > yMin + 1.5;
        });
        const groupXLines = uniqueSorted(groupVerticals.flatMap((s) => [s.x1, s.x2]));
        if (groupXLines.length < 2) {
            if (yMax - yMin < MIN_TABLE_HEIGHT)
                continue;
            const groupHoriz = filteredH.filter((s) => s.y1 >= yMin - 1.5 && s.y1 <= yMax + 1.5);
            if (groupHoriz.length === 0)
                continue;
            const hxMin = Math.min(...groupHoriz.map((s) => s.x1));
            const hxMax = Math.max(...groupHoriz.map((s) => s.x2));
            const result = buildHLineOnlyTable(pageNumber, yLines, hxMin, hxMax, textBoxes, new Set(allConsumedIds));
            if (result) {
                grids.push(result.grid);
                gridConsumedIds.push(result.consumedIds);
                allConsumedIds.push(...result.consumedIds);
            }
            continue;
        }
        if (yMax - yMin < MIN_TABLE_HEIGHT)
            continue;
        const result = buildTableGrid(pageNumber, yLines, groupXLines, filteredSegments, textBoxes);
        grids.push(result.grid);
        gridConsumedIds.push(result.consumedIds);
        allConsumedIds.push(...result.consumedIds);
    }
    // Filter out grids that look like vector diagrams, not data tables.
    // Their consumed text box IDs are released so the text becomes free text.
    const filteredGrids = [];
    const filteredConsumedIds = [];
    for (let i = 0; i < grids.length; i++) {
        if (isDiagram(grids[i]))
            continue;
        filteredGrids.push(grids[i]);
        filteredConsumedIds.push(...gridConsumedIds[i]);
    }
    return { grids: filteredGrids, consumedIds: filteredConsumedIds };
}
