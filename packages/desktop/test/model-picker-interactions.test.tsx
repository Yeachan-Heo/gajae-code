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
afterAll(async () => { await browser?.close(); if (server) { server.kill(); await server.exited; } });

interface Control {
	setPending(value: boolean): void;
	setDisabled(value: boolean): void;
	setSelected(value: string): void;
	setRoles(value: Role[]): void;
	calls(): [string, string | null][];
}
interface Role {
	id: string;
	name: string;
	configured: boolean;
	model: { provider: string; id: string; name: string } | null;
	thinkingLevel: null;
	configurationResolution: { origin: string; layers: string[] };
	canApply: { available: boolean; reason: string | null };
	canClear?: { available: boolean; reason: string | null };
}
const role = (id: string, model: string | null, configured = true, available = true): Role => ({
	id, name: id, configured, model: model ? { provider: "p", id: model, name: model } : null,
	thinkingLevel: null, configurationResolution: { origin: "global", layers: ["global"] },
	canApply: { available, reason: available ? null : "Not supported" }, canClear: { available: configured && id !== "default", reason: null },
});

async function mountFixture(page: Page, content: string, rootId: string, requireControl: boolean): Promise<void> {
	await componentReady(page, async () => {
			await page.addScriptTag({ type: "module", content: "import '/src/styles.css';\n" + content });
			await page.waitForFunction(({ rootId, requireControl }) =>
				!!document.querySelector(`#${rootId} .model-trigger`) &&
				(!requireControl || !!(window as unknown as { pickerTest?: Control }).pickerTest),
				{}, { rootId, requireControl });
	});
}

async function fixture(storage?: string, failStorage = false): Promise<{ context: BrowserContext; page: Page }> {
	const { context, page } = await componentFixture(browser, origin);
	try {
	if (storage !== undefined) await page.evaluate(value => localStorage.setItem("gjc.desktop.model-favorites", value), storage);
	if (failStorage) await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("denied"); }; });
	await mountFixture(page, `
		import React from '/node_modules/.vite/deps/react.js';
		const { useState } = React;
		import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
		const { createRoot } = ReactDOM;
		import { ModelPicker } from '/src/ModelPicker.tsx';
		const h = React.createElement;
		const models = Array.from({ length: 100 }, (_, i) => ({ id: 'p/m' + i, provider: 'p', name: 'Model ' + i, contextWindow: 1000, reasoning: false, thinking: { options: [] } }));
		const calls = [];
		function Fixture() {
			const [selectedId, setSelected] = useState('p/m5');
			const [roles, setRoles] = useState([]);
			const [pending, setPending] = useState(false);
			const [disabled, setDisabled] = useState(false);
			window.pickerTest = { setSelected, setRoles, setPending, setDisabled, calls: () => calls };
			return h(ModelPicker, { models, selectedId, roles, pending, disabled, onSelect: id => calls.push(['legacy', id]), onAssign: (role, id) => calls.push([role, id]) });
		}
		const root = document.createElement('div'); root.id = 'picker-fixture'; document.body.replaceChildren(root); createRoot(root).render(h(Fixture));
	`, 'picker-fixture', true);
	return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}
async function invoke(page: Page, method: "setPending" | "setDisabled", value: boolean): Promise<void> {
	await page.evaluate(({ method, value }) => (window as unknown as { pickerTest: Control }).pickerTest[method](value), { method, value });
}
async function setRoles(page: Page, roles: Role[]): Promise<void> {
	await page.evaluate(value => (window as unknown as { pickerTest: Control }).pickerTest.setRoles(value), roles);
}
async function calls(page: Page): Promise<[string, string | null][]> {
	return page.evaluate(() => (window as unknown as { pickerTest: Control }).pickerTest.calls());
}
async function open(page: Page): Promise<void> { await page.click('.model-trigger'); await page.waitForSelector('.model-result-list'); }
async function choose(page: Page, id: string): Promise<void> { await page.click(`.model-option[data-model-id="${id}"]`); await page.waitForSelector('.model-role-choice'); }
async function rows(page: Page): Promise<string[]> { return page.$$eval('.model-option', buttons => buttons.map(button => button.getAttribute('data-model-id') ?? '')); }

