import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { THEME_IDS } from "../src/themes";
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

declare global {
	interface Window {
		connectionTest: { theme(id: string): void };
	}
}

/** A page-side module script; `body` renders into a fresh root with React (`h`) and `applyTheme` in scope. */
async function mount(page: Page, imports: string, body: string): Promise<void> {
	await componentReady(page, async () => {
		await page.addScriptTag({
			type: "module",
			content: `
				import '/src/styles.css';
				import React from '/node_modules/.vite/deps/react.js';
				import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
				import { applyTheme } from '/src/themes.ts';
				${imports}
				const h = React.createElement;
				window.connectionTest = { theme: applyTheme };
				const root = document.createElement('div');
				root.id = 'connection-fixture';
				document.body.replaceChildren(root);
				${body}
			`,
		});
		await page.waitForFunction(() => !!window.connectionTest);
	});
	await page.addStyleTag({ url: `${origin}/src/styles.css` });
	await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
}

async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	await page.setViewport({ width: 1000, height: 800 });
	return { context, page };
}

suite("Session connection", () => {
	test("a danger button reads at 4.5:1 inside a dialog, at rest, hovered and pressed, in every bundled theme", async () => {
		const { context, page } = await fixture();
		try {
			await mount(
				page,
				`import { Modal } from '/src/components.tsx';
				import { DisconnectConfirmation } from '/src/SessionConnection.tsx';`,
				`ReactDOM.createRoot(root).render(h(Modal, { title: 'Disconnect', onClose: () => {} },
					h(DisconnectConfirmation, { running: true, queued: 2, pending: false, onConfirm: () => {}, onCancel: () => {} })));`,
			);
			const danger = "dialog[open] .disconnect-confirmation .button.danger";
			await page.waitForSelector(danger);
			const failures: string[] = [];
			const check = async (theme: string, state: string) => {
				const [sample] = await page.evaluate(measureContrast, [danger]);
				if (sample!.ratio < 4.5) failures.push(`${theme} · ${state}: ${sample!.ratio}`);
			};
			for (const theme of THEME_IDS) {
				await page.evaluate(id => window.connectionTest.theme(id), theme);
				await page.mouse.move(1, 1);
				await check(theme, "at rest");
				await page.hover(danger);
				await check(theme, "hovered");
				await page.mouse.down();
				await check(theme, "pressed");
				await page.mouse.up();
				// Beyond hue, which sits near the accent in some palettes, a danger button carries an edge
				// of its own (plain buttons have none) at 3:1 or better against the dialog.
				await page.mouse.move(1, 1);
				const edge = await page.$eval(danger, node => {
					const style = getComputedStyle(node);
					const probe = document.createElement("span");
					probe.id = "danger-edge-probe";
					probe.textContent = "edge";
					probe.style.color = style.borderTopColor;
					node.closest(".disconnect-confirmation")!.append(probe);
					return { width: Number.parseFloat(style.borderTopWidth), style: style.borderTopStyle };
				});
				const [edgeSample] = await page.evaluate(measureContrast, ["#danger-edge-probe"]);
				await page.$eval("#danger-edge-probe", node => node.remove());
				if (edge.width < 1 || edge.style !== "solid" || edgeSample!.ratio < 3)
					failures.push(`${theme} · edge: ${edge.width}px ${edge.style} ${edgeSample!.ratio}`);
			}
			expect(failures).toEqual([]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 60000);

	test("the showcase opens each Disconnect confirmation as a real dialog: title, focus, Escape and focus return", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-session-connection .disconnect-dialog-opener");
			const openers = await page.$$eval("#showcase-session-connection .disconnect-dialog-opener", nodes => nodes.length);
			expect(openers).toBe(2);
			const seen: unknown[] = [];
			for (const index of [0, 1]) {
				// Opened from the keyboard, as a user would, so the opener holds focus to return to.
				await page.evaluate(
					position =>
						document
							.querySelectorAll<HTMLButtonElement>("#showcase-session-connection .disconnect-dialog-opener")
							[position]!.focus(),
					index,
				);
				await page.keyboard.press("Enter");
				await page.waitForSelector("dialog[open] .disconnect-confirmation");
				seen.push(
					await page.evaluate(() => {
						const dialog = document.querySelector("dialog[open]")!;
						const probe = document.createElement("span");
						probe.style.backgroundColor = "var(--card)";
						document.body.append(probe);
						const card = getComputedStyle(probe).backgroundColor;
						probe.remove();
						return {
							title: dialog.querySelector("header h2")?.textContent,
							actions: [...dialog.querySelectorAll(".disconnect-confirmation button")].map(button => button.textContent),
							focus: document.activeElement?.classList.contains("modal-close") ?? false,
							onCard: getComputedStyle(dialog).backgroundColor === card,
						};
					}),
				);
				await page.keyboard.press("Escape");
				await page.waitForFunction(() => !document.querySelector("dialog[open]"));
				expect(
					await page.evaluate(
						position =>
							document.activeElement ===
							document.querySelectorAll("#showcase-session-connection .disconnect-dialog-opener")[position],
						index,
					),
				).toBe(true);
			}
			expect(seen).toEqual([
				{
					title: "Disconnect while it is working?",
					actions: ["Cancel", "Stop and disconnect"],
					focus: true,
					onCard: true,
				},
				// Only queued messages go back: nothing is working, so nothing says it is.
				{ title: "Disconnect with queued messages?", actions: ["Cancel", "Disconnect"], focus: true, onCard: true },
			]);
		} finally {
			await context.close();
		}
	}, 30000);

	test("both connection notices lay out alike at the app's composer widths: icon beside and level with the title", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 720, height: 900 });
			// The composer area's content at a 720 px window: 432 px beside the open sidebar, 632 px beside the rail.
			await mount(
				page,
				`import { SessionConnectionNotice } from '/src/SessionConnection.tsx';`,
				`const notice = state => h(SessionConnectionNotice, { state, pending: false, onConnect: () => {} });
				ReactDOM.createRoot(root).render([432, 632].map(width =>
					h('div', { key: width, 'data-width': width, style: { width: width + 'px' } }, notice('disconnected'), notice('elsewhere'))));`,
			);
			await page.waitForSelector(".connection-notice");
			const layouts: Record<string, unknown> = {};
			// A tall window shows the explanation; a short one (720x520) keeps the notice to its title line.
			for (const [height, size] of [
				[900, 14],
				[900, 20],
				[520, 14],
				[520, 20],
			] as const) {
				await page.setViewport({ width: 720, height });
				await page.evaluate(px => document.documentElement.style.setProperty("--text-size", `${px}px`), size);
				for (const width of [432, 632]) {
					layouts[`${width}@${size}x${height}`] = await page.$$eval(`[data-width="${width}"] .connection-notice`, notices =>
						notices.map(notice => {
							const icon = notice.querySelector(".connection-notice-icon")!.getBoundingClientRect();
							const title = notice.querySelector(".connection-notice-text > strong")!;
							const range = document.createRange();
							range.selectNodeContents(title);
							const firstLine = range.getClientRects()[0]!;
							const text = notice.querySelector(".connection-notice-text")!.getBoundingClientRect();
							const button = notice.querySelector(".connection-notice-action")!.getBoundingClientRect();
							const wrapped = button.top >= text.bottom - 0.5;
							return {
								iconBesideTitle: icon.right <= text.left + 0.5,
								iconLevelWithTitle:
									Math.abs(icon.top + icon.height / 2 - (firstLine.top + firstLine.height / 2)) <= 1.5,
								// A wrapped button never sits under the icon.
								buttonClearOfIcon: !wrapped || button.left >= text.left - 0.5,
								wrapped,
								buttonWidth: Math.round(button.width),
							};
						}),
					);
				}
			}
			for (const [key, value] of Object.entries(layouts)) {
				const [disconnected, elsewhere] = value as Array<Record<string, boolean>>;
				expect({ key, ...disconnected }).toMatchObject({
					key,
					iconBesideTitle: true,
					iconLevelWithTitle: true,
					buttonClearOfIcon: true,
				});
				// The two sibling states lay out the same way at the same width.
				expect({ key, ...elsewhere }).toEqual({ key, ...disconnected });
			}
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a header badge that wraps starts flush with the title; on the title's line it keeps its 8 px gap", async () => {
		const { context, page } = await fixture();
		try {
			await mount(
				page,
				`import { SessionConnectionBadge } from '/src/SessionConnectionMark.tsx';`,
				`const title = (key, text, width) => h('div', { key, className: 'toolbar-title', 'data-badge': key, style: { width: width + 'px' } },
					h('h1', null, text), h(SessionConnectionBadge, { session: { connection: { state: 'elsewhere' } } }));
				ReactDOM.createRoot(root).render([title('short', 'Short title', 600), title('wrapped', 'A title long enough to fill the line', 300)]);`,
			);
			await page.waitForSelector(".connection-badge");
			const placement = await page.$$eval(".toolbar-title", titles =>
				titles.map(node => {
					const range = document.createRange();
					range.selectNodeContents(node.querySelector("h1")!);
					const lines = [...range.getClientRects()];
					const badge = node.querySelector(".connection-badge")!.getBoundingClientRect();
					const last = lines.at(-1)!;
					const sameLine = badge.top < last.bottom && badge.bottom > last.top;
					return {
						sameLine,
						gap: sameLine ? Math.round(badge.left - last.right) : null,
						indent: sameLine ? null : Math.round(badge.left - lines[0]!.left),
					};
				}),
			);
			expect(placement).toEqual([
				{ sameLine: true, gap: 8, indent: null },
				{ sameLine: false, gap: null, indent: 0 },
			]);
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a pending Connect keeps its width, its focus and a legible label, and ignores a second click", async () => {
		const { context, page } = await fixture();
		try {
			await mount(
				page,
				`import { SessionConnectionNotice } from '/src/SessionConnection.tsx';`,
				`const calls = [];
				window.connectCalls = calls;
				function Fixture() {
					const [pending, setPending] = React.useState({ disconnected: false, elsewhere: false });
					const notice = state => h(SessionConnectionNotice, { state, pending: pending[state], onConnect: () => {
						calls.push(state);
						setPending(previous => ({ ...previous, [state]: true }));
					} });
					return h('div', { style: { width: '632px' } }, notice('disconnected'), notice('elsewhere'));
				}
				ReactDOM.createRoot(root).render(h(Fixture));`,
			);
			await page.waitForSelector(".connection-notice");
			const geometry = (state: string) =>
				page.$eval(`.connection-notice[data-state="${state}"]`, notice => ({
					button: Math.round(notice.querySelector(".connection-notice-action")!.getBoundingClientRect().width * 10) / 10,
					text: Math.round(notice.querySelector(".connection-notice-text")!.getBoundingClientRect().width * 10) / 10,
				}));
			for (const [state, idle, busy] of [
				["disconnected", "Connect", "Connecting…"],
				["elsewhere", "Check again", "Checking…"],
			] as const) {
				const before = await geometry(state);
				const button = `.connection-notice[data-state="${state}"] .connection-notice-action`;
				expect(await page.$eval(button, node => node.textContent)).toBe(idle);
				await page.focus(button);
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					(selector, label) => document.querySelector(selector)?.textContent === label,
					{},
					button,
					busy,
				);
				// A second press while pending sends nothing, and focus stays on the button.
				await page.keyboard.press("Enter");
				await page.click(button);
				expect(await page.evaluate(selector => document.activeElement === document.querySelector(selector), button)).toBe(
					true,
				);
				expect(await geometry(state)).toEqual(before);
				const name = await page.$eval(button, node => node.textContent);
				expect(name).toBe(busy);
				const failures: string[] = [];
				for (const theme of THEME_IDS) {
					await page.evaluate(id => window.connectionTest.theme(id), theme);
					const [sample] = await page.evaluate(measureContrast, [button]);
					if (sample!.ratio < 4.5) failures.push(`${theme}: ${sample!.ratio}`);
				}
				expect(failures).toEqual([]);
			}
			expect(await page.evaluate(() => (window as unknown as { connectCalls: string[] }).connectCalls)).toEqual([
				"disconnected",
				"elsewhere",
			]);
			// The accessible name is the visible label only: the reserved width adds no text.
			const snapshot = await page.accessibility.snapshot({
				root: (await page.$('.connection-notice[data-state="disconnected"] .connection-notice-action')) ?? undefined,
			});
			expect(snapshot?.name).toBe("Connecting…");
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);

	test("a sidebar row's status icon and connection mark grow with the text together", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			await page.setViewport({ width: 1200, height: 900 });
			await page.goto(`${origin}/?showcase`);
			const row = "#showcase-session-connection .showcase-session-rows .session-row:has(.connection-mark)";
			await page.waitForSelector(row);
			const sizes = (px: number) =>
				page.evaluate(
					(size, selector) => {
						document.documentElement.style.setProperty("--text-size", `${size}px`);
						const box = (node: Element) => Math.round(node.getBoundingClientRect().width);
						const target = document.querySelector(selector)!;
						return { status: box(target.querySelector(".session-state svg")!), mark: box(target.querySelector(".connection-mark svg")!) };
					},
					px,
					row,
				);
			expect(await sizes(14)).toEqual({ status: 13, mark: 12 });
			expect(await sizes(20)).toEqual({ status: 19, mark: 17 });
		} finally {
			await context.close();
		}
	}, 30000);

	test("in a short window a compact notice's explanation stays one press away; a tall window shows it outright", async () => {
		const { context, page } = await fixture();
		try {
			await page.setViewport({ width: 900, height: 520 });
			await mount(
				page,
				`import { SessionConnectionNotice } from '/src/SessionConnection.tsx';
				import { ProviderOnboardingNotice } from '/src/ProviderOnboardingNotice.tsx';`,
				`ReactDOM.createRoot(root).render(h('div', { style: { width: '632px' } },
					h(SessionConnectionNotice, { state: 'disconnected', pending: false, onConnect: () => {} }),
					h(SessionConnectionNotice, { state: 'elsewhere', pending: false, onConnect: () => {} }),
					h(ProviderOnboardingNotice, { onConnect: () => {} })));`,
			);
			const notices = [
				['.connection-notice[data-state="disconnected"]', ".connection-notice-text > span", "your draft is kept"],
				['.connection-notice[data-state="elsewhere"]', ".connection-notice-text > span", "Finish there, then check again."],
				[".provider-notice", ".provider-notice-text > span", "Connect an account or add an API key"],
			] as const;
			const shown = (notice: string, body: string) =>
				page.$eval(`${notice} ${body}`, node => {
					const box = node.getBoundingClientRect();
					return node.checkVisibility() && box.width > 20 && box.height > 8;
				});
			for (const [notice, body, words] of notices) {
				expect(await page.$eval(`${notice} ${body}`, node => node.textContent)).toContain(words);
				// Compact: the explanation is hidden, and a visible toggle reveals it in place.
				expect({ notice, shown: await shown(notice, body) }).toEqual({ notice, shown: false });
				const toggle = `${notice} [aria-expanded]`;
				expect(await page.$eval(toggle, node => (node as HTMLElement).checkVisibility())).toBe(true);
				await page.click(toggle);
				await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-expanded") === "true", {}, toggle);
				expect({ notice, shown: await shown(notice, body) }).toEqual({ notice, shown: true });
			}
			// A tall window shows every explanation and no toggle.
			await page.setViewport({ width: 900, height: 900 });
			for (const [notice, body] of notices) {
				expect(await page.$eval(`${notice} [aria-expanded]`, node => (node as HTMLElement).checkVisibility())).toBe(false);
				expect({ notice, shown: await shown(notice, body) }).toEqual({ notice, shown: true });
			}
		} finally {
			await closeComponentFixture(context, page);
		}
	}, 30000);
});
