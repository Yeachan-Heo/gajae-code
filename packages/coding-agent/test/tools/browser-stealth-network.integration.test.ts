import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, CDPSession } from "puppeteer-core";
import { applyStealthPatches, launchHeadlessBrowser } from "../../src/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	browserKeyForTest,
	releaseBrowser,
} from "../../src/tools/browser/registry";

// These integration tests launch a real (cached) Chromium and no-op skip when
// none is resolvable, so they never fail Chromium-less CI environments.
function chromiumAvailable(): boolean {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return true;
	const cache = path.join(os.homedir(), ".gjc", "puppeteer", "chrome");
	let available = false;
	try {
		available = fs.existsSync(cache) && fs.readdirSync(cache).length > 0;
	} catch {}
	if (!available && process.env.GJC_REQUIRE_CHROMIUM === "1") {
		throw new Error("GJC_REQUIRE_CHROMIUM=1 requires a resolvable Chromium executable");
	}
	return available;
}

async function withStealthPage<T>(
	fn: (page: import("puppeteer-core").Page, browser: Browser) => Promise<T>,
	geo?: { timezone?: string; locale?: string },
): Promise<T> {
	const browser = await launchHeadlessBrowser({ headless: true, ...(geo ? { geo } : {}) });
	try {
		const page = await browser.newPage();
		await applyStealthPatches(browser, page, { browserSession: null as CDPSession | null, override: null }, geo);
		return await fn(page, browser);
	} finally {
		await browser.close();
	}
}

