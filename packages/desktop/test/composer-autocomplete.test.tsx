import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { closeComponentFixture, componentFixture, componentReady } from "./component-fixture";

const port = 16000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const input = ".composer textarea";
const menu = ".composer-completions";
const option = `${menu} [role=option]`;
let server: Bun.Subprocess<"ignore", "ignore", "ignore">;
let browser: Browser;

beforeAll(async () => {
	server = Bun.spawn(["bun", "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: `${import.meta.dir}/..`, stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Vite is starting. */ }
		await Bun.sleep(100);
	}
	if (!ready) throw new Error("Composer autocomplete fixture Vite server did not start");
	browser = await puppeteer.launch({ executablePath: process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
}, 30000);
afterAll(async () => {
	await browser?.close();
	if (server) { server.kill(); await server.exited; }
});

interface Item {
	value: string;
	label: string;
	description?: string;
	text: string;
	cursor: number;
}
interface Result { items: Item[]; reason?: string }
interface Request { owner: string; text: string; cursor: number }
interface Control {
	setValue(value: string): void;
	setOwner(owner: string): void;
	setDisabled(disabled: boolean): void;
	setSendDisabled(disabled: boolean): void;
	setAvailable(available: boolean): void;
	resolve(index: number, result: Result): void;
	reject(index: number): void;
	calls(): Request[];
	sends(): string[];
	state(): { value: string; owner: string; disabled: boolean; sendDisabled: boolean; available: boolean };
	theme(name: string): void;
}
type FixtureWindow = Window & { syntheticCompletion: Control };

// Deliberately synthetic callback fixtures: these exercise the mounted Composer contract,
// not the host catalog, TUI provider, filesystem, or host/TUI parity.
async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
		await page.setViewport({ width: 1024, height: 800 });
		await componentReady(page, async () => {
			await page.addScriptTag({ type: "module", content: `
				import React from '/node_modules/.vite/deps/react.js';
				import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
				import { Composer } from '/src/components.tsx';
				import { applyTheme } from '/src/themes.ts';
				const h = React.createElement;
				const requests = [];
				const sent = [];
				applyTheme('red-claw');
				function Fixture() {
					const [value, setValue] = React.useState('');
					const [owner, setOwner] = React.useState('synthetic-owner-one');
					const [disabled, setDisabled] = React.useState(false);
					const [sendDisabled, setSendDisabled] = React.useState(false);
					const [available, setAvailable] = React.useState(true);
					window.syntheticCompletion = {
						setValue, setOwner, setDisabled, setSendDisabled, setAvailable,
						resolve: (index, result) => requests[index].resolve(result),
						reject: index => requests[index].reject(new Error('Synthetic completion failure')),
						calls: () => requests.map(({ owner, text, cursor }) => ({ owner, text, cursor })),
						sends: () => [...sent],
						state: () => ({ value, owner, disabled, sendDisabled, available }),
						theme: applyTheme,
					};
					return h(React.Fragment, null,
						h('button', { id: 'outside', type: 'button' }, 'Outside composer'),
						h('section', { id: 'fixture-dock', style: { position: 'fixed', left: '16px', right: '16px', bottom: '20px', maxWidth: '720px', margin: '0 auto' } },
							h(Composer, { value, onChange: setValue, onSend: () => sent.push(value), onStop: () => {}, busy: false,
								disabled, sendDisabled,
								autocomplete: available ? { owner, complete: (text, cursor) => { const { promise, resolve, reject } = Promise.withResolvers(); requests.push({ owner, text, cursor, resolve, reject }); return promise; } } : undefined,
							})),
						h('button', { id: 'after', type: 'button', style: { position: 'fixed', right: '8px', top: '8px' } }, 'After composer'));
				}
				const root = document.createElement('div');
				root.id = 'autocomplete-test-root';
				document.body.replaceChildren(root);
				ReactDOM.createRoot(root).render(h(Fixture));
			` });
			await page.waitForFunction(() => !!(window as unknown as FixtureWindow).syntheticCompletion && !!document.querySelector(".composer textarea"));
			await page.addStyleTag({ url: `${origin}/src/styles.css?direct` });
		});
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function set(page: Page, field: "value" | "owner" | "disabled" | "sendDisabled" | "available", value: string | boolean): Promise<void> {
	await page.evaluate(({ field, value }) => {
		const control = (window as unknown as FixtureWindow).syntheticCompletion;
		if (field === "value" && typeof value === "string") control.setValue(value);
		else if (field === "owner" && typeof value === "string") control.setOwner(value);
		else if (field === "disabled" && typeof value === "boolean") control.setDisabled(value);
		else if (field === "sendDisabled" && typeof value === "boolean") control.setSendDisabled(value);
		else if (field === "available" && typeof value === "boolean") control.setAvailable(value);
	}, { field, value });
	await page.waitForFunction(({ field, value }) => (window as unknown as FixtureWindow).syntheticCompletion.state()[field] === value, {}, { field, value });
}
async function selection(page: Page, start: number, end = start): Promise<void> {
	await page.$eval(input, (element, start, end) => {
		const textarea = element as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(start, end);
		textarea.dispatchEvent(new Event("select", { bubbles: true }));
	}, start, end);
}
async function draft(page: Page, text: string, cursor = text.length): Promise<void> {
	await set(page, "value", text);
	await page.waitForFunction(text => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === text, {}, text);
	await selection(page, cursor);
}
async function request(page: Page, index: number): Promise<Request> {
	await page.waitForFunction(index => (window as unknown as FixtureWindow).syntheticCompletion.calls().length > index, {}, index);
	return page.evaluate(index => (window as unknown as FixtureWindow).syntheticCompletion.calls()[index], index);
}
async function resolve(page: Page, index: number, items: Item[], reason?: string): Promise<void> {
	await page.evaluate(({ index, items, reason }) => (window as unknown as FixtureWindow).syntheticCompletion.resolve(index, { items, reason }), { index, items, reason });
}
async function choices(page: Page, index: number, items: Item[]): Promise<void> {
	await request(page, index);
	await resolve(page, index, items);
	await page.waitForFunction(count => document.querySelectorAll(".composer-completions [role=option]").length === count, {}, items.length);
}
async function snapshot(page: Page) {
	return page.$eval(input, element => {
		const textarea = element as HTMLTextAreaElement;
		return { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd, focused: document.activeElement === textarea };
	});
}
async function sends(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as FixtureWindow).syntheticCompletion.sends());
}
async function calls(page: Page): Promise<Request[]> {
	return page.evaluate(() => (window as unknown as FixtureWindow).syntheticCompletion.calls());
}
async function absent(page: Page): Promise<void> {
	await page.waitForSelector(menu, { hidden: true });
}
async function settle(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		await promise;
	});
}
function item(text = "/chosen ", cursor = text.length, label = "Synthetic choice"): Item {
	return { value: "synthetic-value-not-the-replacement", label, description: "Synthetic callback result", text, cursor };
}
async function screenshot(page: Page, name: string): Promise<void> {
	const directory = process.env.GJC_DESKTOP_VISUAL_DIR;
	if (directory) await Bun.write(`${directory}/composer-autocomplete-${name}.png`, await page.screenshot({ fullPage: true }));
}

