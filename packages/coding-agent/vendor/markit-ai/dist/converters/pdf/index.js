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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectColumns } from "./columns.js";
import { extractPages, renderImageRegion } from "./extract.js";
import { resolveTableGrids } from "./grid.js";
import { stripHeadersFooters } from "./headers.js";
import { renderPageContent } from "./render.js";
const EXTENSIONS = [".pdf"];
const MIMETYPES = ["application/pdf", "application/x-pdf"];
/**
 * Process a set of text boxes (one column or full page): run table detection,
 * separate free text, and render to markdown.
 */
function processColumn(pageNumber, textBoxes, segments, imageBlocks) {
    const { grids, consumedIds } = resolveTableGrids(pageNumber, textBoxes, segments);
    const consumedSet = new Set(consumedIds);
    const freeTextBoxes = textBoxes.filter((tb) => !consumedSet.has(tb.id));
    return renderPageContent(freeTextBoxes, grids, imageBlocks, textBoxes);
}
export class PdfConverter {
    name = "pdf";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
            return true;
        }
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m))) {
            return true;
        }
        return false;
    }
    async convert(input, streamInfo) {
        const pdfBytes = new Uint8Array(input);
        const pages = await extractPages(pdfBytes);
        // Remove running headers/footers before processing
        stripHeadersFooters(pages);
        const imageDir = streamInfo.imageDir;
        if (imageDir) {
            mkdirSync(imageDir, { recursive: true });
        }
        const pageMarkdowns = [];
        for (const page of pages) {
            // Build image blocks for this page
            const imageBlocks = [];
            if (imageDir && page.images.length > 0) {
                for (const img of page.images) {
                    const filename = `${img.id}.png`;
                    const filepath = join(imageDir, filename);
                    try {
                        const png = renderImageRegion(pdfBytes, img);
                        writeFileSync(filepath, png);
                        imageBlocks.push({
                            topY: img.topY,
                            markdown: `![${img.id}](${filepath})`,
                        });
                    }
                    catch {
                        // Image rendering failed — skip
                    }
                }
            }
            else if (page.images.length > 0) {
                for (const img of page.images) {
                    imageBlocks.push({
                        topY: img.topY,
                        markdown: `<!-- image: ${img.id} (page ${img.pageNumber}, ${img.bbox.w}x${img.bbox.h}pt) -->`,
                    });
                }
            }
            // Detect column layout.
            // If the page has vertical segments (tables), suppress column detection
            // when one detected column is very narrow — that's a table's first column,
            // not a page layout column.
            const layout = detectColumns(page.textBoxes);
            if (layout.columnCount > 1 &&
                page.segments.some((s) => Math.abs(s.x1 - s.x2) <= 0.8)) {
                const pageXMin = Math.min(...page.textBoxes.map((tb) => tb.bounds.left));
                const pageXMax = Math.max(...page.textBoxes.map((tb) => tb.bounds.right));
                const pageWidth = pageXMax - pageXMin;
                const minColFraction = 0.3;
                const tooNarrow = layout.columns.some((col) => {
                    const colXMin = Math.min(...col.map((tb) => tb.bounds.left));
                    const colXMax = Math.max(...col.map((tb) => tb.bounds.right));
                    return (colXMax - colXMin) / pageWidth < minColFraction;
                });
                if (tooNarrow) {
                    layout.columnCount = 1;
                    layout.columns = [page.textBoxes];
                    layout.boundaries = [];
                }
            }
            if (layout.columnCount === 1) {
                // Single column — process normally
                const md = processColumn(page.pageNumber, page.textBoxes, page.segments, imageBlocks);
                if (md.length > 0)
                    pageMarkdowns.push(md);
            }
            else {
                // Multi-column — process each column independently, then join
                const columnMarkdowns = [];
                for (const colBoxes of layout.columns) {
                    // Filter segments to those within this column's X range
                    const colXMin = Math.min(...colBoxes.map((tb) => tb.bounds.left));
                    const colXMax = Math.max(...colBoxes.map((tb) => tb.bounds.right));
                    const margin = 10;
                    const colSegments = page.segments.filter((seg) => {
                        const segXMin = Math.min(seg.x1, seg.x2);
                        const segXMax = Math.max(seg.x1, seg.x2);
                        return segXMax >= colXMin - margin && segXMin <= colXMax + margin;
                    });
                    // Images go with the first column only (no X info to split by)
                    const md = processColumn(page.pageNumber, colBoxes, colSegments, columnMarkdowns.length === 0 ? imageBlocks : []);
                    if (md.length > 0)
                        columnMarkdowns.push(md);
                }
                const joined = columnMarkdowns.join("\n\n");
                if (joined.length > 0)
                    pageMarkdowns.push(joined);
            }
        }
        return { markdown: pageMarkdowns.join("\n\n") };
    }
}
