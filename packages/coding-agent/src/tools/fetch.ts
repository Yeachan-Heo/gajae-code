import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import type { ImageContent, TextContent } from "@gajae-code/ai";
import { htmlToMarkdown } from "@gajae-code/natives";
import { type Component, Text } from "@gajae-code/tui";
import { $which, ptree, truncate } from "@gajae-code/utils";
import { parseHTML } from "linkedom";
import type { Settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { type Theme, theme } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import type { AgentStorage } from "../session/agent-storage";
import { DEFAULT_MAX_BYTES, truncateHead } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { ensureTool } from "../utils/tools-manager";
import { INSANE_NOTES, tryInsaneFetch } from "../web/insane/bridge";
import { validatePublicHttpUrl, validatePublicHttpUrlForInsane } from "../web/insane/url-guard";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../web/parallel";
import { specialHandlers } from "../web/scrapers";
import type { RenderResult } from "../web/scrapers/types";
import { finalizeOutput, loadPage, looksLikeHtml, MAX_OUTPUT_CHARS } from "../web/scrapers/types";
import { convertWithMarkit, fetchBinary } from "../web/scrapers/utils";
import { applyListLimit } from "./list-limit";
import { formatStyledArtifactReference, type OutputMeta } from "./output-meta";
import { formatExpandHint, getDomain, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

// =============================================================================
// Types and Constants
// =============================================================================

const FETCH_DEFAULT_MAX_LINES = 300;
// Convertible document types handled by markit.
const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.ms-powerpoint",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/rtf",
	"application/epub+zip",
	"application/x-ipynb+json",
	"application/zip",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
]);

const CONVERTIBLE_EXTENSIONS = new Set([
	".pdf",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	".rtf",
	".epub",
	".ipynb",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".mp3",
	".wav",
	".ogg",
]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Check if a command exists (cross-platform)
 */
function hasCommand(cmd: string): boolean {
	return Boolean($which(cmd));
}

/**
 * Build llms.txt candidates scoped to the requested URL
 */
function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
		}

		const trimmedPath = parsed.pathname.replace(/\/+$/, "");
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];

		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
		}

		return endpoints;
	} catch {
		return [];
	}
}

/**
 * Normalize URL (add scheme if missing)
 */
function normalizeUrl(url: string): string {
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\//i.test(value) || /^www\./i.test(value);
}

// URL line selectors mirror the file form: `:50`, `:50-100`, `:50+150`, `:raw`.
// If a URL would otherwise look like `host:port`, add a trailing slash before the selector
// (e.g. `https://example.com/:80` to read line 80 of the document at `https://example.com/`).
const URL_LINE_RANGE_RE = /^(\d+)(?:([-+])(\d+))?$/;

export interface ParsedReadUrlTarget {
	path: string;
	raw: boolean;
	offset?: number;
	limit?: number;
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const embedded = tryExtractEmbeddedUrlSelector(readPath);
	const urlPath = embedded?.path ?? readPath;
	if (!isReadableUrlPath(urlPath)) {
		return null;
	}

	const selector = embedded?.sel;
	const raw = selector === "raw";
	const lineMatch = selector && selector !== "raw" ? URL_LINE_RANGE_RE.exec(selector) : null;
	if (lineMatch) {
		const startLine = Number.parseInt(lineMatch[1]!, 10);
		if (startLine < 1) {
			throw new ToolError("URL line selector 0 is invalid; lines are 1-indexed. Use :1.");
		}
		const sep = lineMatch[2];
		const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
		let endLine: number | undefined;
		if (sep === "+") {
			if (rhs === undefined || rhs < 1) {
				throw new ToolError(`Invalid range ${startLine}+${rhs ?? 0}: count must be >= 1.`);
			}
			endLine = startLine + rhs - 1;
		} else if (sep === "-") {
			if (rhs === undefined || rhs < startLine) {
				throw new ToolError(`Invalid range ${startLine}-${rhs ?? 0}: end must be >= start.`);
			}
			endLine = rhs;
		}
		return {
			path: urlPath,
			raw: false,
			offset: startLine,
			limit: endLine !== undefined ? endLine - startLine + 1 : undefined,
		};
	}

	return { path: urlPath, raw };
}

function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sel?: string } | null {
	const lastColonIndex = readPath.lastIndexOf(":");
	if (lastColonIndex <= 0) {
		return null;
	}

	const candidateSelector = readPath.slice(lastColonIndex + 1);
	const basePath = readPath.slice(0, lastColonIndex);
	if (!isReadableUrlPath(basePath)) {
		return null;
	}

	const isEmbeddedSelector = candidateSelector === "raw" || URL_LINE_RANGE_RE.test(candidateSelector);
	if (!isEmbeddedSelector) {
		return null;
	}

	try {
		new URL(basePath.startsWith("http://") || basePath.startsWith("https://") ? basePath : `https://${basePath}`);
		return { path: basePath, sel: candidateSelector };
	} catch {
		return null;
	}
}

