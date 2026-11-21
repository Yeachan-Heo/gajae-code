import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import puppeteer, { type Browser } from "puppeteer-core";
import { UpdatesNotification, UpdatesPanel, type DesktopUpdatesState } from "../src/UpdatesPanel";
import { checkDesktopUpdate, installDesktopUpdate } from "../src/update-client";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

function state(overrides: Partial<DesktopUpdatesState> = {}): DesktopUpdatesState {
	return {
		native: true, result: { currentVersion: "1.0.0", bundledGjcVersion: "2.0.0", available: false },
		status: "idle", error: null, notificationVisible: false,
		check: async () => {}, install: async () => {}, dismiss: () => {}, ...overrides,
	};
}

describe("desktop updates presentation", () => {
	test("shows bundled versions and treats missing configuration as unavailable", () => {
		const html = renderToStaticMarkup(<UpdatesPanel updates={state({ result: { currentVersion: "1.0.0", bundledGjcVersion: "2.0.0", available: false, reason: "Feed not configured" } })} />);
		expect(html).toContain("1.0.0");
		expect(html).toContain("2.0.0");
		expect(html).toContain("gjc updates with the app.");
		expect(html).toContain("Updates unavailable: Feed not configured");
		expect(html).not.toContain("Up to date");
		expect(html).not.toContain(">Update</button>");
	});
	test("check failures are alerts, not current-version success", () => {
		const html = renderToStaticMarkup(<UpdatesPanel updates={state({ status: "error", error: "Network <offline>" })} />);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Network &lt;offline&gt;");
		expect(html).not.toContain("Up to date");
	});
	test("pending and installed states prevent repeated work and require manual restart", () => {
		for (const status of ["checking", "installing", "installed"] as const) {
			const html = renderToStaticMarkup(<UpdatesPanel updates={state({ status })} />);
			expect(html).toContain('disabled=""');
			expect(html).toContain('role="status"');
			if (status === "installed") expect(html).toContain("Quit and reopen the app");
		}
	});
	test("notification is non-modal and respects dismissal", () => {
		const updates = state({ notificationVisible: true, result: { currentVersion: "1", bundledGjcVersion: "2", available: true, version: "3" } });
		const html = renderToStaticMarkup(<UpdatesNotification updates={updates} />);
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain("App 3 available");
		expect(html).toContain(">Update</button>");
		expect(html).toContain(">Dismiss</button>");
		expect(html).not.toContain("dialog");
		expect(renderToStaticMarkup(<UpdatesNotification updates={{ ...updates, notificationVisible: false }} />)).toBe("");
	});
	test("browser client rejects without a native bridge", async () => {
		await expect(checkDesktopUpdate()).rejects.toThrow("desktop app");
		await expect(installDesktopUpdate()).rejects.toThrow("desktop app");
	});
});

