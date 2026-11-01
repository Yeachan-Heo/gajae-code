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
	setProfiles(value: Profile[]): void;
	setRefreshing(value: boolean): void;
	setBusy(value: boolean): void;
	setApplying(value: boolean): void;
	calls(): [string, string | null][];
}
interface Profile {
	id: string;
	name: string;
	description: string | null;
	group: string | null;
	groupRank: number | null;
	available: boolean;
	source: "builtin" | "configured";
	active: boolean;
	default: boolean;
	roles: { id: string; model: string | null }[];
	capabilities: { selectSession: { available: boolean; reason: string | null }; persistDefault: { available: boolean; reason: string | null } };
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
			const [profiles, setProfiles] = useState([]);
			const [pending, setPending] = useState(false);
			const [disabled, setDisabled] = useState(false);
			const [refreshing, setRefreshing] = useState(false);
			const [busy, setBusy] = useState(false);
			const [applying, setApplying] = useState(false);
			window.pickerTest = { setSelected, setRoles, setProfiles, setRefreshing, setBusy, setApplying, setPending, setDisabled, calls: () => calls };
			return h(ModelPicker, {
				models, selectedId, roles, profiles, pending, disabled, refreshing, busy, applying,
				onSelect: id => calls.push(['legacy', id]),
				onAssign: (role, id) => calls.push([role, id]),
				onApplyProfile: profileId => calls.push(['profile', profileId]),
				onRefresh: () => calls.push(['refresh', null]),
			});
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
async function setProfiles(page: Page, profiles: Profile[]): Promise<void> {
	await page.evaluate(value => (window as unknown as { pickerTest: Control }).pickerTest.setProfiles(value), profiles);
}
async function setApplying(page: Page, value: boolean): Promise<void> {
	await page.evaluate(next => (window as unknown as { pickerTest: Control }).pickerTest.setApplying(next), value);
}
async function setBusy(page: Page, value: boolean): Promise<void> {
	await page.evaluate(next => (window as unknown as { pickerTest: Control }).pickerTest.setBusy(next), value);
}
async function setRefreshing(page: Page, value: boolean): Promise<void> {
	await page.evaluate(next => (window as unknown as { pickerTest: Control }).pickerTest.setRefreshing(next), value);
}
async function setRoles(page: Page, roles: Role[]): Promise<void> {
	await page.evaluate(value => (window as unknown as { pickerTest: Control }).pickerTest.setRoles(value), roles);
}
async function calls(page: Page): Promise<[string, string | null][]> {
	return page.evaluate(() => (window as unknown as { pickerTest: Control }).pickerTest.calls());
}
async function open(page: Page): Promise<void> { await page.click('.model-trigger'); await page.waitForSelector('.model-result-list'); }
async function choose(page: Page, id: string): Promise<void> { await page.click(`.model-option-hit[data-model-id="${id}"]`); await page.waitForSelector('.model-role-choice'); }
async function expandPresets(page: Page): Promise<void> {
	const head = await page.$(".preset-group-head");
	if (head) await head.click();
	await page.waitForSelector(".preset-roles");
}
async function rows(page: Page): Promise<string[]> { return page.$$eval('.model-option-hit', buttons => buttons.map(button => button.getAttribute('data-model-id') ?? '')); }

const profile = (id: string, name: string, roles: { id: string; model: string | null }[], overrides: Partial<Profile> = {}): Profile => ({
	id,
	name,
	description: null,
	group: null,
	groupRank: null,
	available: true,
	source: "configured",
	active: false,
	default: false,
	roles,
	capabilities: { selectSession: { available: true, reason: null }, persistDefault: { available: true, reason: null } },
	...overrides,
});

describe("mounted model picker tabs", () => {
	test("switches between preset and model tabs while keeping one query per tab", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [
				profile("focused", "Focused", [
					{ id: "default", model: "anthropic/claude-sonnet" },
					{ id: "executor", model: "anthropic/claude-haiku" },
					{ id: "planner", model: null },
				]),
				profile("review", "Review only", [{ id: "critic", model: "openai/gpt-review" }], { active: true, default: true }),
			]);
			await open(page);
			// selectedId is set, so the model tab owns the initial view.
			expect(await page.$$eval(".model-tab", tabs => tabs.map(tab => tab.getAttribute("aria-selected")))).toEqual(["false", "true"]);
			await page.type(".model-search input", "m99");
			expect(await rows(page)).toEqual(["p/m99"]);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await expandPresets(page);
			expect(await page.$eval(".model-search input", input => (input as HTMLInputElement).value)).toBe("");
			const presets = await page.$$eval(".model-option-hit", nodes => nodes.map(node => node.textContent ?? ""));
			expect(presets).toHaveLength(2);
			expect(presets[0]).toContain("Focused");
			// One line per role: its label as a tag, its selector beside it.
			expect(
				await page.$$eval(".model-result-list li:first-child .preset-role", rows =>
					rows.map(row => [
						row.querySelector(".model-role-tag")?.textContent,
						row.querySelector(".preset-role-model")?.textContent,
					]),
				),
			).toEqual([
				["Default", "anthropic/claude-sonnet"],
				["Executor", "anthropic/claude-haiku"],
			]);
			expect(presets[0]).not.toContain("Planner");
			expect(presets[1]).toContain("Active");
			expect(presets[1]).toContain("Default profile");
			await page.type(".model-search input", "review");
			expect(await page.$$eval(".model-option-hit", nodes => nodes.map(node => node.textContent ?? ""))).toHaveLength(1);
			await page.click(".model-search input", { clickCount: 3 });
			await page.type(".model-search input", "sonnet");
			expect(await page.$$eval(".model-option-hit", nodes => nodes.map(node => node.textContent ?? ""))).toHaveLength(1);
			await page.click(".model-option-hit");
			expect(await calls(page)).toEqual([["profile", "focused"]]);
			expect(await page.$("dialog")).toBeNull();
		} finally { await closeComponentFixture(context, page); }
	});

	test("refreshes through an icon-only control inside the model toolbar", async () => {
		const { context, page } = await fixture();
		try {
			await open(page);
			const label = await page.$eval(".model-refresh", button => ({
				text: (button.textContent ?? "").trim(),
				label: button.getAttribute("aria-label"),
			}));
			expect(label.text).toBe("");
			expect(label.label).toBe("Refresh the model list");
			await page.click(".model-refresh");
			expect(await calls(page)).toEqual([["refresh", null]]);
			await setRefreshing(page, true);
			await page.waitForFunction(() => (document.querySelector(".model-refresh") as HTMLButtonElement).disabled);
		} finally { await closeComponentFixture(context, page); }
	});

	test("keeps the favorite control inside the model row without selecting it", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role("default", "m5")]);
			await open(page);
			expect(await page.$(".model-option > .model-favorite")).not.toBeNull();
			expect(await page.$$eval(".model-option-hit svg.lucide-check", nodes => nodes.length)).toBe(0);
			await page.click('.model-result-row:has([data-model-id="p/m1"]) .model-favorite');
			expect(await calls(page)).toEqual([]);
			expect(await page.$(".model-role-choice")).toBeNull();
		} finally { await closeComponentFixture(context, page); }
	});

	test("orders preset providers by the terminal's group order and dims the unusable ones", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [
				profile("local", "Local", [], { group: "macOS Local (oMLX)", groupRank: 3, available: false }),
				profile("codex-b", "Codex B", [], { group: "CODEX", groupRank: 0, available: false }),
				profile("codex-a", "Codex A", [], { group: "CODEX", groupRank: 0, active: true }),
				// No declared family: the terminal calls this CUSTOM and lists it last.
				profile("mine", "Mine", [], { group: null, groupRank: null }),
			]);
			await open(page);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await page.waitForSelector(".preset-group");
			// A family with nothing selectable inside sinks below the ones that still work, even
			// though the terminal ranks it ahead of CUSTOM.
			expect(await page.$$eval(".preset-group-head", heads => heads.map(head => head.textContent?.replace(/\d+ presets?/, "").trim()))).toEqual([
				"CODEX",
				"CUSTOM",
				"macOS Local (oMLX)",
			]);
			expect(
				await page.$$eval(".preset-group", groups => groups.map(group => group.classList.contains("preset-unavailable"))),
			).toEqual([false, false, true]);
			// The family holding the current preset is marked, so it is findable while collapsed.
			expect(await page.$$eval(".preset-group", groups => groups.map(group => group.hasAttribute("data-active")))).toEqual([
				true,
				false,
				false,
			]);
			await page.click(".preset-group-head");
			await page.waitForSelector(".preset-group .model-result-list");
			// Inside a family the registered profiles lead, with favorites first; unusable ones are
			// dimmed and refuse both the apply action and starring.
			expect(
				await page.$$eval(".preset-group:first-child .model-result-row", rows =>
					rows.map(row => ({ name: row.querySelector("strong")?.textContent, dimmed: row.classList.contains("preset-unavailable") })),
				),
			).toEqual([
				{ name: "Codex A", dimmed: false },
				{ name: "Codex B", dimmed: true },
			]);
			expect(
				await page.evaluate(() => {
					const row = document.querySelectorAll(".preset-group:first-child .model-result-row")[1];
					return {
						apply: (row?.querySelector(".model-option-hit") as HTMLButtonElement | null)?.disabled,
						star: (row?.querySelector(".model-favorite") as HTMLButtonElement | null)?.disabled,
						text: row?.textContent ?? "",
					};
				}),
			).toEqual({ apply: true, star: true, text: "Codex B" });
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("a family is only dimmed when none of its presets can be selected", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [
				// Terminal order A, B, C, D; B and D have no usable provider anywhere inside them.
				profile("a-live", "A live", [], { group: "ALPHA", groupRank: 0 }),
				profile("a-dead", "A dead", [], { group: "ALPHA", groupRank: 0, available: false }),
				profile("b-dead", "B dead", [], { group: "BRAVO", groupRank: 1, available: false }),
				profile("c-live", "C live", [], { group: "CHARLIE", groupRank: 2 }),
				profile("d-dead", "D dead", [], { group: "DELTA", groupRank: 3, available: false }),
			]);
			await open(page);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await page.waitForSelector(".preset-group");
			expect(
				await page.$$eval(".preset-group", groups =>
					groups.map(group => ({
						name: group.querySelector("strong")?.textContent,
						dimmed: group.classList.contains("preset-unavailable"),
					})),
				),
			).toEqual([
				{ name: "ALPHA", dimmed: false },
				{ name: "CHARLIE", dimmed: false },
				{ name: "BRAVO", dimmed: true },
				{ name: "DELTA", dimmed: true },
			]);
			// One usable preset keeps its whole family bright, and the unusable member inside it
			// still dims on its own row.
			await page.click(".preset-group-head");
			await page.waitForSelector(".preset-group .model-result-row");
			expect(
				await page.$$eval(".preset-group:first-child .model-result-row", rows =>
					rows.map(row => ({ name: row.querySelector("strong")?.textContent, dimmed: row.classList.contains("preset-unavailable") })),
				),
			).toEqual([
				{ name: "A live", dimmed: false },
				{ name: "A dead", dimmed: true },
			]);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("a preset states each role as a tag and right-aligns its model selector", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [
				profile("focused", "Focused", [
					{ id: "default", model: "openai-codex/gpt-6-astra:medium" },
					{ id: "executor", model: "openai-codex/gpt-6-astra:low" },
					{ id: "planner", model: null },
				]),
			]);
			await open(page);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await page.waitForSelector(".preset-group-head");
			await page.click(".preset-group-head");
			await page.waitForSelector(".preset-role");
			expect(
				await page.$$eval(".preset-role", rows =>
					rows.map(row => ({
						tag: row.querySelector(".model-role-tag")?.textContent,
						model: row.querySelector(".preset-role-model")?.textContent,
					})),
				),
			).toEqual([
				{ tag: "Default", model: "openai-codex/gpt-6-astra:medium" },
				{ tag: "Executor", model: "openai-codex/gpt-6-astra:low" },
			]);
			// The old line prefixed every role with a middle dot; the tag replaces it entirely.
			expect(await page.$eval(".preset-roles", node => node.textContent)).not.toContain("·");
			// A column of presets is scanned down the right edge, so every selector ends together.
			const geometry = await page.$$eval(".preset-role", rows =>
				rows.map(row => {
					const rowBox = row.getBoundingClientRect();
					const tag = row.querySelector(".model-role-tag")!.getBoundingClientRect();
					const model = row.querySelector(".preset-role-model")!.getBoundingClientRect();
					return {
						rowRight: Math.round(rowBox.right),
						modelRight: Math.round(model.right),
						tagLeft: Math.round(tag.left) - Math.round(rowBox.left),
						modelStartsAfterTag: model.left >= tag.right,
					};
				}),
			);
			expect(geometry.every(item => Math.abs(item.modelRight - item.rowRight) <= 1)).toBe(true);
			expect(geometry.every(item => item.modelStartsAfterTag)).toBe(true);
			expect(geometry.map(item => item.tagLeft)).toEqual([0, 0]);
		} finally { await closeComponentFixture(context, page); }
	}, 30000);

	test("starring a preset lifts it to the top of its own provider family", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [
				profile("alpha", "Alpha", [], { group: "CODEX", groupRank: 0 }),
				profile("beta", "Beta", [], { group: "CODEX", groupRank: 0 }),
			]);
			await open(page);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await page.waitForSelector(".preset-group-head");
			await page.click(".preset-group-head");
			await page.waitForSelector(".preset-group .model-result-row");
			expect(
				await page.$$eval(".preset-group .model-result-row strong", nodes => nodes.map(node => node.textContent)),
			).toEqual(["Alpha", "Beta"]);
			await page.evaluate(() => {
				const row = [...document.querySelectorAll(".preset-group .model-result-row")].find(
					item => item.querySelector("strong")?.textContent === "Beta",
				);
				row?.querySelector<HTMLButtonElement>(".model-favorite")?.click();
			});
			await page.waitForFunction(
				() => document.querySelector(".preset-group .model-result-row strong")?.textContent === "Beta",
			);
			expect(
				await page.$$eval(".preset-group .model-result-row strong", nodes => nodes.map(node => node.textContent)),
			).toEqual(["Beta", "Alpha"]);
		} finally { await closeComponentFixture(context, page); }
	});
});


	test("blocks dispatch with a visible state while a selection is already applying", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role("default", "m5")]);
			await open(page);
			await setApplying(page, true);
			await page.waitForFunction(() => document.body.textContent?.includes("Applying the selected settings"));
			await choose(page, "p/m1");
			expect(
				await page.$$eval(".model-role-option", nodes => nodes.map(node => (node as HTMLButtonElement).disabled)),
			).toEqual([true, true, true, true, true]);
			expect(await calls(page)).toEqual([]);
			await setApplying(page, false);
			await page.waitForFunction(() => !document.body.textContent?.includes("Applying the selected settings"));
		} finally { await closeComponentFixture(context, page); }
	});