/**
 * Normalize MIME type (lowercase, strip charset/params)
 */
function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Get extension from URL or Content-Disposition
 */
function getExtensionHint(url: string, contentDisposition?: string): string {
	// Try Content-Disposition filename first
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = path.extname(match[1]).toLowerCase();
			if (ext) return ext;
		}
	}

	// Fall back to URL path
	try {
		const pathname = new URL(url).pathname;
		const ext = path.extname(pathname).toLowerCase();
		if (ext) return ext;
	} catch {}

	return "";
}

/**
 * Check if content type is convertible via markit.
 */
function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Try fetching URL with .md appended (llms.txt convention)
 */
async function tryMdSuffix(url: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const candidates: string[] = [];

	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		if (pathname.endsWith("/")) {
			// /foo/bar/ -> /foo/bar/index.html.md
			candidates.push(`${parsed.origin}${pathname}index.html.md`);
		} else if (pathname.includes(".")) {
			// /foo/bar.html -> /foo/bar.html.md
			candidates.push(`${parsed.origin}${pathname}.md`);
		} else {
			// /foo/bar -> /foo/bar.md
			candidates.push(`${parsed.origin}${pathname}.md`);
		}
	} catch {
		return null;
	}

	if (signal?.aborted) {
		return null;
	}

	for (const candidate of candidates) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(candidate, { timeout, signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return result.content;
		}
	}

	return null;
}

/**
 * Try to fetch LLM-friendly endpoints
 */
async function tryLlmEndpoints(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; endpoint: string } | null> {
	const endpoints = buildLlmEndpointCandidates(url);

	if (signal?.aborted || endpoints.length === 0) {
		return null;
	}

	for (const endpoint of endpoints) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5), signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return { content: result.content, endpoint };
		}
	}
	return null;
}

/**
 * Try content negotiation for markdown/plain
 */
async function tryContentNegotiation(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; type: string } | null> {
	if (signal?.aborted) {
		return null;
	}

	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
		signal,
	});

	if (!result.ok) return null;

	const mime = normalizeMime(result.contentType);
	if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
		return { content: result.content, type: result.contentType };
	}

	return null;
}

/**
 * Read a single HTML attribute from a tag string
 */
function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Extract bounded <head> markup to avoid expensive whole-page parsing
 */
function extractHeadHtml(html: string): string {
	const lower = html.toLowerCase();
	const headStart = lower.indexOf("<head");
	if (headStart === -1) {
		return html.slice(0, 32 * 1024);
	}

	const headTagEnd = html.indexOf(">", headStart);
	if (headTagEnd === -1) {
		return html.slice(headStart, headStart + 32 * 1024);
	}

	const headEnd = lower.indexOf("</head>", headTagEnd + 1);
	const fallbackEnd = Math.min(html.length, headTagEnd + 1 + 32 * 1024);
	return html.slice(headStart, headEnd === -1 ? fallbackEnd : headEnd + 7);
}

/**
 * Parse alternate links from HTML head
 */
function parseAlternateLinks(html: string, pageUrl: string): string[] {
	const links: string[] = [];

	try {
		const pagePath = new URL(pageUrl).pathname;
		const headHtml = extractHeadHtml(html);
		const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

		for (const tag of linkTags) {
			const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
			const relTokens = rel.split(/\s+/).filter(Boolean);
			if (!relTokens.includes("alternate")) continue;

			const href = getHtmlAttribute(tag, "href");
			const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
			if (!href) continue;

			// Skip site-wide feeds
			if (
				href.includes("RecentChanges") ||
				href.includes("Special:") ||
				href.includes("/feed/") ||
				href.includes("action=feed")
			) {
				continue;
			}

			if (type.includes("markdown")) {
				links.push(href);
			} else if (
				(type.includes("rss") || type.includes("atom") || type.includes("feed")) &&
				(href.includes(pagePath) || href.includes("comments"))
			) {
				links.push(href);
			}
		}
	} catch {}

	return links;
}

/**
 * Extract document links from HTML (for PDF/DOCX wrapper pages)
 */
function extractDocumentLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();

	try {
		const anchorTags = html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? [];
		for (const tag of anchorTags) {
			const href = getHtmlAttribute(tag, "href");
			if (!href) continue;

			const ext = path.extname(href).toLowerCase();
			if (!CONVERTIBLE_EXTENSIONS.has(ext)) continue;

			const resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			links.push(resolved);
			if (links.length >= 20) break;
		}
	} catch {}

	return links;
}

/**
 * Strip CDATA wrapper and clean text
 */
function cleanFeedText(text: string): string {
	return text
		.replace(/<!\[CDATA\[/g, "")
		.replace(/\]\]>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/<[^>]+>/g, "") // Strip HTML tags
		.trim();
}

/**
 * Parse RSS/Atom feed to markdown
 */