describe("stealth network posture (integration)", () => {
	it("Phase A gate: no HeadlessChrome token in request headers, navigator, or UA-CH brands", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const headers: Record<string, string> = {};
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				req.headers.forEach((v, k) => {
					if (/user-agent|sec-ch-ua/i.test(k)) headers[k] = v;
				});
				return new Response("<html><body>ok</body></html>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}/`;
			const probe = await withStealthPage(async page => {
				await page.goto(url, { waitUntil: "load" });
				return page.evaluate(() => {
					const nav = navigator as unknown as {
						userAgent: string;
						userAgentData?: { brands?: Array<{ brand: string }> };
					};
					return {
						navUA: nav.userAgent,
						brands: (nav.userAgentData?.brands ?? []).map(b => b.brand),
					};
				});
			});
			expect(headers["user-agent"]).toBeTruthy();
			expect(headers["user-agent"]).not.toContain("Headless");
			expect(headers["sec-ch-ua"] ?? "").not.toContain("Headless");
			expect(probe.navUA).not.toContain("Headless");
			expect(probe.brands.join(",")).not.toContain("Headless");
			// navigator UA Chrome major must match the request-header UA major.
			const major = (ua: string) => ua.match(/Chrome\/(\d+)/)?.[1];
			expect(major(probe.navUA)).toBe(major(headers["user-agent"]!));
		} finally {
			server.stop(true);
		}
	}, 120_000);

	it("B1: RTCPeerConnection exposes no non-mDNS raw IP candidate, and WebRTC still negotiates", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const result = await withStealthPage(async page => {
			await page.goto("about:blank");
			return page.evaluate(async () => {
				const rawIp = (c: string) =>
					!/\.local\b/i.test(c) &&
					(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(c) || /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/i.test(c));
				let apiWorks = false;
				const leaked: string[] = [];
				// Minimal typed shim so this compiles without depending on the
				// toolchain's DOM WebRTC lib coverage (runs in the browser context).
				type IceEvt = { candidate: { candidate: string } | null };
				type MinimalPc = {
					onicecandidate: ((e: IceEvt) => void) | null;
					createDataChannel(label: string): void;
					createOffer(): Promise<unknown>;
					setLocalDescription(desc: unknown): Promise<void>;
					localDescription: { sdp?: string } | null;
					iceGatheringState: string;
					addEventListener(type: string, cb: () => void): void;
					close(): void;
				};
				const PcCtor = (globalThis as unknown as { RTCPeerConnection: new () => MinimalPc }).RTCPeerConnection;
				try {
					const pc = new PcCtor();
					pc.onicecandidate = e => {
						if (e.candidate?.candidate && rawIp(e.candidate.candidate)) leaked.push(e.candidate.candidate);
					};
					pc.createDataChannel("x");
					// The guard must not break the core API: offer + gather succeed.
					await pc.setLocalDescription(await pc.createOffer());
					await new Promise<void>(res => {
						pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && res());
						setTimeout(res, 3000);
					});
					apiWorks = !!pc.localDescription?.sdp;
					pc.close();
				} catch {
					apiWorks = false;
				}
				return { leaked, apiWorks };
			});
		});
		// No raw-IP candidate leaked, and the WebRTC API stays functional (the guard
		// filters only raw-IP candidates; it never nulls the offer/gather flow).
		expect(result.leaked).toEqual([]);
		expect(result.apiWorks).toBe(true);
	}, 120_000);

	it("B2: configured geo keeps request headers, navigator, and Intl coherent", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const headers: Record<string, string> = {};
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				headers["accept-language"] = req.headers.get("accept-language") ?? "";
				return new Response("ok");
			},
		});
		try {
			const probe = await withStealthPage(
				async page => {
					await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
					return page.evaluate(() => ({
						language: navigator.language,
						languages: [...navigator.languages],
						locale: Intl.DateTimeFormat().resolvedOptions().locale,
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						explicitUtc: Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).resolvedOptions().timeZone,
					}));
				},
				{ timezone: "Asia/Tokyo", locale: "fr-FR" },
			);

			expect(headers["accept-language"]).toMatch(/^fr-FR,fr(?:;q=0\.9)?$/i);
			expect(probe.language).toBe("fr-FR");
			expect(probe.languages).toEqual(["fr-FR", "fr"]);
			expect(probe.locale).toBe("fr-FR");
			expect(probe.timezone).toBe("Asia/Tokyo");
			expect(probe.explicitUtc).toBe("UTC");
		} finally {
			server.stop(true);
		}
	}, 120_000);

	it("B3: unset geo retains the existing default stealth profile", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const browser = await launchHeadlessBrowser({ headless: true });
		try {
			const page = await browser.newPage();
			const readLocale = () =>
				page.evaluate(() => ({
					language: navigator.language,
					languages: [...navigator.languages],
					locale: Intl.DateTimeFormat().resolvedOptions().locale,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}));
			const before = await readLocale();
			await applyStealthPatches(browser, page, { browserSession: null, override: null });
			await page.goto("about:blank");
			expect(await readLocale()).toEqual(before);
		} finally {
			await browser.close();
		}
	}, 120_000);

	it("B4: timezone-only geo does not apply the hard-coded locale/timezone script", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const probe = await withStealthPage(
			async page => {
				await page.goto("about:blank");
				return page.evaluate(() => ({
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					explicitUtc: Intl.DateTimeFormat(undefined, { timeZone: "UTC" }).resolvedOptions().timeZone,
				}));
			},
			{ timezone: "Asia/Tokyo" },
		);
		expect(probe.timezone).toBe("Asia/Tokyo");
		expect(probe.explicitUtc).toBe("UTC");
	}, 120_000);

	it("B5: managed cache identity includes geo and profile posture but external modes ignore geo", () => {
		const kind = { kind: "headless", headless: true } as const;
		const base = browserKeyForTest(kind, { geo: { timezone: "Asia/Tokyo", locale: "fr-FR" } });
		expect(browserKeyForTest(kind, { geo: { timezone: "Asia/Tokyo", locale: "de-DE" } })).not.toBe(base);
		expect(
			browserKeyForTest(kind, {
				geo: { timezone: "Asia/Tokyo", locale: "fr-FR" },
				profileReuse: "auto",
			}),
		).not.toBe(base);
		expect(
			browserKeyForTest({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" }, { geo: { timezone: "invalid" } }),
		).toBe("connected:http://127.0.0.1:9222");
	});
	it("B6: headless browser cache serializes identical geo and separates different geo", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		const handles: BrowserHandle[] = [];
		try {
			const [french, frenchConcurrent] = await Promise.all([
				acquireBrowser(
					{ kind: "headless", headless: true },
					{ cwd: process.cwd(), geo: { timezone: "Asia/Tokyo", locale: "fr-FR" } },
				),
				acquireBrowser(
					{ kind: "headless", headless: true },
					{ cwd: process.cwd(), geo: { timezone: "Asia/Tokyo", locale: "fr-FR" } },
				),
			]);
			handles.push(french);
			const german = await acquireBrowser(
				{ kind: "headless", headless: true },
				{ cwd: process.cwd(), geo: { timezone: "Asia/Tokyo", locale: "de-DE" } },
			);
			handles.push(german);

			expect(frenchConcurrent).toBe(french);
			expect(german).not.toBe(french);
			expect(german.key).not.toBe(french.key);
			expect(french.geo).toEqual({ timezone: "Asia/Tokyo", locale: "fr-FR" });
			expect(german.geo).toEqual({ timezone: "Asia/Tokyo", locale: "de-DE" });
		} finally {
			for (const handle of new Set(handles)) {
				await releaseBrowser(handle, { kill: false });
			}
		}
	}, 120_000);
});
