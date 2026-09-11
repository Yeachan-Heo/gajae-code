/**
 * PDF content extraction using mupdf.
 *
 * Extracts text boxes (with position, font size, bold) and vector line
 * segments (table borders) from each page. Uses mupdf's native WASM
 * engine for fast parsing, and reads raw content streams for vector graphics.
 *
 * Coordinate system: PDF native (origin = bottom-left, Y increases upward).
 */
// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
/** Y tolerance for merging text fragments on the same visual line. */
const SAME_LINE_Y_TOLERANCE = 2;
/** Max horizontal gap (pts) to merge adjacent fragments into one text box. */
const MAX_MERGE_GAP = 14;
// Reuse the asynchronously initialized module when rendering extracted images.
let mupdf;
/**
 * Merge horizontally adjacent raw text items on the same visual line into
 * word/phrase-level text boxes.
 */
function mergeIntoWords(raws) {
    if (raws.length === 0)
        return [];
    // Sort by Y descending (top-first in bottom-left coords), then X ascending
    const sorted = [...raws].sort((a, b) => {
        const dy = b.y - a.y;
        return Math.abs(dy) > SAME_LINE_Y_TOLERANCE ? dy : a.x - b.x;
    });
    const merged = [];
    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i];
        const sameY = Math.abs(next.y - cur.y) <= SAME_LINE_Y_TOLERANCE;
        const close = next.x <= cur.x + cur.width + MAX_MERGE_GAP;
        if (sameY && close) {
            const gap = next.x - (cur.x + cur.width);
            const sep = gap > 1 ? " " : "";
            cur.text += sep + next.text;
            cur.width = next.x + next.width - cur.x;
            cur.height = Math.max(cur.height, next.height);
            cur.fontSize = Math.max(cur.fontSize, next.fontSize);
            cur.isBold = cur.isBold || next.isBold;
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
 * Extract text boxes from a mupdf page using structured text output.
 *
 * mupdf's structured text JSON uses top-left origin; we convert to
 * bottom-left (standard PDF coordinates) using the page height.
 */
function extractTextBoxes(page, pageNumber, pageHeight, stext) {
    if (!stext) {
        stext = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
    }
    const raws = [];
    for (const block of stext.blocks) {
        if (block.type !== "text")
            continue;
        for (const line of block.lines) {
            const text = line.text?.trim();
            if (!text)
                continue;
            const fontSize = line.font?.size ?? 0;
            const weight = line.font?.weight ?? "normal";
            const fontName = line.font?.name ?? "";
            const isBold = weight === "bold" ||
                /bold/i.test(fontName) ||
                /Black|Heavy/i.test(fontName);
            // mupdf bbox: {x, y, w, h} in top-left coords
            // Convert to bottom-left: pdfY = pageHeight - (bbox.y + bbox.h)
            const bboxY = line.bbox.y;
            const bboxH = line.bbox.h;
            const pdfY = pageHeight - (bboxY + bboxH);
            raws.push({
                text,
                x: line.bbox.x,
                y: pdfY,
                width: line.bbox.w,
                height: bboxH,
                fontSize,
                isBold,
            });
        }
    }
    const words = mergeIntoWords(raws);
    return words
        .map((w, i) => ({
        id: `p${pageNumber}-t${i}`,
        text: w.text.trim(),
        pageNumber,
        fontSize: w.fontSize,
        isBold: w.isBold,
        bounds: {
            left: w.x,
            right: w.x + w.width,
            bottom: w.y,
            top: w.y + w.height,
        },
    }))
        .filter((b) => b.text.length > 0);
}
// ---------------------------------------------------------------------------
// Vector segment extraction from raw content stream
// ---------------------------------------------------------------------------
/** Minimum aspect ratio for a filled rect to be considered a line. */
const LINE_ASPECT_THRESHOLD = 6;
/** Minimum length (pts) for a segment to count. */
const MIN_LENGTH = 2;
/** Maximum thickness (pts) for a border line (filters out filled areas). */
const MAX_THICKNESS = 3;
/**
 * Convert a thin filled rectangle to a horizontal or vertical segment.
 * Returns null if the rect doesn't look like a border line.
 */
function thinRectToSegment(id, x, y, w, h) {
    const aw = Math.abs(w);
    const ah = Math.abs(h);
    if (aw > ah * LINE_ASPECT_THRESHOLD &&
        aw >= MIN_LENGTH &&
        ah <= MAX_THICKNESS) {
        // Horizontal line
        const cy = y + ah / 2;
        return { id, x1: x, y1: cy, x2: x + aw, y2: cy };
    }
    if (ah > aw * LINE_ASPECT_THRESHOLD &&
        ah >= MIN_LENGTH &&
        aw <= MAX_THICKNESS) {
        // Vertical line
        const cx = x + aw / 2;
        return { id, x1: cx, y1: y, x2: cx, y2: y + ah };
    }
    return null;
}
/**
 * Emit 4 edge segments from a stroked rectangle.
 */
function pushStrokedRectEdges(segments, id, x, y, w, h) {
    const aw = Math.abs(w);
    const ah = Math.abs(h);
    const base = id;
    if (aw >= MIN_LENGTH) {
        segments.push({ id: `${base}-b`, x1: x, y1: y, x2: x + aw, y2: y });
        segments.push({
            id: `${base}-t`,
            x1: x,
            y1: y + ah,
            x2: x + aw,
            y2: y + ah,
        });
    }
    if (ah >= MIN_LENGTH) {
        segments.push({ id: `${base}-l`, x1: x, y1: y, x2: x, y2: y + ah });
        segments.push({
            id: `${base}-r`,
            x1: x + aw,
            y1: y,
            x2: x + aw,
            y2: y + ah,
        });
    }
}
const CTM_IDENTITY = [1, 0, 0, 1, 0, 0];
/** Concatenate two affine matrices: result = parent × child. */
function ctmConcat(p, c) {
    return [
        p[0] * c[0] + p[2] * c[1],
        p[1] * c[0] + p[3] * c[1],
        p[0] * c[2] + p[2] * c[3],
        p[1] * c[2] + p[3] * c[3],
        p[0] * c[4] + p[2] * c[5] + p[4],
        p[1] * c[4] + p[3] * c[5] + p[5],
    ];
}
function ctmApply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
// ---------------------------------------------------------------------------
// Content stream parsing
// ---------------------------------------------------------------------------
/**
 * Parse a PDF content stream and extract line segments from thin filled
 * rectangles (re+f), stroked rectangles (re+S), and explicit lines (m/l+S).
 * Tracks the CTM via q/Q/cm operators so coordinates are in page space.
 */
function extractSegmentsFromContentStream(raw, pageNumber) {
    const segments = [];
    const tokens = tokenizeContentStream(raw);
    let idx = 0;
    let strokeWidth = 1.0;
    // Graphics state stack (q/Q): saves CTM + strokeWidth
    let ctm = [...CTM_IDENTITY];
    const stateStack = [];
    // State for path building (in user coordinates, pre-CTM)
    let curX = 0;
    let curY = 0;
    let pathStartX = 0;
    let pathStartY = 0;
    const pendingRects = [];
    const pendingLines = [];
    function flushPath(mode) {
        const sid = () => `p${pageNumber}-s${segments.length}`;
        if (mode === "fill") {
            for (const r of pendingRects) {
                // Transform the rect corners through CTM, then check if it's a thin line
                const [x0, y0] = ctmApply(ctm, r.x, r.y);
                const [x1, y1] = ctmApply(ctm, r.x + r.w, r.y + r.h);
                const seg = thinRectToSegment(sid(), Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
                if (seg)
                    segments.push(seg);
            }
        }
        else if (mode === "stroke" && strokeWidth <= MAX_THICKNESS) {
            for (const r of pendingRects) {
                const [x0, y0] = ctmApply(ctm, r.x, r.y);
                const [x1, y1] = ctmApply(ctm, r.x + r.w, r.y + r.h);
                pushStrokedRectEdges(segments, sid(), Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
            }
            for (const l of pendingLines) {
                const [lx1, ly1] = ctmApply(ctm, l.x1, l.y1);
                const [lx2, ly2] = ctmApply(ctm, l.x2, l.y2);
                const dx = Math.abs(lx2 - lx1);
                const dy = Math.abs(ly2 - ly1);
                // Only keep H/V lines
                if ((dx >= MIN_LENGTH && dy < 1) || (dy >= MIN_LENGTH && dx < 1)) {
                    segments.push({ id: sid(), x1: lx1, y1: ly1, x2: lx2, y2: ly2 });
                }
            }
        }
        pendingRects.length = 0;
        pendingLines.length = 0;
    }
    while (idx < tokens.length) {
        const t = tokens[idx];
        if (t === "q") {
            stateStack.push({ ctm: [...ctm], strokeWidth });
        }
        else if (t === "Q") {
            const saved = stateStack.pop();
            if (saved) {
                ctm = saved.ctm;
                strokeWidth = saved.strokeWidth;
            }
        }
        else if (t === "cm" && idx >= 6) {
            const a = Number(tokens[idx - 6]);
            const b = Number(tokens[idx - 5]);
            const c = Number(tokens[idx - 4]);
            const d = Number(tokens[idx - 3]);
            const e = Number(tokens[idx - 2]);
            const f = Number(tokens[idx - 1]);
            ctm = ctmConcat(ctm, [a, b, c, d, e, f]);
        }
        else if (t === "w" && idx >= 1) {
            strokeWidth = Number(tokens[idx - 1]) || strokeWidth;
        }
        else if (t === "re" && idx >= 4) {
            const x = Number(tokens[idx - 4]);
            const y = Number(tokens[idx - 3]);
            const w = Number(tokens[idx - 2]);
            const h = Number(tokens[idx - 1]);
            if (Number.isFinite(x + y + w + h)) {
                pendingRects.push({ x, y, w, h });
            }
        }
        else if (t === "m" && idx >= 2) {
            curX = Number(tokens[idx - 2]);
            curY = Number(tokens[idx - 1]);
            pathStartX = curX;
            pathStartY = curY;
        }
        else if (t === "l" && idx >= 2) {
            const x2 = Number(tokens[idx - 2]);
            const y2 = Number(tokens[idx - 1]);
            pendingLines.push({ x1: curX, y1: curY, x2, y2 });
            curX = x2;
            curY = y2;
        }
        else if (t === "h") {
            // closePath: line back to start
            if (curX !== pathStartX || curY !== pathStartY) {
                pendingLines.push({
                    x1: curX,
                    y1: curY,
                    x2: pathStartX,
                    y2: pathStartY,
                });
            }
            curX = pathStartX;
            curY = pathStartY;
        }
        else if (t === "f" || t === "F" || t === "f*") {
            flushPath("fill");
        }
        else if (t === "S" || t === "s") {
            if (t === "s") {
                // closeStroke: implicit closePath
                if (curX !== pathStartX || curY !== pathStartY) {
                    pendingLines.push({
                        x1: curX,
                        y1: curY,
                        x2: pathStartX,
                        y2: pathStartY,
                    });
                }
            }
            flushPath("stroke");
        }
        else if (t === "B" || t === "B*" || t === "b" || t === "b*") {
            // fill + stroke combined
            flushPath("fill");
            flushPath("stroke");
        }
        else if (t === "n") {
            // end path without painting — discard
            pendingRects.length = 0;
            pendingLines.length = 0;
        }
        idx++;
    }
    return segments;
}
/**
 * Fast tokenizer for PDF content streams.
 * Splits on whitespace, skipping comments and string literals.
 */
function tokenizeContentStream(raw) {
    const tokens = [];
    const len = raw.length;
    let i = 0;
    while (i < len) {
        const ch = raw.charCodeAt(i);
        // Skip whitespace
        if (ch <= 32) {
            i++;
            continue;
        }
        // Skip comments
        if (ch === 37 /* % */) {
            while (i < len && raw.charCodeAt(i) !== 10)
                i++;
            continue;
        }
        // Skip string literals (...)
        if (ch === 40 /* ( */) {
            let depth = 1;
            i++;
            while (i < len && depth > 0) {
                const c = raw.charCodeAt(i);
                if (c === 92 /* \ */) {
                    i++;
                }
                else if (c === 40) {
                    depth++;
                }
                else if (c === 41) {
                    depth--;
                }
                i++;
            }
            continue;
        }
        // Skip hex strings <...>
        if (ch === 60 /* < */ && i + 1 < len && raw.charCodeAt(i + 1) !== 60) {
            i++;
            while (i < len && raw.charCodeAt(i) !== 62)
                i++;
            i++; // skip >
            continue;
        }
        // Skip dict delimiters << >>
        if (ch === 60 && i + 1 < len && raw.charCodeAt(i + 1) === 60) {
            i += 2;
            continue;
        }
        if (ch === 62 && i + 1 < len && raw.charCodeAt(i + 1) === 62) {
            i += 2;
            continue;
        }
        // Regular token: read until whitespace or delimiter
        const start = i;
        while (i < len) {
            const c = raw.charCodeAt(i);
            if (c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 37)
                break;
            i++;
        }
        if (i > start) {
            tokens.push(raw.substring(start, i));
        }
    }
    return tokens;
}
// ---------------------------------------------------------------------------
// Image region detection
// ---------------------------------------------------------------------------
/** Minimum area (pts²) for an image to be considered a diagram, not an icon. */
const MIN_IMAGE_AREA = 5000;
function extractImageRegions(stext, pageNumber, pageHeight) {
    const regions = [];
    for (const block of stext.blocks) {
        if (block.type !== "image")
            continue;
        const { x, y, w, h } = block.bbox;
        if (w * h < MIN_IMAGE_AREA)
            continue; // skip tiny icons
        // Convert Y from mupdf (top-left) to PDF (bottom-left) for ordering
        const pdfTopY = pageHeight - y;
        regions.push({
            id: `p${pageNumber}-img${regions.length}`,
            pageNumber,
            bbox: { x, y, w, h },
            topY: pdfTopY,
        });
    }
    return regions;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Render an image region from a PDF page as a PNG buffer.
 * Uses mupdf's DrawDevice to render just the cropped area at 2x resolution.
 */
export function renderImageRegion(input, region) {
    const doc = mupdf.Document.openDocument(input, "application/pdf");
    const page = doc.loadPage(region.pageNumber - 1);
    const pad = 10;
    const bx = region.bbox.x - pad;
    const by = region.bbox.y - pad;
    const bw = region.bbox.w + 2 * pad;
    const bh = region.bbox.h + 2 * pad;
    const scale = 2;
    const pw = Math.round(bw * scale);
    const ph = Math.round(bh * scale);
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
    pix.clear(255);
    const matrix = [scale, 0, 0, scale, -bx * scale, -by * scale];
    const dl = page.toDisplayList();
    const dev = new mupdf.DrawDevice(matrix, pix);
    dl.run(dev, mupdf.Matrix.identity);
    dev.close();
    return pix.asPNG();
}
/**
 * Extract text boxes and vector segments from all pages of a PDF buffer.
 */
export async function extractPages(input) {
    try {
        mupdf = await import("mupdf");
    }
    catch (cause) {
        throw new Error("MuPDF module initialization failed", { cause });
    }
    const doc = mupdf.Document.openDocument(input, "application/pdf");
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
        const pageNumber = i + 1;
        const page = doc.loadPage(i);
        const bounds = page.getBounds();
        const pageHeight = bounds[3] - bounds[1];
        // Single structured text pass with both flags
        const stext = JSON.parse(page.toStructuredText("preserve-whitespace,preserve-images").asJSON());
        // Extract text boxes and image regions from the same parse
        const textBoxes = extractTextBoxes(page, pageNumber, pageHeight, stext);
        const images = extractImageRegions(stext, pageNumber, pageHeight);
        // Extract vector segments from raw content stream
        let segments = [];
        try {
            const pageObj = page.getObject();
            const contents = pageObj.get("Contents");
            if (contents) {
                let rawBytes;
                if (contents.isArray()) {
                    // Multiple content streams — concatenate
                    const parts = [];
                    const len = contents.length ?? 0;
                    for (let j = 0; j < len; j++) {
                        const stream = contents.get(j);
                        if (stream?.readStream) {
                            parts.push(stream.readStream().asUint8Array());
                        }
                    }
                    const totalLen = parts.reduce((s, p) => s + p.length, 0);
                    rawBytes = new Uint8Array(totalLen);
                    let offset = 0;
                    for (const part of parts) {
                        rawBytes.set(part, offset);
                        offset += part.length;
                    }
                }
                else {
                    rawBytes = contents.readStream().asUint8Array();
                }
                const raw = new TextDecoder().decode(rawBytes);
                segments = extractSegmentsFromContentStream(raw, pageNumber);
            }
        }
        catch {
            // Content stream extraction failed — proceed with text only
        }
        pages.push({ pageNumber, textBoxes, segments, images });
    }
    return pages;
}
