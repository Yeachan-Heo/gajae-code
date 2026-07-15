import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, CDPSession } from "puppeteer-core";
import { applyStealthPatches, launchHeadlessBrowser } from "../../src/tools/browser/launch";

// These integration tests launch a real (cached) Chromium and no-op skip when
// none is resolvable, so they never fail Chromium-less CI environments.
function chromiumAvailable(): boolean {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return true;
	const cache = path.join(os.homedir(), ".gjc", "puppeteer", "chrome");
	try {
		return fs.existsSync(cache) && fs.readdirSync(cache).length > 0;
	} catch {
		return false;
	}
}

async function withStealthPage<T>(
	fn: (page: import("puppeteer-core").Page, browser: Browser) => Promise<T>,
): Promise<T> {
	const browser = await launchHeadlessBrowser({ headless: true });
	try {
		const page = await browser.newPage();
		await applyStealthPatches(browser, page, { browserSession: null as CDPSession | null, override: null });
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

	it("B2: geo unset is a no-op; geo set overrides the timezone", async () => {
		if (!chromiumAvailable()) {
			expect(true).toBe(true);
			return;
		}
		// Default (no geo): the browser's natural timezone with NO override applied.
		const defaultTz = await withStealthPage(async page => {
			await page.goto("about:blank");
			return page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
		});
		expect(defaultTz).toBeTruthy();

		// geo set: timezone reflects the override (via TZ env at launch) and differs
		// from the untouched default, proving the override actually took effect.
		const target = defaultTz === "America/New_York" ? "Asia/Tokyo" : "America/New_York";
		const browser = await launchHeadlessBrowser({ headless: true, geo: { timezone: target } });
		try {
			const page = await browser.newPage();
			await applyStealthPatches(browser, page, { browserSession: null as CDPSession | null, override: null });
			await page.goto("about:blank");
			const overriddenTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
			expect(overriddenTz).toBe(target);
			expect(overriddenTz).not.toBe(defaultTz);
		} finally {
			await browser.close();
		}
	}, 120_000);
});