function parseFeedToMarkdown(content: string, maxItems = 10): string {
	try {
		const doc = parseHTML(content).document;

		// Try RSS
		const channel = doc.querySelector("channel");
		if (channel) {
			const title = cleanFeedText(channel.querySelector("title")?.text || "RSS Feed");
			const items = channel.querySelectorAll("item").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const item of items) {
				const itemTitle = cleanFeedText(item.querySelector("title")?.text || "Untitled");
				const link = cleanFeedText(item.querySelector("link")?.text || "");
				const pubDate = cleanFeedText(item.querySelector("pubDate")?.text || "");
				const desc = cleanFeedText(item.querySelector("description")?.text || "");

				md += `## ${itemTitle}\n`;
				if (pubDate) md += `*${pubDate}*\n\n`;
				if (desc) md += `${desc.slice(0, 500)}${desc.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}

		// Try Atom
		const feed = doc.querySelector("feed");
		if (feed) {
			const title = cleanFeedText(feed.querySelector("title")?.text || "Atom Feed");
			const entries = feed.querySelectorAll("entry").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const entry of entries) {
				const entryTitle = cleanFeedText(entry.querySelector("title")?.text || "Untitled");
				const link = entry.querySelector("link")?.getAttribute("href") || "";
				const updated = cleanFeedText(entry.querySelector("updated")?.text || "");
				const summary = cleanFeedText(
					entry.querySelector("summary")?.text || entry.querySelector("content")?.text || "",
				);

				md += `## ${entryTitle}\n`;
				if (updated) md += `*${updated}*\n\n`;
				if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}
	} catch {}

	return content; // Fall back to raw content
}

/**
 * Render HTML to markdown using Parallel, jina, trafilatura, lynx (in order of preference)
 */
async function renderHtmlToText(
	url: string,
	html: string,
	timeout: number,
	settings: Settings,
	userSignal: AbortSignal | undefined,
	storage: AgentStorage | null,
): Promise<{ content: string; ok: boolean; method: string }> {
	const signal = ptree.combineSignals(userSignal, timeout * 1000);
	const execOptions = {
		mode: "group" as const,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full" as const,
		signal,
	};

	// Try Parallel extract first when credentials are configured
	if (settings.get("providers.parallelFetch") && findParallelApiKey(storage)) {
		try {
			const parallelResult = await extractWithParallel(
				[url],
				{
					objective: "Extract the main content",
					excerpts: true,
					fullContent: false,
					signal,
				},
				storage,
			);
			const firstDocument = parallelResult.results[0];
			if (firstDocument) {
				const content = getParallelExtractContent(firstDocument);
				if (content.trim().length > 100 && !isLowQualityOutput(content)) {
					return { content, ok: true, method: "parallel" };
				}
			}
		} catch {
			// Parallel extract failed, continue to next method
			signal?.throwIfAborted();
		}
	}

	// Try jina first (reader API)
	try {
		const jinaUrl = `https://r.jina.ai/${url}`;
		const response = await fetch(jinaUrl, {
			headers: { Accept: "text/markdown" },
			signal,
		});
		if (response.ok) {
			const content = await response.text();
			if (content.trim().length > 100 && !isLowQualityOutput(content)) {
				return { content, ok: true, method: "jina" };
			}
		}
	} catch {
		// Jina failed, continue to next method
		signal?.throwIfAborted();
	}

	// Try trafilatura (auto-install via uv/pip)
	const trafilatura = await ensureTool("trafilatura", { signal, silent: true });
	if (trafilatura) {
		const result = await ptree.exec([trafilatura, "-u", url, "--output-format", "markdown"], execOptions);
		if (result.ok && result.stdout.trim().length > 100) {
			return { content: result.stdout, ok: true, method: "trafilatura" };
		}
	}

	// Try lynx (can't auto-install, system package)
	const lynx = hasCommand("lynx");
	if (lynx) {
		const result = await ptree.exec(["lynx", "-dump", "-nolist", "-width", "250", url], execOptions);
		if (result.ok) {
			return { content: result.stdout, ok: true, method: "lynx" };
		}
	}

	// Fall back to native converter (fastest, no network/subprocess)
	try {
		const content = await htmlToMarkdown(html, { cleanContent: true });
		if (content.trim().length > 100 && !isLowQualityOutput(content)) {
			return { content, ok: true, method: "native" };
		}
	} catch {
		// Native converter failed, continue to next method
		signal?.throwIfAborted();
	}
	return { content: "", ok: false, method: "none" };
}

/**
 * Check if lynx output looks JS-gated or mostly navigation
 */
function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();

	// JS-gated indicators
	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
		return true;
	}

	// Mostly navigation (high link/menu density)
	const lines = content.split("\n").filter(l => l.trim());
	const shortLines = lines.filter(l => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
		return true;
	}

	return false;
}

/**
 * Format JSON
 */
function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
};

// =============================================================================
// Unified Special Handler Dispatch
// =============================================================================

/**
 * Try all special handlers
 */
