// TEST ONLY: user-flow scenario QA for the real App shell.
// Drives the real React App (Vite) against the real Host sidecar and the
// zero-provider model fixture. Browser/App transport proof only: no live
// provider, native WKWebView or signed-bundle certification.
//
//   bun packages/desktop/scripts/app-flow-qa.ts [scenario...]
//
// Manual only: needs a local Chrome (GJC_QA_CHROME overrides the macOS default),
// a free port 1420, and no other Vite server on it. Scenarios share one created
// conversation and therefore run in the listed order; naming scenarios runs only
// the independent ones (boot, new-session, send-turn, abort-turn, queue-steer,
// model-picker, reasoning-level, deferred-model-change, command-search-slash,
// settings-controls, export-message, attachment, side-chat, operator-shell,
// session-info).
// Writes artifacts/app-flow-qa/receipt.json plus failure screenshots.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const root = path.resolve(import.meta.dir, "../../..");
const directory = path.resolve(root, "artifacts/app-flow-qa");
const origin = "http://127.0.0.1:1420";
const chromePath = process.env.GJC_QA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const attachmentPath = path.join(directory, "flow-attachment.txt");
const ATTACHMENT_TEXT = "flow-qa attachment line";

interface Bootstrap {
	bootstrapUrl: string;
	project: string;
	modelFixture: { artifactPath: string; models: string[] };
}
interface FixtureRequest {
	id: number;
	body: { model?: string; reasoning_effort?: string; messages?: { role: string; content: unknown }[] };
	state: "held" | "completed" | "aborted";
}
interface FixtureSnapshot {
	requests: FixtureRequest[];
}
interface StepResult {
	name: string;
	ok: boolean;
	detail?: string;
}

const only = new Set(process.argv.slice(2));
const results: StepResult[] = [];

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

await fs.mkdir(directory, { recursive: true });
await Bun.write(attachmentPath, `${ATTACHMENT_TEXT}\n`);

let vite: Bun.Subprocess | undefined;
let host: Bun.Subprocess | undefined;
let browser: Browser | undefined;
let bootstrap: Bootstrap | undefined;
let page: Page;

async function launchVite(): Promise<Bun.Subprocess> {
	// The port is a fixed global resource: a foreign server answering there would
	// otherwise serve the whole run while the owned child died behind it.
	if (await responds(origin)) throw new Error("Port 1420 is already serving; stop it before running the QA suite");
	const child = Bun.spawn(
		[process.execPath, "x", "--no-install", "vite", "--host", "127.0.0.1", "--port", "1420", "--strictPort"],
		{ cwd: path.join(root, "packages/desktop"), stdin: "ignore", stdout: "ignore", stderr: "inherit" },
	);
	for (let attempt = 0; attempt < 150; attempt++) {
		if (child.exitCode !== null) throw new Error("QA UI server exited; port 1420 is likely taken");
		if (await responds(origin)) {
			// Vite binds only after startup, so a live child plus a live port is ours.
			await Bun.sleep(200);
			if (child.exitCode !== null) throw new Error("QA UI server exited after binding");
			return child;
		}
		await Bun.sleep(100);
	}
	child.kill("SIGKILL");
	await child.exited;
	throw new Error("QA UI server did not become ready");
}

async function responds(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(1000) });
		return true;
	} catch {
		return false;
	}
}

async function launchHost(): Promise<Bootstrap> {
	const child = Bun.spawn([process.execPath, "packages/desktop/scripts/host-ui-qa.ts"], {
		cwd: root,
		env: { ...process.env, GJC_DESKTOP_QA_MODEL_FIXTURE: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "inherit",
	});
	host = child;
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`QA host exited before bootstrap: ${buffered}`);
		buffered += decoder.decode(value, { stream: true });
		const newline = buffered.indexOf("\n");
		if (newline >= 0) return JSON.parse(buffered.slice(0, newline)) as Bootstrap;
	}
}
const pageErrors: string[] = [];
/** model.set params the App wrote to the host, captured from the bridge POST /request envelopes. */
const modelSetWrites: { modelId?: string }[] = [];