describe("mounted model picker busy state", () => {
	test("keeps the dialog open across loading and leaves every dispatch available during a run", async () => {
		const { context, page } = await fixture();
		try {
			await setProfiles(page, [profile("focused", "Focused", [{ id: "default", model: "p/m1" }])]);
			await setRoles(page, [role("default", "m5"), role("executor", "m8")]);
			await open(page);
			// Refreshing the catalog must not unmount the dialog.
			await setRefreshing(page, true);
			await Bun.sleep(150);
			expect(await page.$("dialog")).not.toBeNull();
			await setRefreshing(page, false);
			// A running conversation keeps every dispatch available: the caller defers the
			// request instead of the picker refusing it, and nothing explains that in prose.
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][0]!.click());
			await expandPresets(page);
			const presetDisabledIdle = await page.$$eval("#picker-fixture .model-option-hit, dialog .model-option-hit", nodes =>
				nodes.map(node => (node as HTMLButtonElement).disabled),
			);
			await setBusy(page, true);
			expect(await page.$(".model-busy-reason")).toBeNull();
			// The run changes nothing about which actions are offered; only availability does.
			expect(
				await page.$$eval("#picker-fixture .model-option-hit, dialog .model-option-hit", nodes =>
					nodes.map(node => (node as HTMLButtonElement).disabled),
				),
			).toEqual(presetDisabledIdle);
			await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".model-tab")][1]!.click());
			await choose(page, "p/m8");
			const rolesIdle = await page.$$eval(".model-role-option", nodes =>
				nodes.map(node => (node as HTMLButtonElement).disabled),
			);
			await setBusy(page, false);
			expect(
				await page.$$eval(".model-role-option", nodes => nodes.map(node => (node as HTMLButtonElement).disabled)),
			).toEqual(rolesIdle);
			await page.click(".model-role-option");
			expect(await calls(page)).toEqual([["default", "p/m8"]]);
		} finally { await closeComponentFixture(context, page); }
	});
});

