/**
 * Running header/footer detection and removal.
 *
 * Many PDFs have repeated text at the top or bottom of every page:
 * document titles, chapter names, page numbers, copyright notices.
 * These pollute the markdown output as false headings or noise.
 *
 * Algorithm:
 *   1. For each page, bucket text boxes by Y position (top/bottom zones)
 *   2. Collect the text content at each zone across all pages
 *   3. Text appearing on >20% of pages OR 8+ consecutive pages is a
 *      running header/footer
 *   4. Remove matching text boxes before further processing
 */
import type { PageContent } from "./types.js";
/**
 * Detect and remove running headers and footers from all pages.
 * Mutates the pages array in place, removing header/footer text boxes.
 *
 * Uses two strategies:
 *   1. Global frequency: text appearing on > 20% of all pages
 *   2. Consecutive runs: text appearing on 8+ consecutive pages
 */
export declare function stripHeadersFooters(pages: PageContent[]): void;
