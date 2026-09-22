import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { AudioConverter } from "./converters/audio.js";
import { CsvConverter } from "./converters/csv.js";
import { DocxConverter } from "./converters/docx.js";
import { EpubConverter } from "./converters/epub.js";
import { GitHubConverter } from "./converters/github.js";
import { HtmlConverter } from "./converters/html.js";
import { ImageConverter } from "./converters/image.js";
import { IpynbConverter } from "./converters/ipynb.js";
import { IWorkConverter } from "./converters/iwork.js";
import { JsonConverter } from "./converters/json.js";
import { PdfConverter } from "./converters/pdf/index.js";
import { PlainTextConverter } from "./converters/plain-text.js";
import { PptxConverter } from "./converters/pptx.js";
import { RssConverter } from "./converters/rss.js";
import { WikipediaConverter } from "./converters/wikipedia.js";
import { XlsxConverter } from "./converters/xlsx.js";
import { XmlConverter } from "./converters/xml.js";
import { YamlConverter } from "./converters/yaml.js";
import { ZipConverter } from "./converters/zip.js";
const USER_AGENT = "markit/0.1.0";
export class Markit {
    converters = [];
    options;
    constructor(options = {}, plugins = []) {
        this.options = options;
        // Plugin converters go first — they override builtins for the same format
        const pluginConverters = plugins.flatMap((p) => p.converters);
        // Built-in converters: specific formats first, generic last.
        const specific = [
            new PdfConverter(),
            new DocxConverter(),
            new PptxConverter(),
            new XlsxConverter(),
            new EpubConverter(),
            new IpynbConverter(),
            new IWorkConverter(),
            new GitHubConverter(),
            new WikipediaConverter(),
            new RssConverter(),
            new CsvConverter(),
            new JsonConverter(),
            new YamlConverter(),
            new ImageConverter(),
            new AudioConverter(),
        ];
        const generic = [new XmlConverter(), new HtmlConverter()];
        // ZIP gets all converters (plugin + builtin) for recursive extraction
        const allNonZip = [...pluginConverters, ...specific, ...generic];
        const zipConverter = new ZipConverter(allNonZip);
        // Plugin converters first, then builtins, plain text last
        this.converters = [
            ...pluginConverters,
            ...specific,
            zipConverter,
            ...generic,
            new PlainTextConverter(),
        ];
    }
    /**
     * Convert a local file to markdown.
     */
    async convertFile(path, extra) {
        const buffer = readFileSync(path);
        const streamInfo = {
            localPath: path,
            extension: extname(path).toLowerCase(),
            filename: basename(path),
            ...extra,
        };
        return this.convert(buffer, streamInfo);
    }
    /**
     * Convert a URL to markdown.
     */
    async convertUrl(url) {
        // Let converters with a URL-specific hook handle it first
        const streamInfo = { url };
        for (const converter of this.converters) {
            if (!converter.convertUrl || !converter.accepts(streamInfo))
                continue;
            try {
                return await converter.convertUrl(url, this.options);
            }
            catch {
                // Fall through to default fetch path
            }
        }
        // For root URLs, check if the site has /llms.txt and return it if so
        const parsedUrl = new URL(url);
        if (parsedUrl.pathname === "/" || parsedUrl.pathname === "") {
            const result = await this.tryLlmsTxt(parsedUrl.origin);
            if (result)
                return result;
        }
        const response = await fetch(url, {
            headers: {
                Accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1",
                "User-Agent": USER_AGENT,
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        const contentType = response.headers.get("content-type") || "";
        const mimetype = contentType.split(";")[0].trim();
        const urlPath = new URL(url).pathname;
        const ext = extname(urlPath).toLowerCase();
        // Content negotiation worked — server returned markdown directly
        if (mimetype === "text/markdown") {
            const buffer = Buffer.from(await response.arrayBuffer());
            return this.convert(buffer, {
                url,
                mimetype: "text/markdown",
                extension: ".md",
                filename: basename(urlPath) || undefined,
            });
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        // For HTML responses, try to discover a raw markdown source.
        // Patterns: <link rel="alternate">, VitePress .md files, llms.txt convention.
        if (mimetype === "text/html") {
            const result = await this.tryMarkdownSource(buffer, url, ext);
            if (result)
                return result;
        }
        return this.convert(buffer, {
            url,
            mimetype,
            extension: ext || undefined,
            filename: basename(urlPath) || undefined,
        });
    }
    /**
     * For root URLs, check if the site publishes /llms.txt.
     * If it exists, return it as markdown directly.
     */
    async tryLlmsTxt(origin) {
        const llmsTxtUrl = `${origin}/llms.txt`;
        try {
            const response = await fetch(llmsTxtUrl, {
                method: "HEAD",
                headers: { "User-Agent": USER_AGENT },
            });
            if (!response.ok)
                return null;
            const ct = (response.headers.get("content-type") || "")
                .split(";")[0]
                .trim();
            if (!ct.includes("markdown") &&
                !ct.includes("text/plain") &&
                !ct.includes("text/html"))
                return null;
            // HEAD succeeded — now GET the content
            const getResponse = await fetch(llmsTxtUrl, {
                headers: { "User-Agent": USER_AGENT },
            });
            if (!getResponse.ok)
                return null;
            const buffer = Buffer.from(await getResponse.arrayBuffer());
            return { markdown: buffer.toString("utf-8") };
        }
        catch {
            return null;
        }
    }
    /**
     * Inspect an HTML response for a discoverable markdown source URL.
     * If found, fetch and convert the raw markdown instead.
     */
    async tryMarkdownSource(htmlBuffer, url, ext) {
        const html = htmlBuffer.toString("utf-8", 0, Math.min(htmlBuffer.length, 50_000));
        const mdSourceUrl = discoverMarkdownSource(html, url, ext);
        if (!mdSourceUrl)
            return null;
        return this.fetchMarkdownSource(mdSourceUrl);
    }
    /**
     * Fetch a markdown source URL, validating the response is actually markdown.
     */
    async fetchMarkdownSource(mdUrl) {
        try {
            const response = await fetch(mdUrl, {
                headers: { "User-Agent": USER_AGENT },
            });
            if (!response.ok)
                return null;
            const ct = (response.headers.get("content-type") || "")
                .split(";")[0]
                .trim();
            if (!ct.includes("markdown") && !ct.includes("text/plain"))
                return null;
            const mdBuffer = Buffer.from(await response.arrayBuffer());
            return this.convert(mdBuffer, {
                url: mdUrl,
                mimetype: "text/markdown",
                extension: ".md",
                filename: basename(new URL(mdUrl).pathname),
            });
        }
        catch {
            return null;
        }
    }
    /**
     * Convert a buffer with stream info to markdown.
     */
    async convert(input, streamInfo) {
        const errors = [];
        for (const converter of this.converters) {
            if (!converter.accepts(streamInfo))
                continue;
            try {
                return await converter.convert(input, streamInfo, this.options);
            }
            catch (err) {
                errors.push({
                    converter: converter.name,
                    error: err instanceof Error ? err : new Error(String(err)),
                });
            }
        }
        if (errors.length > 0) {
            const details = errors
                .map((e) => `  ${e.converter}: ${e.error.message}`)
                .join("\n");
            throw new AggregateError(errors.map((entry) => entry.error), `Conversion failed:\n${details}`, { cause: errors[0].error });
        }
        throw new Error(`Unsupported format: ${streamInfo.extension || streamInfo.mimetype || "unknown"}`);
    }
}
/**
 * Try to discover a raw markdown source URL from an HTML response.
 * Checks for known markers in the HTML itself:
 *   1. <link rel="alternate" type="text/markdown" href="..."> tag
 *   2. VitePress markers → append .md to the URL
 *
 * The llms.txt .md probe is handled separately in tryMarkdownSource
 * as a fallback when no markers are found.
 *
 * @internal Exported for testing.
 */
export function discoverMarkdownSource(html, url, ext) {
    // 1. Look for <link rel="alternate" type="text/markdown" href="...">
    const linkMatch = html.match(/<link[^>]+rel=["']alternate["'][^>]+type=["']text\/markdown["'][^>]+href=["']([^"']+)["']/i) ??
        html.match(/<link[^>]+type=["']text\/markdown["'][^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i);
    if (linkMatch?.[1]) {
        try {
            return new URL(linkMatch[1], url).href;
        }
        catch {
            /* ignore malformed URLs */
        }
    }
    // 2. VitePress detection — serves .md alongside HTML
    if (!ext &&
        (html.includes("__VP_HASH_MAP__") ||
            html.includes("VPContent") ||
            html.includes("vitepress"))) {
        return appendMdExtension(url);
    }
    return null;
}
function appendMdExtension(url) {
    return url.endsWith("/") ? `${url.slice(0, -1)}.md` : `${url}.md`;
}
