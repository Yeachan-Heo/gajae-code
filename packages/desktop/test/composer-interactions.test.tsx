import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) break; } catch { /* server is starting */ }
		await Bun.sleep(100);
	}
	browser = await puppeteer.launch({ executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
}, 30000);
afterAll(async () => {
	await browser?.close();
	if (server) { server.kill(); await server.exited; }
});

interface TestControl {
	setValue(value: string): void;
	setDisabled(value: boolean): void;
	setSendDisabled(value: boolean): void;
	setBusy(value: boolean): void;
	setAllowQueue(value: boolean): void;
	setModal(value: boolean): void;
	sends(): number;
	state(): Record<string, string | boolean>;
}

async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
	await componentReady(page, async () => {
	await page.addScriptTag({ type: "module", content: `
		import '/src/styles.css';
		import React from '/node_modules/.vite/deps/react.js';
		import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
		const { useState } = React;
		const { createRoot } = ReactDOM;
		import { Composer, Modal } from '/src/components.tsx';
		import { AttachmentPicker } from '/src/AttachmentPicker.tsx';
		const h = React.createElement;
		let sends = 0;
		function Fixture() {
			const [value, setValue] = useState('');
			const [disabled, setDisabled] = useState(false);
			const [sendDisabled, setSendDisabled] = useState(false);
			const [busy, setBusy] = useState(false);
			const [allowQueue, setAllowQueue] = useState(true);
			const [modal, setModal] = useState(false);
			const [attachments, setAttachments] = useState([]);
			window.composerTest = { setValue, setDisabled, setSendDisabled, setBusy, setAllowQueue, setModal, sends: () => sends, state: () => ({ value, disabled, sendDisabled, busy, allowQueue, modal }) };
			return h(React.Fragment, null,
				h('button', { id: 'open', onClick: () => setModal(true) }, 'Open'),
				h(Composer, { value, onChange: setValue, onSend: () => sends++, onStop: () => {}, busy, disabled, sendDisabled, allowQueue,
					attachment: h(AttachmentPicker, { sessionId: 'one', attachments, supportsImageInput: true, disabled,
						onChange: (_session, update) => setAttachments(update) }) }),
				modal && h(Modal, { title: 'Dialog', onClose: () => setModal(false) }, h('button', { id: 'inside' }, 'Inside'), h('details', { id: 'disclosure' }, h('summary', { id: 'summary' }, 'Details'), 'Activity detail')));
		}
		const root = document.createElement('div');
		root.id = 'composer-test-root';
		document.body.replaceChildren(root);
		createRoot(root).render(h(Fixture));
	` });
	await page.waitForFunction(() =>
		!!(window as unknown as { composerTest?: TestControl }).composerTest &&
		!!document.querySelector('#composer-test-root .composer textarea'),
	);
	});
	return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function update(page: Page, method: keyof Omit<TestControl, "sends" | "state">, value: string | boolean): Promise<void> {
	await page.evaluate(({ method, value }) => {
		const control = (window as unknown as { composerTest: TestControl }).composerTest;
		if (method === "setValue" && typeof value === "string") control.setValue(value);
		else if (typeof value === "boolean" && method !== "setValue") control[method](value);
	}, { method, value });
	await page.waitForFunction(({ method, value }) => {
		const field = method[3].toLowerCase() + method.slice(4);
		return (window as unknown as { composerTest: TestControl }).composerTest.state()[field] === value;
	}, {}, { method, value });
}
async function sends(page: Page): Promise<number> {
	return page.evaluate(() => (window as unknown as { composerTest: TestControl }).composerTest.sends());
}

