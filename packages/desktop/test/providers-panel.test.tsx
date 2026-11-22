import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopAuthProvider, DesktopAuthState, DesktopModel } from "@gajae-code/desktop-host/protocol";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import type { ProviderKeyState } from "../src/ProvidersPanel";
import { type DesktopThemeId, THEME_IDS, THEME_STORAGE_KEY } from "../src/themes";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";
import { measureContrast } from "./fixtures/contrast";

const suite = browserPath ? describe : describe.skip;

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	if (!browserPath) return;
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
			/* Server is starting. */
		}
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => {
	await browser?.close();
	if (server) {
		server.kill();
		await server.exited;
	}
});

/** Everything the page-side fixture feeds the panel; the step and the query stay panel-owner state. */
interface FixtureData {
	providers: DesktopAuthProvider[];
	models: DesktopModel[];
	flow: DesktopAuthState | null;
	owned: string[];
	loaded: boolean;
	disconnected: boolean;
	busy: boolean;
	keyState: ProviderKeyState | null;
	loadError?: string;
}
type Call = [string, ...(string | null)[]];
interface Control {
	set(data: Partial<FixtureData>): void;
	select(provider: string | null): void;
	/** Dialog fixtures only: mounts or unmounts the native `Modal` around the panel. */
	open(value: boolean): void;
	/** Applies a bundled theme the way the app does (`applyTheme`). */
	theme(id: DesktopThemeId): void;
	calls(): Call[];
}
interface FixtureOptions {
	height?: number;
	/** Render the panel inside the real `Modal` with the Providers dialog's class, as the app does. */
	dialog?: boolean;
	/** With `dialog`, start with the dialog unmounted so a test can stage data before it opens. */
	closed?: boolean;
}
declare global {
	interface Window {
		providersTest: Control;
	}
}

const provider = (id: string, name: string, overrides: Partial<DesktopAuthProvider> = {}): DesktopAuthProvider => ({
	id,
	name,
	configured: false,
	stored: false,
	credentialKinds: [],
	canSignIn: true,
	canStoreKey: true,
	...overrides,
});
const providers = [
	provider("alpha", "Alpha Cloud", { configured: true, stored: true, credentialKinds: ["oauth"] }),
	provider("beta", "Beta"),
	provider("gamma", "Gamma Gateway"),
	provider("delta", "delta", { canSignIn: false }),
	provider(
		"long-provider-identifier-that-keeps-going-without-any-break-opportunity-for-wrapping",
		"Long provider name 긴 이름의 공급자 that must wrap inside a narrow dialog without overflowing",
	),
];
const models: DesktopModel[] = ["a1", "a2"].map(id => ({
	id: `alpha/${id}`,
	name: id,
	provider: "alpha",
	contextWindow: 8192,
	reasoning: false,
	thinking: { options: [] },
}));
const FLOW = "00000000-0000-4000-8000-0000000000f1";
const flow = (overrides: Partial<DesktopAuthState>): DesktopAuthState => ({
	id: FLOW,
	provider: "beta",
	status: "authorizing",
	...overrides,
});