async function text(): Promise<string> {
	return page.evaluate(() => document.body.innerText);
}
async function fixture(): Promise<FixtureSnapshot> {
	return JSON.parse(await Bun.file(bootstrap!.modelFixture.artifactPath).text()) as FixtureSnapshot;
}
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (await predicate()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}
async function waitText(needle: string, timeout = 15000) {
	await waitFor(async () => (await text()).includes(needle), `text ${JSON.stringify(needle)}`, timeout);
}
async function status(): Promise<string> {
	return page.evaluate(() => document.querySelector(".session-status")?.textContent?.trim() ?? "");
}
async function idle() {
	await waitFor(async () => (await status()).includes("Idle"), "idle session status");
}
/** Click the last element whose trimmed text equals the label. */
async function clickText(label: string) {
	const clicked = await page.evaluate(exact => {
		const target = [...document.querySelectorAll("button, [role=button]")]
			.filter(node => (node.textContent ?? "").trim() === exact)
			.at(-1);
		if (!target) return false;
		(target as HTMLElement).click();
		return true;
	}, label);
	expect(clicked, `no clickable element labelled ${JSON.stringify(label)}`);
	await Bun.sleep(120);
}
/** Click a role option in the model picker's role step by its visible label. */
async function clickRole(label: string) {
	const clicked = await page.evaluate(target => {
		const option = [...document.querySelectorAll<HTMLButtonElement>(".model-role-choice .model-role-option")].find(
			node => !node.disabled && (node.textContent ?? "").trim().startsWith(target),
		);
		if (!option) return false;
		option.click();
		return true;
	}, label);
	expect(clicked, `no role option labelled ${JSON.stringify(label)}`);
	await Bun.sleep(120);
}
async function composerValue(): Promise<string> {
	return page.evaluate(
		() => (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.value ?? "",
	);
}
async function typeComposer(value: string) {
	const field = await page.$(".composer textarea");
	expect(field, "composer textarea missing");
	await (field as NonNullable<typeof field>).click({ clickCount: 3 });
	await (field as NonNullable<typeof field>).type(value);
}
/** The composer action is icon-only: send is the one submit button in the action slot. */
async function send() {
	const clicked = await page.evaluate(() => {
		const button = document.querySelector<HTMLButtonElement>('.composer-actions button[type="submit"]');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	});
	expect(clicked, "composer send action was not clickable");
	await Bun.sleep(120);
}
/** Stop is the same slot while a turn runs and the draft is empty; only its label says which. */
async function stop() {
	const clicked = await page.evaluate(() => {
		const button = document.querySelector<HTMLButtonElement>('.composer-actions button[aria-label="Stop"]');
		if (!button || button.disabled) return false;
		button.click();
		return true;
	});
	expect(clicked, "composer stop action was not clickable");
	await Bun.sleep(120);
}
async function hold() {
	await page.evaluate(() => (window as never as { __qaFixture: { hold(): Promise<unknown> } }).__qaFixture.hold());
}
async function release(id: number) {
	await page.evaluate(
		value =>
			(window as never as { __qaFixture: { release(id: number): Promise<unknown> } }).__qaFixture.release(value),
		id,
	);
}
async function sessionRows(): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll(".session-row .session-title")].map(node => (node.textContent ?? "").trim()),
	);
}
async function selectSession(title: string) {
	const click = (label: string) =>
		page.evaluate(title => {
			for (const row of document.querySelectorAll(".session-row")) {
				if ((row.querySelector(".session-title")?.textContent ?? "").trim() !== title) continue;
				(row.querySelector(".session-select") as HTMLElement).click();
				return true;
			}
			return false;
		}, label);
	let opened = await click(title);
	// A workspace lists five conversations per page, so reveal pages until the row exists.
	for (let pageIndex = 0; !opened && pageIndex < 20; pageIndex++) {
		const more = await page.$(".project-group .show-more");
		if (!more) break;
		await more.click();
		await Bun.sleep(80);
		opened = await click(title);
	}
	expect(opened, `session row ${JSON.stringify(title)} missing`);
	await waitFor(async () => (await text()).includes(title), `conversation ${JSON.stringify(title)}`);
	await Bun.sleep(200);
}
async function openMenu() {
	await page.evaluate(() =>
		(document.querySelector('[aria-label="Conversation actions menu"]') as HTMLElement).click(),
	);
	await page.waitForSelector(".modal", { timeout: 8000 });
}
async function openMenuAction(label: string) {
	await openMenu();
	await page.evaluate(LABEL => {
		const target = [...document.querySelectorAll(".modal .command-list button")].find(node =>
			(node.textContent ?? "").includes(LABEL),
		);
		if (!target) throw new Error(`missing menu action ${LABEL}`);
		(target as HTMLElement).click();
	}, label);
	await Bun.sleep(600);
}
async function openPalette() {
	await clickText("Commands");
	await page.waitForSelector("#command-search", { timeout: 8000 });
	await Bun.sleep(300);
}
async function closeDialog() {
	await page.keyboard.press("Escape");
	await waitFor(
		async () => !(await page.evaluate(() => Boolean(document.querySelector(".modal")))),
		"dialog close",
		5000,
	);
}

