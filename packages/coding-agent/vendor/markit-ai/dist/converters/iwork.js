import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
const EXTENSIONS = [".pages", ".key", ".numbers"];
const SF = "http://developer.apple.com/namespaces/sf";
const SFA = "http://developer.apple.com/namespaces/sfa";
const KEY = "http://developer.apple.com/namespaces/keynote2";
/**
 * Converts Apple iWork files (Pages, Keynote, Numbers) to markdown.
 *
 * All three formats are ZIP archives containing an XML file:
 *   - Pages:   index.xml   (sf:p paragraphs with named styles)
 *   - Keynote: index.apxl  (key:slide elements with sf:p text)
 *   - Numbers: index.xml   (sf:t text cells + sf:n number cells)
 */
export class IWorkConverter {
    name = "iwork";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
            return true;
        }
        return false;
    }
    async convert(input, streamInfo) {
        const zip = await JSZip.loadAsync(input);
        const ext = streamInfo.extension;
        if (ext === ".pages")
            return this.convertPages(zip, streamInfo);
        if (ext === ".key")
            return this.convertKeynote(zip, streamInfo);
        if (ext === ".numbers")
            return this.convertNumbers(zip);
        throw new Error(`Unsupported iWork format: ${ext}`);
    }
    // ---------------------------------------------------------------------------
    // Pages
    // ---------------------------------------------------------------------------
    async convertPages(zip, streamInfo) {
        const xml = await this.readIndex(zip, "index.xml");
        const root = parseXml(xml);
        const imageDir = streamInfo.imageDir;
        if (imageDir)
            mkdirSync(imageDir, { recursive: true });
        let imageCount = 0;
        const lines = [];
        let title;
        for (const p of iterAll(root, SF, "p")) {
            const text = collectText(p).trim();
            if (!text)
                continue;
            const style = p.getAttribute("sf:style") || "";
            const prefix = paragraphPrefix(style);
            if (!title && text.length > 0)
                title = text;
            lines.push(`${prefix}${text}`);
        }
        // Extract images
        for (const name of Object.keys(zip.files)) {
            if (!name.match(/\.(png|jpg|jpeg|gif|webp|tiff|bmp)$/i))
                continue;
            if (name.startsWith("QuickLook/"))
                continue;
            imageCount++;
            const imgName = name.split("/").pop() || `image_${imageCount}`;
            if (imageDir) {
                const file = zip.file(name);
                if (file) {
                    const buf = await file.async("nodebuffer");
                    const filepath = join(imageDir, imgName);
                    writeFileSync(filepath, buf);
                    lines.push(`![${imgName}](${filepath})`);
                }
            }
            else {
                lines.push(`<!-- image: ${imgName} -->`);
            }
        }
        return { markdown: lines.join("\n\n"), title };
    }
    // ---------------------------------------------------------------------------
    // Keynote
    // ---------------------------------------------------------------------------
    async convertKeynote(zip, streamInfo) {
        const xml = await this.readIndex(zip, "index.apxl");
        const root = parseXml(xml);
        const imageDir = streamInfo.imageDir;
        if (imageDir)
            mkdirSync(imageDir, { recursive: true });
        const sections = [];
        let title;
        const slides = [...iterAll(root, KEY, "slide")];
        for (let i = 0; i < slides.length; i++) {
            const slide = slides[i];
            const slideLines = [`<!-- Slide ${i + 1} -->`];
            const paragraphs = [...iterAll(slide, SF, "p")];
            let isTitle = true;
            for (const p of paragraphs) {
                const text = collectText(p).trim();
                if (!text)
                    continue;
                if (isTitle) {
                    slideLines.push(`# ${text}`);
                    if (!title)
                        title = text;
                    isTitle = false;
                }
                else {
                    slideLines.push(text);
                }
            }
            sections.push(slideLines.join("\n"));
        }
        // Extract media images
        let imageCount = 0;
        for (const name of Object.keys(zip.files)) {
            if (!name.match(/\.(png|jpg|jpeg|gif|webp|tiff|bmp)$/i))
                continue;
            if (name.startsWith("QuickLook/"))
                continue;
            imageCount++;
            const imgName = name.split("/").pop() || `image_${imageCount}`;
            if (imageDir) {
                const file = zip.file(name);
                if (file) {
                    const buf = await file.async("nodebuffer");
                    const filepath = join(imageDir, imgName);
                    writeFileSync(filepath, buf);
                    sections.push(`![${imgName}](${filepath})`);
                }
            }
            else {
                sections.push(`<!-- image: ${imgName} -->`);
            }
        }
        return { markdown: sections.join("\n\n"), title };
    }
    // ---------------------------------------------------------------------------
    // Numbers
    // ---------------------------------------------------------------------------
    async convertNumbers(zip) {
        const xml = await this.readIndex(zip, "index.xml");
        const root = parseXml(xml);
        // Find grid elements (tables)
        const grids = [...iterAll(root, SF, "grid")];
        if (grids.length === 0) {
            // Fallback: extract all text and number cells
            return this.convertNumbersFallback(root);
        }
        const sections = [];
        for (const grid of grids) {
            const rows = this.extractGrid(grid);
            if (rows.length === 0)
                continue;
            const maxCols = Math.max(...rows.map((r) => r.length));
            for (const row of rows) {
                while (row.length < maxCols)
                    row.push("");
            }
            const [header, ...body] = rows;
            const lines = [];
            lines.push(`| ${header.join(" | ")} |`);
            lines.push(`| ${header.map(() => "---").join(" | ")} |`);
            for (const row of body) {
                lines.push(`| ${row.join(" | ")} |`);
            }
            sections.push(lines.join("\n"));
        }
        return { markdown: sections.join("\n\n") };
    }
    extractGrid(grid) {
        const datasource = findFirst(grid, SF, "datasource");
        if (!datasource)
            return [];
        const rows = [];
        let currentRow = [];
        let colCount = 0;
        let totalCells = 0;
        const allValues = [];
        // Get column count from grid attributes (raw attribute names)
        const numCols = Number.parseInt(grid.getAttribute("sf:numcols") || "0", 10);
        for (const child of datasource.children) {
            const tag = child.tagName;
            let value = "";
            if (tag === `${SF}:t`) {
                // Text cell
                const ct = findFirst(child, SF, "ct");
                value = ct?.getAttribute("sfa:s") || collectText(child).trim();
            }
            else if (tag === `${SF}:n`) {
                // Number cell
                value = child.getAttribute("sf:v") || "";
            }
            else if (tag === `${SF}:b`) {
                // Boolean cell
                value = child.getAttribute("sf:v") === "1" ? "TRUE" : "FALSE";
            }
            else if (tag === `${SF}:d`) {
                // Date cell
                value = child.getAttribute("sf:v") || "";
            }
            else if (tag === `${SF}:du`) {
                // Duration cell
                value = child.getAttribute("sf:v") || "";
            }
            else if (tag === `${SF}:e`) {
                // Empty cell
                value = "";
            }
            else {
                continue;
            }
            currentRow.push(value);
            allValues.push(value);
            colCount++;
            totalCells++;
            if (numCols > 0 && colCount >= numCols) {
                rows.push(currentRow);
                currentRow = [];
                colCount = 0;
            }
        }
        if (currentRow.length > 0)
            rows.push(currentRow);
        // If the grid used default dimensions and produced only one row,
        // the data probably doesn't fill the full grid width. Fall back to
        // treating the cells as a 2-column key/value list or single column.
        if (rows.length <= 1 && totalCells > 0 && totalCells < numCols) {
            // Re-layout: try 2 columns if even, otherwise single column
            const cols = totalCells % 2 === 0 ? 2 : 1;
            const relaid = [];
            for (let i = 0; i < allValues.length; i += cols) {
                relaid.push(allValues.slice(i, i + cols));
            }
            return relaid;
        }
        return rows;
    }
    convertNumbersFallback(root) {
        const values = [];
        for (const t of iterAll(root, SF, "t")) {
            const ct = findFirst(t, SF, "ct");
            const val = ct?.getAttribute("sfa:s") || "";
            if (val)
                values.push(val);
        }
        for (const n of iterAll(root, SF, "n")) {
            const val = n.getAttribute("sf:v") || "";
            if (val)
                values.push(val);
        }
        return { markdown: values.join("\n") };
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    async readIndex(zip, filename) {
        const file = zip.file(filename);
        if (!file) {
            throw new Error(`Invalid iWork file: missing ${filename}`);
        }
        return file.async("string");
    }
}
/**
 * Minimal XML parser that preserves namespace prefixes in tag names
 * and extracts text content and attributes.
 */
