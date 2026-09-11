import { createTurndown } from "../utils/turndown.js";
const _EXTENSIONS = [".rss", ".atom", ".xml"];
const MIMETYPES = [
    "application/rss+xml",
    "application/rss",
    "application/atom+xml",
    "application/atom",
    "text/xml",
    "application/xml",
];
export class RssConverter {
    name = "rss";
    accepts(streamInfo) {
        // Only accept known RSS/Atom extensions directly
        if (streamInfo.extension &&
            [".rss", ".atom"].includes(streamInfo.extension))
            return true;
        // For .xml, we'll try and fail gracefully
        if (streamInfo.extension === ".xml")
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, _streamInfo) {
        const text = new TextDecoder("utf-8").decode(input);
        // Detect feed type
        if (text.includes("<rss")) {
            return this.parseRss(text);
        }
        else if (text.includes("<feed")) {
            return this.parseAtom(text);
        }
        // Not a feed — fall through for XML as generic text
        throw new Error("Not an RSS or Atom feed");
    }
    parseRss(xml) {
        const turndown = createTurndown();
        const sections = [];
        // Extract from the <channel> block specifically
        const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
        const channelXml = channelMatch ? channelMatch[1] : xml;
        const channelTitle = this.extract(channelXml, "title");
        const channelDesc = this.extract(channelXml, "description");
        if (channelTitle)
            sections.push(`# ${channelTitle}`);
        if (channelDesc)
            sections.push(this.htmlToMd(channelDesc, turndown));
        // Extract items
        const items = this.extractAll(xml, "item");
        for (const item of items) {
            const title = this.extract(item, "title");
            const pubDate = this.extract(item, "pubDate");
            const description = this.extract(item, "description");
            const content = this.extract(item, "content:encoded");
            const link = this.extract(item, "link");
            const parts = [];
            if (title)
                parts.push(`## ${title}`);
            if (pubDate)
                parts.push(`Published: ${pubDate}`);
            if (link)
                parts.push(`[Link](${link})`);
            if (content) {
                parts.push(this.htmlToMd(content, turndown));
            }
            else if (description) {
                parts.push(this.htmlToMd(description, turndown));
            }
            if (parts.length > 0)
                sections.push(parts.join("\n"));
        }
        return { markdown: sections.join("\n\n").trim(), title: channelTitle };
    }
    parseAtom(xml) {
        const turndown = createTurndown();
        const sections = [];
        const feedTitle = this.extract(xml, "title");
        const subtitle = this.extract(xml, "subtitle");
        if (feedTitle)
            sections.push(`# ${feedTitle}`);
        if (subtitle)
            sections.push(subtitle);
        const entries = this.extractAll(xml, "entry");
        for (const entry of entries) {
            const title = this.extract(entry, "title");
            const updated = this.extract(entry, "updated");
            const summary = this.extract(entry, "summary");
            const content = this.extract(entry, "content");
            const parts = [];
            if (title)
                parts.push(`## ${title}`);
            if (updated)
                parts.push(`Updated: ${updated}`);
            if (content) {
                parts.push(this.htmlToMd(content, turndown));
            }
            else if (summary) {
                parts.push(this.htmlToMd(summary, turndown));
            }
            if (parts.length > 0)
                sections.push(parts.join("\n"));
        }
        return { markdown: sections.join("\n\n").trim(), title: feedTitle };
    }
    htmlToMd(html, turndown) {
        // Unescape CDATA and HTML entities that might be in RSS
        const unescaped = html
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
        // If it looks like HTML, convert it
        if (unescaped.includes("<")) {
            return turndown.turndown(unescaped).trim();
        }
        return unescaped.trim();
    }
    extract(xml, tag) {
        // Handle both <tag>content</tag> and <tag><![CDATA[content]]></tag>
        const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
        const match = xml.match(re);
        if (!match)
            return undefined;
        return (match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() || undefined);
    }
    extractAll(xml, tag) {
        const results = [];
        const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
        let match = re.exec(xml);
        while (match !== null) {
            results.push(match[0]);
            match = re.exec(xml);
        }
        return results;
    }
}