async function fixture(width = 1000, options: FixtureOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await page.setViewport({ width, height: options.height ?? 900 });
		await componentReady(page, async () => {
			await page.addScriptTag({
				type: "module",
				content: `
					import '/src/styles.css';
					import React from '/node_modules/.vite/deps/react.js';
					import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
					import { Modal } from '/src/components.tsx';
					import { ProvidersPanel } from '/src/ProvidersPanel.tsx';
					import { projectProviders, visibleFlow } from '/src/provider-status.ts';
					import { applyTheme } from '/src/themes.ts';
					const h = React.createElement;
					const calls = [];
					const dialog = ${options.dialog === true};
					function Fixture() {
						const [data, setData] = React.useState({ providers: [], models: [], flow: null, owned: [], loaded: true, disconnected: false, busy: false, keyState: null });
						const [selected, setSelected] = React.useState(null);
						const [query, setQuery] = React.useState('');
						const [open, setOpen] = React.useState(${options.closed !== true});
						window.providersTest = { set: next => setData(previous => ({ ...previous, ...next })), select: setSelected, open: setOpen, theme: applyTheme, calls: () => calls };
						const owned = new Set(data.owned);
						const shown = visibleFlow(data.flow, owned);
						const panel = h(ProvidersPanel, {
							groups: projectProviders(data.providers, data.models, shown, owned),
							totalModels: data.models.length,
							loaded: data.loaded,
							loadError: data.loadError,
							disconnected: data.disconnected,
							busy: data.busy,
							query,
							onQueryChange: setQuery,
							selected,
							onSelect: id => { calls.push(['select', id]); setSelected(id); },
							flow: shown,
							keyState: data.keyState,
							onRetryLoad: () => calls.push(['retry']),
							onSignIn: id => calls.push(['signIn', id]),
							onAnswer: (flowId, promptId, value) => calls.push(['answer', flowId, promptId, value]),
							onCancel: flowId => calls.push(['cancel', flowId]),
							onSaveKey: (id, draft) => calls.push(['saveKey', id, draft]),
							onOpenUrl: url => calls.push(['open', url]),
							onDone: () => calls.push(['done']),
						});
						if (!dialog) return h('div', { className: 'modal-content', style: { maxWidth: '640px' } }, panel);
						return open
							? h(Modal, { title: 'Providers', className: 'providers-dialog', onClose: () => { calls.push(['close']); setOpen(false); } }, panel)
							: h('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open');
					}
					const root = document.createElement('div');
					root.id = 'providers-fixture';
					document.body.replaceChildren(root);
					ReactDOM.createRoot(root).render(h(Fixture));
				`,
			});
			await page.waitForFunction(
				() =>
					!!document.querySelector("#providers-fixture :is(.providers-panel, #opener)") && !!window.providersTest,
			);
		});
		await page.addStyleTag({ url: `${origin}/src/styles.css` });
		await set(page, { providers, models });
		if (options.closed !== true) await page.waitForSelector(".provider-row");
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function set(page: Page, data: Partial<FixtureData>): Promise<void> {
	await page.evaluate(value => window.providersTest.set(value), data);
}
async function select(page: Page, id: string | null): Promise<void> {
	await page.evaluate(value => window.providersTest.select(value), id);
}
async function calls(page: Page): Promise<Call[]> {
	return page.evaluate(() => window.providersTest.calls());
}
/** The focused element, named the way a test reads it. */
async function focused(page: Page): Promise<string> {
	return page.evaluate(() => {
		const active = document.activeElement as HTMLElement | null;
		if (!active) return "";
		if (active.dataset.providerId) return `row:${active.dataset.providerId}`;
		if (active.tagName === "INPUT") return `input:${(active as HTMLInputElement).type}`;
		return `${active.tagName.toLowerCase()}:${active.textContent?.trim() ?? ""}`;
	});
}
async function buttons(page: Page): Promise<Array<{ text: string; disabled: boolean }>> {
	return page.$$eval(".providers-panel button", nodes =>
		nodes.map(node => ({ text: node.textContent?.trim() ?? "", disabled: (node as HTMLButtonElement).disabled })),
	);
}
async function click(page: Page, text: string): Promise<void> {
	await page.evaluate(label => {
		const button = [...document.querySelectorAll<HTMLButtonElement>(".providers-panel button")].find(
			node => node.textContent?.trim() === label,
		);
		if (!button) throw new Error(`Missing button: ${label}`);
		button.click();
	}, text);
}
/** The reader's text size, as Settings applies it (`applyFontSize`). */
async function textSize(page: Page, px: number): Promise<void> {
	await page.evaluate(value => document.documentElement.style.setProperty("--text-size", `${value}px`), px);
}
/**
 * Every provider row under `scope` whose name or id shares pixels with its status or a method
 * tag, or whose status or tags break onto a second line. Names are measured as their text's line
 * boxes, so a status spilling over the name is caught even though the two flex boxes never meet.
 */
async function rowCollisions(page: Page, scope: string): Promise<string[]> {
	return page.$$eval(`${scope} .provider-row`, rows => {
		const problems: string[] = [];
		const lines = (node: Element) => {
			const range = document.createRange();
			range.selectNodeContents(node);
			return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
		};
		const meet = (a: DOMRect, b: DOMRect) =>
			a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
		for (const row of rows) {
			const label = row.getAttribute("data-provider-id") ?? "?";
			const text = [...row.querySelectorAll(".provider-row-main > strong, .provider-row-main > .provider-id")].flatMap(
				lines,
			);
			const status = row.querySelector(".provider-status");
			const tags = [...row.querySelectorAll(".provider-methods .model-role-tag")];
			for (const item of [status, ...tags]) {
				if (!item) continue;
				const box = item.getBoundingClientRect();
				if (text.some(line => meet(line, box))) problems.push(`${label}: "${item.textContent}" overlaps the name`);
				if (new Set(lines(item).map(line => Math.round(line.top))).size > 1)
					problems.push(`${label}: "${item.textContent}" wraps`);
			}
			if (row.scrollWidth > row.clientWidth) problems.push(`${label}: row overflows`);
		}
		return problems;
	});
}
async function waitText(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		value => document.querySelector(".providers-panel")?.textContent?.includes(value),
		{},
		text,
	);
}

