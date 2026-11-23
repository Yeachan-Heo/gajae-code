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
});
