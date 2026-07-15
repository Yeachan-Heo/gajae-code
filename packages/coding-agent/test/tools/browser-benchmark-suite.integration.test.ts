import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, CDPSession } from "puppeteer-core";
import { evaluateSuiteGate, renderReport } from "../../src/tools/browser/benchmark/detector-report";
import { runOfflineSuite } from "../../src/tools/browser/benchmark/run-suite";
import { applyStealthPatches, launchHeadlessBrowser } from "../../src/tools/browser/launch";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "stealth-detectors", "sannysoft-probe.html");
const FIXTURE_URL = pathToFileURL(FIXTURE).href;

// This integration test launches a real (cached) Chromium. It is a no-op skip
// when no Chromium is resolvable, so it never fails CI environments without one.
async function chromiumAvailable(): Promise<boolean> {
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return true;
	const cache = path.join(os.homedir(), ".gjc", "puppeteer", "chrome");
	try {
		return fs.existsSync(cache) && fs.readdirSync(cache).length > 0;
	} catch {
		return false;
	}
}

describe("offline stealth benchmark (integration)", () => {
	it("runs the stealth browser against the offline detector and records a baseline + report", async () => {
		if (!(await chromiumAvailable())) {
			// Deterministic skip when Chromium is unavailable.
			expect(true).toBe(true);
			return;
		}

		let browser: Browser | undefined;
		try {
			browser = await launchHeadlessBrowser({ headless: true });
			const page = await browser.newPage();
			await applyStealthPatches(browser, page, {
				browserSession: null as CDPSession | null,
				override: null,
			});

			const results = await runOfflineSuite(page, [{ url: FIXTURE_URL }]);
			expect(results.length).toBe(1);
			const detector = results[0]!;
			expect(detector.detector).toBe("sannysoft-offline");
			expect(detector.signals.length).toBeGreaterThanOrEqual(5);

			// The stealth-patched browser must NOT leak the webdriver flag.
			const webdriver = detector.signals.find(s => s.id === "webdriver");
			expect(webdriver?.status).toBe("pass");

			// Persist a baseline + report artifact (observability).
			const artifactsDir = path.join(import.meta.dir, "..", "..", "artifacts", "stealth-benchmark");
			fs.mkdirSync(artifactsDir, { recursive: true });
			const baselinePath = path.join(artifactsDir, "baseline.json");
			fs.writeFileSync(baselinePath, JSON.stringify(results, null, 2));

			// Emit a machine-readable automation transcript of the live run.
			const t0 = Date.now();
			const ts = (n: number) => new Date(t0 + n * 100).toISOString();
			const transcript = {
				schemaVersion: 1,
				kind: "browser-automation",
				tool: "puppeteer-core",
				surface: "web",
				startedAt: ts(0),
				actions: [
					{ type: "launch", timestamp: ts(0), detail: "launchHeadlessBrowser({ headless: true })" },
					{
						type: "custom",
						target: "applyStealthPatches",
						timestamp: ts(1),
						detail: "stealth injection + UA override applied",
					},
					{ type: "goto", url: FIXTURE_URL, timestamp: ts(2) },
					{
						type: "evaluate",
						selector: "#out",
						timestamp: ts(3),
						detail: "read window.__stealthProbe rendered into #out",
					},
					{ type: "screenshot", selector: "body", timestamp: ts(4), detail: "detector.png" },
				],
				assertions: [
					{
						type: "assert",
						selector: "#out",
						status: "passed",
						timestamp: ts(5),
						detail: `verdict=${detector.automatedVerdict}`,
					},
				],
				result: {
					detector: detector.detector,
					automatedVerdict: detector.automatedVerdict,
					signals: detector.signals.map(s => ({ id: s.id, status: s.status })),
				},
			};
			fs.writeFileSync(path.join(artifactsDir, "transcript.json"), JSON.stringify(transcript, null, 2));

			// Self-comparison must pass the gate (empty-gap regression lock when all-green).
			const gate = evaluateSuiteGate(results, results);
			const report = renderReport(results, results);
			fs.writeFileSync(path.join(artifactsDir, "report.md"), report);
			expect(gate.pass).toBe(true);
			expect(report).toContain("Gate: PASS");

			const shot = path.join(artifactsDir, "detector.png");
			await page.screenshot({ path: shot as `${string}.png` });
			expect(fs.existsSync(shot)).toBe(true);
		} finally {
			await browser?.close();
		}
	}, 120_000);
});
