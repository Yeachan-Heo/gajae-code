import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { createTurndown, normalizeTablesHtml } from "../utils/turndown.js";
const EXTENSIONS = [".epub"];
const MIMETYPES = [
    "application/epub",
    "application/epub+zip",
    "application/x-epub+zip",
];
export class EpubConverter {
    name = "epub";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, _streamInfo) {
        const zip = await JSZip.loadAsync(input);
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            textNodeName: "#text",
            processEntities: { maxTotalExpansions: 1_000_000 },
        });
        // Find content.opf path from container.xml
        const containerXml = await zip
            .file("META-INF/container.xml")
            ?.async("string");
        if (!containerXml)
            throw new Error("Invalid EPUB: missing container.xml");
        const container = parser.parse(containerXml);
        const rootfile = container.container?.rootfiles?.rootfile;
        const opfPath = Array.isArray(rootfile)
            ? rootfile[0]["@_full-path"]
            : rootfile?.["@_full-path"];
        if (!opfPath)
            throw new Error("Invalid EPUB: missing rootfile path");
        // Parse content.opf
        const opfXml = await zip.file(opfPath)?.async("string");
        if (!opfXml)
            throw new Error("Invalid EPUB: missing content.opf");
        const opf = parser.parse(opfXml);
        // Extract metadata
        const meta = opf.package?.metadata ?? {};
        const metadata = {
            title: this.getText(meta["dc:title"]),
            authors: this.getTextArray(meta["dc:creator"]).join(", ") || undefined,
            language: this.getText(meta["dc:language"]),
            publisher: this.getText(meta["dc:publisher"]),
            date: this.getText(meta["dc:date"]),
            description: this.getText(meta["dc:description"]),
        };
        // Build manifest map (id → href)
        const manifestItems = opf.package?.manifest?.item;
        const itemList = Array.isArray(manifestItems)
            ? manifestItems
            : manifestItems
                ? [manifestItems]
                : [];
        const manifest = new Map();
        for (const item of itemList) {
            manifest.set(item["@_id"], item["@_href"]);
        }
        // Get spine order
        const spineItems = opf.package?.spine?.itemref;
        const spineList = Array.isArray(spineItems)
            ? spineItems
            : spineItems
                ? [spineItems]
                : [];
        const spineOrder = spineList.map((s) => s["@_idref"]);
        // Resolve file paths
        const basePath = opfPath.includes("/")
            ? opfPath.substring(0, opfPath.lastIndexOf("/"))
            : "";
        const turndown = createTurndown();
        const sections = [];
        // Add metadata header
        const metaLines = [];
        for (const [key, value] of Object.entries(metadata)) {
            if (value)
                metaLines.push(`**${key.charAt(0).toUpperCase() + key.slice(1)}:** ${value}`);
        }
        if (metaLines.length > 0)
            sections.push(metaLines.join("\n"));
        // Convert spine files
        for (const idref of spineOrder) {
            const href = manifest.get(idref);
            if (!href)
                continue;
            const filePath = basePath ? `${basePath}/${href}` : href;
            const html = await zip.file(filePath)?.async("string");
            if (!html)
                continue;
            // Strip script/style, convert to markdown
            const cleaned = html
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "");
            const md = turndown.turndown(normalizeTablesHtml(cleaned)).trim();
            if (md)
                sections.push(md);
        }
        return {
            markdown: sections.join("\n\n").trim(),
            title: metadata.title,
        };
    }
    getText(node) {
        if (!node)
            return undefined;
        if (typeof node === "string")
            return node;
        if (node["#text"])
            return String(node["#text"]);
        if (Array.isArray(node))
            return this.getText(node[0]);
        return undefined;
    }
    getTextArray(node) {
        if (!node)
            return [];
        const list = Array.isArray(node) ? node : [node];
        return list.map((n) => this.getText(n)).filter(Boolean);
    }
}
