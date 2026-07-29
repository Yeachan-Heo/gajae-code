import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { escapeUntrustedContent, loadReadUrlCacheEntry, WRAP_PREFIX_CHARS } from "@gajae-code/coding-agent/tools/fetch";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import * as imageResize from "@gajae-code/coding-agent/utils/image-resize";
import * as toolsManager from "@gajae-code/coding-agent/utils/tools-manager";
import { specialHandlers } from "@gajae-code/coding-agent/web/scrapers";
import * as scrapers from "@gajae-code/coding-agent/web/scrapers/types";
import * as scraperUtils from "@gajae-code/coding-agent/web/scrapers/utils";
import * as natives from "@gajae-code/natives";
import { hookFetch, ptree, Snowflake } from "@gajae-code/utils";

const withMissingSystemPython = () => {
	const whichSpy = vi.spyOn(Bun, "which").mockImplementation(() => null);
	return {
		[Symbol.dispose]() {
			whichSpy.mockRestore();
		},
	};
};

describe("read tool URL selector shorthands", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-kagi-toggle-shorthand-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	const createSession = (): ToolSession => {
		const sessionFile = path.join(testDir, "session.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		let nextArtifactId = 0;
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => {
				const id = String(nextArtifactId++);
				return {
					id,
					path: path.join(artifactsDir, `${id}.${toolType}.log`),
				};
			},
			settings: Settings.isolated({
				"fetch.enabled": true,
			}),
		};
	};

	it("supports embedded raw selectors in URL paths", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/embedded-raw";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== pageUrl) {
				throw new Error(`Unexpected URL: ${requestedUrl}`);
			}
			return {
				ok: true,
				status: 200,
				contentType: "text/html",
				finalUrl: pageUrl,
				content: "<html><body><main><h1>Embedded raw page</h1></main></body></html>",
			};
		});

		const result = await tool.execute("fetch-embedded-raw", { path: `${pageUrl}:raw` });
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body><main><h1>Embedded raw page</h1></main></body></html>");
		expect(loadPageSpy).toHaveBeenCalledWith(pageUrl, expect.anything());
	});

	it("supports embedded line selectors in URL paths", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/embedded-lines";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== pageUrl) {
				throw new Error(`Unexpected URL: ${requestedUrl}`);
			}
			return {
				ok: true,
				status: 200,
				contentType: "text/plain",
				finalUrl: pageUrl,
				content: "Line 1\nLine 2\nLine 3",
			};
		});

		const result = await tool.execute("fetch-embedded-lines", { path: `${pageUrl}:7-8` });
		const textBlock = result.content.find(content => content.type === "text");

		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Line 1");
		expect(textBlock?.text).toContain("Line 2");
		// Read tool widens the window by ±3 unanchored context lines.
		expect(loadPageSpy).toHaveBeenCalledTimes(1);
		expect(loadPageSpy).toHaveBeenCalledWith(pageUrl, expect.anything());
	});
});

