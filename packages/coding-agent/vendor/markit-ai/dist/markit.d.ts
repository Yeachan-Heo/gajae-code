import type { PluginDef } from "./plugins/types.js";
import type { ConversionResult, MarkitOptions, StreamInfo } from "./types.js";
export declare class Markit {
    private converters;
    private options;
    constructor(options?: MarkitOptions, plugins?: PluginDef[]);
    /**
     * Convert a local file to markdown.
     */
    convertFile(path: string, extra?: Partial<StreamInfo>): Promise<ConversionResult>;
    /**
     * Convert a URL to markdown.
     */
    convertUrl(url: string): Promise<ConversionResult>;
    /**
     * For root URLs, check if the site publishes /llms.txt.
     * If it exists, return it as markdown directly.
     */
    private tryLlmsTxt;
    /**
     * Inspect an HTML response for a discoverable markdown source URL.
     * If found, fetch and convert the raw markdown instead.
     */
    private tryMarkdownSource;
    /**
     * Fetch a markdown source URL, validating the response is actually markdown.
     */
    private fetchMarkdownSource;
    /**
     * Convert a buffer with stream info to markdown.
     */
    convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
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
export declare function discoverMarkdownSource(html: string, url: string, ext: string): string | null;