describe("mounted model picker", () => {
	test("renders and searches the full catalog; selection requires an explicit role", async () => {
		const { context, page } = await fixture();
		try {
			await setRoles(page, [role('default', 'm5')]); await open(page);
			expect((await rows(page)).length).toBe(100);
			expect(await page.$eval('dialog', element => element.textContent?.includes('Show more models'))).toBe(false);
			await page.type('.model-search input', 'm99');
			expect(await rows(page)).toEqual(['p/m99']);
			await choose(page, 'p/m99'); expect(await calls(page)).toEqual([]);
			expect(await page.$$eval('.model-role-option', buttons => buttons.map(button => button.textContent?.split(' · ')[0]))).toEqual(['Default', 'Executor', 'Planner', 'Critic', 'Architect']);
			await page.click('.model-role-option');
			expect(await calls(page)).toEqual([['default', 'p/m99']]);
		} finally { await closeComponentFixture(context, page); }
	});

	test("puts the model in use first, then favorites, then the other role assignments", async () => {
		const { context, page } = await fixture(JSON.stringify(['p/m2']));
		try {
			await setRoles(page, [role('architect', 'm8'), role('critic', 'm8', false), role('planner', 'm8'), role('executor', 'm8'), role('default', 'm5')]);
			await open(page);
			// p/m5 is the model in use; p/m2 is starred; p/m8 carries every role; the rest keep
			// catalog order.
			expect((await rows(page)).slice(0, 4)).toEqual(['p/m5', 'p/m2', 'p/m8', 'p/m0']);
			expect(await page.$$eval('[data-model-id="p/m8"] .model-role-tag', tags => tags.map(tag => tag.textContent))).toEqual(['Executor', 'Planner', 'Critic', 'Architect']);
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
			expect(await page.$('.model-option-hit[data-model-id="p/missing"]')).toBeNull();
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
			expect(await page.$eval('[data-model-id="p/m8"] .model-role-tag', element => element.textContent)).toBe('Planner');
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
			// Neither a background mutation (pending) nor a disabled trigger may tear down
			// a dialog the user is using: only dismissal, an applied selection, or an
			// owner change closes it.
			await invoke(page, 'setPending', true);
			await Bun.sleep(150);
			expect(await page.$('.model-role-choice')).not.toBeNull();
			await invoke(page, 'setPending', false);
			await invoke(page, 'setDisabled', true);
			await Bun.sleep(150);
			expect(await page.$('.model-role-choice')).not.toBeNull();
			await invoke(page, 'setDisabled', false);
			await page.evaluate(() => (window as unknown as { pickerTest: Control }).pickerTest.setSelected('p/m2'));
			await page.waitForSelector('dialog', { hidden: true });
			expect(await calls(page)).toEqual([]);
		} finally { await closeComponentFixture(context, page); }
	});
});
