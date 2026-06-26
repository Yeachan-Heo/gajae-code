import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AddressResolver } from "../../../src/web/insane/url-guard";
import { loadPage } from "../../../src/web/scrapers/types";
import { fetchBinary } from "../../../src/web/scrapers/utils";

function staticResolver(map: Record<string, string[]>): AddressResolver {
	return async hostname => map[hostname] ?? [];
}

function throwingResolver(): AddressResolver {
	return async () => {
		throw new Error("resolver must not be called");
	};
}

afterEach(() => vi.restoreAllMocks());

describe("loadPage public URL guard", () => {
	it("blocks private IP literals before opening a request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await loadPage("http://127.0.0.1/admin", { resolver: throwingResolver() });

		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("not public HTTP(S)");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks redirects to private targets before following them", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			expect(String(input)).toBe("https://public.example/start");
			return new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/admin" },
			});
		}) as typeof fetch);

		const result = await loadPage("https://public.example/start", {
			resolver: staticResolver({ "public.example": ["93.184.216.34"] }),
		});

		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("not public HTTP(S)");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
	});

	it("follows public redirects after re-validating the target", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			const requested = String(input);
			if (requested === "https://public.example/start") {
				return new Response(null, { status: 302, headers: { location: "/next" } });
			}
			expect(requested).toBe("https://public.example/next");
			return new Response("hello world", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}) as typeof fetch);

		const result = await loadPage("https://public.example/start", {
			resolver: staticResolver({ "public.example": ["93.184.216.34"] }),
		});

		expect(result.ok).toBe(true);
		expect(result.finalUrl).toBe("https://public.example/next");
		expect(result.content).toBe("hello world");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

describe("fetchBinary public URL guard", () => {
	it("blocks private IP literals before opening a binary request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await fetchBinary("http://127.0.0.1/secret.pdf", 20, undefined, {
			resolver: throwingResolver(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error ?? "").toContain("not public HTTP(S)");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks binary redirects to private targets before following them", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			expect(String(input)).toBe("https://public.example/file.pdf");
			return new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/private.pdf" },
			});
		}) as typeof fetch);

		const result = await fetchBinary("https://public.example/file.pdf", 20, undefined, {
			resolver: staticResolver({ "public.example": ["93.184.216.34"] }),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error ?? "").toContain("not public HTTP(S)");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
	});
});