async function handleSpecialUrls(
	url: string,
	timeout: number,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
): Promise<FetchRenderResult | null> {
	for (const handler of specialHandlers) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		const result = await handler(url, timeout, signal, storage);
		if (result) return result;
	}
	return null;
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Opt-in insane-search fallback for blocked / degraded public URL reads.
 *
 * Returns a finalized `method: "insane"` result on success, or null (so the
 * caller continues with its normal degraded behavior). Fail-closed: no note,
 * guard DNS, dependency probe, or subprocess when raw mode or the opt-in
 * setting is off. The public-URL guard runs BEFORE any probe/spawn.
 */
export async function tryInsaneFallback(args: {
	url: string;
	finalUrl: string;
	timeout: number;
	raw: boolean;
	settings: Settings;
	signal: AbortSignal | undefined;
	fetchedAt: string;
	notes: string[];
}): Promise<FetchRenderResult | null> {
	if (args.raw) return null;
	if (args.settings.get("web.insaneFallback") !== true) return null;

	const target = args.finalUrl || args.url;
	const guard = await validatePublicHttpUrlForInsane(target);
	if (!guard.ok) {
		args.notes.push(INSANE_NOTES.guardBlocked(guard.reason));
		return null;
	}

	const result = await tryInsaneFetch(guard.url.toString(), {
		timeoutMs: args.timeout * 1000,
		signal: args.signal,
	});
	if (result.ok) {
		const output = finalizeOutput(result.content);
		return {
			url: args.url,
			finalUrl: target,
			contentType: "text/markdown",
			method: "insane",
			content: output.content,
			fetchedAt: args.fetchedAt,
			truncated: output.truncated,
			notes: [...args.notes, ...result.notes],
		};
	}
	for (const note of result.notes) args.notes.push(note);
	return null;
}

/**
 * Main render function implementing the full pipeline
 */
