/**
 * Markdown rendering for PDF pages.
 *
 * Converts table grids and free text boxes into markdown, handling:
 * - Table grid → markdown table (`| col | col |`)
 * - Free text → paragraphs with heading detection (by font size)
 * - Content ordering (top-to-bottom via Y coordinate)
 * - Paragraph wrap merging (lines broken across PDF line boundaries)
 * - Page number removal
 *
 * Ported from @oharato/pdf2md-ts, stripped of CJK/TDnet-specific logic.
 */
// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
/** Convert full-width ASCII characters (Ａ→A, ！→! etc.) to normal ASCII. */
function normalizeFullWidthAscii(text) {
    return text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}
function escapePipes(text) {
    return normalizeFullWidthAscii(text)
        .replaceAll("|", "\\|")
        .replaceAll("\n", "<br>");
}
/** Parse a markdown pipe-delimited row into cell strings. */
function parsePipeRow(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|"))
        return [];
    return trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
}
// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------
/**
 * Render a TableGrid as a markdown table.
 */
export function renderTableToMarkdown(table) {
    if (table.rows === 0 || table.cols === 0)
        return "";
    const matrix = Array.from({ length: table.rows }, () => Array.from({ length: table.cols }, () => ""));
    for (const cell of table.cells) {
        if (cell.row < table.rows && cell.col < table.cols) {
            matrix[cell.row][cell.col] = escapePipes(cell.text.trim());
        }
    }
    const normalized = normalizeShiftedSparseColumns(matrix);
    const promoted = promoteSubHeaderPrefixes(normalized);
    const header = `| ${promoted[0].join(" | ")} |`;
    const divider = `| ${Array.from({ length: promoted[0].length }, () => "---").join(" | ")} |`;
    const body = promoted
        .slice(1)
        .map((row) => `| ${row.join(" | ")} |`)
        .join("\n");
    return [header, divider, body].filter((l) => l.length > 0).join("\n");
}
/**
 * Fix tables with ≥5 columns where sparse single-value columns are
 * misaligned. Shifts those values to the adjacent dense column and
 * removes the now-empty sparse columns.
 */
function normalizeShiftedSparseColumns(matrix) {
    if (matrix.length === 0 || matrix[0].length < 5)
        return matrix;
    const _rows = matrix.length;
    const cols = matrix[0].length;
    const counts = Array.from({ length: cols }, (_, c) => matrix.reduce((n, row) => n + (row[c].trim().length > 0 ? 1 : 0), 0));
    const denseCols = new Set(counts
        .map((count, col) => ({ count, col }))
        .filter(({ col, count }) => col === 0 || count >= 2)
        .map(({ col }) => col));
    const sparseCols = counts
        .map((count, col) => ({ count, col }))
        .filter(({ col, count }) => col > 0 && col < cols - 1 && count === 1)
        .map(({ col }) => col);
    if (sparseCols.length < 2 || denseCols.size < 4)
        return matrix;
    const moves = [];
    for (const from of sparseCols) {
        const row = matrix.findIndex((r) => r[from].trim().length > 0);
        const to = from + 1;
        if (row < 0)
            return matrix;
        if (!denseCols.has(to))
            return matrix;
        if (matrix[row][to].trim().length > 0)
            return matrix;
        moves.push({ from, to, row });
    }
    const copy = matrix.map((row) => [...row]);
    for (const { from, to, row } of moves) {
        copy[row][to] =
            copy[row][to].trim().length > 0
                ? `${copy[row][to]} ${copy[row][from]}`
                : copy[row][from];
        copy[row][from] = "";
    }
    const keepCols = Array.from({ length: cols }, (_, c) => c).filter((c) => copy.some((row) => row[c].trim().length > 0));
    if (keepCols.length === cols)
        return copy;
    return copy.map((row) => keepCols.map((c) => row[c]));
}
/**
 * When a data row has ≥2 parenthesized qualifiers in non-first columns
 * (and the first column is empty), promote them into the header row.
 */
