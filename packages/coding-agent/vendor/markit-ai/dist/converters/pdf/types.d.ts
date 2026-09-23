/** Bounding box in PDF coordinate space (origin = bottom-left). */
export type Bounds = {
    left: number;
    right: number;
    /** Higher value = higher on the page. */
    top: number;
    bottom: number;
};
/** A text fragment with position and font metadata. */
export type TextBox = {
    id: string;
    text: string;
    bounds: Bounds;
    pageNumber: number;
    /** Dominant font size in points. */
    fontSize: number;
    /** True if rendered bold (font name or rendering mode). */
    isBold: boolean;
};
/** A horizontal or vertical line segment extracted from vector graphics. */
export type Segment = {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};
/** A single cell in a resolved table grid. */
export type TableCell = {
    row: number;
    col: number;
    text: string;
    rowSpan: number;
    colSpan: number;
};
/** A resolved table grid ready for markdown rendering. */
export type TableGrid = {
    pageNumber: number;
    rows: number;
    cols: number;
    cells: TableCell[];
    warnings: string[];
    /** Top Y coordinate (PDF space: larger = higher on page). */
    topY: number;
    /** True for tables detected without vector borders. */
    isBorderless: boolean;
};
/** An image/diagram region detected on a page. */
export type ImageRegion = {
    id: string;
    pageNumber: number;
    /** Bounding box in mupdf coordinates (top-left origin). */
    bbox: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    /** Y position in PDF coordinates (bottom-left) for ordering. */
    topY: number;
};
/** Result of extracting content from a single PDF page. */
export type PageContent = {
    pageNumber: number;
    textBoxes: TextBox[];
    segments: Segment[];
    images: ImageRegion[];
};
/** A block of rendered content (text paragraph or table). */
export type ContentBlock = {
    topY: number;
    content: string;
    /** True if this line has wide gaps between text boxes (column headers). */
    isTabular?: boolean;
};
