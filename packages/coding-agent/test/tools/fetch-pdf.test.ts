import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { loadReadUrlCacheEntry, readUrlCacheTestHooks } from "@gajae-code/coding-agent/tools/fetch";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import * as urlGuard from "@gajae-code/coding-agent/web/insane/url-guard";
import * as scrapers from "@gajae-code/coding-agent/web/scrapers/utils";

// A real, deterministic one-page PDF, including byte-accurate cross references.
function pdfFixture(text: string): string {
	const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n` : "";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

describe("PDF URL source-text inspection", () => {
	let server: Bun.Server<undefined>;
	let session: ToolSession;
	let body: string | Buffer;
	let contentType: string;
	let requests: number;

	beforeEach(() => {
		body = pdfFixture("Dummy PDF file");
		contentType = "application/pdf";
		requests = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests++;
				if (new URL(request.url).pathname.endsWith(".md")) return new Response(null, { status: 404 });
				const response = new Response(body, { headers: { "content-type": contentType } });
				return response;
			},
		});
		// Only bypass the public-address boundary for this local fixture server.
		// HTTP loading, binary loading, and PDF conversion remain real.
		vi.spyOn(urlGuard, "validatePublicHttpUrl").mockImplementation(async rawUrl => {
			const url = new URL(rawUrl);
			expect(url.origin).toBe(server.url.origin);
			return { ok: true, url, addresses: ["127.0.0.1"] };
		});
		vi.spyOn(urlGuard, "guardedPublicFetch").mockImplementation(async (rawUrl, init) => {
			const url = new URL(rawUrl);
			expect(url.origin).toBe(server.url.origin);
			let response = await fetch(url, init);
			if (!contentType) {
				// Bun.serve inserts text/plain for an untyped body. Remove only that
				// transport default to exercise a genuinely absent response header.
				response = new Response(response.body, { status: response.status, headers: response.headers });
				response.headers.delete("content-type");
			}
			return { ok: true, response, logicalUrl: url, wireUrl: url };
		});
		session = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "fetch.enabled": true }),
		};
		readUrlCacheTestHooks.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		readUrlCacheTestHooks.reset();
		server.stop(true);
	});

	for (const [route, mime] of [
		["document", "application/pdf; charset=binary"],
		["document.txt", "application/pdf"],
		["document.pdf", "application/octet-stream"],
		["document.pdf", "binary/octet-stream"],
		["document.pdf", "unknown"],
		["document.pdf", ""],
	]) {
		it(`extracts short text from ${mime}`, async () => {
			contentType = mime;
			const result = await loadReadUrlCacheEntry(session, { path: new URL(route, server.url).href });
			expect(result.details.method).toBe("markit");
			expect(result.output).toContain("Dummy PDF file");
			expect(result.output).not.toContain("%PDF-");
		});

		for (const [label, payload] of [
			["blank page", pdfFixture("")],
			["empty body", ""],
			["malformed PDF", "%PDF-1.4\nmalformed payload without a document"],
		]) {
			it(`fails ${label} with ${mime} rather than returning PDF source`, async () => {
				contentType = mime;
				body = payload;
				const result = await loadReadUrlCacheEntry(session, { path: new URL(route, server.url).href });
				expect(result.details.method).toBe("failed");
				expect(result.details.notes.join("\n")).toMatch(/markit conversion (failed: .+|produced no usable output)/);
				expect(result.output).not.toContain("%PDF-");
				expect(result.output).not.toContain("malformed payload");
			});
		}

		it(`keeps explicit :raw intentional for ${mime}`, async () => {
			contentType = mime;
			const conversion = vi.spyOn(scrapers, "convertWithMarkit");
			const result = await new ReadTool(session).execute("read-pdf-raw", {
				path: `${new URL(route, server.url).href}:raw`,
			});
			expect(result.details?.method).toBe("raw");
			expect(result.content.some(item => item.type === "text" && item.text.includes("%PDF-1.4"))).toBe(true);
			expect(conversion).not.toHaveBeenCalled();
			expect(requests).toBe(1);
		});
	}

	it("preserves the detailed converter failure in the read receipt", async () => {
		vi.spyOn(scrapers, "convertWithMarkit").mockResolvedValue({
			ok: false,
			content: "",
			error: "PDF decoder: missing cross-reference table",
		});
		const result = await new ReadTool(session).execute("read-pdf-failure", {
			path: new URL("document", server.url).href,
		});
		expect(result.details?.method).toBe("failed");
		expect(result.details?.notes).toContain("markit conversion failed: PDF decoder: missing cross-reference table");
		expect(result.content.some(item => item.type === "text" && item.text.includes("%PDF-"))).toBe(false);
	});

	it("rejects whitespace-only successful conversion output", async () => {
		vi.spyOn(scrapers, "convertWithMarkit").mockResolvedValue({ ok: true, content: " \n\t" });
		const result = await loadReadUrlCacheEntry(session, { path: new URL("document", server.url).href });
		expect(result.details.method).toBe("failed");
		expect(result.details.notes).toContain("markit conversion produced no usable output");
		expect(result.output).not.toContain("%PDF-");
	});

	it("does not reuse initial PDF bytes when the binary fetch fails", async () => {
		vi.spyOn(scrapers, "fetchBinary").mockResolvedValue({ ok: false, error: "HTTP 503" });
		const result = await loadReadUrlCacheEntry(session, { path: new URL("document", server.url).href });
		expect(result.details.method).toBe("failed");
		expect(result.details.notes).toContain("Binary fetch failed: HTTP 503");
		expect(result.output).not.toContain("%PDF-");
	});

	it("retains inline images when a .pdf URL actually serves PNG", async () => {
		contentType = "image/png";
		body = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		const result = await new ReadTool(session).execute("read-pdf-image", {
			path: new URL("image.pdf", server.url).href,
		});
		expect(result.details?.method).toBe("image");
		const image = result.content.find(item => item.type === "image");
		if (image?.type !== "image") throw new Error("expected inline image");
		expect(image.mimeType).toBe("image/png");
		expect(image.data).toBe(body.toString("base64"));
		const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(metadata.width).toBe(1);
		expect(metadata.height).toBe(1);
	});

	for (const [mime, payload, method, expectedContent] of [
		["application/json", '{"error":"Document unavailable"}', "json", '"error": "Document unavailable"'],
		[
			"application/xml",
			'<?xml version="1.0"?><rss version="2.0"><channel><title>Document feed</title><link>https://example.com</link><description>Document updates</description><item><title>Document unavailable</title><link>https://example.com/status</link><description>Try again later</description></item></channel></rss>',
			"feed",
			"# RSS Feed",
		],
		[
			"application/atom+xml",
			'<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Document feed</title><id>urn:document:feed</id><updated>2026-01-01T00:00:00Z</updated><entry><title>Document unavailable</title><id>urn:document:status</id><updated>2026-01-01T00:00:00Z</updated><summary>Try again later</summary></entry></feed>',
			"feed",
			"# Atom Feed",
		],
		["text/plain", "Document unavailable", "text", "Document unavailable"],
	]) {
		it(`retains the ${method} handler when a .pdf URL serves ${mime}`, async () => {
			contentType = mime;
			body = payload;
			const conversion = vi.spyOn(scrapers, "convertWithMarkit");
			const binaryFetch = vi.spyOn(scrapers, "fetchBinary");
			const result = await loadReadUrlCacheEntry(session, { path: new URL("unavailable.pdf", server.url).href });
			expect(result.details.method).toBe(method);
			expect(result.output).toContain(expectedContent);
			expect(result.details.notes.join("\n")).not.toContain("markit");
			expect(conversion).not.toHaveBeenCalled();
			expect(binaryFetch).not.toHaveBeenCalled();
			expect(requests).toBe(1);
			// Preserve the existing handler's output for the same payload at a non-PDF URL.
			const ordinary = await loadReadUrlCacheEntry(session, { path: new URL("unavailable", server.url).href });
			expect(result.output.split("---\n").slice(1).join("---\n")).toBe(
				ordinary.output.split("---\n").slice(1).join("---\n"),
			);
		});
	}

	it("retains HTML fallback when a .pdf URL actually serves HTML", async () => {
		contentType = "text/html";
		body = "<html><body><p>Document unavailable</p></body></html>";
		const result = await loadReadUrlCacheEntry(session, { path: new URL("unavailable.pdf", server.url).href });
		expect(result.details.method).toBe("raw-html");
		expect(result.output).toContain("Document unavailable");
	});
});