function promoteSubHeaderPrefixes(matrix) {
    if (matrix.length < 2)
        return matrix;
    const PAREN_RE = /^\([^)]{1,40}\)$/;
    const result = matrix.map((row) => [...row]);
    const cols = matrix[0].length;
    const rowsToRemove = new Set();
    for (let r = 1; r < result.length; r++) {
        if (rowsToRemove.has(r))
            continue;
        const promotable = [];
        for (let col = 1; col < cols; col++) {
            const cell = (result[r][col] ?? "").trim();
            if (!cell)
                continue;
            const parts = cell.split("<br>");
            if (parts.length === 1 && PAREN_RE.test(cell)) {
                promotable.push({ col, prefix: cell, isFullCell: true });
            }
            else if (parts.length >= 2 && PAREN_RE.test(parts[0].trim())) {
                promotable.push({
                    col,
                    prefix: parts[0].trim(),
                    isFullCell: false,
                });
            }
        }
        if (promotable.length < 2)
            continue;
        if (promotable.some((p) => p.isFullCell) && result[r][0].trim().length > 0)
            continue;
        for (const { col, prefix, isFullCell } of promotable) {
            result[0][col] = result[0][col].trim()
                ? `${result[0][col]} ${prefix}`
                : prefix;
            if (isFullCell) {
                result[r][col] = "";
            }
            else {
                const parts = result[r][col].split("<br>");
                result[r][col] = parts.slice(1).join("<br>");
            }
        }
        if (result[r].every((cell) => cell.trim().length === 0)) {
            rowsToRemove.add(r);
        }
    }
    return result.filter((_, r) => !rowsToRemove.has(r));
}
// ---------------------------------------------------------------------------
// Free text rendering
// ---------------------------------------------------------------------------
/** Y tolerance for grouping text boxes onto the same visual line. */
const TEXT_LINE_Y_TOLERANCE = 3;
/** Minimum X gap between adjacent boxes to mark line as tabular. */
const TABULAR_X_GAP = 30;
/**
 * Minimum font size (pts) to consider when computing the modal body font.
 * Tiny labels from diagrams, footnote markers, and superscripts are excluded
 * so they don't skew the modal toward small sizes.
 */
const MIN_BODY_FONT_SIZE = 7;
/**
 * Compute the most frequent font size among text boxes, ignoring very small
 * text that likely comes from diagrams, footnotes, or superscripts.
 */