let workspace = "";

/** Create one conversation through the sidebar and return its title. */
async function createSession(): Promise<string> {
	const before = await sessionRows();
	await page.evaluate(() => (document.querySelector('[aria-label^="New conversation in"]') as HTMLElement).click());
	await waitFor(async () => (await sessionRows()).length > before.length, "new session row");
	const created = (await sessionRows()).find(title => !before.includes(title));
	expect(created, "created session is not listed");
	await idle();
	return created;
}

async function ensureWorkspace() {
	if (workspace) {
		await selectSession(workspace);
		await idle();
		return;
	}
	workspace = await createSession();
}

const scenarios: { name: string; run: () => Promise<void> }[] = [
	{
		name: "boot",
		async run() {
			expect(await page.$(".app-shell"), "app shell missing");
			expect(!(await page.$(".error-banner")), `error banner rendered: ${(await text()).slice(0, 300)}`);
			expect((await text()).includes("qa-project"), "project name missing from sidebar");
			expect((await sessionRows()).length > 0, "no sessions listed");
		},
	},
	{
		name: "new-session",
		async run() {
			await ensureWorkspace();
			expect((await sessionRows()).includes(workspace), "created session is not listed");
			expect((await status()).includes("Idle"), `new session is not idle: ${await status()}`);
			const header = await page.evaluate(() => document.querySelector(".toolbar-title h1")?.textContent ?? "");
			expect(header === workspace, `toolbar does not show the created session: ${header}`);
		},
	},
	{
		name: "send-turn",
		async run() {
			await ensureWorkspace();
			await hold();
			const before = (await fixture()).requests.length;
			await typeComposer("flow-qa hello");
			await send();
			await waitFor(async () => (await status()).includes("Working"), "running status");
			// The transcript owns the message; the composer must not invite a resend.
			expect((await composerValue()) === "", "submitted draft stayed in the composer");
			await waitFor(async () => (await fixture()).requests.length > before, "fixture request");
			const request = (await fixture()).requests.at(-1)!;
			expect(JSON.stringify(request.body.messages ?? "").includes("flow-qa hello"), "prompt text not delivered");
			expect(request.state === "held", `fixture request not held: ${request.state}`);
			await release(request.id);
			await waitText("Fixture turn");
			await idle();
			expect((await fixture()).requests.at(-1)!.state === "completed", "fixture request did not complete");
		},
	},
	{
		name: "abort-turn",
		async run() {
			await ensureWorkspace();
			await hold();
			await typeComposer("flow-qa abort");
			await send();
			await waitFor(async () => (await status()).includes("Working"), "running status");
			await waitText("Fixture turn");
			await stop();
			await idle();
			await waitFor(
				async () => (await fixture()).requests.at(-1)!.state === "aborted",
				"aborted fixture request",
				8000,
			);
			expect((await text()).includes("Fixture turn"), "aborted partial text was discarded");
		},
	},
	{
		name: "queue-steer",
		async run() {
			await ensureWorkspace();
			await hold();
			await typeComposer("flow-qa first turn");
			await send();
			await waitFor(async () => (await status()).includes("Working"), "running status");
			const held = (await fixture()).requests.at(-1)!;
			await typeComposer("flow-qa queued turn");
			await send();
			await waitText("1 queued");
			expect((await composerValue()) === "", "queued draft stayed in the composer");
			await release(held.id);
			await waitFor(
				async () => (await fixture()).requests.at(-1)!.state === "completed" && (await sessionQueued()) === null,
				"queued input to drain",
				25000,
			);
			const requests = (await fixture()).requests;
			const delivered = requests.slice(-2).map(request => JSON.stringify(request.body.messages ?? ""));
			expect(
				delivered.some(body => body.includes("flow-qa queued turn")),
				"queued input was never delivered",
			);
			await idle();
		},
	},
	{
		name: "model-picker",
		async run() {
			await ensureWorkspace();
			await page.waitForSelector(".model-trigger", { timeout: 10000 });
			await page.evaluate(() => (document.querySelector(".model-trigger") as HTMLElement).click());
			await page.waitForSelector(".model-dialog", { timeout: 8000 });
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")]
					.find(tab => tab.textContent?.includes("Models"))
					?.click(),
			);
			await page.waitForSelector(".model-result-list .model-option-hit", { timeout: 8000 });
			const options = await page.$$eval(".model-option-hit", nodes =>
				nodes.map(node => (node.textContent ?? "").trim()),
			);
			expect(options.length === 3, `expected only the three fixture models, saw ${options.length}`);
			const search = await page.$(".model-search");
			expect(search, "model search input missing");
			await (search as NonNullable<typeof search>).type("plain");
			await Bun.sleep(300);
			const filtered = await page.$$eval(".model-option-hit", nodes =>
				nodes.map(node => (node.textContent ?? "").trim()),
			);
			expect(filtered.length === 1 && filtered[0]!.includes("qa-plain"), `search filter wrong: ${filtered}`);
			// The model row only records the choice; the role step dispatches it.
			await page.click(".model-option-hit");
			await page.waitForSelector(".model-role-choice", { timeout: 8000 });
			await clickRole("Default");
			await waitFor(
				async () =>
					!(await page.evaluate(() => Boolean(document.querySelector(".model-dialog")))) &&
					(await text()).includes("qa-plain"),
				"model selection",
			);
			const request = await sendAndSettle("flow-qa model");
			expect(request.body.model === "qa-plain", `selected model not used: ${request.body.model}`);
		},
	},
	{
		name: "reasoning-level",
		async run() {
			await ensureWorkspace();
			await page.waitForSelector(".model-trigger", { timeout: 10000 });
			await page.evaluate(() => (document.querySelector(".model-trigger") as HTMLElement).click());
			await page.waitForSelector(".model-dialog", { timeout: 8000 });
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")]
					.find(tab => tab.textContent?.includes("Models"))
					?.click(),
			);
			await page.waitForSelector(".model-result-list .model-option-hit", { timeout: 8000 });
			// Target the intended model by id: ordering depends on the default selected earlier.
			await page.waitForSelector('.model-option-hit[data-model-id$="/qa-reasoning"]', { timeout: 8000 });
			await page.click('.model-option-hit[data-model-id$="/qa-reasoning"]');
			await page.waitForSelector(".model-role-choice", { timeout: 8000 });
			await clickRole("Default");
			await waitFor(
				async () => (await text()).includes("qa-reasoning") && !(await page.$(".model-dialog")),
				"reasoning model selected",
			);
			// The reasoning control is a custom listbox, so the level is chosen by label.
			await page.waitForSelector(".reasoning-control .select-trigger:not([disabled])", { timeout: 8000 });
			await page.click(".reasoning-control .select-trigger");
			await page.waitForSelector(".select-menu .select-option:not([disabled])", { timeout: 8000 });
			await page.evaluate(() => {
				const option = [...document.querySelectorAll<HTMLButtonElement>(".select-menu .select-option")].find(item =>
					/high/iu.test(item.textContent ?? ""),
				);
				option?.click();
			});
			await waitFor(
				async () =>
					/high/iu.test(
						await page.$eval(".reasoning-control .select-trigger", element => element.textContent ?? ""),
					),
				"reasoning level applied",
			);
			const request = await sendAndSettle("flow-qa reasoning");
			expect(
				request.body.reasoning_effort === "high",
				`reasoning effort not applied: ${request.body.reasoning_effort}`,
			);
		},
	},
	{
		name: "deferred-model-change",
		// The picker defers a model change while a turn runs; the write must land exactly once, after idle.
		async run() {
			await ensureWorkspace();
			await hold();
			const requests = (await fixture()).requests.length;
			await typeComposer("flow-qa deferred model");
			await send();
			await waitFor(async () => (await status()).includes("Working"), "running status");
			await waitFor(async () => (await fixture()).requests.length > requests, "fixture request");
			const held = (await fixture()).requests.at(-1)!;
			expect(held.state === "held", `fixture request not held: ${held.state}`);
			const writesBefore = modelSetWrites.length;
			await page.waitForSelector(".model-trigger", { timeout: 10000 });
			await page.evaluate(() => (document.querySelector(".model-trigger") as HTMLElement).click());
			await page.waitForSelector(".model-dialog", { timeout: 8000 });
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".model-tab")]
					.find(tab => tab.textContent?.includes("Models"))
					?.click(),
			);
			await page.waitForSelector(".model-result-list .model-option-hit", { timeout: 8000 });
			const current = await page.evaluate(() => {
				const selected = document.querySelector(
					".model-option[aria-current] .model-option-hit",
				) as HTMLElement | null;
				return selected?.dataset.modelId ?? "";
			});
			const chosen = await page.evaluate(selected => {
				const option = [...document.querySelectorAll<HTMLElement>(".model-option-hit")].find(
					node => node.dataset.modelId !== selected,
				);
				if (!option) return null;
				const name = (option.querySelector("strong")?.textContent ?? "").trim();
				return { id: option.dataset.modelId ?? "", name };
			}, current);
			expect(chosen, "no other fixture model to defer");
			expect(chosen.id && chosen.name, "fixture model row has no id or name");
			await page.click(`.model-option-hit[data-model-id="${chosen.id}"]`);
			await page.waitForSelector(".model-role-choice", { timeout: 8000 });
			expect(
				modelSetWrites.length === writesBefore,
				`model row click wrote to the host: ${JSON.stringify(modelSetWrites.slice(writesBefore))}`,
			);
			await clickRole("Default");
			await waitFor(
				async () => !(await page.evaluate(() => Boolean(document.querySelector(".model-dialog")))),
				"model dialog close",
			);
			const trigger = await page.$eval(".model-trigger", node => (node.textContent ?? "").trim());
			expect(trigger.includes(chosen.name), `deferred model not shown: ${trigger}`);
			// The turn is still held: the deferred choice must stay out of the host.
			await Bun.sleep(500);
			expect(
				modelSetWrites.length === writesBefore,
				`model change was written during the run: ${JSON.stringify(modelSetWrites.slice(writesBefore))}`,
			);
			await release(held.id);
			await waitFor(async () => (await fixture()).requests.at(-1)!.state === "completed", "turn completion");
			await idle();
			await waitFor(async () => modelSetWrites.length > writesBefore, "deferred model write");
			await Bun.sleep(300);
			const dispatched = modelSetWrites.slice(writesBefore);
			expect(dispatched.length === 1, `expected one model change after the run, saw ${dispatched.length}`);
			expect(dispatched[0]!.modelId === chosen.id, `deferred model change wrote ${JSON.stringify(dispatched[0])}`);
		},
	},
	{
		name: "command-search-slash",
		async run() {
			await ensureWorkspace();
			await openPalette();
			const search = await page.$("#command-search");
			await (search as NonNullable<typeof search>).type("/model");
			await Bun.sleep(300);
			const slash = await page.evaluate(() => {
				const list = [...document.querySelectorAll(".command-list")][1];
				return [...(list?.querySelectorAll("button") ?? [])].map(node => (node.textContent ?? "").trim());
			});
			expect(slash.length > 0, "typing the slash form listed no slash commands");
			expect(
				slash.some(entry => entry.startsWith("/model")),
				`unexpected slash results: ${slash}`,
			);
			await closeDialog();
		},
	},
	{
		name: "settings-controls",
		async run() {
			await ensureWorkspace();
			await page.evaluate(() => {
				const button = [...document.querySelectorAll("button")].find(
					node => (node.textContent ?? "").trim() === "Settings",
				);
				if (!button) throw new Error("settings button missing");
				(button as HTMLElement).click();
			});
			await openSettingsTab();
			await page.waitForSelector(".setting-field", { timeout: 10000 });
			const controls = await page.$$eval(".setting-field", forms =>
				forms.map(form => {
					const control = form.querySelector("input, select") as HTMLInputElement | HTMLSelectElement | null;
					return {
						path: (form.querySelector("label")?.textContent ?? "").trim(),
						tag: control?.tagName ?? "",
						type: (control as HTMLInputElement | null)?.type ?? "",
					};
				}),
			);
			const booleans = controls.filter(control => control.path === "startup.networkPrewarm");
			expect(booleans.length === 1, "expected the startup.networkPrewarm setting");
			expect(booleans[0]!.type === "checkbox", `boolean setting rendered as ${booleans[0]!.type}`);
			const numbers = controls.filter(control => control.path === "sdk.promptDeadlineMs");
			expect(numbers.length === 1, "expected the sdk.promptDeadlineMs setting");
			expect(numbers[0]!.type === "number", `number setting rendered as ${numbers[0]!.type}`);
			// The control type only matters if saving it round-trips a real boolean.
			const toggled = await page.evaluate(() => {
				for (const form of document.querySelectorAll(".setting-field")) {
					if ((form.querySelector("label")?.textContent ?? "").trim() !== "startup.networkPrewarm") continue;
					const box = form.querySelector("input") as HTMLInputElement;
					box.click();
					(form.querySelector("button[type=submit]") as HTMLElement).click();
					return box.checked;
				}
				return null;
			});
			expect(toggled !== null, "startup.networkPrewarm checkbox missing");
			await waitFor(
				async () =>
					(await page.$eval(".modal", node => (node as HTMLElement).innerText)).includes("Settings saved"),
				"settings save",
				15000,
			);
			await closeDialog();
			await Bun.sleep(400);
			await page.evaluate(() => {
				const button = [...document.querySelectorAll("button")].find(
					node => (node.textContent ?? "").trim() === "Settings",
				);
				(button as HTMLElement).click();
			});
			await openSettingsTab();
			await page.waitForSelector(".setting-field", { timeout: 10000 });
			const persisted = await page.evaluate(() => {
				for (const form of document.querySelectorAll(".setting-field")) {
					if ((form.querySelector("label")?.textContent ?? "").trim() !== "startup.networkPrewarm") continue;
					return (form.querySelector("input") as HTMLInputElement).checked;
				}
				return null;
			});
			expect(persisted === toggled, `boolean setting did not persist: ${persisted}`);
			await closeDialog();
		},
	},
	{
		name: "export-message",
		async run() {
			await ensureWorkspace();
			await openPalette();
			await page.evaluate(() => {
				const entry = [...document.querySelectorAll(".modal .command-list button")].find(node =>
					(node.textContent ?? "").includes("Export conversation"),
				);
				if (!entry) throw new Error("export command missing");
				(entry as HTMLElement).click();
			});
			await page.waitForSelector(".modal h2", { timeout: 15000 });
			await waitText("Exported the conversation", 15000);
			const body = await page.evaluate(
				() => (document.querySelector(".modal") as HTMLElement | null)?.innerText ?? "",
			);
			expect(/\.html/u.test(body), `export result has no file path: ${body.slice(0, 200)}`);
			expect(!body.includes('"path"'), "export result still renders the raw protocol object");
			await closeDialog();
		},
	},
	{
		name: "attachment",
		async run() {
			await ensureWorkspace();
			const input = await page.$(".attachment-picker input[type=file]");
			expect(input, "attachment file input missing");
			await (input as NonNullable<typeof input>).uploadFile(attachmentPath);
			await waitText("flow-attachment.txt");
			const before = (await fixture()).requests.length;
			await typeComposer("flow-qa attachment");
			await send();
			await waitFor(async () => (await fixture()).requests.length > before, "attachment request");
			const request = (await fixture()).requests.at(-1)!;
			await releaseHeld();
			await waitFor(async () => (await fixture()).requests.at(-1)!.state === "completed", "attachment reply");
			expect(JSON.stringify(request.body.messages ?? "").includes(ATTACHMENT_TEXT), "attachment text not delivered");
			await idle();
		},
	},
	{
		name: "side-chat",
		async run() {
			await ensureWorkspace();
			await openMenuAction("Side chat");
			await page.waitForSelector(".modal textarea", { timeout: 8000 });
			const field = await page.$(".modal textarea");
			await (field as NonNullable<typeof field>).type("flow-qa side question");
			await clickText("Send side chat");
			await waitText("Responded", 20000);
			const body = await page.evaluate(
				() => (document.querySelector(".modal") as HTMLElement | null)?.innerText ?? "",
			);
			expect(body.includes("Fixture turn"), `side chat has no answer: ${body.slice(0, 200)}`);
			await closeDialog();
		},
	},
	{
		name: "operator-shell",
		async run() {
			await ensureWorkspace();
			await openMenuAction("Direct execution");
			await page.waitForSelector(".modal textarea", { timeout: 8000 });
			const field = await page.$(".modal textarea");
			await (field as NonNullable<typeof field>).type("!echo flow-qa-operator");
			await clickText("Run");
			await waitText("flow-qa-operator", 20000);
			const output = await page.evaluate(() =>
				[...document.querySelectorAll(".modal pre")].map(node => node.textContent ?? "").join("\n"),
			);
			expect(output.includes("flow-qa-operator"), `operator output missing: ${output.slice(0, 200)}`);
			await closeDialog();
		},
	},
	{
		name: "session-info",
		async run() {
			await ensureWorkspace();
			await openMenuAction("Session info");
			await waitText("Refresh session information", 10000);
			const body = await page.evaluate(
				() => (document.querySelector(".modal") as HTMLElement | null)?.innerText ?? "",
			);
			// Assert values, not the labels the panel always prints.
			expect(body.includes(".jsonl"), `session info has no transcript file: ${body.slice(0, 300)}`);
			expect(
				body.includes(bootstrap!.project),
				`session info does not name the working directory: ${body.slice(0, 300)}`,
			);
			// A session with a transcript file is file-backed, so the state is not a union.
			expect(
				/Transcript persistence\s*On/u.test(body),
				`session info does not report a persisted transcript: ${body.slice(0, 300)}`,
			);
			await closeDialog();
		},
	},
	{
		name: "fork",
		async run() {
			await ensureWorkspace();
			await openMenuAction("Fork conversation");
			await page.waitForSelector(".modal select", { timeout: 10000 });
			const option = await page.evaluate(() => {
				const select = document.querySelector(".modal select") as HTMLSelectElement | null;
				const candidate = [...(select?.options ?? [])].find(item => item.value !== "");
				return candidate?.value ?? "";
			});
			expect(option, "fork has no selectable user entry");
			await page.select(".modal select", option);
			await Bun.sleep(300);
			const before = await sessionRows();
			await page.evaluate(() => {
				const action = [...document.querySelectorAll(".modal button")].find(node =>
					(node.textContent ?? "").includes("Fork before the selected message"),
				);
				if (!action) throw new Error("fork action missing");
				(action as HTMLElement).click();
			});
			await waitFor(async () => (await sessionRows()).length > before.length, "forked session row");
			await idle();
			const created = (await sessionRows()).find(title => !before.includes(title))!;
			expect(created.includes("fork"), `forked session title unexpected: ${created}`);
			const selected = await page.evaluate(
				() => document.querySelector(".session-row.selected .session-title")?.textContent?.trim() ?? "",
			);
			expect(selected === created, `fork did not select the child session: ${selected}`);
			expect((await composerValue()).length > 0, "fork did not prefill the child draft");
		},
	},
	{
		name: "delete-session",
		// Last scenario: it removes the conversation every other scenario shared.
		async run() {
			await ensureWorkspace();
			const victim = workspace;
			const others = (await sessionRows()).filter(title => title !== victim);
			expect(others.length > 0, "no other session to verify the removal against");
			await selectSession(victim);
			await openMenuAction("Delete conversation");
			await clickText("Delete conversation");
			await waitFor(async () => !(await sessionRows()).includes(victim), "session removal");
			const remaining = await sessionRows();
			for (const title of others) expect(remaining.includes(title), `deleting one session removed ${title}`);
		},
	},
];