suite("Providers panel interactions", () => {
	test("search, rows and Back keep one keyboard path and restore the originating row and query", async () => {
		const { context, page } = await fixture();
		try {
			expect(await page.$$eval(".provider-group-heading", nodes => nodes.map(node => node.textContent))).toEqual([
				"Connected",
				"All providers",
			]);
			expect(await page.$eval(".provider-summary", node => node.textContent)).toBe(
				"1 connected · 2 models available",
			);
			await page.focus(".model-search input");
			await page.keyboard.press("ArrowDown");
			expect(await focused(page)).toBe("row:alpha");
			await page.keyboard.press("ArrowDown");
			expect(await focused(page)).toBe("row:beta");
			await page.keyboard.press("End");
			expect(await focused(page)).toBe(
				"row:long-provider-identifier-that-keeps-going-without-any-break-opportunity-for-wrapping",
			);
			await page.keyboard.press("Home");
			expect(await focused(page)).toBe("row:alpha");
			await page.focus(".model-search input");
			await page.keyboard.type("GAM");
			expect(
				await page.$$eval(".provider-row", nodes => nodes.map(node => node.getAttribute("data-provider-id"))),
			).toEqual(["gamma"]);
			await page.keyboard.press("ArrowDown");
			expect(await focused(page)).toBe("row:gamma");
			await page.keyboard.press("Enter");
			await page.waitForSelector(".provider-detail");
			expect(await focused(page)).toBe("h3:Gamma Gateway");
			expect(await calls(page)).toEqual([["select", "gamma"]]);
			await click(page, "All providers");
			await page.waitForSelector(".provider-row");
			expect(await focused(page)).toBe("row:gamma");
			expect(await page.$eval(".model-search input", node => (node as HTMLInputElement).value)).toBe("GAM");
			await page.$eval(".model-search input", node => (node as HTMLInputElement).select());
			await page.keyboard.type("no-such-provider");
			await waitText(page, "No providers match");
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a provider configured outside the app reads by its models and says so in its detail", async () => {
		const { context, page } = await fixture();
		try {
			await set(page, {
				providers: [...providers, provider("epsilon", "Epsilon Gateway", { configured: true })],
				models: [...models, { ...models[0]!, id: "epsilon/e1", provider: "epsilon" }],
			});
			await page.waitForSelector('.provider-row[data-provider-id="epsilon"]');
			expect(
				await page.$eval('.provider-row[data-provider-id="epsilon"] .provider-status', node => [
					node.getAttribute("data-state"),
					node.textContent,
				]),
			).toEqual(["ready", "1 model"]);
			await select(page, "epsilon");
			await waitText(page, "Configured outside the app");
			// A provider whose credential is stored is not described as configured outside the app.
			await select(page, "alpha");
			await waitText(page, "2 models available");
			expect(await page.$eval(".provider-detail", node => node.textContent)).not.toContain(
				"Configured outside the app",
			);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a provider warning offers Continue only while the flow waits on it", async () => {
		const { context, page } = await fixture();
		try {
			const warning = { id: "00000000-0000-4000-8000-0000000000a1", message: "⚠️  WARNING: fixture risk notice" };
			await set(page, { flow: flow({ status: "waiting", warning }) });
			await select(page, "beta");
			await page.waitForSelector(".provider-warning");
			// Focus lands on the warning heading, never on the confirm button.
			expect(await focused(page)).toBe("h5:Notice from Beta");
			expect(await page.$eval(".provider-warning p", node => node.textContent)).toBe(warning.message);
			await click(page, "Continue");
			await click(page, "Cancel sign-in");
			expect(await calls(page)).toEqual([
				["answer", FLOW, warning.id, "confirm"],
				["cancel", FLOW],
			]);
			// The Host never sends a warning outside waiting; the panel still refuses to confirm one.
			await set(page, { flow: flow({ status: "authorizing", warning }) });
			await page.waitForFunction(() => !document.querySelector(".provider-warning button"));
			const labels = (await buttons(page)).map(button => button.text);
			expect(labels).not.toContain("Continue");
			expect(labels.filter(label => label === "Cancel sign-in")).toHaveLength(1);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("prompts take focus, clear on submit and allow an empty answer only when the provider does", async () => {
		const { context, page } = await fixture();
		try {
			await set(page, {
				flow: flow({
					status: "waiting",
					prompt: { id: "00000000-0000-4000-8000-0000000000b1", message: "Enter the code" },
				}),
			});
			await select(page, "beta");
			await page.waitForSelector(".provider-prompt input");
			expect(await focused(page)).toBe("input:password");
			const submit = () => buttons(page).then(list => list.find(button => button.text === "Submit"));
			expect((await submit())?.disabled).toBe(true);
			await page.keyboard.type("private-answer");
			expect((await submit())?.disabled).toBe(false);
			await page.keyboard.press("Enter");
			expect(await page.$eval(".provider-prompt input", node => (node as HTMLInputElement).value)).toBe("");
			await set(page, {
				flow: flow({
					status: "waiting",
					prompt: { id: "00000000-0000-4000-8000-0000000000b2", message: "Enterprise domain", allowEmpty: true },
				}),
			});
			await waitText(page, "Enterprise domain");
			expect((await submit())?.disabled).toBe(false);
			await click(page, "Submit");
			expect(await calls(page)).toEqual([
				["answer", FLOW, "00000000-0000-4000-8000-0000000000b1", "private-answer"],
				["answer", FLOW, "00000000-0000-4000-8000-0000000000b2", ""],
			]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("each outcome says its news once, and another provider's sign-in reads correctly for any name", async () => {
		const { context, page } = await fixture();
		const occurrences = (text: string) =>
			page.$eval(".provider-detail", (node, value) => node.textContent!.split(value).length - 1, text);
		try {
			const configured = provider("zeta", "Zeta Cloud", { configured: true, stored: true });
			const browserSignIn = provider("eta", "Design example browser sign-in", { canStoreKey: false });
			await set(page, {
				providers: [...providers, configured, browserSignIn],
				flow: flow({ provider: "zeta", status: "complete" }),
				owned: [FLOW],
			});
			await select(page, "zeta");
			await page.waitForSelector('.provider-flow[data-view="connected"]');
			expect(await occurrences("No models from this provider yet.")).toBe(1);
			await set(page, { flow: flow({ provider: "zeta", status: "cancelled" }) });
			await page.waitForSelector('.provider-flow[data-view="cancelled"]');
			expect(await occurrences("Sign-in cancelled")).toBe(1);
			await set(page, { flow: flow({ provider: "eta", status: "authorizing" }) });
			await page.waitForSelector(".provider-blocked");
			expect(await page.$eval(".provider-blocked", node => node.firstChild?.textContent)).toBe(
				"A sign-in to Design example browser sign-in is still in progress. Finish or cancel it first.",
			);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a load error spans the dialog like the other dialogs' error banners", async () => {
		const { context, page } = await fixture(1000, { dialog: true });
		try {
			await set(page, { loaded: false, loadError: "Could not load the provider list." });
			await page.waitForSelector(".provider-load-error .error-banner");
			const widths = await page.evaluate(() => ({
				banner: Math.round(document.querySelector(".provider-load-error .error-banner")!.getBoundingClientRect().width),
				panel: Math.round(document.querySelector(".providers-panel")!.getBoundingClientRect().width),
			}));
			expect(widths.banner).toBe(widths.panel);
			expect((await buttons(page)).map(button => button.text)).toContain("Retry");
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a dialog that opens on a pending answer or warning focuses it, not the dialog's Close button", async () => {
		const { context, page } = await fixture(1000, { dialog: true, closed: true });
		try {
			const prompt = { id: "00000000-0000-4000-8000-0000000000b1", message: "Enter the code" };
			await set(page, { flow: flow({ status: "waiting", prompt }) });
			await select(page, "beta");
			await page.click("#opener");
			await page.waitForSelector("dialog[open] .provider-prompt input");
			expect(await focused(page)).toBe("input:password");
			await page.keyboard.press("Escape");
			await page.waitForSelector("#opener");
			const warning = { id: "00000000-0000-4000-8000-0000000000a1", message: "Fixture risk notice" };
			await set(page, { flow: flow({ status: "waiting", warning }) });
			await page.click("#opener");
			await page.waitForSelector("dialog[open] .provider-warning");
			expect(await focused(page)).toBe("h5:Notice from Beta");
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a prompt that arrives while the dialog is open takes focus from the list and from an earlier prompt", async () => {
		const { context, page } = await fixture(1000, { dialog: true });
		try {
			await page.focus(".model-search input");
			await set(page, {
				flow: flow({ status: "waiting", prompt: { id: "00000000-0000-4000-8000-0000000000b1", message: "First" } }),
			});
			await select(page, "beta");
			await page.waitForSelector("dialog[open] .provider-prompt input");
			expect(await focused(page)).toBe("input:password");
			await page.focus(".provider-back");
			await set(page, {
				flow: flow({ status: "waiting", prompt: { id: "00000000-0000-4000-8000-0000000000b2", message: "Second" } }),
			});
			await waitText(page, "Second");
			expect(await focused(page)).toBe("input:password");
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("opens only an HTTPS sign-in page and shows a device code as its own block", async () => {
		const { context, page } = await fixture();
		try {
			await set(page, { flow: flow({ url: "http://sign-in.example.invalid/authorize" }) });
			await select(page, "beta");
			await waitText(page, "not a safe HTTPS link");
			expect((await buttons(page)).map(button => button.text)).not.toContain("Open sign-in page");
			const url = "https://sign-in.example.invalid/device";
			await set(page, { flow: flow({ status: "waiting", url, verificationCode: "WDJB-MJHT" }) });
			await page.waitForSelector(".provider-code-value");
			expect(await page.$eval(".provider-code-value", node => node.textContent)).toBe("WDJB-MJHT");
			expect(await page.$eval(".provider-url", node => node.textContent)).toContain(url);
			await click(page, "Open sign-in page");
			expect((await calls(page)).at(-1)).toEqual(["open", url]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a device code stays on one line, fits a narrow window whole and scrolls only when longer", async () => {
		const { context, page } = await fixture(390, { height: 844, dialog: true });
		try {
			await select(page, "beta");
			const layout = () =>
				page.evaluate(() => {
					const code = document.querySelector<HTMLElement>(".provider-code-value")!;
					const panel = document.querySelector<HTMLElement>(".providers-panel")!;
					const range = document.createRange();
					range.selectNodeContents(code);
					return {
						lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
						inside: code.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 0.5,
						panelOverflow: panel.scrollWidth - panel.clientWidth,
						scrolls: code.scrollWidth > code.clientWidth,
					};
				});
			// A usual device code is shown whole; a longer one scrolls inside its block, never widening the dialog.
			for (const [code, scrolls] of [
				["WDJB-MJHT", false],
				["WDJB-MJHT-KQPX-ZRTV-LMNB", true],
			] as const) {
				await set(page, {
					flow: flow({ status: "waiting", url: "https://sign-in.example.invalid/device", verificationCode: code }),
				});
				await page.waitForFunction(
					value => document.querySelector(".provider-code-value")?.textContent === value,
					{},
					code,
				);
				for (const size of [14, 20]) {
					await textSize(page, size);
					expect({ code, size, ...(await layout()) }).toEqual({
						code,
						size,
						lines: 1,
						inside: true,
						panelOverflow: 0,
						scrolls,
					});
				}
			}
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("disconnected and another provider's active flow disable every action with a reason", async () => {
		const { context, page } = await fixture();
		try {
			await set(page, {
				flow: flow({ provider: "alpha", status: "waiting", url: "https://sign-in.example.invalid/a" }),
			});
			await select(page, "beta");
			await waitText(page, "A sign-in to Alpha Cloud is still in progress. Finish or cancel it first.");
			await page.type(".provider-key input", "sk-typed-key");
			const disabled = async () =>
				Object.fromEntries((await buttons(page)).map(button => [button.text, button.disabled]));
			expect(await disabled()).toMatchObject({ "Sign in": true, "Save key": true, "Go to Alpha Cloud": false });
			await click(page, "Go to Alpha Cloud");
			await page.waitForSelector(".provider-flow");
			expect(await focused(page)).toBe("h4:Continue in your browser");
			await set(page, { flow: null, disconnected: true });
			await click(page, "All providers");
			await page.waitForSelector(".provider-row");
			expect(
				await page.$$eval(".provider-row", nodes => nodes.every(node => (node as HTMLButtonElement).disabled)),
			).toBe(true);
			expect(await page.$eval(".provider-summary", node => node.textContent)).toContain("disconnected");
			await select(page, "alpha");
			await page.waitForSelector(".provider-detail");
			expect(await disabled()).toMatchObject({ Reconnect: true, "Save key": true, Disconnect: true });
			expect(await page.$eval(".provider-key input", node => (node as HTMLInputElement).disabled)).toBe(true);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a key submit hands the raw draft to its owner once and never keeps it in the field", async () => {
		const { context, page } = await fixture();
		try {
			await select(page, "delta");
			await page.waitForSelector(".provider-key input");
			// A key-only provider has no sign-in section and keeps the plain heading.
			expect((await buttons(page)).map(button => button.text)).not.toContain("Sign in");
			await page.type(".provider-key input", "  sk-raw-draft  ");
			await page.keyboard.press("Enter");
			expect(await page.$eval(".provider-key input", node => (node as HTMLInputElement).value)).toBe("");
			expect((await calls(page)).at(-1)).toEqual(["saveKey", "delta", "  sk-raw-draft  "]);
			await set(page, { keyState: { provider: "delta", status: "invalid", reason: "command" } });
			await waitText(page, "terminal command");
			expect(await page.$eval(".provider-key input", node => node.getAttribute("aria-invalid"))).toBe("true");
			await set(page, { keyState: { provider: "delta", status: "saved", catalogRefreshed: false } });
			await waitText(page, "The model list couldn't refresh");
			await click(page, "Done");
			expect((await calls(page)).at(-1)).toEqual(["done"]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a search placeholder too long for its field ends with an ellipsis: Providers, Tools and the model picker", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 390, height: 844 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-tool-catalog-populated .model-search input");
			await textSize(page, 20);
			await page.click("#showcase-models .model-trigger");
			await page.waitForSelector("dialog[open] .model-search input");
			const fields = await page.evaluate(() => {
				const canvas = document.createElement("canvas").getContext("2d")!;
				return Object.fromEntries(
					(
						[
							["providers", "#showcase-providers .providers-showcase-frame[data-narrow] .model-search input"],
							["tools", "#showcase-tool-catalog-populated .model-search input"],
							["models", "dialog[open] .model-search input"],
						] as const
					).map(([name, selector]) => {
						const input = document.querySelector<HTMLInputElement>(selector)!;
						const style = getComputedStyle(input);
						canvas.font = style.font;
						const room = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
						return [
							name,
							{ overflows: canvas.measureText(input.placeholder).width > room, textOverflow: style.textOverflow },
						];
					}),
				);
			});
			// At 390 px with 20 px text each placeholder overflows its field, and each field ends it with an ellipsis.
			expect(fields).toEqual({
				providers: { overflows: true, textOverflow: "ellipsis" },
				tools: { overflows: true, textOverflow: "ellipsis" },
				models: { overflows: true, textOverflow: "ellipsis" },
			});
		} finally {
			await context.close();
		}
	}, 30000);

	test("the showcase marks the selected state and its status lines describe what is shown", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-providers .provider-row");
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			await page.mouse.move(1, 1);
			const look = (pressed: boolean) =>
				page.$eval(`#showcase-providers > .actions[role=group] button[aria-pressed="${pressed}"]`, node => {
					const style = getComputedStyle(node);
					return { text: node.textContent, background: style.backgroundColor, border: style.borderTopColor };
				});
			const selected = await look(true);
			const other = await look(false);
			expect(selected.text).toBe("Populated");
			expect(selected.background).not.toBe(other.background);
			expect(selected.border).not.toBe(other.border);
			const [contrast] = await page.evaluate(measureContrast, ['#showcase-providers button[aria-pressed="true"]']);
			expect(contrast!.ratio).toBeGreaterThanOrEqual(4.5);
			expect(await page.$eval("#showcase-providers .showcase-result", node => node.textContent)).toBe(
				"Showing: Populated",
			);
			// Each group label lines up with its buttons, and the two account-summary frames do not touch.
			const layout = await page.evaluate(() => {
				const center = (node: Element) => {
					const range = document.createRange();
					range.selectNodeContents(node);
					const rect = range.getBoundingClientRect();
					return rect.top + rect.height / 2;
				};
				const groups = [...document.querySelectorAll("#showcase-providers > .actions[role=group]")];
				const frames = [...document.querySelectorAll("#showcase-providers > .providers-showcase-frame")].slice(-2);
				return {
					labelOffsets: groups.map(group =>
						Math.round(Math.abs(center(group.querySelector("strong")!) - center(group.querySelector("button")!))),
					),
					summaryGap: Math.round(frames[1]!.getBoundingClientRect().top - frames[0]!.getBoundingClientRect().bottom),
				};
			});
			expect(layout.labelOffsets.every(offset => offset <= 1)).toBe(true);
			expect(layout.summaryGap).toBeGreaterThanOrEqual(8);
			// The onboarding section has no states to pick from.
			expect(await page.$eval("#showcase-provider-onboarding .showcase-result", node => node.textContent)).not.toContain(
				"Pick a state",
			);
		} finally {
			await context.close();
		}
	}, 30000);

	test("the showcase renders every providers fixture state and the onboarding notice placements", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(String(error)));
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-providers .providers-panel");
			expect(
				await page.$$eval(".showcase-index a", nodes =>
					nodes.map(node => node.getAttribute("href")).filter(href => href?.includes("provider")),
				),
			).toEqual(["#showcase-providers", "#showcase-provider-onboarding"]);
			const states = await page.$$eval("#showcase-providers > .actions[role=group] button", nodes =>
				nodes.map(node => node.textContent ?? ""),
			);
			expect(states.length).toBeGreaterThanOrEqual(26);
			for (const label of states) {
				await page.evaluate(text => {
					const button = [
						...document.querySelectorAll<HTMLButtonElement>("#showcase-providers > .actions[role=group] button"),
					].find(node => node.textContent === text);
					button?.click();
				}, label);
				await page
					.waitForFunction(
						text =>
							document.querySelector("#showcase-providers .showcase-result")?.textContent === `Showing: ${text}`,
						{ timeout: 5000 },
						label,
					)
					.catch(error => {
						throw new Error(`State ${label} did not render: ${errors.join("; ")}`, { cause: error });
					});
				expect(await page.$$eval("#showcase-providers .providers-panel", nodes => nodes.length)).toBe(2);
			}
			expect(
				await page.$$eval("#showcase-provider-onboarding .provider-notice", nodes =>
					nodes.map(node => node.parentElement?.className),
				),
			).toEqual(["provider-notice-dock", "composer-area", "providers-showcase-narrow-notice"]);
			// The narrow onboarding frame is as wide as the notice in a 390 px window, and lays out as there.
			expect(
				await page.$eval(".providers-showcase-narrow-notice .provider-notice", notice => {
					const button = notice.querySelector(".provider-notice-action")!.getBoundingClientRect();
					const main = notice.querySelector(".provider-notice-main")!.getBoundingClientRect();
					return {
						width: Math.round(notice.getBoundingClientRect().width),
						fullWidthButton: Math.round(button.width) === Math.round(main.width),
					};
				}),
			).toEqual({ width: 302, fullWidthButton: true });
			expect(errors).toEqual([]);
		} finally {
			await context.close();
		}
	}, 60000);

	test("a long name never meets its status or method tags in the dialog, at any width or text size", async () => {
		// Longer than any real provider name, one carrying the longest status, one a single unbroken word.
		const longRows = [
			provider(
				"extra-long-name",
				"Extraordinarily long provider display name written to outgrow every real provider name, so the row has to wrap it beside its status 이름이 아주 긴 공급자",
				{ configured: true, stored: true },
			),
			provider("unbroken-name", "Providernamewithoutanyspaceswhatsoeverthatkeepsgoingpasttheedgeofthedialog"),
		];
		for (const [width, height] of [
			[1400, 900],
			[720, 520],
			[481, 800],
			[390, 844],
		] as const) {
			const { context, page } = await fixture(width, { height, dialog: true });
			try {
				await set(page, { providers: [...providers, ...longRows], models });
				await page.waitForSelector('.provider-row[data-provider-id="unbroken-name"]');
				expect(
					await page.$eval('.provider-row[data-provider-id="extra-long-name"] .provider-status', node => node.textContent),
				).toBe("Connected · no models");
				for (const size of [14, 20]) {
					await textSize(page, size);
					expect({ width, size, problems: await rowCollisions(page, "dialog") }).toEqual({ width, size, problems: [] });
				}
			} finally {
				await closeComponentFixture(context, page);
			}
		}
	}, 60000);

	test("the showcase's long-name row stays clear of its status in both frames", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			for (const width of [1200, 390]) {
				await page.setViewport({ width, height: 900 });
				await page.goto(`${origin}/?showcase`);
				await page.waitForSelector("#showcase-providers .providers-panel .provider-row");
				for (const size of [14, 20]) {
					await textSize(page, size);
					expect({
						width,
						size,
						problems: await rowCollisions(page, "#showcase-providers .providers-showcase-frame"),
					}).toEqual({ width, size, problems: [] });
				}
			}
		} finally {
			await context.close();
		}
	}, 60000);

	test("a refused key draws the field in the error color, focused or not, and a valid field does not", async () => {
		const { context, page } = await fixture();
		try {
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			await select(page, "delta");
			await page.waitForSelector(".provider-key input");
			const errorColor = await page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--status-error)";
				document.body.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			});
			const border = () => page.$eval(".provider-key input", node => getComputedStyle(node).borderTopColor);
			expect(await border()).not.toBe(errorColor);
			await page.type(".provider-key input", "!op read secret");
			await page.keyboard.press("Enter");
			await set(page, { keyState: { provider: "delta", status: "invalid", reason: "command" } });
			await page.waitForSelector('.provider-key input[aria-invalid="true"]');
			// The field keeps focus after the refused submit, where the focus ring must not hide the error.
			expect(await page.evaluate(() => document.activeElement?.matches(".provider-key input"))).toBe(true);
			expect(await border()).toBe(errorColor);
			await page.$eval(".provider-key input", node => (node as HTMLInputElement).blur());
			expect(await border()).toBe(errorColor);
			await set(page, { keyState: null });
			await page.waitForSelector('.provider-key input:not([aria-invalid="true"])');
			expect(await border()).not.toBe(errorColor);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("amber flow-card text, the failed status and the key error clear 4.5:1 in every bundled theme", async () => {
		const { context, page } = await fixture(1000, { dialog: true });
		try {
			await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
			const failures: string[] = [];
			const check = async (theme: string, state: string, selectors: string[]) => {
				for (const sample of await page.evaluate(measureContrast, selectors))
					if (sample.ratio < 4.5) failures.push(`${theme} · ${state} · "${sample.text}": ${sample.ratio}`);
			};
			const warning = { id: "00000000-0000-4000-8000-0000000000a1", message: "Fixture risk notice" };
			for (const theme of THEME_IDS) {
				await page.evaluate(id => window.providersTest.theme(id), theme);
				// A sign-in this dialog started has failed: its row at rest and under the pointer.
				await select(page, null);
				await set(page, {
					flow: flow({ provider: "gamma", status: "error", error: "Denied" }),
					owned: [FLOW],
					keyState: null,
				});
				const failed = '.provider-row[data-provider-id="gamma"] .provider-status[data-state="failed"]';
				await page.waitForSelector(failed);
				await page.mouse.move(1, 1);
				await check(theme, "failed row", [failed]);
				await page.hover('.provider-row[data-provider-id="gamma"]');
				await check(theme, "failed row under the pointer", [failed]);
				await select(page, "gamma");
				await page.waitForSelector('.provider-flow[data-view="failed"]');
				await check(theme, "failed detail", [
					'.provider-detail-head .provider-status[data-state="failed"]',
					".provider-flow .error-banner .error-content",
				]);
				await set(page, { flow: flow({ provider: "gamma", url: "http://sign-in.example.invalid/authorize" }) });
				await page.waitForSelector(".provider-flow .error-banner");
				await check(theme, "insecure sign-in address", [".provider-flow .error-banner .error-content"]);
				// The amber outcome cards: connected without models, and saved without a refreshed list.
				await set(page, { flow: flow({ provider: "beta", status: "complete" }) });
				await select(page, "beta");
				await page.waitForSelector('.provider-flow[data-view="connected"][data-tone="waiting"]');
				await check(theme, "connected without models", [".provider-flow-status"]);
				await set(page, { flow: flow({ provider: "beta", status: "waiting", warning }) });
				await page.waitForSelector('.provider-flow[data-view="warning"][data-tone="waiting"]');
				await check(theme, "provider warning", [".provider-flow-status", ".provider-warning > h5", ".provider-warning > p"]);
				// The Host does not drop a URL or device code it already sent when a warning arrives.
				await set(page, {
					flow: flow({
						provider: "beta",
						status: "waiting",
						warning,
						url: "https://sign-in.example.invalid/device",
						verificationCode: "WDJB-MJHT",
					}),
				});
				await page.waitForSelector('.provider-flow[data-view="warning"][data-tone="waiting"] .provider-url');
				await check(theme, "provider warning with a sign-in page", [".provider-code > span", ".provider-url"]);
				await set(page, { flow: null, keyState: { provider: "delta", status: "saved", catalogRefreshed: false } });
				await select(page, "delta");
				await page.waitForSelector('.provider-flow[data-view="saved-refresh-failed"][data-tone="waiting"]');
				await check(theme, "saved without a refreshed list", [".provider-flow-status"]);
				await set(page, { keyState: { provider: "delta", status: "invalid", reason: "command" } });
				await page.waitForSelector(".provider-field-error");
				await check(theme, "key error", [".provider-field-error"]);
				await set(page, { keyState: { provider: "delta", status: "error", error: "Fixture save failure" } });
				await page.waitForSelector(".provider-key .error-banner");
				await check(theme, "key save failure", [".provider-key .error-banner .error-content"]);
				await select(page, null);
				await set(page, { keyState: null, loaded: false, loadError: "Could not load the provider list." });
				await page.waitForSelector(".provider-load-error .error-banner");
				await check(theme, "load error", [".provider-load-error .error-banner .error-content"]);
				await set(page, { loaded: true, loadError: undefined });
			}
			expect(failures).toEqual([]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 60000);

	test("the shared error banner clears 4.5:1 in every bundled theme in the other places it appears", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			const failures: string[] = [];
			for (const theme of THEME_IDS) {
				await page.evaluate((key, id) => localStorage.setItem(key, id), THEME_STORAGE_KEY, theme);
				await page.reload();
				await page.waitForFunction(id => document.documentElement.dataset.theme === id, {}, theme);
				await page.waitForSelector("#showcase-tool-catalog-error .error-banner");
				// The Tools dialog's read error, and the app's generic banner (a lost host connection).
				const samples = await page.evaluate(measureContrast, [
					"#showcase-tool-catalog-error .error-banner .error-content",
					"#showcase-feedback .error-banner .error-content",
				]);
				for (const sample of samples)
					if (sample.ratio < 4.5) failures.push(`${theme} · ${sample.selector}: ${sample.ratio}`);
			}
			expect(failures).toEqual([]);
		} finally {
			await context.close();
		}
	}, 60000);

	test("the onboarding notice's text clears 4.5:1 on its amber card in every bundled theme", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			const failures: string[] = [];
			for (const theme of THEME_IDS) {
				await page.evaluate((key, id) => localStorage.setItem(key, id), THEME_STORAGE_KEY, theme);
				await page.reload();
				await page.waitForFunction(id => document.documentElement.dataset.theme === id, {}, theme);
				await page.waitForSelector("#showcase-provider-onboarding .provider-notice");
				const samples = await page.evaluate(measureContrast, [
					"#showcase-provider-onboarding .provider-notice-dock .provider-notice-text > strong",
					"#showcase-provider-onboarding .provider-notice-dock .provider-notice-text > span",
					"#showcase-provider-onboarding .composer-area .provider-notice-text > span",
				]);
				for (const sample of samples)
					if (sample.ratio < 4.5) failures.push(`${theme} · "${sample.text}": ${sample.ratio}`);
			}
			expect(failures).toEqual([]);
		} finally {
			await context.close();
		}
	}, 60000);

	test("the narrow layout follows the panel's width: the dialog in a 480 px window and the showcase's narrow frame", async () => {
		const narrowLayout = (page: Page, scope: string) =>
			page.$eval(`${scope} .providers-panel`, panel => ({
				width: Math.round(panel.getBoundingClientRect().width),
				narrow: getComputedStyle(panel.querySelector(".provider-row-meta")!).alignItems === "flex-start",
			}));
		const dialogPanel: Record<number, { width: number; narrow: boolean }> = {};
		for (const width of [390, 480, 481]) {
			const { context, page } = await fixture(width, { dialog: true });
			try {
				dialogPanel[width] = await narrowLayout(page, "dialog");
			} finally {
				await closeComponentFixture(context, page);
			}
		}
		expect(dialogPanel[390]!.narrow).toBe(true);
		expect(dialogPanel[480]!.narrow).toBe(true);
		expect(dialogPanel[481]!.narrow).toBe(false);
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-providers .provider-row");
			// The narrow frame shows what a 390 px window shows: the same panel width and layout.
			expect(await narrowLayout(page, "#showcase-providers .providers-showcase-frame[data-narrow]")).toEqual(
				dialogPanel[390],
			);
			expect(
				(await narrowLayout(page, "#showcase-providers .providers-showcase-frame:not([data-narrow])")).narrow,
			).toBe(false);
		} finally {
			await context.close();
		}
	}, 60000);

	test("only the provider list scrolls in small windows and at 20 px text; the detail scrolls as one", async () => {
		const many = Array.from({ length: 30 }, (_, index) =>
			provider(`fixture-${String(index).padStart(2, "0")}`, `Fixture provider ${index}`),
		);
		const { context, page } = await fixture(720, { height: 520, dialog: true });
		try {
			await set(page, { providers: [...providers, ...many] });
			await page.waitForSelector('.provider-row[data-provider-id="fixture-29"]');
			const layouts: Record<string, unknown> = {};
			for (const step of ["list", "detail"] as const) {
				await select(page, step === "list" ? null : "beta");
				await page.waitForSelector(`.providers-panel[data-step="${step}"]`);
				// 28 px is past the Settings range (200% of the default), where the reviewer also looks.
				for (const [width, height, text] of [
					[720, 520, 14],
					[720, 520, 20],
					[720, 520, 28],
					[390, 844, 14],
					[390, 844, 20],
				] as const) {
					await page.setViewport({ width, height });
					await textSize(page, text);
					layouts[`${step} ${width}x${height}@${text}`] = await page.evaluate(() => {
						const dialog = document.querySelector("dialog[open]")!;
						const frame = dialog.getBoundingClientRect();
						const inside = (node: Element | null) => {
							const box = node?.getBoundingClientRect();
							return !!box && box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5;
						};
						const scrolls = (node: Element) => node.scrollHeight > node.clientHeight + 1;
						const list = dialog.querySelector(".provider-list");
						return {
							// Every vertical scroller in the dialog, by class.
							scrollers: [dialog, ...dialog.querySelectorAll("*")]
								.filter(node => scrolls(node) && /auto|scroll/u.test(getComputedStyle(node).overflowY))
								.map(node => node.className),
							listShowsRows: list ? list.clientHeight >= 48 : null,
							pinned: list
								? [".model-search input", ".provider-summary", ".provider-footer"].map(selector =>
										inside(dialog.querySelector(selector)),
									)
								: null,
						};
					});
				}
			}
			const list = { scrollers: ["provider-list"], listShowsRows: true, pinned: [true, true, true] };
			expect(layouts).toMatchObject({
				"list 720x520@14": list,
				"list 720x520@20": list,
				"list 720x520@28": list,
				"list 390x844@14": list,
				"list 390x844@20": list,
			});
			// The detail has no inner scroller: at most the dialog's content scrolls, as one.
			for (const [key, value] of Object.entries(layouts).filter(([key]) => key.startsWith("detail"))) {
				const { scrollers } = value as { scrollers: string[] };
				expect({ key, scrollers: scrollers.filter(name => name !== "modal-content") }).toEqual({ key, scrollers: [] });
			}
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 60000);

	test("fits a 390px window in the list, the detail and the flow card", async () => {
		const { context, page } = await fixture(390);
		try {
			const overflow = () =>
				page.evaluate(() => {
					const panel = document.querySelector<HTMLElement>(".providers-panel");
					return {
						page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
						panel: panel ? panel.scrollWidth - panel.clientWidth : -1,
					};
				});
			expect(await overflow()).toEqual({ page: 0, panel: 0 });
			const id = "long-provider-identifier-that-keeps-going-without-any-break-opportunity-for-wrapping";
			await set(page, {
				flow: flow({
					provider: id,
					status: "waiting",
					url: `https://sign-in.example.invalid/${"segment".repeat(30)}?state=${"0".repeat(64)}`,
					verificationCode: "WDJB-MJHT",
				}),
			});
			await select(page, id);
			await page.waitForSelector(".provider-flow");
			expect(await overflow()).toEqual({ page: 0, panel: 0 });
			await set(page, { flow: null });
			await page.waitForSelector(".provider-key");
			expect(await overflow()).toEqual({ page: 0, panel: 0 });
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);
});
