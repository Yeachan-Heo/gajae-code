import TurndownService from "turndown";
export declare function createTurndown(): TurndownService;
/**
 * Normalize HTML tables so turndown-plugin-gfm can handle them:
 * - Wrap first row in <thead> if missing
 * - Strip <p> tags inside <td>/<th> cells
 */
export declare function normalizeTablesHtml(html: string): string;