async function releaseHeld() {
	for (const request of (await fixture()).requests) if (request.state === "held") await release(request.id);
}
/** Send one prompt and let the fixture finish it, whatever the hold state. */
async function sendAndSettle(value: string): Promise<FixtureRequest> {
	const before = (await fixture()).requests.length;
	await typeComposer(value);
	await send();
	await waitFor(async () => (await fixture()).requests.length > before, "fixture request");
	await releaseHeld();
	await waitFor(async () => (await fixture()).requests.at(-1)!.state === "completed", "turn completion");
	await idle();
	return (await fixture()).requests.at(-1)!;
}
// The settings dialog is tabbed; the runtime setting list lives on the Settings tab.
async function openSettingsTab() {
	await page.waitForSelector(".settings-tabs", { timeout: 10000 });
	await page.evaluate(() => {
		const tab = [...document.querySelectorAll<HTMLButtonElement>(".settings-tab")].find(
			node => (node.textContent ?? "").trim() === "Runtime",
		);
		if (!tab) throw new Error("settings tab missing");
		tab.click();
	});
	await page.waitForSelector(
		".settings-panel:not([hidden]) .setting-field, .settings-panel:not([hidden]) .settings-hint",
		{
			timeout: 10000,
		},
	);
}

async function sessionQueued(): Promise<string | null> {
	return page.evaluate(() => (document.querySelector(".queued-inputs") as HTMLElement | null)?.innerText ?? null);
}

