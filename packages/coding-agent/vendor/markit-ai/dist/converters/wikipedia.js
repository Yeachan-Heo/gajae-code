import { createTurndown } from "../utils/turndown.js";
const WIKIPEDIA_RE = /^https?:\/\/[a-zA-Z]{2,3}\.wikipedia\.org\//;
export class WikipediaConverter {
    name = "wikipedia";
    accepts(streamInfo) {
        if (!streamInfo.url)
            return false;
        return WIKIPEDIA_RE.test(streamInfo.url);
    }
    async convert(input, streamInfo) {
        const html = new TextDecoder(streamInfo.charset || "utf-8").decode(input);
        // Extract the main content div
        const contentMatch = html.match(/<div[^>]*id="mw-content-text"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|$)/i);
        // Extract title
        const titleMatch = html.match(/<span[^>]*class="mw-page-title-main"[^>]*>([\s\S]*?)<\/span>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch
            ? titleMatch[1].replace(/ - Wikipedia$/, "").trim()
            : undefined;
        const turndown = createTurndown();
        // Clean up Wikipedia-specific elements
        let content = contentMatch ? contentMatch[1] : html;
        content = content
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<div[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/div>/gi, "") // edit links
            .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, "") // reference numbers
            .replace(/<div[^>]*class="[^"]*navbox[\s\S]*?<\/div>/gi, "") // navboxes
            .replace(/<table[^>]*class="[^"]*sidebar[\s\S]*?<\/table>/gi, ""); // sidebars
        const markdown = turndown.turndown(content).trim();
        const result = title ? `# ${title}\n\n${markdown}` : markdown;
        return { markdown: result, title };
    }
}
