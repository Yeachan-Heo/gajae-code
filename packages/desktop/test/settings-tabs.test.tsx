import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { renderToStaticMarkup } from "react-dom/server";
import {
	SETTINGS_TABS,
	SettingsSection,
	SettingsTabs,
	settingsPanelId,
	settingsTabId,
} from "../src/SettingsTabs";
import { closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

/** Read one attribute from an opening tag without depending on attribute order. */
function attribute(tag: string, name: string): string | null {
	return new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1] ?? null;
}

function tabListMarkup(): string {
	return renderToStaticMarkup(<SettingsTabs prefix="p" active="account" onSelect={() => {}} />);
}

describe("settings tab presentation", () => {
	test("renders four roving tabs whose ids, controls and selection match their panel", () => {
		const html = tabListMarkup();
		const list = /<div\b[^>]*role="tablist"[^>]*>/u.exec(html)?.[0] ?? "";
		expect(attribute(list, "class")).toBe("settings-tabs");
		// The tablist must carry an accessible name, not just a role.
		expect(attribute(list, "aria-label")?.trim()).toBeTruthy();

		const tabs = html.match(/<button\b[^>]*>/gu) ?? [];
		expect(tabs).toHaveLength(SETTINGS_TABS.length);
		for (const [index, tab] of SETTINGS_TABS.entries()) {
			const markup = tabs[index]!;
			const selected = tab === "account";
			expect(attribute(markup, "role")).toBe("tab");
			expect(attribute(markup, "id")).toBe(settingsTabId("p", tab));
			expect(attribute(markup, "aria-controls")).toBe(settingsPanelId("p", tab));
			expect(attribute(markup, "aria-selected")).toBe(selected ? "true" : "false");
			// Roving tabindex: only the selected tab is reachable with Tab.
			expect(attribute(markup, "tabindex")).toBe(selected ? "0" : "-1");
		}

		const labels = Array.from(
			html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/gu),
			match => match[1] ?? "",
		);
		expect(labels).toHaveLength(SETTINGS_TABS.length);
		expect(labels.every(label => label.trim() !== "")).toBe(true);
	});

	test("labels a section by its heading and keeps the hint and content in their regions", () => {
		const html = renderToStaticMarkup(
			<SettingsSection id="p-key" title="API key" hint="Stored on this machine.">
				<input id="p-key-input" />
			</SettingsSection>,
		);
		const section = /<section\b[^>]*>/u.exec(html)?.[0] ?? "";
		expect(attribute(section, "class")).toBe("settings-section");
		expect(attribute(section, "aria-labelledby")).toBe("p-key-heading");
		expect(html).toContain('<h3 id="p-key-heading">API key</h3>');
		expect(html).toContain('<p class="settings-hint">Stored on this machine.</p>');

		const body = /<div class="settings-section-body">([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? "";
		expect(body).toContain('id="p-key-input"');
		expect(body).not.toContain("settings-section-head");
	});
});

describe("settings tab interactions", () => {
	beforeAll(async () => {
		server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
			cwd: `${import.meta.dir}/..`,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(origin)).ok) break;
			} catch {
				// server is starting
			}
			await Bun.sleep(100);
		}
		browser = await puppeteer.launch({
			executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			headless: true,
		});
	}, 30000);

	afterAll(async () => {
		await browser?.close();
		if (server) {
			server.kill();
			await server.exited;
		}
	});

	async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
		const { context, page } = await componentFixture(browser, origin);
		try {
			await componentReady(page, async () => {
				await page.addScriptTag({
					type: "module",
					content: `
						import React from '/node_modules/.vite/deps/react.js';
						import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
						import { SettingsTabs } from '/src/SettingsTabs.tsx';
						const h = React.createElement;
						function Fixture() {
							const [active, setActive] = React.useState('general');
							return h('div', { id: 'settings-fixture' },
								h(SettingsTabs, { prefix: 'fixture', active, onSelect: setActive }),
								h('output', { id: 'settings-active' }, active));
						}
						const root = document.createElement('div');
						root.id = 'settings-fixture-root';
						document.body.replaceChildren(root);
						ReactDOM.createRoot(root).render(h(Fixture));
					`,
				});
				await page.waitForFunction(() => document.querySelectorAll('#settings-fixture [role="tab"]').length === 4);
			});
			return { context, page };
		} catch (error) {
			await context.close();
			throw error;
		}
	}

	interface TabState {
		active: string | null;
		selected: string[];
		focused: string;
	}

	async function tabState(page: Page): Promise<TabState> {
		return page.evaluate(() => ({
			active: document.querySelector("#settings-active")?.textContent ?? null,
			selected: Array.from(document.querySelectorAll<HTMLElement>("#settings-fixture [role='tab']"))
				.filter(tab => tab.getAttribute("aria-selected") === "true")
				.map(tab => tab.id),
			focused: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
		}));
	}

	async function waitForTab(page: Page, tab: string): Promise<void> {
		await page.waitForFunction(
			expected => document.querySelector("#settings-active")?.textContent === expected,
			{},
			tab,
		);
	}

	async function clickTab(page: Page, tab: string): Promise<void> {
		await page.click(`#fixture-tab-${tab}`);
		await waitForTab(page, tab);
	}

	test("clicking a tab selects it and moves aria-selected", async () => {
		const { context, page } = await fixture();
		try {
			expect((await tabState(page)).selected).toEqual(["fixture-tab-general"]);
			await clickTab(page, "settings");
			const state = await tabState(page);
			expect(state.active).toBe("settings");
			expect(state.selected).toEqual(["fixture-tab-settings"]);
		} finally {
			await closeComponentFixture(context, page);
		}
	});

	test("ArrowRight moves forward and wraps from the last tab to the first, carrying focus", async () => {
		const { context, page } = await fixture();
		try {
			await clickTab(page, "capabilities");
			await page.keyboard.press("ArrowRight");
			await waitForTab(page, "general");
			let state = await tabState(page);
			expect(state.selected).toEqual(["fixture-tab-general"]);
			expect(state.focused).toBe("fixture-tab-general");

			await page.keyboard.press("ArrowRight");
			await waitForTab(page, "account");
			state = await tabState(page);
			expect(state.selected).toEqual(["fixture-tab-account"]);
			expect(state.focused).toBe("fixture-tab-account");
		} finally {
			await closeComponentFixture(context, page);
		}
	});

	test("Home and End jump to the first and last tab and carry focus", async () => {
		const { context, page } = await fixture();
		try {
			await clickTab(page, "account");
			await page.keyboard.press("Home");
			await waitForTab(page, "general");
			let state = await tabState(page);
			expect(state.selected).toEqual(["fixture-tab-general"]);
			expect(state.focused).toBe("fixture-tab-general");

			await page.keyboard.press("End");
			await waitForTab(page, "capabilities");
			state = await tabState(page);
			expect(state.selected).toEqual(["fixture-tab-capabilities"]);
			expect(state.focused).toBe("fixture-tab-capabilities");
		} finally {
			await closeComponentFixture(context, page);
		}
	});
});