async function selected(page: Page, index: number): Promise<void> {
	await page.waitForFunction(index => {
		const options = [...document.querySelectorAll(".composer-completions [role=option]")];
		const active = options[index];
		return active?.getAttribute("aria-selected") === "true" &&
			document.querySelector(".composer textarea")?.getAttribute("aria-activedescendant") === active.id;
	}, {}, index);
	expect(await page.$$eval(`${option}[aria-selected=true]`, elements => elements.length)).toBe(1);
}
async function boundedMenu(page: Page): Promise<{ scrollTop: number; fontSize: number }> {
	const metrics = await page.$eval(menu, element => {
		const bounds = element.getBoundingClientRect();
		const anchor = document.querySelector(".composer")!.getBoundingClientRect();
		const options = [...element.querySelectorAll<HTMLElement>("[role=option]")];
		const scroller = [element, ...element.querySelectorAll("[role=listbox]")].find(candidate =>
			candidate.scrollHeight > candidate.clientHeight && /auto|scroll/.test(getComputedStyle(candidate).overflowY));
		const active = element.querySelector<HTMLElement>('[aria-selected="true"]')!;
		const activeBounds = active.getBoundingClientRect();
		const scrollBounds = scroller?.getBoundingClientRect();
		return {
			portal: element.parentElement === document.body,
			above: bounds.bottom <= anchor.top + 1,
			left: bounds.left, right: bounds.right, top: bounds.top,
			height: bounds.height, viewportWidth: innerWidth,
			internalScroll: !!scroller, scrollTop: scroller?.scrollTop ?? 0,
			activeVisible: !!scrollBounds && activeBounds.top >= scrollBounds.top - 1 && activeBounds.bottom <= scrollBounds.bottom + 1,
			count: options.length, fontSize: parseFloat(getComputedStyle(active).fontSize),
		};
	});
	expect(metrics.portal).toBe(true);
	expect(metrics.above).toBe(true);
	expect(metrics.left).toBeGreaterThanOrEqual(0);
	expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
	expect(metrics.top).toBeGreaterThanOrEqual(0);
	expect(metrics.height).toBeLessThanOrEqual(242);
	expect(metrics.internalScroll).toBe(true);
	expect(metrics.activeVisible).toBe(true);
	expect(metrics.count).toBe(48);
	return { scrollTop: metrics.scrollTop, fontSize: metrics.fontSize };
}