describe("read tool URL handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-kagi-toggle-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	const createSession = (overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession => {
		const sessionFile = path.join(testDir, "session.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		let nextArtifactId = 0;
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => {
				const id = String(nextArtifactId++);
				return {
					id,
					path: path.join(artifactsDir, `${id}.${toolType}.log`),
				};
			},
			settings: Settings.isolated({
				"fetch.enabled": true,
				...overrides,
			}),
		};
	};

	it("returns an image content block when fetching image URLs", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const imageBytes = new Uint8Array([137, 80, 78, 71]);
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: imageBytes,
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: false,
			content: "",
			error: "markit unavailable",
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: imageBytes,
			mimeType: "image/png",
			originalWidth: 1,
			originalHeight: 1,
			width: 1,
			height: 1,
			wasResized: false,
			get data() {
				return imageBytes.toBase64();
			},
		});

		const result = await tool.execute("fetch-image", { path: "https://example.com/image.png" });
		const imageBlock = result.content.find(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);

		expect(result.details?.method).toBe("image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.mimeType).toBe("image/png");
		expect(imageBlock?.data).toBe(imageBytes.toBase64());
	});

	it("resizes fetched images before emitting image content blocks", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const resizeSpy = vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([1, 2, 3]),
			mimeType: "image/jpeg",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
			get data() {
				return "cmVzaXplZA==";
			},
		});
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([137, 80, 78, 71]),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: false,
			content: "",
			error: "markit unavailable",
		});

		const result = await tool.execute("fetch-image-resized", { path: "https://example.com/image.png" });
		const imageBlock = result.content.find(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);
		const textBlock = result.content.find(content => content.type === "text");

		expect(resizeSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.method).toBe("image");
		expect(imageBlock?.mimeType).toBe("image/jpeg");
		expect(imageBlock?.data).toBe("cmVzaXplZA==");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("displayed at 1000x500");
	});

	it("keeps markit extracted text for image responses", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const extractedText = "Converted image text content that is definitely longer than fifty characters.";
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
			originalWidth: 100,
			originalHeight: 100,
			width: 100,
			height: 100,
			wasResized: false,
			get data() {
				return "aW1hZ2U=";
			},
		});
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([137, 80, 78, 71]),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: true,
			content: extractedText,
		});

		const result = await tool.execute("fetch-image-with-ocr", { path: "https://example.com/image.png" });
		const textBlock = result.content.find(content => content.type === "text");
		const imageBlock = result.content.find(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);

		expect(result.details?.method).toBe("image");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain(extractedText);
		expect(imageBlock?.mimeType).toBe("image/png");
		expect(imageBlock?.data).toBe("aW1hZ2U=");
	});
	it("falls back to text-only output for unsupported image MIME types", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const fetchBinarySpy = vi.spyOn(scraperUtils, "fetchBinary");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/svg+xml",
			finalUrl: "https://example.com/image.svg",
			content: "<svg></svg>",
		});

		const result = await tool.execute("fetch-image-unsupported", { path: "https://example.com/image.svg" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(fetchBinarySpy).not.toHaveBeenCalled();
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<svg></svg>");
	});

	it("uses binary conversion fallback for unsupported image MIME when extension is convertible", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const convertedText = "Converted image text from markit fallback with sufficient length to pass threshold.";
		const fetchBinarySpy = vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([255, 216, 255, 224]),
		});
		const convertSpy = vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: true,
			content: convertedText,
		});
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/jpg",
			finalUrl: "https://example.com/image.jpg",
			content: "\u0000\u0001garbage",
		});

		const result = await tool.execute("fetch-image-jpg-fallback", { path: "https://example.com/image.jpg" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("markit");
		expect(fetchBinarySpy).toHaveBeenCalledTimes(1);
		expect(convertSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.notes).toContain("Attempting binary conversion fallback for unsupported image MIME type");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain(convertedText);
	});

	it("does not treat text/html at .png paths as inline images", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({ ok: false, error: "not an image" });
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/html",
			finalUrl: "https://example.com/foo.png",
			content: "<html><body>not really an image</body></html>",
		});

		const result = await tool.execute("fetch-html-png-path", { path: "https://example.com/foo.png:raw" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>not really an image</body></html>");
	});

	it("falls back to textual output when inline image refetch fails", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const convertSpy = vi.spyOn(scraperUtils, "convertWithMarkit");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/transient.png",
			content: "<html><body>temporary gateway page</body></html>",
		});
		const fetchBinarySpy = vi
			.spyOn(scraperUtils, "fetchBinary")
			.mockResolvedValue({ ok: false, error: "upstream blocked" });

		const result = await tool.execute("fetch-image-refetch-failed", { path: "https://example.com/transient.png" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>temporary gateway page</body></html>");
		expect(convertSpy).not.toHaveBeenCalled();
		expect(fetchBinarySpy).toHaveBeenCalledTimes(1);
	});
	it("falls back to text-only output when image payload bytes are invalid", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/broken.png",
			content: "<html><body>gateway error</body></html>",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: false,
			content: "",
			error: "conversion failed",
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
			mimeType: "image/png",
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
			get data() {
				return "PGh0bWw=";
			},
		});

		const result = await tool.execute("fetch-broken-image", { path: "https://example.com/broken.png" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("image-invalid");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>gateway error</body></html>");
	});
	it("prefers rendered page content over site-wide llms.txt for deep pages", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://bun.com/reference/bun/UnixSocketOptions";
		const pageHtml = "<html><body><main><h1>UnixSocketOptions</h1><p>Page-specific docs.</p></main></body></html>";
		const renderedMarkdown = `# UnixSocketOptions\n\n${"Page-specific API docs. ".repeat(8)}`;
		using missingSystemPython = withMissingSystemPython();
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}

			if (requestedUrl === `${pageUrl}.md`) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}

			if (requestedUrl === "https://bun.com/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Bun\n\n${"Site-wide overview. ".repeat(12)}`,
				};
			}

			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});
		using hook = hookFetch(() => new Response("blocked", { status: 500, statusText: "Blocked" }));
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(natives, "htmlToMarkdown").mockResolvedValue(renderedMarkdown);

		const result = await tool.execute("fetch-deep-page", { path: pageUrl });
		const requestedUrls = loadPageSpy.mock.calls.map(([requestedUrl]) => requestedUrl);
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("native");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("UnixSocketOptions");
		expect(requestedUrls).not.toContain("https://bun.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.md");
		void missingSystemPython;
		void hook;
	});

	it("does not use subprocess output to trigger an llms.txt refetch", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/docs/reference/widget";
		const pageHtml = "<html><body><nav>Docs</nav><main><h1>Widget</h1></main></body></html>";
		const lowQualityRender = `${"Please enable JavaScript to view this page.\n".repeat(6)}${"navigation\n".repeat(4)}`;
		using missingSystemPython = withMissingSystemPython();
		vi.spyOn(ptree, "exec").mockResolvedValue({ ok: true, stdout: lowQualityRender } as never);
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}

			if (
				[
					`${pageUrl}.md`,
					"https://example.com/docs/reference/llms.txt",
					"https://example.com/docs/reference/llms.md",
					"https://example.com/docs/llms.md",
				].includes(requestedUrl)
			) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}

			if (requestedUrl === "https://example.com/docs/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Example Docs\n\n${"Section-scoped fallback. ".repeat(10)}`,
				};
			}

			if (requestedUrl === "https://example.com/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Example\n\n${"Site-wide fallback. ".repeat(10)}`,
				};
			}

			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});
		using hook = hookFetch(() => new Response("blocked", { status: 500, statusText: "Blocked" }));
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/usr/bin/trafilatura");

		const result = await tool.execute("fetch-section-llms", { path: pageUrl });
		const requestedUrls = loadPageSpy.mock.calls.map(([requestedUrl]) => requestedUrl);
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw-html");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Widget");
		expect(requestedUrls).not.toContain("https://example.com/docs/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.md");
		void missingSystemPython;
		void hook;
	});
	it("does not hand fetched HTML URLs to Parallel when configured", async () => {
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/parallel-page";
		const pageHtml = "<html><body><main><h1>Parallel Page</h1></main></body></html>";
		const ensureToolSpy = vi.spyOn(toolsManager, "ensureTool");
		const htmlToMarkdownSpy = vi.spyOn(natives, "htmlToMarkdown");
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}

			if (requestedUrl === `${pageUrl}.md`) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}

			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});
		using parallelExtractHook = hookFetch(input => {
			const requestedUrl = String(input);
			if (requestedUrl === "https://api.parallel.ai/v1beta/extract") {
				return new Response(
					JSON.stringify({
						extract_id: "extract-fetch-1",
						results: [
							{
								url: pageUrl,
								title: "Parallel Page",
								excerpts: [
									"Parallel-rendered content that is comfortably longer than one hundred characters. ".repeat(
										2,
									),
								],
								full_content: null,
							},
						],
						errors: [],
						warnings: null,
						usage: null,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("blocked", { status: 500, statusText: "Blocked" });
		});

		const result = await tool.execute("fetch-parallel-html", { path: pageUrl });
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw-html");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Parallel Page");
		expect(ensureToolSpy).not.toHaveBeenCalled();
		expect(htmlToMarkdownSpy).toHaveBeenCalledTimes(1);
		void parallelExtractHook;
	});

	it("reuses cached output for repeated plain URL reads", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/repeated-read-cache";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: "Cached line 1\nCached line 2",
		});

		const firstResult = await tool.execute("fetch-cache-first", { path: pageUrl });
		const secondResult = await tool.execute("fetch-cache-second", { path: pageUrl });
		const firstText = firstResult.content.find(content => content.type === "text");
		const secondText = secondResult.content.find(content => content.type === "text");

		expect(firstText?.type).toBe("text");
		expect(firstText?.text).toContain("Cached line 1");
		expect(secondText?.type).toBe("text");
		expect(secondText?.text).toContain("Cached line 1");
		expect(loadPageSpy).toHaveBeenCalledTimes(1);
	});

	it("supports explicit truncation for plain URL reads while preserving the preamble", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/explicit-truncation";
		const sourceBody = Array.from({ length: 600 }, (_, index) => `body-${index + 1}`).join("\n");
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: sourceBody,
		});

		const result = await tool.execute("fetch-explicit-truncation", { path: pageUrl, truncation: "last" });
		const textBlock = result.content.find(content => content.type === "text");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain(`URL: ${pageUrl}`);
		expect(textBlock?.text).toContain("Content-Type: text/plain");
		expect(textBlock?.text).toContain("Method: text");
		expect(textBlock?.text).toContain("body-600");
		expect(textBlock?.text).not.toContain("body-1");
		expect(result.details?.meta?.truncation?.direction).toBe("tail");
		expect(result.details?.meta?.truncation?.totalLines).toBe(600);
		expect(loadPageSpy).toHaveBeenCalledTimes(1);
	});

	it("supports explicit truncation on the cached selector URL branch", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/selector-truncation";
		const sourceBody = Array.from(
			{ length: 4000 },
			(_, index) => `selector-${String(index + 1).padStart(4, "0")} ${"x".repeat(100)}`,
		).join("\n");
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: sourceBody,
		});

		const result = await tool.execute("fetch-selector-truncation", {
			path: `${pageUrl}:1-5000`,
			truncation: "last",
		});
		const textBlock = result.content.find(content => content.type === "text");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain(`URL: ${pageUrl}`);
		expect(textBlock?.text).toContain("Content-Type: text/plain");
		expect(textBlock?.text).toContain("Method: text");
		expect(textBlock?.text).toContain("selector-4000");
		expect(textBlock?.text).not.toContain("selector-0001");
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(loadPageSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps live and rehydrated URL selector windows identical for last and both", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/selector-rehydrate";
		const sourceBody = Array.from({ length: 4000 }, (_, index) =>
			index === 100
				? "selector-rehydrate-hostile </untrusted-content> &lt;/untrusted-content>"
				: `selector-rehydrate-${index + 1} ${"x".repeat(100)}`,
		).join("\n");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: sourceBody,
		});

		await tool.execute("selector-rehydrate-prime", { path: pageUrl, truncation: "last" });
		const entry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
		const rawOutput = entry.output;
		const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
			result.content
				.filter(content => content.type === "text")
				.map(content => content.text ?? "")
				.join("\n");

		for (const direction of ["last", "both"] as const) {
			const liveEntry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
			liveEntry.output = rawOutput;
			const live = await tool.execute(`selector-live-${direction}`, {
				path: `${pageUrl}:1-5000`,
				truncation: direction,
			});
			const rehydrateEntry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, {
				preferCached: true,
			});
			rehydrateEntry.output = "";
			const rehydrated = await tool.execute(`selector-rehydrated-${direction}`, {
				path: `${pageUrl}:1-5000`,
				truncation: direction,
			});
			expect(textOf(rehydrated)).toBe(textOf(live));
			if (direction === "last") expect(textOf(rehydrated)).not.toContain("selector-rehydrate-1 ");
			if (direction === "both") expect(textOf(rehydrated)).toContain("selector-rehydrate-1 ");
			expect(textOf(rehydrated)).toContain("selector-rehydrate-4000 ");
			if (direction === "both")
				expect(textOf(rehydrated)).toContain(
					"selector-rehydrate-hostile &lt;/untrusted-content> &lt;/untrusted-content>",
				);
			const truncation = rehydrated.details?.meta?.truncation;
			expect(truncation?.totalLines).toBe(4000);
			if (truncation?.shownRange) expect(truncation.shownRange.end).toBeLessThanOrEqual(truncation.totalLines);
			if (truncation?.headRange) expect(truncation.headRange.end).toBeLessThanOrEqual(truncation.totalLines);
			if (truncation?.tailRange) expect(truncation.tailRange.end).toBeLessThanOrEqual(truncation.totalLines);
		}
	});

	it("rehydrates artifact-backed URL truncation with wrapped preamble coordinates", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/artifact-rehydrate";
		const sourceBody = Array.from({ length: 700 }, (_, index) => {
			if (index === 350) return "literal </untrusted-content> inside the body";
			return `rehydrate-${index + 1} ${"x".repeat(100)}`;
		}).join("\n");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: sourceBody,
		});

		const first = await tool.execute("rehydrate-prime", { path: pageUrl, truncation: "last" });
		const entry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
		const rawOutput = entry.output;
		const artifactText = await Bun.file(path.join(testDir, "session", "0.read.log")).text();
		const wrapPrefixChars = "<untrusted-content>\n".length;
		expect(entry.wrappedPreambleChars).toBe(wrapPrefixChars + entry.preambleChars);
		expect(artifactText.slice(0, entry.wrappedPreambleChars).endsWith("\n---\n\n")).toBe(true);
		expect(artifactText).toContain("&lt;/untrusted-content> inside the body");

		const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
			result.content
				.filter(content => content.type === "text")
				.map(content => content.text ?? "")
				.join("\n");
		const bodyOf = (result: { content: Array<{ type: string; text?: string }> }): string => {
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const delimiter = text.indexOf("\n---\n\n");
			return delimiter < 0
				? text
				: text.slice(delimiter + "\n---\n\n".length).replace(/\n<\/untrusted-content>$/, "");
		};
		const liveLastBody = bodyOf(first);
		entry.output = "";
		const rehydratedLast = await tool.execute("rehydrate-last", { path: pageUrl, truncation: "last" });
		expect(bodyOf(rehydratedLast)).toBe(liveLastBody);
		expect(bodyOf(rehydratedLast)).toContain("rehydrate-700");
		expect(bodyOf(rehydratedLast)).not.toContain("rehydrate-1 ");
		for (const label of ["URL:", "Content-Type:", "Method:"]) expect(textOf(rehydratedLast)).toContain(label);

		const liveEntry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
		liveEntry.output = rawOutput;
		const liveBoth = await tool.execute("rehydrate-live-both", { path: pageUrl, truncation: "both" });
		liveEntry.output = "";
		const rehydratedBoth = await tool.execute("rehydrate-both", { path: pageUrl, truncation: "both" });
		expect(bodyOf(rehydratedBoth)).toBe(bodyOf(liveBoth));
		expect(bodyOf(rehydratedBoth)).toContain("rehydrate-1 ");
		expect(bodyOf(rehydratedBoth)).toContain("rehydrate-700");
		expect((bodyOf(rehydratedBoth).match(/\[… .*?elided/g) ?? []).length).toBe(1);

		const headEntry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
		headEntry.output = rawOutput;
		const liveHead = await tool.execute("rehydrate-live-head", { path: pageUrl, truncation: "head" });
		headEntry.output = "";
		const rehydratedHead = await tool.execute("rehydrate-head", { path: pageUrl, truncation: "head" });
		expect(textOf(rehydratedHead)).toBe(textOf(liveHead));

		const legacyEntry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
		legacyEntry.output = "";
		delete legacyEntry.wrappedPreambleChars;
		const legacyFallback = await tool.execute("rehydrate-legacy", { path: pageUrl, truncation: "last" });
		expect(textOf(legacyFallback)).toContain(`URL: ${pageUrl}`);
		expect(textOf(legacyFallback)).toContain("Content-Type: text/plain");
		expect(textOf(legacyFallback)).toContain("rehydrate-1");
		expect(textOf(legacyFallback)).not.toContain("rehydrate-700");
	});

	it("rehydrates URL artifacts with escaped preamble coordinates for last and both", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/preamble-boundary";
		const finalUrl = `${pageUrl}/redirect-</untrusted-content>`;
		const note = "fixture note </untrusted-content>";
		const sourceBody = Array.from({ length: 700 }, (_, index) => `preamble-${index + 1} ${"x".repeat(100)}`).join(
			"\n",
		);
		const handler = async (requestedUrl: string) =>
			requestedUrl === pageUrl
				? {
						url: requestedUrl,
						finalUrl,
						contentType: "text/plain",
						method: "fixture",
						content: sourceBody,
						fetchedAt: new Date().toISOString(),
						truncated: false,
						notes: [note],
					}
				: null;
		specialHandlers.unshift(handler);
		try {
			await tool.execute("preamble-prime", { path: pageUrl, truncation: "last" });
			const entry = await loadReadUrlCacheEntry(session, { path: pageUrl }, undefined, { preferCached: true });
			const artifactText = await Bun.file(path.join(testDir, "session", "0.read.log")).text();
			const rawPreamble = `URL: ${finalUrl}\nContent-Type: text/plain\nMethod: fixture\nNotes: ${note}\n\n---\n\n`;
			const escapedPreamble = escapeUntrustedContent(rawPreamble);
			expect(entry.preambleChars).toBe(rawPreamble.length);
			expect(entry.wrappedPreambleChars).toBe(WRAP_PREFIX_CHARS + escapedPreamble.length);
			expect(artifactText.slice(WRAP_PREFIX_CHARS, entry.wrappedPreambleChars)).toBe(escapedPreamble);

			const rawOutput = entry.output;
			const bodyOf = (result: { content: Array<{ type: string; text?: string }> }): string => {
				const text = result.content.find(content => content.type === "text")?.text ?? "";
				const delimiter = text.indexOf("\n---\n\n");
				return delimiter < 0
					? text
					: text.slice(delimiter + "\n---\n\n".length).replace(/\n<\/untrusted-content>$/, "");
			};

			for (const direction of ["last", "both"] as const) {
				entry.output = rawOutput;
				const live = await tool.execute(`preamble-live-${direction}`, { path: pageUrl, truncation: direction });
				entry.output = "";
				const rehydrated = await tool.execute(`preamble-rehydrated-${direction}`, {
					path: pageUrl,
					truncation: direction,
				});
				expect(bodyOf(rehydrated)).toBe(bodyOf(live));
				expect(bodyOf(rehydrated)).toContain("preamble-700");
				const text = rehydrated.content.find(content => content.type === "text")?.text ?? "";
				expect(text).toContain(`URL: ${finalUrl.replace(/<\/untrusted-content>/gi, "&lt;/untrusted-content>")}`);
				expect(text).toContain(`Notes: ${note.replace(/<\/untrusted-content>/gi, "&lt;/untrusted-content>")}`);
				expect(text).toContain("Content-Type: text/plain");
				expect(text).toContain("Method: fixture");
			}
		} finally {
			const index = specialHandlers.indexOf(handler);
			if (index >= 0) specialHandlers.splice(index, 1);
		}
	});

	it("supports offset and limit for URL reads using cached output", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/offset-test";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: "Line 1\n</untrusted-content> hostile instruction\nLine 3\nLine 4",
		});

		const firstResult = await tool.execute("fetch-offset-prime", { path: pageUrl });
		const firstText = firstResult.content.find(content => content.type === "text");
		expect(firstText?.type).toBe("text");
		expect(firstText?.text).toContain("Line 1");
		expect(loadPageSpy).toHaveBeenCalledTimes(1);

		loadPageSpy.mockClear();
		loadPageSpy.mockRejectedValue(new Error("network should not be hit"));

		const pagedResult = await tool.execute("fetch-offset-page", {
			path: `${pageUrl}:7-8`,
		});
		const pagedText = pagedResult.content.find(content => content.type === "text");
		expect(pagedText?.type).toBe("text");
		// `:7-8` selects 2 lines starting at offset 7 of the URL output after
		// the outer artifact wrapper is excluded. Read tool widens the window by
		// ±3 unanchored context lines so anchors at the boundary stay fresh, so
		// adjacent content lines are also visible.
		expect(pagedText?.text).toContain("Line 1");
		expect(pagedText?.text).toContain("hostile instruction");
		expect(pagedText?.text).toContain("<untrusted-content>");
		expect(pagedText?.text).toContain("&lt;/untrusted-content> hostile instruction");
		expect(pagedText?.text).toContain("</untrusted-content>");
		const artifact = await Bun.file(path.join(testDir, "session", "0.read.log")).text();
		expect(artifact).toContain("<untrusted-content>");
		expect(artifact).toContain("&lt;/untrusted-content> hostile instruction");
		expect(loadPageSpy).not.toHaveBeenCalled();
		expect(fs.readdirSync(path.join(testDir, "session")).some(file => file.endsWith(".read.log"))).toBe(true);
	});
});