async function renderUrl(
	url: string,
	timeout: number,
	raw: boolean,
	settings: Settings,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null,
): Promise<FetchRenderResult> {
	const notes: string[] = [];
	const fetchedAt = new Date().toISOString();
	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	// Handle internal protocol URLs (e.g., pi-internal://) - return empty
	if (url.startsWith("pi-internal://")) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "internal",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["Internal protocol URL - no external content"],
		};
	}

	// Step 0: Normalize URL (ensure scheme for special handlers)
	url = normalizeUrl(url);
	const publicUrl = await validatePublicHttpUrl(url);
	if (!publicUrl.ok) {
		notes.push(`Blocked URL fetch: target URL is not public HTTP(S): ${publicUrl.reason}`);
		return {
			url,
			finalUrl: url,
			contentType: "unknown",
			method: "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes,
		};
	}
	url = publicUrl.url.toString();

	// Step 1: Try special handlers for known sites (unless raw mode)
	if (!raw) {
		const specialResult = await handleSpecialUrls(url, timeout, signal, storage);
		if (specialResult) return specialResult;
	}

	// Step 2: Fetch page
	const response = await loadPage(url, { timeout, signal });
	if (signal?.aborted) {
		throw new ToolAbortError();
	}
	if (!response.ok) {
		const failureNote =
			response.error ?? (response.status ? `Failed to fetch URL (HTTP ${response.status})` : "Failed to fetch URL");
		notes.push(failureNote);
		const insane = await tryInsaneFallback({
			url,
			finalUrl: response.finalUrl || url,
			timeout,
			raw,
			settings,
			signal,
			fetchedAt,
			notes,
		});
		if (insane) return insane;
		return {
			url,
			finalUrl: response.finalUrl || url,
			contentType: response.contentType || "unknown",
			method: "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes,
		};
	}

	const { finalUrl, content: rawContent } = response;
	const mime = normalizeMime(response.contentType);
	const extHint = getExtensionHint(finalUrl);

	const imageMimeType = resolveImageMimeType(mime, extHint);
	let skipConvertibleBinaryRetry = false;
	if (imageMimeType) {
		if (!isInlineImageMimeTypeSupported(imageMimeType)) {
			notes.push(
				`Image MIME type ${imageMimeType} is unsupported for inline model serialization; returning text metadata only`,
			);
			const shouldTryConvertibleFallback = isConvertible(mime, extHint);
			if (shouldTryConvertibleFallback) {
				notes.push("Attempting binary conversion fallback for unsupported image MIME type");
			} else {
				notes.push("Falling back to textual rendering from initial response");
			}
			skipConvertibleBinaryRetry = !shouldTryConvertibleFallback;
		} else {
			const binary = await fetchBinary(finalUrl, timeout, signal);
			if (binary.ok) {
				notes.push("Fetched image binary");
				const conversionExtension = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
				let convertedText: string | null = null;
				const converted = await convertWithMarkit(binary.buffer, conversionExtension, timeout, signal);
				if (converted.ok) {
					if (converted.content.trim().length > 50) {
						notes.push("Converted with markit");
						convertedText = converted.content;
					} else {
						notes.push("markit conversion produced no usable output");
					}
				} else if (converted.error) {
					notes.push(`markit conversion failed: ${converted.error}`);
				} else {
					notes.push("markit conversion failed");
				}

				if (binary.buffer.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
					notes.push(
						`Image exceeds inline source limit (${binary.buffer.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						convertedText ?? `Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: convertedText ? "markit" : "image-too-large",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}

				const resized = await resizeImage(
					{ type: "image", data: Buffer.from(binary.buffer).toBase64(), mimeType: imageMimeType },
					{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES },
				);
				const isDecodedImage =
					resized.originalWidth > 0 && resized.originalHeight > 0 && resized.width > 0 && resized.height > 0;
				if (!isDecodedImage) {
					notes.push(`Fetched payload could not be decoded as ${imageMimeType}; returning text metadata only`);
					const output = finalizeOutput(
						convertedText ??
							rawContent ??
							`Fetched payload was labeled ${imageMimeType}, but bytes were not a valid image.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: convertedText ? "markit" : "image-invalid",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}
				if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
					notes.push(
						`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
					);
					const output = finalizeOutput(
						convertedText ?? `Fetched image content (${imageMimeType}), but it is too large to inline render.`,
					);
					return {
						url,
						finalUrl,
						contentType: imageMimeType,
						method: convertedText ? "markit" : "image-too-large",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}

				const dimensionNote = formatDimensionNote(resized);
				let imageSummary = convertedText ?? `Fetched image content (${resized.mimeType}).`;
				if (dimensionNote) {
					imageSummary += `\n${dimensionNote}`;
				}
				const output = finalizeOutput(imageSummary);
				return {
					url,
					finalUrl,
					contentType: resized.mimeType,
					method: "image",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
					image: {
						data: resized.data,
						mimeType: resized.mimeType,
					},
				};
			}
			notes.push(binary.error ? `Binary fetch failed: ${binary.error}` : "Binary fetch failed");
			notes.push("Falling back to textual rendering from initial response");
			skipConvertibleBinaryRetry = true;
		}
	}

	// Step 3: Handle convertible binary files (PDF, DOCX, etc.)
	if (!skipConvertibleBinaryRetry && isConvertible(mime, extHint)) {
		const binary = await fetchBinary(finalUrl, timeout, signal);
		if (binary.ok) {
			const ext = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
			const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
			if (converted.ok) {
				if (converted.content.trim().length > 50) {
					notes.push("Converted with markit");
					const output = finalizeOutput(converted.content);
					return {
						url,
						finalUrl,
						contentType: mime,
						method: "markit",
						content: output.content,
						fetchedAt,
						truncated: output.truncated,
						notes,
					};
				}
				notes.push("markit conversion produced no usable output");
			} else if (converted.error) {
				notes.push(`markit conversion failed: ${converted.error}`);
			} else {
				notes.push("markit conversion failed");
			}
		} else if (binary.error) {
			notes.push(`Binary fetch failed: ${binary.error}`);
		} else {
			notes.push("Binary fetch failed");
		}
	}

	// Step 4: Handle non-HTML text content
	const isHtml = mime.includes("html") || mime.includes("xhtml");
	const isJson = mime.includes("json");
	const isXml = mime.includes("xml") && !isHtml;
	const isText = mime.includes("text/plain") || mime.includes("text/markdown");
	const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");

	if (isJson) {
		const output = finalizeOutput(formatJson(rawContent));
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "json",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	if (isFeed || (isXml && (rawContent.includes("<rss") || rawContent.includes("<feed")))) {
		const parsed = parseFeedToMarkdown(rawContent);
		const output = finalizeOutput(parsed);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "feed",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	if (isText && !looksLikeHtml(rawContent)) {
		const output = finalizeOutput(rawContent);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "text",
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	// Step 5: For HTML, try digestible formats first (unless raw mode)
	if (isHtml && !raw) {
		// 5A: Check for page-specific markdown alternate
		const alternates = parseAlternateLinks(rawContent, finalUrl);
		const markdownAlt = alternates.find(alt => alt.endsWith(".md") || alt.includes("markdown"));
		if (markdownAlt) {
			const resolved = markdownAlt.startsWith("http") ? markdownAlt : new URL(markdownAlt, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 100 && !looksLikeHtml(altResult.content)) {
				notes.push(`Used markdown alternate: ${resolved}`);
				const output = finalizeOutput(altResult.content);
				return {
					url,
					finalUrl,
					contentType: "text/markdown",
					method: "alternate-markdown",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}
		}

		// 5B: Try URL.md suffix (llms.txt convention)
		const mdSuffix = await tryMdSuffix(finalUrl, timeout, signal);
		if (mdSuffix) {
			notes.push("Found .md suffix version");
			const output = finalizeOutput(mdSuffix);
			return {
				url,
				finalUrl,
				contentType: "text/markdown",
				method: "md-suffix",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// 5C: Content negotiation
		const negotiated = await tryContentNegotiation(url, timeout, signal);
		if (negotiated) {
			notes.push(`Content negotiation returned ${negotiated.type}`);
			const output = finalizeOutput(negotiated.content);
			return {
				url,
				finalUrl,
				contentType: normalizeMime(negotiated.type),
				method: "content-negotiation",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// 5D: Check for feed alternates
		const feedAlternates = alternates.filter(alt => !alt.endsWith(".md") && !alt.includes("markdown"));
		for (const altUrl of feedAlternates.slice(0, 2)) {
			const resolved = altUrl.startsWith("http") ? altUrl : new URL(altUrl, finalUrl).href;
			const altResult = await loadPage(resolved, { timeout, signal });
			if (altResult.ok && altResult.content.trim().length > 200) {
				notes.push(`Used feed alternate: ${resolved}`);
				const parsed = parseFeedToMarkdown(altResult.content);
				const output = finalizeOutput(parsed);
				return {
					url,
					finalUrl,
					contentType: "application/feed",
					method: "alternate-feed",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}
		}

		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		// 5E: Render HTML with lynx or html2text
		const htmlResult = await renderHtmlToText(finalUrl, rawContent, timeout, settings, signal, storage);
		if (!htmlResult.ok) {
			notes.push("html rendering failed (lynx/html2text unavailable)");
			const insane = await tryInsaneFallback({ url, finalUrl, timeout, raw, settings, signal, fetchedAt, notes });
			if (insane) return insane;
			const output = finalizeOutput(rawContent);
			return {
				url,
				finalUrl,
				contentType: mime,
				method: "raw-html",
				content: output.content,
				fetchedAt,
				truncated: output.truncated,
				notes,
			};
		}

		// Step 6: If rendered output is low quality, try more targeted fallbacks
		if (isLowQualityOutput(htmlResult.content)) {
			const docLinks = extractDocumentLinks(rawContent, finalUrl);
			if (docLinks.length > 0) {
				const docUrl = docLinks[0];
				const binary = await fetchBinary(docUrl, timeout, signal);
				if (binary.ok) {
					const ext = getExtensionHint(docUrl, binary.contentDisposition);
					const converted = await convertWithMarkit(binary.buffer, ext, timeout, signal);
					if (converted.ok && converted.content.trim().length > htmlResult.content.length) {
						notes.push(`Extracted and converted document: ${docUrl}`);
						const output = finalizeOutput(converted.content);
						return {
							url,
							finalUrl,
							contentType: "application/document",
							method: "extracted-document",
							content: output.content,
							fetchedAt,
							truncated: output.truncated,
							notes,
						};
					}
					if (!converted.ok && converted.error) {
						notes.push(`markit conversion failed: ${converted.error}`);
					}
				} else if (binary.error) {
					notes.push(`Binary fetch failed: ${binary.error}`);
				}
			}

			const llmResult = await tryLlmEndpoints(finalUrl, timeout, signal);
			if (llmResult) {
				notes.push(`Used llms.txt fallback: ${llmResult.endpoint}`);
				const output = finalizeOutput(llmResult.content);
				return {
					url,
					finalUrl,
					contentType: "text/plain",
					method: "llms.txt",
					content: output.content,
					fetchedAt,
					truncated: output.truncated,
					notes,
				};
			}

			const insaneLowQuality = await tryInsaneFallback({
				url,
				finalUrl,
				timeout,
				raw,
				settings,
				signal,
				fetchedAt,
				notes,
			});
			if (insaneLowQuality) return insaneLowQuality;
			notes.push("Page appears to require JavaScript or is mostly navigation");
		}

		const output = finalizeOutput(htmlResult.content);
		return {
			url,
			finalUrl,
			contentType: mime,
			method: htmlResult.method,
			content: output.content,
			fetchedAt,
			truncated: output.truncated,
			notes,
		};
	}

	// Fallback: return raw content
	const output = finalizeOutput(rawContent);
	return {
		url,
		finalUrl,
		contentType: mime,
		method: "raw",
		content: output.content,
		fetchedAt,
		truncated: output.truncated,
		notes,
	};
}

// =============================================================================
// Tool Definition
// =============================================================================

export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

interface ReadUrlCacheEntry {
	artifactId?: string;
	details: ReadUrlToolDetails;
	image?: FetchImagePayload;
	output: string;
}

const readUrlCache = new Map<string, ReadUrlCacheEntry>();

function getReadUrlCacheKey(session: ToolSession, requestedUrl: string, raw: boolean): string {
	const scope = session.getSessionFile() ?? session.cwd;
	return `${scope}::${raw ? "raw" : "rendered"}::${normalizeUrl(requestedUrl)}`;
}

async function readArtifactOutput(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir) return null;

	try {
		const files = await fs.readdir(artifactsDir);
		const match = files.find(file => file.startsWith(`${artifactId}.`));
		if (!match) return null;
		return await Bun.file(path.join(artifactsDir, match)).text();
	} catch {
		return null;
	}
}

async function materializeReadUrlCacheEntry(
	session: ToolSession,
	entry: ReadUrlCacheEntry,
): Promise<ReadUrlCacheEntry | null> {
	if (entry.artifactId) {
		const artifactOutput = await readArtifactOutput(session, entry.artifactId);
		if (artifactOutput !== null) {
			return { ...entry, output: artifactOutput };
		}
	}

	return entry.output.length > 0 ? entry : null;
}

async function persistReadUrlArtifact(session: ToolSession, output: string): Promise<string | undefined> {
	const { path: artifactPath, id } = (await session.allocateOutputArtifact?.("read")) ?? {};
	if (!artifactPath) return undefined;
	await Bun.write(artifactPath, output);
	return id;
}

async function ensureReadUrlCacheArtifact(session: ToolSession, entry: ReadUrlCacheEntry): Promise<ReadUrlCacheEntry> {
	if (entry.artifactId) return entry;
	const artifactId = await persistReadUrlArtifact(session, entry.output);
	return artifactId ? { ...entry, artifactId } : entry;
}

function cacheReadUrlEntry(session: ToolSession, requestedUrl: string, raw: boolean, entry: ReadUrlCacheEntry): void {
	readUrlCache.set(getReadUrlCacheKey(session, requestedUrl, raw), entry);
	readUrlCache.set(getReadUrlCacheKey(session, entry.details.finalUrl, raw), entry);
}

async function buildReadUrlCacheEntry(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean },
): Promise<ReadUrlCacheEntry> {
	const { path: url, raw = false } = params;

	const effectiveTimeout = clampTimeout("fetch", 30);

	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	const storage = session.settings.getStorage();
	const result = await renderUrl(url, effectiveTimeout, raw, session.settings, signal, storage);
	const output = buildUrlReadOutput(result, result.content);
	const artifactId = options?.ensureArtifact ? await persistReadUrlArtifact(session, output) : undefined;

	return {
		artifactId,
		details: {
			kind: "url",
			url: result.url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: result.method,
			truncated: Boolean(result.truncated),
			notes: result.notes,
		},
		image: result.image,
		output,
	};
}

export async function loadReadUrlCacheEntry(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean; preferCached?: boolean },
): Promise<ReadUrlCacheEntry> {
	const raw = params.raw ?? false;
	const cached = readUrlCache.get(getReadUrlCacheKey(session, params.path, raw));
	if (options?.preferCached && cached) {
		const prepared = options.ensureArtifact ? await ensureReadUrlCacheArtifact(session, cached) : cached;
		const materialized = await materializeReadUrlCacheEntry(session, prepared);
		if (materialized) {
			cacheReadUrlEntry(session, params.path, raw, materialized);
			return materialized;
		}
	}

	const fresh = await buildReadUrlCacheEntry(session, params, signal, {
		ensureArtifact: options?.ensureArtifact,
	});
	cacheReadUrlEntry(session, params.path, raw, fresh);
	return fresh;
}

function buildUrlReadOutput(result: FetchRenderResult, content: string): string {
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

export async function executeReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadUrlToolDetails>> {
	let cacheEntry = await loadReadUrlCacheEntry(session, params, signal, { preferCached: true });
	const truncation = truncateHead(cacheEntry.output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: FETCH_DEFAULT_MAX_LINES,
	});
	const needsArtifact = truncation.truncated;
	if (needsArtifact && !cacheEntry.artifactId) {
		cacheEntry = await ensureReadUrlCacheArtifact(session, cacheEntry);
		cacheReadUrlEntry(session, params.path, params.raw ?? false, cacheEntry);
	}
	const output = needsArtifact ? truncation.content : cacheEntry.output;
	const details: ReadUrlToolDetails = {
		...cacheEntry.details,
		truncated: Boolean(cacheEntry.details.truncated || needsArtifact),
	};

	const contentBlocks: Array<TextContent | ImageContent> = [{ type: "text", text: output }];
	if (cacheEntry.image) {
		contentBlocks.push({ type: "image", data: cacheEntry.image.data, mimeType: cacheEntry.image.mimeType });
	}

	const resultBuilder = toolResult(details).content(contentBlocks).sourceUrl(details.finalUrl);
	if (needsArtifact) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: cacheEntry.artifactId });
	} else if (cacheEntry.details.truncated) {
		const outputLines = cacheEntry.output.split("\n").length;
		const outputBytes = Buffer.byteLength(cacheEntry.output, "utf-8");
		const totalBytes = Math.max(outputBytes + 1, MAX_OUTPUT_CHARS + 1);
		const totalLines = outputLines + 1;
		resultBuilder.truncationFromText(cacheEntry.output, {
			direction: "tail",
			totalLines,
			totalBytes,
			maxBytes: MAX_OUTPUT_CHARS,
		});
	}

	return resultBuilder.done();
}

// =============================================================================
// TUI Rendering
// =============================================================================

/** Count non-empty lines */
function countNonEmptyLines(text: string): number {
	return text.split("\n").filter(l => l.trim()).length;
}

/** Render URL read call (URL preview) */
export function renderReadUrlCall(
	args: { path?: string; url?: string; raw?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const url = args.path ?? args.url ?? "";
	const domain = getDomain(url);
	const path = truncate(url.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const description = `${domain}${path ? ` ${path}` : ""}`.trim();
	const meta: string[] = [];
	if (args.raw) meta.push("raw");
	const text = renderStatusLine({ icon: "pending", title: "Read", description, meta }, uiTheme);
	return new Text(text, 0, 0);
}

/** Render URL read result with tree-based layout */
export function renderReadUrlResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme = theme,
): Component {
	const details = result.details;

	if (result.isError || !details) {
		const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
		const errorText = (rawErrorText || "No response data").replace(/^Error:\s*/, "");
		const urlText = details?.finalUrl ?? details?.url ?? "";
		const description = urlText ? `${getDomain(urlText)}${urlText.replace(/^https?:\/\/[^/]+/, "")}` : undefined;
		const header = renderStatusLine({ icon: "error", title: "Read", description }, uiTheme);
		const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
		const outputBlock = new CachedOutputBlock();
		return {
			render: (width: number) =>
				outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
			invalidate: () => outputBlock.invalidate(),
		};
	}

	const domain = getDomain(details.finalUrl);
	const path = truncate(details.finalUrl.replace(/^https?:\/\/[^/]+/, ""), 50, "…");
	const hasRedirect = details.url !== details.finalUrl;
	const hasNotes = details.notes.length > 0;
	const truncation = details.meta?.truncation;
	const truncated = Boolean(details.truncated || truncation);

	const header = renderStatusLine(
		{
			icon: truncated ? "warning" : "success",
			title: "Read",
			description: `${domain}${path ? ` ${path}` : ""}`,
		},
		uiTheme,
	);

	const contentText = result.content[0]?.text ?? "";
	const contentBody = contentText.includes("---\n\n")
		? contentText.split("---\n\n").slice(1).join("---\n\n")
		: contentText;
	const lineCount = countNonEmptyLines(contentBody);
	const charCount = contentBody.trim().length;
	const contentLines = contentBody.split("\n").filter(l => l.trim());

	const metadataLines: string[] = [
		`${uiTheme.fg("muted", "Content-Type:")} ${details.contentType || "unknown"}`,
		`${uiTheme.fg("muted", "Method:")} ${details.method}`,
	];
	if (hasRedirect) {
		metadataLines.push(`${uiTheme.fg("muted", "Final URL:")} ${uiTheme.fg("mdLinkUrl", details.finalUrl)}`);
	}
	const lineLabel = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
	metadataLines.push(`${uiTheme.fg("muted", "Lines:")} ${lineLabel}`);
	metadataLines.push(`${uiTheme.fg("muted", "Chars:")} ${charCount}`);
	if (truncated) {
		metadataLines.push(uiTheme.fg("warning", `${uiTheme.status.warning} Output truncated`));
		if (truncation?.artifactId) metadataLines.push(formatStyledArtifactReference(truncation.artifactId, uiTheme));
	}
	if (hasNotes) {
		metadataLines.push(`${uiTheme.fg("muted", "Notes:")} ${details.notes.join("; ")}`);
	}

	const outputBlock = new CachedOutputBlock();
	let lastExpanded: boolean | undefined;
	let contentPreviewLines: string[] | undefined;

	return {
		render: (width: number) => {
			const { expanded } = options;

			if (contentPreviewLines === undefined || lastExpanded !== expanded) {
				const previewLimit = expanded ? 12 : 3;
				const previewList = applyListLimit(contentLines, { headLimit: previewLimit });
				const previewLines = previewList.items.map(line => line.trimEnd());
				const remaining = Math.max(0, contentLines.length - previewList.items.length);
				contentPreviewLines =
					previewLines.length > 0
						? previewLines.map(line => uiTheme.fg("dim", line))
						: [uiTheme.fg("dim", "(no content)")];
				if (remaining > 0) {
					const hint = formatExpandHint(uiTheme, expanded, true);
					contentPreviewLines.push(uiTheme.fg("muted", `… ${remaining} more lines${hint ? ` ${hint}` : ""}`));
				}
				lastExpanded = expanded;
				outputBlock.invalidate();
			}

			return outputBlock.render(
				{
					header,
					state: truncated ? "warning" : "success",
					sections: [
						{ label: uiTheme.fg("toolTitle", "Metadata"), lines: metadataLines },
						{ label: uiTheme.fg("toolTitle", "Content Preview"), lines: contentPreviewLines },
					],
					width,
					applyBg: false,
				},
				uiTheme,
			);
		},
		invalidate: () => {
			outputBlock.invalidate();
			contentPreviewLines = undefined;
			lastExpanded = undefined;
		},
	};
}