function parseXml(xml) {
    // Use a simple recursive descent approach
    const root = createElement("root");
    const stack = [root];
    // Match tags and text
    const tagRe = /<(\/?)([a-zA-Z0-9_:.-]+)((?:\s+[a-zA-Z0-9_:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    let lastIndex = 0;
    let match = tagRe.exec(xml);
    while (match !== null) {
        const [fullMatch, isClose, tagName, attrs, isSelfClose] = match;
        const textBefore = xml.slice(lastIndex, match.index);
        lastIndex = match.index + fullMatch.length;
        // Add text to current element
        if (textBefore.trim()) {
            const current = stack[stack.length - 1];
            if (current.children.length > 0) {
                current.children[current.children.length - 1].tail += textBefore.trim();
            }
            else {
                current.text += textBefore.trim();
            }
        }
        if (isClose) {
            // Closing tag
            stack.pop();
        }
        else {
            // Opening tag
            const el = createElement(expandTag(tagName, xml));
            parseAttributes(attrs, el);
            stack[stack.length - 1].children.push(el);
            if (!isSelfClose) {
                stack.push(el);
            }
        }
        match = tagRe.exec(xml);
    }
    return root;
}
function createElement(tagName) {
    return {
        tagName,
        children: [],
        text: "",
        tail: "",
        attributes: {},
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
    };
}
function parseAttributes(attrStr, el) {
    const attrRe = /([a-zA-Z0-9_:.-]+)\s*=\s*"([^"]*)"/g;
    let m = attrRe.exec(attrStr);
    while (m !== null) {
        el.attributes[m[1]] = m[2];
        m = attrRe.exec(attrStr);
    }
}
/**
 * Expand namespace prefix in tag name to full URI.
 * e.g. "sf:p" with xmlns:sf="..." → "{uri}p"
 * For simplicity, we use the known Apple namespaces.
 */
function expandTag(tag, _xml) {
    const nsMap = {
        sf: SF,
        sfa: SFA,
        sl: "http://developer.apple.com/namespaces/sl",
        key: KEY,
    };
    const colon = tag.indexOf(":");
    if (colon === -1)
        return tag;
    const prefix = tag.slice(0, colon);
    const local = tag.slice(colon + 1);
    const uri = nsMap[prefix];
    return uri ? `${uri}:${local}` : tag;
}
function collectText(el) {
    let result = el.text;
    for (const child of el.children) {
        result += collectText(child);
        result += child.tail;
    }
    return result;
}
function* iterAll(el, ns, localName) {
    const fullTag = `${ns}:${localName}`;
    if (el.tagName === fullTag)
        yield el;
    for (const child of el.children) {
        yield* iterAll(child, ns, localName);
    }
}
function findFirst(el, ns, localName) {
    for (const found of iterAll(el, ns, localName)) {
        return found;
    }
    return null;
}
/**
 * Map iWork paragraph style names to markdown heading prefixes.
 */
function paragraphPrefix(style) {
    if (!style)
        return "";
    const lower = style.toLowerCase();
    if (lower.includes("title"))
        return "# ";
    if (lower.includes("subtitle"))
        return "## ";
    if (lower.includes("heading-1") || lower.includes("heading 1"))
        return "## ";
    if (lower.includes("heading-2") || lower.includes("heading 2"))
        return "### ";
    if (lower.includes("heading-3") || lower.includes("heading 3"))
        return "#### ";
    if (lower.includes("heading-4") || lower.includes("heading 4"))
        return "##### ";
    if (lower.includes("caption"))
        return "*";
    return "";
}