try {
	vite = await launchVite();
	bootstrap = await launchHost();
	browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	page.on("pageerror", error => pageErrors.push(String(error)));
	page.on("console", message => {
		if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
	});
	page.on("request", request => {
		if (request.method() !== "POST") return;
		if (!new URL(request.url()).pathname.endsWith("/request")) return;
		try {
			const body = request.postData();
			if (!body) return;
			const envelope = JSON.parse(body) as { method?: unknown; params?: unknown };
			if (envelope.method !== "model.set" || !envelope.params || typeof envelope.params !== "object") return;
			modelSetWrites.push(envelope.params as { modelId?: string });
		} catch {
			// Not a JSON envelope: only host requests carry a method.
		}
	});
	const source = await (await fetch(bootstrap.bootstrapUrl)).text();
	await page.evaluateOnNewDocument(source);
	await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
	await page.waitForSelector(".app-shell", { timeout: 20000 });
	await waitFor(async () => (await sessionRows()).length > 0, "session catalog");

	for (const scenario of scenarios) {
		if (only.size && !only.has(scenario.name)) continue;
		const started = Date.now();
		try {
			await scenario.run();
			results.push({ name: scenario.name, ok: true });
			process.stdout.write(`ok ${scenario.name} (${Date.now() - started}ms)\n`);
		} catch (error) {
			results.push({ name: scenario.name, ok: false, detail: String(error) });
			await page.screenshot({ path: path.join(directory, `${scenario.name}.failure.png`), fullPage: true });
			process.stdout.write(`FAIL ${scenario.name}: ${String(error)}\n`);
		}
	}
	const failed = results.filter(result => !result.ok);
	await Bun.write(
		path.join(directory, "receipt.json"),
		JSON.stringify(
			{
				scenarios: results,
				pageErrors,
				project: bootstrap?.project,
				finishedAt: new Date().toISOString(),
				note: "Real App/Host/SDK transport against the zero-provider fixture. No live provider, native WKWebView or full parity claim.",
			},
			null,
			2,
		),
	);
	process.stdout.write(`${JSON.stringify({ passed: results.length - failed.length, failed: failed.length })}\n`);
	if (failed.length || pageErrors.length) {
		process.stdout.write(`${JSON.stringify({ failed, pageErrors }, null, 2)}\n`);
		process.exitCode = 1;
	}
} finally {
	await browser?.close();
	if (host && host.exitCode === null) {
		host.kill("SIGTERM");
		await host.exited;
	}
	if (vite && vite.exitCode === null) {
		vite.kill("SIGTERM");
		await vite.exited;
	}
}
