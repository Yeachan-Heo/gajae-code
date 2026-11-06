import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { browserPath, closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

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
		try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

async function fixture(retain = false): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await componentReady(page, async () => {
			await page.addScriptTag({ type: "module", content: `
				import React from '/node_modules/.vite/deps/react.js';
				import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
				import { Modal } from '/src/components.tsx';
				import '/src/styles.css';
				const h = React.createElement;
				function Fixture() {
					const [open, setOpen] = React.useState(false);
					const [calls, setCalls] = React.useState(0);
					return h(React.Fragment, null,
						h('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'),
						h('output', { id: 'calls' }, String(calls)),
						open && h(Modal, { title: 'Modal fixture', onClose: () => {
							setCalls(value => value + 1);
							if (!${retain}) setOpen(false);
						} }, h('button', { id: 'inside' }, 'Inside')));
				}
				const root = document.createElement('div');
				document.body.replaceChildren(root);
				ReactDOM.createRoot(root).render(h(Fixture));
			` });
			await page.waitForSelector('#opener');
		});
		await page.addStyleTag({ url: `${origin}/src/styles.css` });
		await page.click('#opener');
		await page.waitForSelector('dialog[open]');
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function points(page: Page) {
	return page.$eval('dialog', dialog => {
		const rect = dialog.getBoundingClientRect();
		return {
			outside: { x: rect.left - 10, y: rect.top + rect.height / 2 },
			padding: { x: rect.left + 4, y: rect.top + 4 },
		};
	});
}

async function expectOpen(page: Page) {
	expect(await page.$eval('#calls', node => node.textContent)).toBe('0');
	expect(await page.$eval('dialog', node => node.open)).toBe(true);
}

suite('Modal native dismissal', () => {
	test('outside press and release calls onClose once without closing the native dialog itself', async () => {
		const { context, page } = await fixture(true);
		try {
			const { outside } = await points(page);
			await page.mouse.click(outside.x, outside.y);
			await page.waitForFunction(() => document.querySelector('#calls')?.textContent === '1');
			expect(await page.$eval('#calls', node => node.textContent)).toBe('1');
			expect(await page.$eval('dialog', node => node.open)).toBe(true);
		} finally { await closeComponentFixture(context, page); }
	});

	for (const direction of ['outside-to-inside', 'inside-to-outside'] as const) {
		test(`${direction} drag does not dismiss`, async () => {
			const { context, page } = await fixture();
			try {
				const { outside, padding } = await points(page);
				const [start, end] = direction === 'outside-to-inside' ? [outside, padding] : [padding, outside];
				await page.mouse.move(start.x, start.y);
				await page.mouse.down();
				await page.mouse.move(end.x, end.y, { steps: 5 });
				await page.mouse.up();
				await expectOpen(page);
			} finally { await closeComponentFixture(context, page); }
		});
	}

	test('padding, header, content and secondary-button clicks do not dismiss', async () => {
		const { context, page } = await fixture();
		try {
			const { outside, padding } = await points(page);
			await page.mouse.click(padding.x, padding.y);
			await page.click('dialog h2');
			await page.click('#inside');
			await page.mouse.click(outside.x, outside.y, { button: 'right' });
			await expectOpen(page);
		} finally { await closeComponentFixture(context, page); }
	});

	for (const method of ['Escape', 'backdrop'] as const) {
		test(`${method} dismissal restores focus to the opener`, async () => {
			const { context, page } = await fixture();
			try {
				if (method === 'Escape') await page.keyboard.press('Escape');
				else {
					const { outside } = await points(page);
					await page.mouse.click(outside.x, outside.y);
				}
				await page.waitForFunction(() => !document.querySelector('dialog'));
				expect(await page.$eval('#calls', node => node.textContent)).toBe('1');
				expect(await page.evaluate(() => document.activeElement?.id)).toBe('opener');
			} finally { await closeComponentFixture(context, page); }
		});
	}
});