describe("mounted compact composer", () => {
	test("Enter sends, Shift+Enter inserts a newline, and modifiers and IME never send", async () => {
		const { context, page } = await fixture();
		try {
			await page.focus('.composer textarea');
			await page.keyboard.type('hello');
			await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
			expect(await page.$eval('.composer textarea', element => (element as HTMLTextAreaElement).value)).toBe('hello\n');
			await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
			await page.$eval('.composer textarea', element => {
				element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
				element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
				element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
				element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229 }));
			});
			expect(await sends(page)).toBe(0);
			await page.keyboard.press('Enter');
			expect(await sends(page)).toBe(1);
		} finally { await closeComponentFixture(context, page); }
	});

	test("disabled, recovery and busy queue restrictions prevent sending", async () => {
		const { context, page } = await fixture();
		try {
			await update(page, 'setValue', 'draft');
			await update(page, 'setSendDisabled', true);
			await page.waitForSelector('.composer button[type=submit]:disabled');
			await page.focus('.composer textarea'); await page.keyboard.press('Enter');
			await update(page, 'setSendDisabled', false);
			await update(page, 'setBusy', true); await update(page, 'setAllowQueue', false);
			// A running turn whose draft cannot be steered offers stop instead of a dead send slot.
			await page.waitForSelector('.composer-actions button[aria-label="Stop"]');
			expect(await page.evaluate(() => document.querySelectorAll('.composer button[type=submit]').length)).toBe(0);
			await page.keyboard.press('Enter');
			await update(page, 'setDisabled', true);
			await update(page, 'setBusy', false);
			await update(page, 'setAllowQueue', true);
			await page.waitForSelector('.composer textarea:disabled');
			await page.$eval('form.composer', element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
			expect(await sends(page)).toBe(0);
		} finally { await closeComponentFixture(context, page); }
	});

	test("grows for wrapping and newlines, caps and resets after clearing", async () => {
		const { context, page } = await fixture();
		try {
			const measure = () => page.$eval('.composer textarea', element => ({ height: element.getBoundingClientRect().height, rows: (element as HTMLTextAreaElement).rows, overflow: (element as HTMLElement).style.overflowY }));
			const initial = await measure();
			expect(initial.rows).toBe(1);
			await update(page, 'setValue', 'long line '.repeat(300));
			await page.waitForFunction(() => (document.querySelector('.composer textarea') as HTMLElement).style.overflowY === 'auto');
			const grown = await measure();
			expect(grown.height).toBeGreaterThan(initial.height);
			expect(grown.overflow).toBe('auto');
			await update(page, 'setValue', '');
			await page.waitForFunction(() => (document.querySelector('.composer textarea') as HTMLTextAreaElement).value === '');
			expect((await measure()).height).toBe(initial.height);
			await update(page, 'setValue', 'one\ntwo\nthree');
			await page.waitForFunction(() => (document.querySelector('.composer textarea') as HTMLTextAreaElement).value.includes('\n'));
			expect((await measure()).height).toBeGreaterThan(initial.height);
		} finally { await closeComponentFixture(context, page); }
	});

	test("resizes an existing multiline draft when text grows without another edit", async () => {
		const { context, page } = await fixture();
		try {
			await update(page, 'setValue', 'one\ntwo\nthree');
			const before = await page.$eval('.composer textarea', element => element.getBoundingClientRect().height);
			await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
			await page.waitForFunction(() => {
				const element = document.querySelector('.composer textarea') as HTMLTextAreaElement;
				const style = getComputedStyle(element);
				return element.clientHeight + 1 >= parseFloat(style.lineHeight) * 3 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
			});
			const size = await page.$eval('.composer textarea', element => ({ rows: (element as HTMLTextAreaElement).rows, height: element.getBoundingClientRect().height, font: getComputedStyle(element).fontSize }));
			expect(size.rows).toBe(1);
			expect(parseFloat(size.font)).toBe(28);
			expect(size.height).toBeGreaterThan(before);
		} finally { await closeComponentFixture(context, page); }
	});

	test("attachment trigger starts the footer, leaving a full-width input, and modal restores focus", async () => {
		const { context, page } = await fixture();
		try {
			const attachment = await page.$eval('.composer', element => {
				const input = element.querySelector('.composer-input')!;
				const textarea = input.querySelector('textarea')!;
				const footer = element.querySelector('.composer-footer')!;
				const button = footer.querySelector('button[aria-label="Attach file"]')!;
				return {
					iconOnly: button.textContent === '',
					firstControl: footer.querySelector('button') === button,
					inputOnly: input.children.length === 1 && input.firstElementChild === textarea,
					fullWidth: Math.abs(textarea.getBoundingClientRect().width - input.getBoundingClientRect().width) < 1,
					belowInput: button.getBoundingClientRect().top >= textarea.getBoundingClientRect().bottom,
					hiddenPicker: !!footer.querySelector('input[type=file][hidden]'),
				};
			});
			expect(attachment).toEqual({ iconOnly: true, firstControl: true, inputOnly: true, fullWidth: true, belowInput: true, hiddenPicker: true });
			await page.$eval('.attachment-picker input[type=file]', input => input.addEventListener('click', event => { event.preventDefault(); input.setAttribute('data-clicked', 'yes'); }));
			await page.click('.attachment-trigger');
			expect(await page.$eval('.attachment-picker input[type=file]', input => input.getAttribute('data-clicked'))).toBe('yes');
			await page.click('#open');
			await page.waitForSelector('dialog[open] .modal-content #inside');
			expect(await page.$eval('dialog', dialog => !!dialog.querySelector(':scope > header .modal-close[aria-label="Close"]') && !!dialog.querySelector(':scope > .modal-content #inside'))).toBe(true);
			expect(await page.$eval('.modal-close', button => button.textContent)).toBe('');
			await page.focus('#inside');
			for (const key of ['Tab', 'Tab'] as const) {
				await page.keyboard.press(key);
				expect(await page.evaluate(() => !!document.querySelector('dialog')?.contains(document.activeElement))).toBe(true);
			}
			await page.keyboard.down('Shift');
			try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
			expect(await page.evaluate(() => !!document.querySelector('dialog')?.contains(document.activeElement))).toBe(true);
			await page.$eval('#inside', element => { (element as HTMLButtonElement).disabled = true; });
			await page.focus('.modal-close');
			await page.keyboard.press('Tab');
			expect(await page.evaluate(() => document.activeElement?.id)).toBe('summary');
			await page.keyboard.press('Enter');
			expect(await page.$eval('#disclosure', element => (element as HTMLDetailsElement).open)).toBe(true);
			await page.keyboard.press('Tab');
			expect(await page.$eval('.modal-close', element => element === document.activeElement)).toBe(true);
			await page.keyboard.down('Shift');
			try { await page.keyboard.press('Tab'); } finally { await page.keyboard.up('Shift'); }
			expect(await page.evaluate(() => document.activeElement?.id)).toBe('summary');
			await page.keyboard.press('Escape');
			await page.waitForSelector('dialog', { hidden: true });
			expect(await page.evaluate(() => document.activeElement?.id)).toBe('open');
			await page.click('#open');
			await page.waitForSelector('dialog[open]');
			await page.click('.modal-close');
			await page.waitForSelector('dialog', { hidden: true });
			expect(await page.evaluate(() => document.activeElement?.id)).toBe('open');
		} finally { await closeComponentFixture(context, page); }
	});
});
