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
	let body: string;
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
				return new Response(body, { headers: { "content-type": contentType } });
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
			return { ok: true, response: await fetch(url, init), logicalUrl: url, wireUrl: url };
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
		["document.pdf", "application/octet-stream"],
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

	it("retains HTML fallback when a .pdf URL actually serves HTML", async () => {
		contentType = "text/html";
		body = "<html><body><p>Document unavailable</p></body></html>";
		const result = await loadReadUrlCacheEntry(session, { path: new URL("unavailable.pdf", server.url).href });
		expect(result.details.method).toBe("raw-html");
		expect(result.output).toContain("Document unavailable");
	});
});
