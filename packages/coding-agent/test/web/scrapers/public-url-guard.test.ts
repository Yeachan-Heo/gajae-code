import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import { INSANE_NOTES, tryInsaneFetch } from "../../../src/web/insane/bridge";
import { type AddressResolver, guardedPublicFetch, hasConfiguredProxy } from "../../../src/web/insane/url-guard";
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

const publicFetch = (addresses: string[], init: BunFetchRequestInit = {}) =>
	guardedPublicFetch("https://public.example/path", init, { resolver: async () => addresses });

afterEach(() => vi.restoreAllMocks());

describe("loadPage public URL guard", () => {
	it("owns Host, TLS verification, SNI, and connection reuse policy", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
		await publicFetch(["93.184.216.34"], {
			headers: { Host: "attacker.invalid" },
			keepalive: true,
			tls: {
				rejectUnauthorized: false,
				serverName: "attacker.invalid",
				checkServerIdentity: () => new Error("bypass"),
			},
		});
		const init = fetchSpy.mock.calls[0]?.[1] as BunFetchRequestInit;
		expect(new Headers(init.headers).get("host")).toBe("public.example");
		expect(init.keepalive).toBe(false);
		expect(init.tls).toEqual({ rejectUnauthorized: true, serverName: "public.example" });
	});

	it("fails over between address families only on transport errors", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		for (const addresses of [
			["93.184.216.34", "2606:4700:4700::1111"],
			["2606:4700:4700::1111", "93.184.216.34"],
		]) {
			fetchSpy
				.mockReset()
				.mockRejectedValueOnce(new Error("connect failed"))
				.mockResolvedValueOnce(new Response("ok"));
			await publicFetch(addresses);
			expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual(
				addresses.map(address => `https://${address.includes(":") ? `[${address}]` : address}/path`),
			);
		}
		fetchSpy.mockReset().mockResolvedValue(new Response("unavailable", { status: 503 }));
		await publicFetch(["93.184.216.34", "1.1.1.1"]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("fails closed on proxy or Unix-socket routing before DNS or dial", async () => {
		const resolver = vi.fn(async () => ["93.184.216.34"]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		for (const init of [{ proxy: "http://127.0.0.1:8080" }, { unix: "/tmp/hostile.sock" }]) {
			expect(await guardedPublicFetch("https://public.example", init, { resolver })).toMatchObject({
				ok: false,
			});
		}
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
			expect(hasConfiguredProxy({ [key]: "hostile" })).toBe(true);
		}
		const previousLateProxy = process.env.http_proxy;
		try {
			resolver.mockImplementationOnce(async () => {
				process.env.http_proxy = "http://127.0.0.1:8080";
				return ["93.184.216.34"];
			});
			expect(await guardedPublicFetch("https://public.example", {}, { resolver })).toMatchObject({ ok: false });
		} finally {
			if (previousLateProxy === undefined) delete process.env.http_proxy;
			else process.env.http_proxy = previousLateProxy;
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("bounds pending DNS by the shared timeout and caller abort", async () => {
		const resolver = async () => Promise.withResolvers<string[]>().promise;
		await expect(
			guardedPublicFetch("https://public.example", { signal: AbortSignal.timeout(5) }, { resolver }),
		).rejects.toBeInstanceOf(DOMException);
		const controller = new AbortController();
		const pending = loadPage("https://public.example", { resolver, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("blocks private IP literals before opening a request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await loadPage("http://127.0.0.1/admin", { resolver: throwingResolver() });

		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("not public HTTP(S)");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("blocks redirects to private targets before following them", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			expect(String(input)).toBe("https://93.184.216.34/start");
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
		let resolution = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			const requested = String(input);
			if (requested === "https://93.184.216.34/start") {
				return new Response(null, { status: 302, headers: { location: "/next" } });
			}
			expect(requested).toBe("https://93.184.216.34/next");
			return new Response("hello world", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}) as typeof fetch);

		const result = await loadPage("https://public.example/start", {
			resolver: async () => {
				resolution++;
				return ["93.184.216.34"];
			},
		});

		expect(result.ok).toBe(true);
		expect(result.finalUrl).toBe("https://public.example/next");
		expect(result.content).toBe("hello world");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(resolution).toBe(2);
	});

	it("blocks DNS rebinding on a redirect", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/private" } }));
		let resolution = 0;
		const rebound = await loadPage("https://rebind.example/start", {
			resolver: async () => [resolution++ === 0 ? "93.184.216.34" : "127.0.0.1"],
		});
		expect(rebound.ok).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
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
			expect(String(input)).toBe("https://93.184.216.34/file.pdf");
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

it("disables the default Insane bridge before dependency probing", async () => {
	const prober = vi.fn(async () => ({ vendorPresent: true, python: true, curlCffi: true, browser: true }));
	expect(await tryInsaneFetch("https://public.example", { prober })).toEqual({
		ok: false,
		reason: "disabled-security",
		notes: [INSANE_NOTES.securityDisabled],
	});
	expect(prober).not.toHaveBeenCalled();
});