describe("mounted Composer with explicitly synthetic async autocomplete", () => {
	test("slash stays in the draft; clicking an option applies the exact whole text and caret without sending", async () => {
		const { context, page } = await fixture();
		try {
			await page.focus(input);
			await page.keyboard.type("/");
			expect(await request(page, 0)).toEqual({ owner: "synthetic-owner-one", text: "/", cursor: 1 });
			expect(await page.$("dialog")).toBeNull();
			expect((await snapshot(page)).value).toBe("/");
			expect(await page.$eval('.composer', element => {
				const style = getComputedStyle(element);
				return { width: style.outlineWidth, style: style.outlineStyle, selector: element.matches(':has(textarea:focus-visible)') };
			})).toMatchObject({ width: '2px', style: 'solid', selector: true });
			await choices(page, 0, [item("server whole replacement\nuntouched tail", 7)]);
			expect(await page.$eval(menu, element => element.parentElement === document.body)).toBe(true);
			expect(await page.$eval(`${menu} [role=listbox]`, element => !!element.getAttribute("aria-label"))).toBe(true);
			expect(await page.$eval(input, element => element.getAttribute("aria-controls"))).toBe(await page.$eval(`${menu} [role=listbox]`, element => element.id));
			expect(await page.$eval(option, element => element.textContent)).toContain("Synthetic callback result");
			await page.click(option);
			await absent(page);
			expect(await snapshot(page)).toEqual({ value: "server whole replacement\nuntouched tail", start: 7, end: 7, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	for (const key of ["Enter", "Tab"] as const) {
		test(`${key} accepts a visible completion; normal Enter subsequently sends the draft`, async () => {
			const { context, page } = await fixture();
			try {
				await draft(page, "/sy");
				await choices(page, 0, [item("accepted draft", 8)]);
				await page.keyboard.press(key);
				await absent(page);
				expect(await snapshot(page)).toEqual({ value: "accepted draft", start: 8, end: 8, focused: true });
				expect(await sends(page)).toEqual([]);
				await page.keyboard.press("Enter");
				expect(await sends(page)).toEqual(["accepted draft"]);
			} finally { await closeComponentFixture(context, page); }
		});
	}

	test("rapid edits are debounced into one query for the current draft and caret", async () => {
		const { context, page } = await fixture();
		try {
			await page.focus(input);
			await page.keyboard.type("/synthetic");
			expect(await request(page, 0)).toEqual({ owner: "synthetic-owner-one", text: "/synthetic", cursor: 10 });
			await Bun.sleep(200);
			expect(await calls(page)).toHaveLength(1);
			await choices(page, 0, [item("debounced result", 5)]);
			await page.keyboard.press("Tab");
			expect(await snapshot(page)).toEqual({ value: "debounced result", start: 5, end: 5, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("a caret-only replacement keeps the same draft and restores its supplied position", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/same");
			await choices(page, 0, [item("/same", 0)]);
			await page.keyboard.press("Tab");
			await absent(page);
			expect(await snapshot(page)).toEqual({ value: "/same", start: 0, end: 0, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	for (const example of [
		{ name: "suffix after a mid-draft command", text: "/fi keep suffix", cursor: 3, replacement: "/finished keep suffix", caret: 9 },
		{ name: "multiline prefix and suffix", text: "first line\n/fi keep\nlast line", cursor: 14, replacement: "first line\n/finished keep\nlast line", caret: 20 },
		{ name: "quoted file tokens containing spaces", text: 'inspect @"docs/my fi suffix\nkeep', cursor: 20, replacement: 'inspect @"docs/my file.txt" suffix\nkeep', caret: 26 },
	]) {
		test(`preserves ${example.name} via the supplied whole-draft replacement`, async () => {
			const { context, page } = await fixture();
			try {
				await draft(page, example.text, example.cursor);
				expect(await request(page, 0)).toEqual({ owner: "synthetic-owner-one", text: example.text, cursor: example.cursor });
				await choices(page, 0, [item(example.replacement, example.caret)]);
				await page.keyboard.press("Enter");
				await absent(page);
				expect(await snapshot(page)).toEqual({ value: example.replacement, start: example.caret, end: example.caret, focused: true });
				expect(await sends(page)).toEqual([]);
			} finally { await closeComponentFixture(context, page); }
		});
	}

	test("Escape dismisses through focus and caret changes until an actual edit", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/file");
			await choices(page, 0, [item()]);
			await page.evaluate(() => window.addEventListener('keydown', event => {
				if (event.key === 'Escape') document.body.dataset.outerEscape = 'received';
			}));
			await page.keyboard.press("Escape");
			await absent(page);
			expect(await page.evaluate(() => document.body.dataset.outerEscape)).toBeUndefined();
			await page.keyboard.press('Escape');
			expect(await page.evaluate(() => document.body.dataset.outerEscape)).toBe('received');
			await page.keyboard.press("ArrowLeft");
			await Bun.sleep(250);
			expect(await page.$(menu)).toBeNull();
			expect(await calls(page)).toHaveLength(1);
			await page.keyboard.press("ArrowRight");
			await page.click("#outside");
			await page.focus(input);
			await Bun.sleep(250);
			expect(await page.$(menu)).toBeNull();
			expect(await calls(page)).toHaveLength(1);
			await page.keyboard.type("s");
			expect((await request(page, 1)).text).toBe("/files");
			await choices(page, 1, [item()]);
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("late responses cannot replace newer query results or cross an owner change", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/a");
			await request(page, 0);
			await page.keyboard.type("b");
			expect((await request(page, 1)).text).toBe("/ab");
			await choices(page, 1, [item("new query draft", 3, "New query")]);
			await resolve(page, 0, [item("stale query draft", 1, "Stale query")]);
			await settle(page);
			expect(await page.$eval(option, element => element.textContent)).toContain("New query");
			expect((await snapshot(page)).value).toBe("/ab");
			await page.keyboard.type("c");
			await request(page, 2);
			await set(page, "owner", "synthetic-owner-two");
			await absent(page);
			expect(await request(page, 3)).toEqual({ owner: "synthetic-owner-two", text: "/abc", cursor: 4 });
			await resolve(page, 2, [item("old owner draft", 1, "Old owner")]);
			await settle(page);
			expect(await page.$(option)).toBeNull();
			await choices(page, 3, [item("current owner draft", 6, "Current owner")]);
			await page.keyboard.press("Tab");
			expect(await snapshot(page)).toEqual({ value: "current owner draft", start: 6, end: 6, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("a noncollapsed selection hides options and cannot accept or query until edited", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/fi suffix", 3);
			await choices(page, 0, [item("must not apply", 0)]);
			await selection(page, 1, 3);
			await absent(page);
			await Bun.sleep(250);
			expect(await calls(page)).toHaveLength(1);
			expect(await snapshot(page)).toEqual({ value: "/fi suffix", start: 1, end: 3, focused: true });
			await page.keyboard.press("Tab");
			expect((await snapshot(page)).value).toBe("/fi suffix");
			expect(await sends(page)).toEqual([]);
			await selection(page, 1, 3);
			await page.keyboard.type("le");
			expect((await request(page, 1)).text).toBe("/le suffix");
			await choices(page, 1, [item("selected edit preserved suffix", 13)]);
			await page.keyboard.press("Tab");
			expect(await snapshot(page)).toEqual({ value: "selected edit preserved suffix", start: 13, end: 13, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("modified keys and IME do not navigate, accept, or send", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/ime");
			await choices(page, 0, [item(), item("other draft", 2, "Other")]);
			const prevented = await page.$eval(input, element => {
				const results: boolean[] = [];
				for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
					const keys = modifier === "shiftKey" ? ["Enter", "Tab", "ArrowDown", "ArrowUp"] : ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"];
					for (const key of keys) {
						const event = new KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true });
						element.dispatchEvent(event);
						results.push(event.defaultPrevented);
					}
				}
				return results;
			});
			expect(prevented.every(value => !value)).toBe(true);
			await selected(page, 0);
			expect((await snapshot(page)).value).toBe("/ime");
			await page.$eval(input, element => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
			await absent(page);
			await page.$eval(input, element => {
				for (const key of ["Enter", "Tab", "ArrowDown"]) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, isComposing: true }));
			});
			await Bun.sleep(250);
			expect(await calls(page)).toHaveLength(1);
			expect(await sends(page)).toEqual([]);
			await page.$eval(input, element => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
			await choices(page, 1, [item()]);
			await page.$eval(input, element => {
				element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
				element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 }));
			});
			expect((await snapshot(page)).value).toBe("/ime");
			expect(await sends(page)).toEqual([]);
			await page.keyboard.down("Shift");
			try { await page.keyboard.press("Enter"); } finally { await page.keyboard.up("Shift"); }
			expect((await snapshot(page)).value).toBe("/ime\n");
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("ordinary prose, email, and embedded tokens never call the source; real file tokens do", async () => {
		const { context, page } = await fixture();
		try {
			for (const text of ["ordinary prose", "email person@example.com", "https://example.com/path", "prefix/command", "word@file"]) {
				await draft(page, text);
				await Bun.sleep(200);
				expect(await page.$(menu)).toBeNull();
				expect(await calls(page)).toHaveLength(0);
			}
			await draft(page, "inspect @src/");
			expect((await request(page, 0)).text).toBe("inspect @src/");
			await choices(page, 0, [item("inspect @src/entry.ts ", 22)]);
			await page.keyboard.press("Tab");
			expect((await snapshot(page)).value).toBe("inspect @src/entry.ts ");
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("loading, empty, error, and explicit unavailable responses preserve the draft and remain non-options", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/state");
			await request(page, 0);
			await page.waitForSelector(`${menu} [role=status]`);
			const loading = await page.$eval(`${menu} [role=status]`, element => element.textContent?.trim());
			expect(loading).toBeTruthy();
			await screenshot(page, "loading");
			expect(await page.$(option)).toBeNull();
			await resolve(page, 0, []);
			await page.waitForFunction(loading => document.querySelector(".composer-completions [role=status]")?.textContent?.trim() !== loading, {}, loading);
			const empty = await page.$eval(`${menu} [role=status]`, element => element.textContent?.trim());
			expect(empty).toBeTruthy();
			await screenshot(page, "empty");
			expect(await snapshot(page)).toEqual({ value: "/state", start: 6, end: 6, focused: true });
			await page.keyboard.type("e");
			await request(page, 1);
			await page.evaluate(() => (window as unknown as FixtureWindow).syntheticCompletion.reject(1));
			await page.waitForFunction(({ loading, empty }) => {
				const status = document.querySelector(".composer-completions [role=status]")?.textContent?.trim();
				return !!status && status !== loading && status !== empty;
			}, {}, { loading, empty });
			expect(await page.$(option)).toBeNull();
			expect((await snapshot(page)).value).toBe("/statee");
			await screenshot(page, "error");
			await page.keyboard.type("u");
			await request(page, 2);
			await resolve(page, 2, [], "Synthetic provider unavailable");
			await page.waitForFunction(() => document.querySelector(".composer-completions [role=status]")?.textContent === "Synthetic provider unavailable");
			await screenshot(page, "unavailable");
			expect(await page.$(option)).toBeNull();
			expect(await sends(page)).toEqual([]);
			await page.keyboard.press("Enter");
			expect(await sends(page)).toEqual(["/stateeu"]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("blur hides pending results, focus restores querying, and click acceptance retains input focus", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/focus");
			await request(page, 0);
			await page.click("#outside");
			await absent(page);
			await resolve(page, 0, [item("late blurred result", 1)]);
			await settle(page);
			expect(await page.$(menu)).toBeNull();
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("outside");
			expect((await snapshot(page)).value).toBe("/focus");
			await page.focus(input);
			await choices(page, 1, [item("focused result", 4)]);
			await page.click(option);
			expect(await snapshot(page)).toEqual({ value: "focused result", start: 4, end: 4, focused: true });
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("disabled input and missing source discard pending results; send-disabled still allows safe completion", async () => {
		const { context, page } = await fixture();
		try {
			await draft(page, "/disabled");
			await request(page, 0);
			await set(page, "disabled", true);
			await absent(page);
			expect(await page.$eval(input, element => (element as HTMLTextAreaElement).disabled)).toBe(true);
			expect(await page.$eval(".composer-action", element => (element as HTMLButtonElement).disabled)).toBe(true);
			await resolve(page, 0, [item("disabled stale result", 1)]);
			await settle(page);
			expect(await page.$(menu)).toBeNull();
			expect((await snapshot(page)).value).toBe("/disabled");
			expect(await sends(page)).toEqual([]);
			await set(page, "disabled", false);
			await page.focus(input);
			await request(page, 1);
			await set(page, "available", false);
			await absent(page);
			await resolve(page, 1, [item("unavailable stale result", 1)]);
			await settle(page);
			expect(await page.$(menu)).toBeNull();
			expect(await page.$eval(input, element => element.getAttribute("aria-autocomplete"))).toBeNull();
			await page.keyboard.type("x");
			await Bun.sleep(250);
			expect(await calls(page)).toHaveLength(2);
			await set(page, "sendDisabled", true);
			await set(page, "available", true);
			await choices(page, 2, [item("safe replacement", 4)]);
			await page.keyboard.press("Enter");
			expect(await snapshot(page)).toEqual({ value: "safe replacement", start: 4, end: 4, focused: true });
			await page.keyboard.press("Enter");
			await page.click(".composer-action");
			expect(await sends(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});

	for (const theme of ["red-claw", "blue-crab"]) {
		test(`${theme}: keyboard selection wraps and scrolls a bounded above-input portal at normal and enlarged narrow sizes`, async () => {
			const { context, page } = await fixture();
			try {
				await page.evaluate(theme => (window as unknown as FixtureWindow).syntheticCompletion.theme(theme), theme);
				await draft(page, "/many");
				const items = Array.from({ length: 48 }, (_, index) => item(`choice ${index}`, 3, index === 0 ? "한국어와 TypeScript를 함께 검토하는 자동완성 예시" : `Synthetic option ${String(index).padStart(2, "0")}`));
				await choices(page, 0, items);
				await selected(page, 0);
				await settle(page);
				const top = await boundedMenu(page);
				expect(top.scrollTop).toBe(0);
				await screenshot(page, `${theme}-above-input-top`);
				await page.keyboard.press("ArrowUp");
				await selected(page, 47);
				await settle(page);
				expect((await boundedMenu(page)).scrollTop).toBeGreaterThan(0);
				await page.keyboard.press("ArrowDown");
				await selected(page, 0);
				for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowDown");
				await selected(page, 24);
				await settle(page);
				const middle = await boundedMenu(page);
				expect(middle.scrollTop).toBeGreaterThan(top.scrollTop);
				await screenshot(page, `${theme}-middle-scroll`);
				for (let i = 24; i < 47; i++) await page.keyboard.press("ArrowDown");
				await selected(page, 47);
				await settle(page);
				expect((await boundedMenu(page)).scrollTop).toBeGreaterThan(middle.scrollTop);
				await screenshot(page, `${theme}-bottom-scroll`);
				await page.setViewport({ width: 390, height: 844 });
				await settle(page);
				await boundedMenu(page);
				await screenshot(page, `${theme}-narrow`);
				await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
				await settle(page);
				const enlarged = await boundedMenu(page);
				expect(enlarged.fontSize).toBeGreaterThan(top.fontSize);
				await screenshot(page, `${theme}-narrow-enlarged`);
				expect((await snapshot(page)).focused).toBe(true);
				expect((await snapshot(page)).value).toBe("/many");
				expect(await sends(page)).toEqual([]);
				await page.keyboard.press("Tab");
				expect(await snapshot(page)).toEqual({ value: "choice 47", start: 3, end: 3, focused: true });
				expect(await sends(page)).toEqual([]);
			} finally { await closeComponentFixture(context, page); }
		}, 15000);
	}
});
