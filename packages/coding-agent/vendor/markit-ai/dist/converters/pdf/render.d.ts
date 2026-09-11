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
import type { TableGrid, TextBox } from "./types.js";
/**
 * Render a TableGrid as a markdown table.
 */
export declare function renderTableToMarkdown(table: TableGrid): string;
/**
 * Render one page's content: free text and tables interleaved top-to-bottom.
 */
export declare function renderPageContent(freeTextBoxes: TextBox[], tables: TableGrid[], imageBlocks?: Array<{
    topY: number;
    markdown: string;
}>, allTextBoxes?: TextBox[]): string;
