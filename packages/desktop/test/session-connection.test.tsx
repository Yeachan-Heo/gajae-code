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
});