function modalFontSize(textBoxes) {
    const counts = new Map();
    for (const tb of textBoxes) {
        const size = Math.round((tb.fontSize ?? 0) * 10) / 10;
        if (size < MIN_BODY_FONT_SIZE)
            continue;
        counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    let modal = 0;
    let maxCount = 0;
    for (const [size, count] of counts) {
        if (count > maxCount) {
            maxCount = count;
            modal = size;
        }
    }
    return modal;
}
/** Group free text boxes into horizontal lines, sorted top-to-bottom. */
function groupFreeTextIntoLines(textBoxes) {
    if (textBoxes.length === 0)
        return [];
    const sorted = [...textBoxes].sort((a, b) => {
        const ya = (a.bounds.top + a.bounds.bottom) / 2;
        const yb = (b.bounds.top + b.bounds.bottom) / 2;
        const dy = yb - ya;
        if (Math.abs(dy) > TEXT_LINE_Y_TOLERANCE)
            return dy;
        return a.bounds.left - b.bounds.left;
    });
    const lines = [];
    let curParts = [sorted[0].text];
    let curBoxes = [sorted[0]];
    let curY = (sorted[0].bounds.top + sorted[0].bounds.bottom) / 2;
    let curTopY = curY;
    let curFontSize = sorted[0].fontSize;
    let curIsBold = sorted[0].isBold;
    const finishLine = () => {
        let isTabular = false;
        for (let j = 1; j < curBoxes.length; j++) {
            if (curBoxes[j].bounds.left - curBoxes[j - 1].bounds.right >
                TABULAR_X_GAP) {
                isTabular = true;
                break;
            }
        }
        lines.push({
            text: curParts.join(" "),
            topY: curTopY,
            fontSize: curFontSize,
            isBold: curIsBold,
            isTabular,
        });
    };
    for (let i = 1; i < sorted.length; i++) {
        const box = sorted[i];
        const cy = (box.bounds.top + box.bounds.bottom) / 2;
        if (Math.abs(cy - curY) <= TEXT_LINE_Y_TOLERANCE) {
            curParts.push(box.text);
            curBoxes.push(box);
            curFontSize = Math.max(curFontSize, box.fontSize);
            curIsBold = curIsBold || box.isBold;
        }
        else {
            finishLine();
            curParts = [box.text];
            curBoxes = [box];
            curY = cy;
            curTopY = cy;
            curFontSize = box.fontSize;
            curIsBold = box.isBold;
        }
    }
    finishLine();
    return lines;
}
/** Determine markdown heading prefix based on font size relative to body. */
function headingPrefix(fontSize, bodyFontSize, isBold) {
    if (bodyFontSize <= 0)
        return "";
    const ratio = fontSize / bodyFontSize;
    // Large headings (>2x body size)
    if (ratio >= 2.0)
        return "# ";
    // Medium headings (~1.5x body size)
    if (ratio >= 1.4)
        return "## ";
    // Small headings (bold and slightly larger)
    if (ratio >= 1.1 && isBold)
        return "### ";
    return "";
}
// ---------------------------------------------------------------------------
// Block merging
// ---------------------------------------------------------------------------
/** Merge consecutive blocks with the same heading prefix (wrapped headings). */
function mergeConsecutiveHeadings(blocks, bodyFS) {
    if (blocks.length === 0)
        return [];
    const HEADING_RE = /^(#{1,6} )/;
    const maxGap = Math.max(bodyFS * 3, 30);
    const merged = [];
    let cur = { ...blocks[0] };
    for (let i = 1; i < blocks.length; i++) {
        const next = blocks[i];
        const curMatch = cur.content.match(HEADING_RE);
        const nextMatch = next.content.match(HEADING_RE);
        const gap = cur.topY - next.topY;
        if (curMatch &&
            nextMatch &&
            curMatch[1] === nextMatch[1] &&
            gap <= maxGap) {
            cur = {
                topY: cur.topY,
                content: `${cur.content} ${next.content.slice(nextMatch[1].length)}`,
                isTabular: cur.isTabular || next.isTabular,
            };
        }
        else {
            merged.push(cur);
            cur = { ...next };
        }
    }
    merged.push(cur);
    return merged;
}
/**
 * Merge consecutive plain-text blocks that are wrapped lines of the same paragraph.
 */
function mergeParagraphWraps(blocks, bodyFS) {
    if (blocks.length === 0 || bodyFS <= 0)
        return blocks;
    const HEADING_RE = /^#{1,6} /;
    const SENTENCE_END_RE = /[.!?…)\]]\s*$/;
    const maxGap = bodyFS * 2.0;
    const MIN_WRAP_LENGTH = 25;
    const merged = [];
    let cur = { ...blocks[0], lastTopY: blocks[0].topY };
    for (let i = 1; i < blocks.length; i++) {
        const next = blocks[i];
        const curIsBody = !HEADING_RE.test(cur.content) && !cur.content.startsWith("|");
        const nextIsBody = !HEADING_RE.test(next.content) && !next.content.startsWith("|");
        const gap = cur.lastTopY - next.topY;
        const isWrap = curIsBody &&
            nextIsBody &&
            !cur.isTabular &&
            !next.isTabular &&
            gap > 0 &&
            gap <= maxGap &&
            cur.content.length > MIN_WRAP_LENGTH &&
            !SENTENCE_END_RE.test(cur.content);
        if (isWrap) {
            cur = {
                topY: cur.topY,
                lastTopY: next.topY,
                content: `${cur.content.trimEnd()} ${next.content.trimStart()}`,
                isTabular: false,
            };
        }
        else {
            merged.push({ topY: cur.topY, content: cur.content });
            cur = { ...next, lastTopY: next.topY };
        }
    }
    merged.push({ topY: cur.topY, content: cur.content });
    return merged;
}
/** Remove page number blocks near the bottom of the page. */
function removePageNumbers(blocks) {
    const PAGE_NUM_RE = /^(?:#{1,6}\s*)?\d+\s*$/;
    const BOTTOM_Y = 120;
    return blocks.filter((block, idx) => {
        const isBottom = idx >= blocks.length - 3;
        const isLowY = block.topY <= BOTTOM_Y;
        const isPageNum = PAGE_NUM_RE.test(block.content.trim());
        return !(isBottom && isLowY && isPageNum);
    });
}
// ---------------------------------------------------------------------------
// Detached first-column table reconstruction
// ---------------------------------------------------------------------------
/**
 * Fix tables where the first column was emitted as free text blocks
 * around a markdown table containing only the right-side columns.
 *
 * Detects: a plain-text header line with (N+1) tokens above an N-column
 * markdown table, plus short label lines whose count matches the table's
 * logical row count. Reconstructs into a proper (N+1)-column table.
 */
function normalizeDetachedFirstColumnTables(blocks) {
    const HEADING_RE = /^#{1,6}\s/;
    const isTableBlock = (text) => text.trimStart().startsWith("|");
    const isPlainBlock = (text) => !HEADING_RE.test(text) && !isTableBlock(text);
    const isShortLabel = (text) => {
        const t = text.trim();
        return t.length > 0 && t.length <= 40;
    };
    const splitTokens = (text) => text
        .trim()
        .split(/[ \t]+/)
        .filter(Boolean);
    const replacements = new Map();
    const remove = new Set();
    for (let tableIdx = 0; tableIdx < blocks.length; tableIdx++) {
        if (remove.has(tableIdx))
            continue;
        const tableBlock = blocks[tableIdx];
        if (!isTableBlock(tableBlock.content))
            continue;
        const tableLines = tableBlock.content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("|"));
        const dataRows = tableLines
            .filter((line) => !/^\|\s*[-: ]+\|/.test(line))
            .map(parsePipeRow)
            .filter((row) => row.length > 0);
        if (dataRows.length === 0)
            continue;
        const cols = dataRows[0].length;
        if (cols < 2 || dataRows.some((row) => row.length !== cols))
            continue;
        // Expand by <br> count to get logical row count
        const logicalRows = [];
        for (const row of dataRows) {
            const splitCells = row.map((cell) => cell.split("<br>").map((p) => p.trim()));
            const rowSpan = Math.max(...splitCells.map((parts) => parts.length));
            for (let k = 0; k < rowSpan; k++) {
                logicalRows.push(splitCells.map((parts) => parts[k] ?? ""));
            }
        }
        if (logicalRows.length < 2)
            continue;
        // Find header with (cols + 1) non-numeric tokens
        let headerIdx = -1;
        let headerTokens = [];
        for (let i = Math.max(0, tableIdx - 4); i <= tableIdx - 1; i++) {
            const text = normalizeFullWidthAscii(blocks[i].content).trim();
            if (!isPlainBlock(text))
                continue;
            const tokens = splitTokens(text);
            if (tokens.length === cols + 1 &&
                tokens.every((tok) => !/[0-9]/.test(tok))) {
                headerIdx = i;
                headerTokens = tokens;
            }
        }
        if (headerIdx < 0)
            continue;
        // Collect short label lines above/below table
        const aboveLabels = [];
        for (let i = tableIdx - 1; i > headerIdx; i--) {
            const text = normalizeFullWidthAscii(blocks[i].content).trim();
            if (!isPlainBlock(text) || !isShortLabel(text))
                break;
            aboveLabels.push({ idx: i, text });
        }
        aboveLabels.reverse();
        const belowLabels = [];
        for (let i = tableIdx + 1; i < blocks.length; i++) {
            const text = normalizeFullWidthAscii(blocks[i].content).trim();
            if (!isPlainBlock(text) || !isShortLabel(text))
                break;
            belowLabels.push({ idx: i, text });
        }
        const labels = [...aboveLabels, ...belowLabels];
        if (labels.length !== logicalRows.length)
            continue;
        // Reconstruct the full table
        const normalizedLines = [];
        normalizedLines.push(`| ${headerTokens.join(" | ")} |`);
        normalizedLines.push(`| ${Array.from({ length: cols + 1 }, () => "---").join(" | ")} |`);
        for (let r = 0; r < logicalRows.length; r++) {
            normalizedLines.push(`| ${labels[r].text} | ${logicalRows[r].join(" | ")} |`);
        }
        replacements.set(tableIdx, normalizedLines.join("\n"));
        remove.add(headerIdx);
        for (const label of labels)
            remove.add(label.idx);
    }
    if (replacements.size === 0 && remove.size === 0)
        return blocks;
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
        if (remove.has(i))
            continue;
        const replaced = replacements.get(i);
        if (replaced) {
            out.push({ topY: blocks[i].topY, content: replaced });
        }
        else {
            out.push(blocks[i]);
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Render one page's content: free text and tables interleaved top-to-bottom.
 */
export function renderPageContent(freeTextBoxes, tables, imageBlocks = [], allTextBoxes) {
    const blocks = [];
    // Use ALL text boxes (before table/diagram filtering) for modal font size,
    // so that diagram labels released as free text don't skew the body size.
    const bodyFS = modalFontSize(allTextBoxes ?? freeTextBoxes);
    // Free text lines
    for (const line of groupFreeTextIntoLines(freeTextBoxes)) {
        const prefix = headingPrefix(line.fontSize, bodyFS, line.isBold);
        blocks.push({
            topY: line.topY,
            content: prefix + line.text,
            isTabular: prefix === "" && line.isTabular,
        });
    }
    // Tables
    for (const table of tables) {
        const md = renderTableToMarkdown(table);
        if (md.length > 0) {
            blocks.push({ topY: table.topY, content: md });
        }
    }
    // Images
    for (const img of imageBlocks) {
        blocks.push({ topY: img.topY, content: img.markdown });
    }
    // Sort top-to-bottom (higher Y = higher on page = comes first)
    blocks.sort((a, b) => b.topY - a.topY);
    const cleaned = removePageNumbers(blocks);
    const headingsMerged = mergeConsecutiveHeadings(cleaned, bodyFS);
    const merged = mergeParagraphWraps(headingsMerged, bodyFS);
    const normalized = normalizeDetachedFirstColumnTables(merged);
    return normalized
        .map((b) => b.content)
        .join("\n\n")
        .trim();
}
