import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
export function createTurndown() {
    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
    });
    turndown.use(gfm);
    // Fix strikethrough: GFM spec uses ~~ (double tilde), not ~ (single)
    turndown.addRule("strikethrough", {
        filter: ["del", "s", "strike"],
        replacement(content) {
            return `~~${content}~~`;
        },
    });
    // Fix heading escaping: turndown escapes "1." to "1\." to avoid ordered lists
    turndown.addRule("heading", {
        filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
        replacement(content, node) {
            const level = Number(node.nodeName.charAt(1));
            const prefix = "#".repeat(level);
            // Unescape unnecessary backslash before periods in headings
            const cleaned = content.replace(/\\([.])/g, "$1").trim();
            return `\n\n${prefix} ${cleaned}\n\n`;
        },
    });
    // Override listItem rule to use single space after marker (turndown hardcodes 3)
    turndown.addRule("listItem", {
        filter: "li",
        replacement(content, node, options) {
            content = content
                .replace(/^\n+/, "")
                .replace(/\n+$/, "\n")
                .replace(/\n/gm, "\n  ");
            const parent = node.parentNode;
            let prefix = `${options.bulletListMarker} `;
            if (parent?.nodeName === "OL") {
                const start = parent.getAttribute("start");
                const index = Array.prototype.indexOf.call(parent.children, node);
                prefix = `${(start ? Number(start) : 1) + index}. `;
            }
            return prefix + content + (node.nextSibling ? "\n" : "");
        },
    });
    return turndown;
}
/**
 * Normalize HTML tables so turndown-plugin-gfm can handle them:
 * - Wrap first row in <thead> if missing
 * - Strip <p> tags inside <td>/<th> cells
 */
export function normalizeTablesHtml(html) {
    // Strip <p> tags inside table cells, joining multiple paragraphs with <br>
    let result = html.replace(/<(td|th)([^>]*)>([\s\S]*?)<\/(td|th)>/gi, (_match, tag, attrs, inner, closeTag) => {
        const stripped = inner
            .replace(/^\s*<p>/i, "")
            .replace(/<\/p>\s*$/i, "")
            .replace(/<\/p>\s*<p>/gi, " ");
        return `<${tag}${attrs}>${stripped}</${closeTag}>`;
    });
    // Add thead to tables that lack it
    result = result.replace(/<table([^>]*)>\s*(?:<tbody>\s*)?(<tr[\s\S]*?<\/tr>)([\s\S]*?)<\/(?:tbody>\s*<\/)?table>/gi, (_match, attrs, firstRow, rest) => {
        const theadRow = firstRow
            .replace(/<td/gi, "<th")
            .replace(/<\/td>/gi, "</th>");
        return `<table${attrs}><thead>${theadRow}</thead><tbody>${rest}</tbody></table>`;
    });
    return result;
}