describe("mounted model picker", () => {
	test("renders and searches the full catalog; selection requires an explicit role", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role('default', 'm5')]); await open(page);
			expect((await rows(page)).length).toBe(100);
			expect(await page.$eval('dialog', element => element.textContent?.includes('모델 더 보기'))).toBe(false);
			await page.type('.model-search input', 'm99');
			expect(await rows(page)).toEqual(['p/m99']);
			await choose(page, 'p/m99'); expect(await calls(page)).toEqual([]);
			expect(await page.$$eval('.model-role-option', buttons => buttons.map(button => button.textContent?.split(' · ')[0]))).toEqual(['Default', 'Executor', 'Planner', 'Critic', 'Architect']);
			await page.click('.model-role-option');
			expect(await calls(page)).toEqual([['default', 'p/m99']]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("orders all role tags before favorites, and clearing restores catalog position after refresh", async () => {
		const { context, page } = await fixture(JSON.stringify(['p/m2']));
		try {
			await setRoles(page, [role('architect', 'm8'), role('critic', 'm8', false), role('planner', 'm8'), role('executor', 'm8'), role('default', 'm5')]);
			await open(page);
			expect((await rows(page)).slice(0, 4)).toEqual(['p/m5', 'p/m8', 'p/m2', 'p/m0']);
			expect(await page.$$eval('[data-model-id="p/m8"] .model-role-tag', tags => tags.map(tag => tag.textContent))).toEqual(['Executor', 'Planner', 'Critic · 상속', 'Architect']);
			await choose(page, 'p/m8');
			await page.click('.model-role-clear');
			expect(await calls(page)).toEqual([['executor', null]]);
			await setRoles(page, [role('default', 'm5')]); await open(page);
			expect((await rows(page)).slice(0, 5)).toEqual(['p/m5', 'p/m2', 'p/m0', 'p/m1', 'p/m3']);
			expect((await rows(page)).indexOf('p/m8')).toBe(8);
		} finally { await closeComponentFixture(context, page); }
	});

	test("favorites persist deduplicated with unavailable IDs; stars never select a model", async () => {
		const { context, page } = await fixture(JSON.stringify(['p/m4', 'p/m4', 'other/unavailable']));
		try {
			await open(page);
			await page.click('.model-result-row:has([data-model-id="p/m3"]) .model-favorite');
			expect(await calls(page)).toEqual([]);
			expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gjc.desktop.model-favorites') ?? 'null'))).toEqual(['p/m4', 'other/unavailable', 'p/m3']);
			await page.reload();
			await mountFixture(page, `
				import React from '/node_modules/.vite/deps/react.js';
				import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
		const { createRoot } = ReactDOM;
				import { ModelPicker } from '/src/ModelPicker.tsx';
				const models = [3, 4, 5].map(i => ({ id: 'p/m' + i, provider: 'p', name: 'Model ' + i, contextWindow: 1000, reasoning: false, thinking: { options: [] } }));
				const root = document.createElement('div'); root.id = 'picker-reload-fixture'; document.body.replaceChildren(root);
				createRoot(root).render(React.createElement(ModelPicker, { models, onSelect: () => {} }));
			`, 'picker-reload-fixture', false);
			await open(page);
			expect((await rows(page)).slice(0, 2)).toEqual(['p/m3', 'p/m4']);
			expect(await page.$$eval('.model-favorite[aria-pressed="true"]', buttons => buttons.length)).toBe(2);
			expect(await page.evaluate(() => localStorage.getItem('gjc.desktop.model-favorites'))).toContain('other/unavailable');
		} finally { await closeComponentFixture(context, page); }
	});

	test("clears an owned role when its model is absent from the available catalog", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role('default', 'm5'), role('executor', 'missing')]);
			await open(page);
			expect(await page.$('.model-option[data-model-id="p/missing"]')).toBeNull();
			await page.click('.model-role-unavailable-clear');
			expect(await calls(page)).toEqual([['executor', null]]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("labels configured shared roles as inherited when no session choice is owned", async () => {
		const { context, page } = await fixture();
		try {
			const inherited = role('planner', 'm8');
			inherited.canClear = { available: false, reason: 'Inherited configuration' };
			await setRoles(page, [role('default', 'm5'), inherited]);
			await open(page);
			expect(await page.$eval('[data-model-id="p/m8"] .model-role-tag', element => element.textContent)).toBe('Planner · 상속');
		} finally { await closeComponentFixture(context, page); }
	});

	test("malformed stored favorites are reported and do not block selection", async () => {
		const { context, page } = await fixture('{bad json');
		try {
			await setRoles(page, [role('default', 'm5')]); await open(page);
			expect(await page.$('.model-favorites-error')).not.toBeNull();
			await choose(page, 'p/m0'); await page.click('.model-role-option');
			expect(await calls(page)).toEqual([['default', 'p/m0']]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("storage failure is visible without preventing assignment", async () => {
		const { context, page } = await fixture(undefined, true);
		try {
			await setRoles(page, [role('default', 'm5')]); await open(page);
			await page.click('.model-favorite');
			expect(await page.$eval('.model-favorites-error', element => element.getAttribute('role'))).toBe('alert');
			await choose(page, 'p/m0'); await page.click('.model-role-option');
			expect(await calls(page)).toEqual([['default', 'p/m0']]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("unsupported roles cannot mutate and stale or pending owners dismiss the choice", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role('default', 'm5', true, false), role('executor', 'm1', true, false)]); await open(page); await choose(page, 'p/m1');
			expect(await page.$$eval('.model-role-option', buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true);
			expect(await page.$eval('.model-role-reason', element => element.textContent)).toBe('Not supported');
			await page.click('.model-role-back');
			expect(await page.evaluate(() => document.activeElement?.getAttribute('data-model-id'))).toBe('p/m1');
			await choose(page, 'p/m1');
			await invoke(page, 'setPending', true); await page.waitForSelector('dialog', { hidden: true });
			await invoke(page, 'setPending', false); await open(page); await choose(page, 'p/m1');
			await invoke(page, 'setDisabled', true); await page.waitForSelector('dialog', { hidden: true });
			await invoke(page, 'setDisabled', false); await open(page); await choose(page, 'p/m1');
			await page.evaluate(() => (window as unknown as { pickerTest: Control }).pickerTest.setSelected('p/m2'));
			await page.waitForSelector('dialog', { hidden: true });
			expect(await calls(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});
});