const suite = browserPath ? describe : describe.skip;
const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;
beforeAll(async () => {
	if (!browserPath) return;
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* Vite is starting. */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

suite("mounted desktop updater", () => {
	test("browser mount and manual actions never call native operations", async () => {
		const { context, page } = await componentFixture(browser, origin);
		try {
			await componentReady(page, async () => {
				await page.addScriptTag({ type: "module", content: `
					import React from '/node_modules/.vite/deps/react.js';
					import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
					import { useDesktopUpdates, UpdatesPanel } from '/src/UpdatesPanel.tsx';
					const client = {isNative: () => false, check: async () => { throw new Error('Native check called'); }, install: async () => { throw new Error('Native install called'); }};
					function Fixture() {
						const updates = useDesktopUpdates(client);
						window.browserUpdates = updates;
						return React.createElement(UpdatesPanel, {updates});
					}
					ReactDOM.createRoot(document.querySelector('div')).render(React.createElement(Fixture));
				` });
				await page.waitForSelector(".updates-panel");
			});
			await page.evaluate("Promise.all([window.browserUpdates.check(), window.browserUpdates.install()])");
			expect(await page.$eval(".updates-panel", element => element.textContent)).toContain("Updates require the desktop app.");
			expect(await page.evaluate("window.browserUpdates.error")).toBeNull();
			expect(await page.$eval(".updates-panel button", element => (element as HTMLButtonElement).disabled)).toBe(true);
		} finally { await closeComponentFixture(context, page); }
	});
	test("deduplicates operations, dismisses by version, and never installs automatically", async () => {
		const { context, page } = await componentFixture(browser, origin);
		try {
			await componentReady(page, async () => {
				await page.addScriptTag({ type: "module", content: `
					import React from '/node_modules/.vite/deps/react.js';
					import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
					import { useDesktopUpdates, UpdatesPanel, UpdatesNotification } from '/src/UpdatesPanel.tsx';
					const calls = {check: 0, install: 0};
					const originalInterval = window.setInterval.bind(window);
					window.setInterval = (callback, delay, ...args) => {
						if (delay === 6 * 60 * 60 * 1000) window.updatePoll = callback;
						return originalInterval(callback, delay, ...args);
					};
					let resolveCheck, resolveInstall, rejectInstall;
					const client = {isNative: () => true,
						check: () => { calls.check++; return new Promise(r => resolveCheck = r); },
						install: () => { calls.install++; return new Promise((resolve, reject) => { resolveInstall = resolve; rejectInstall = reject; }); }};
					function Fixture() {
						const updates = useDesktopUpdates(client);
						window.updatesTest = {updates, calls, resolve: version => resolveCheck({currentVersion:'1',bundledGjcVersion:'2',available:true,version}), finish: () => resolveInstall(), fail: () => rejectInstall(new Error('Signature verification failed'))};
						return React.createElement(React.Fragment, null, React.createElement(UpdatesPanel, {updates}), React.createElement(UpdatesNotification, {updates}));
					}
					ReactDOM.createRoot(document.querySelector('div')).render(React.createElement(React.StrictMode, null, React.createElement(Fixture)));
				` });
				await page.waitForFunction("window.updatesTest?.calls.check === 1");
			});
			await page.evaluate("void window.updatesTest.updates.check(); void window.updatesTest.updates.check();");
			expect(await page.evaluate("window.updatesTest.calls")).toEqual({ check: 1, install: 0 });
			await page.evaluate("window.updatesTest.resolve('3')");
			await page.waitForSelector(".updates-notification");
			await page.evaluate("window.updatesTest.updates.dismiss()");
			await page.waitForFunction("!document.querySelector('.updates-notification')");
			await page.evaluate("void window.updatesTest.updates.check()");
			await page.waitForFunction("window.updatesTest.calls.check === 2");
			await page.evaluate("window.updatesTest.resolve('3')");
			await page.waitForFunction("window.updatesTest.updates.status === 'idle'");
			expect(await page.$(".updates-notification")).toBeNull();
			await page.evaluate("window.updatePoll()");
			await page.waitForFunction("window.updatesTest.calls.check === 3");
			await page.evaluate("window.updatesTest.resolve('4')");
			await page.waitForSelector(".updates-notification");
			expect(await page.evaluate("window.updatesTest.calls.install")).toBe(0);
			await page.evaluate("void window.updatesTest.updates.install(); void window.updatesTest.updates.install(); void window.updatesTest.updates.check();");
			await page.waitForFunction("window.updatesTest.calls.install === 1");
			expect(await page.evaluate("window.updatesTest.calls.check")).toBe(3);
			await page.evaluate("window.updatesTest.fail()");
			await page.waitForFunction("window.updatesTest.updates.status === 'error'");
			expect(await page.$eval(".updates-notification [role='alert']", element => element.textContent)).toContain("Signature verification failed");
			expect(await page.evaluate("window.updatesTest.updates.result.available")).toBe(false);
			expect(await page.$$eval(".updates-notification button", elements => elements.map(element => element.textContent?.trim()))).toEqual(["Check for updates", "Dismiss"]);
			await page.evaluate("void window.updatesTest.updates.install()");
			expect(await page.evaluate("window.updatesTest.calls.install")).toBe(1);
			await page.evaluate("void window.updatesTest.updates.check()");
			await page.waitForFunction("window.updatesTest.calls.check === 4");
			await page.evaluate("window.updatesTest.resolve('4')");
			await page.waitForFunction("window.updatesTest.updates.status === 'idle'");
			await page.evaluate("void window.updatesTest.updates.install()");
			await page.waitForFunction("window.updatesTest.calls.install === 2");
			await page.evaluate("window.updatesTest.finish()");
			await page.waitForFunction("window.updatesTest.updates.status === 'installed'");
			expect(await page.$eval(".updates-panel", element => element.textContent)).toContain("Quit and reopen");
		} finally { await closeComponentFixture(context, page); }
	});
});
