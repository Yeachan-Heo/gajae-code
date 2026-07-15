/**
 * Offline stealth benchmark harness (plan Phase 1).
 *
 * Drives a puppeteer Page (already stealth-patched by the browser tool) against
 * self-contained offline detector fixtures and collects normalized results. The
 * navigation/evaluation is injected so this stays unit-testable without a real
 * browser; the integration test wires a live puppeteer Page.
 */

import type { DetectorResult, RawProbe } from "./detector-report";
import { parseProbe } from "./detector-report";

/** Minimal surface of a puppeteer Page that the harness needs. */
export interface SuitePage {
	goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
	evaluate<T>(fn: () => T): Promise<T>;
}

export interface SuiteFixture {
	/** file:// (or http://) URL of the offline detector fixture. */
	url: string;
}

/** Read the probe the fixture placed on `window.__stealthProbe`. */
function readProbe(): RawProbe {
	// Runs in the browser context.
	const probe = (globalThis as unknown as { __stealthProbe?: RawProbe }).__stealthProbe;
	if (!probe) throw new Error("fixture did not expose window.__stealthProbe");
	return probe;
}

/** Navigate to each fixture and collect a normalized DetectorResult per fixture. */
export async function runOfflineSuite(page: SuitePage, fixtures: readonly SuiteFixture[]): Promise<DetectorResult[]> {
	const results: DetectorResult[] = [];
	for (const fixture of fixtures) {
		await page.goto(fixture.url, { waitUntil: "load" });
		const raw = await page.evaluate<RawProbe>(readProbe);
		results.push(parseProbe(raw));
	}
	return results;
}
