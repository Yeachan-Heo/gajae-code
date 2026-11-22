import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopAuthProvider, DesktopModel, DesktopRequest } from "@gajae-code/desktop-host/protocol";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { browserPath } from "./component-fixture";
import { installNavigationFixture, type NavigationFixtureOptions } from "./fixtures/navigation";

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

const providers: DesktopAuthProvider[] = [
	{
		id: "fixture",
		name: "Fixture Cloud",
		configured: false,
		stored: false,
		credentialKinds: [],
		canSignIn: false,
		canStoreKey: true,
	},
];
const NOTICE = ".provider-notice";
const DOCKED = ".conversation-column > .provider-notice-dock > .provider-notice";
const ABOVE_COMPOSER = ".composer-area > .provider-notice";

interface Launch {
	holdBootstrap?: boolean;
	/** Hold every `models.list` request so the test answers it (the conversation catalog). */
	holdModelLists?: boolean;
	options?: NavigationFixtureOptions;
}

/** The mounted App on the page-owned navigation transport, by default in its zero-model state. */
async function fixture(launch: Launch = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluateOnNewDocument(installNavigationFixture, launch.holdBootstrap === true, {
			zeroModels: true,
			providers,
			...launch.options,
		});
		if (launch.holdModelLists)
			await page.evaluateOnNewDocument(() => {
				// Runs right after the fixture installed its transport and before any page script.
				const transport = (
					window as unknown as {
						__TAURI_INTERNALS__: {
							invoke(command: string, args?: { request?: DesktopRequest }): Promise<unknown>;
						};
					}
				).__TAURI_INTERNALS__;
				const invoke = transport.invoke.bind(transport);
				transport.invoke = (command, args) => {
					if (command === "engine_request" && args?.request?.method === "models.list") {
						window.navigationFixture.requests().push(args.request);
						return Promise.resolve();
					}
					return invoke(command, args);
				};
			});
		// Any render that ever shows the notice above the composer, however briefly, is recorded.
		await page.evaluateOnNewDocument(() => {
			const flags = window as unknown as { noticeAboveComposerSeen: boolean };
			flags.noticeAboveComposerSeen = false;
			new MutationObserver(() => {
				if (document.querySelector(".composer-area > .provider-notice")) flags.noticeAboveComposerSeen = true;
			}).observe(document, { subtree: true, childList: true });
		});
		await page.goto(origin);
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function select(page: Page, title: string): Promise<void> {
	await page.waitForSelector(".session-row");
	await page.click(`.session-select[title="${title}"]`);
	await page.waitForSelector(`.session-select[title="${title}"][aria-current="page"]`);
}
async function heldModelLists(page: Page): Promise<DesktopRequest[]> {
	return page.evaluate(() => window.navigationFixture.requests().filter(request => request.method === "models.list"));
}
async function answerModelLists(page: Page, after: number, models: DesktopModel[]): Promise<void> {
	await page.waitForFunction(
		after => window.navigationFixture.requests().filter(request => request.method === "models.list").length > after,
		{},
		after,
	);
	const held = (await heldModelLists(page)).slice(after);
	await page.evaluate(
		(ids, result) => {
			for (const id of ids) window.navigationFixture.emit({ type: "response", id, ok: true, result });
		},
		held.map(request => request.id),
		models,
	);
}
/** Re-publish the snapshot as a new object, as the Host does, so the app reloads its catalog. */
function resnapshot(): void {
	const current = window.navigationFixture.snapshot();
	window.navigationFixture.emit({ type: "snapshot", snapshot: { ...current, models: [...current.models] } });
}
async function noticeSeenAboveComposer(page: Page): Promise<boolean> {
	return page.evaluate(() => (window as unknown as { noticeAboveComposerSeen: boolean }).noticeAboveComposerSeen);
}
async function composerStatus(page: Page): Promise<string[]> {
	return page.$$eval(
		".composer .model-control-status, .composer .model-controls > .button:not(.model-trigger)",
		nodes => nodes.map(node => node.textContent?.trim() ?? ""),
	);
}
const fixtureModel: DesktopModel = {
	id: "fixture/astra",
	provider: "fixture",
	name: "Astra",
	contextWindow: 128000,
	reasoning: true,
	thinking: { options: [{ value: "medium", label: "Medium" }] },
};

suite("Zero-model onboarding notice", () => {
	test("docks below the empty state and moves above the composer once the conversation's catalog settles empty", async () => {
		const { context, page } = await fixture();
		try {
			await page.waitForSelector(DOCKED);
			const layout = await page.evaluate(() => {
				const column = document.querySelector(".conversation-column")!.getBoundingClientRect();
				const dock = document.querySelector(".provider-notice-dock")!;
				return {
					afterEmpty: dock.previousElementSibling?.classList.contains("empty"),
					gapToBottom: Math.round(column.bottom - dock.getBoundingClientRect().bottom),
					emptyActions: document.querySelectorAll(".empty .button").length,
				};
			});
			expect(layout).toEqual({ afterEmpty: true, gapToBottom: 0, emptyActions: 1 });
			expect(await page.$eval(DOCKED, node => [node.getAttribute("role"), node.textContent])).toEqual([
				"status",
				"No models available yetConnect an account or add an API key to start a conversation.Connect a provider",
			]);
			await select(page, "Oldest conversation · Idle");
			await page.waitForSelector(ABOVE_COMPOSER);
			expect(await page.$$(NOTICE)).toHaveLength(1);
			// The notice replaces the composer's own model status.
			expect(await composerStatus(page)).toEqual([]);
		} finally {
			await context.close();
		}
	}, 30000);

	test("never shows while bootstrapping or after a fatal error", async () => {
		const { context, page } = await fixture({ holdBootstrap: true });
		try {
			await page.waitForSelector(".connection-state");
			await Bun.sleep(300);
			expect(await page.$(NOTICE)).toBeNull();
			await page.evaluate(() => window.navigationFixture.connect());
			await page.waitForSelector(DOCKED);
			await page.evaluate(() => window.navigationFixture.emit({ type: "fatal", error: "Fixture host exited" }));
			await page.waitForFunction(() => !document.querySelector(".provider-notice"));
			await Bun.sleep(200);
			expect(await page.$(NOTICE)).toBeNull();
		} finally {
			await context.close();
		}
	}, 30000);

	test("does not blink while the conversation's catalog loads or reloads", async () => {
		const { context, page } = await fixture({ holdModelLists: true });
		try {
			await page.waitForSelector(DOCKED);
			// The snapshot has no model, but this conversation's own catalog does.
			await select(page, "Oldest conversation · Idle");
			await answerModelLists(page, 0, [fixtureModel]);
			await page.waitForSelector(".model-trigger:not([disabled])");
			const before = (await heldModelLists(page)).length;
			await page.evaluate(resnapshot);
			await answerModelLists(page, before, [fixtureModel]);
			await Bun.sleep(200);
			expect(await noticeSeenAboveComposer(page)).toBe(false);
			// A conversation whose catalog settled empty keeps the notice through a reload.
			const middle = (await heldModelLists(page)).length;
			await select(page, "Middle conversation · Working");
			await answerModelLists(page, middle, []);
			await page.waitForSelector(ABOVE_COMPOSER);
			const reload = (await heldModelLists(page)).length;
			await page.evaluate(() => {
				const flags = window as unknown as { noticeGone: boolean };
				flags.noticeGone = false;
				new MutationObserver(() => {
					if (!document.querySelector(".composer-area > .provider-notice")) flags.noticeGone = true;
				}).observe(document, { subtree: true, childList: true });
			});
			await page.evaluate(resnapshot);
			await page.waitForFunction(
				reload =>
					window.navigationFixture.requests().filter(request => request.method === "models.list").length > reload,
				{},
				reload,
			);
			expect(await page.$(ABOVE_COMPOSER)).not.toBeNull();
			await answerModelLists(page, reload, []);
			await Bun.sleep(100);
			expect(await page.evaluate(() => (window as unknown as { noticeGone: boolean }).noticeGone)).toBe(false);
		} finally {
			await context.close();
		}
	}, 30000);

	test("stays put when switching between conversations that have no models", async () => {
		const { context, page } = await fixture();
		try {
			await select(page, "Oldest conversation · Idle");
			await page.waitForSelector(ABOVE_COMPOSER);
			await page.evaluate(() => {
				const flags = window as unknown as { noticeGone: boolean };
				flags.noticeGone = false;
				new MutationObserver(() => {
					if (!document.querySelector(".composer-area > .provider-notice")) flags.noticeGone = true;
				}).observe(document, { subtree: true, childList: true });
			});
			await select(page, "Newest conversation · Done");
			await page.waitForFunction(() =>
				window.navigationFixture
					.requests()
					.some(request => request.method === "models.list" && request.params.sessionId === "new"),
			);
			await Bun.sleep(200);
			expect(await page.$(ABOVE_COMPOSER)).not.toBeNull();
			expect(await page.evaluate(() => (window as unknown as { noticeGone: boolean }).noticeGone)).toBe(false);
		} finally {
			await context.close();
		}
	}, 30000);

	test("Escape closes only the Providers dialog and leaves an open Session work card in place", async () => {
		const { context, page } = await fixture();
		try {
			await select(page, "Oldest conversation · Idle");
			await page.waitForSelector(ABOVE_COMPOSER);
			await page.click(".session-work-toggle");
			await page.waitForSelector(".session-work-card");
			await page.click(`${ABOVE_COMPOSER} .button`);
			await page.waitForSelector("dialog.providers-dialog[open] .provider-row");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			await Bun.sleep(100);
			expect(await page.$(".session-work-card")).not.toBeNull();
			expect(await page.evaluate(() => document.activeElement?.closest(".provider-notice") !== null)).toBe(true);
		} finally {
			await context.close();
		}
	}, 30000);

	test("its button opens the Providers dialog, and a saved key removes it in the snapshot's render", async () => {
		const { context, page } = await fixture({ holdModelLists: true });
		try {
			await select(page, "Oldest conversation · Idle");
			await answerModelLists(page, 0, []);
			await page.waitForSelector(ABOVE_COMPOSER);
			await page.click(`${ABOVE_COMPOSER} .button`);
			await page.waitForSelector("dialog.providers-dialog[open] .provider-row");
			await page.click('.provider-row[data-provider-id="fixture"]');
			await page.waitForSelector(".provider-key input");
			await page.type(".provider-key input", "sk-onboarding-key");
			const lists = (await heldModelLists(page)).length;
			await page.keyboard.press("Enter");
			// The snapshot that carries models hides the notice before this conversation's catalog answers.
			await page.waitForFunction(() => !document.querySelector(".provider-notice"));
			expect((await heldModelLists(page)).length).toBeGreaterThan(lists);
			await page.waitForFunction(() =>
				document.querySelector("dialog.providers-dialog")?.textContent?.includes("Connected · 2 models available"),
			);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			await answerModelLists(page, lists, [fixtureModel]);
			expect(await page.$(NOTICE)).toBeNull();
		} finally {
			await context.close();
		}
	}, 30000);

	test("Settings -> Account summarizes models, and Manage providers stacks the dialog with Escape returning to it", async () => {
		const { context, page } = await fixture();
		try {
			await page.waitForSelector(DOCKED);
			await page.click('button[aria-label="Settings"], button[title="Settings"]');
			await page.waitForSelector(".settings-tabs");
			await page.evaluate(() =>
				[...document.querySelectorAll<HTMLButtonElement>(".settings-tab")]
					.find(tab => tab.textContent?.trim() === "Account")
					?.click(),
			);
			const panel = ".settings-panel:not([hidden])";
			await page.waitForFunction(
				selector => document.querySelector(selector)?.textContent?.includes("Manage providers"),
				{},
				panel,
			);
			expect(await page.$eval(`${panel} .providers-summary [role=status]`, node => node.textContent)).toBe(
				"No models available yet.",
			);
			await page.click(`${panel} .providers-summary .button`);
			await page.waitForSelector("dialog.providers-dialog[open]");
			// Stacked: Settings stays open underneath, and the Providers dialog is the top layer.
			expect(
				(await page.$$eval("dialog[open] > header h2", nodes => nodes.map(node => node.textContent ?? ""))).sort(),
			).toEqual(["Providers", "Settings"]);
			expect(
				await page.evaluate(() => {
					const rect = document.querySelector("dialog.providers-dialog")!.getBoundingClientRect();
					const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24);
					return hit?.closest("dialog")?.classList.contains("providers-dialog");
				}),
			).toBe(true);
			await page.click('.provider-row[data-provider-id="fixture"]');
			await page.waitForSelector(".provider-key input");
			await page.type(".provider-key input", "sk-settings-key");
			await page.keyboard.press("Enter");
			await page.waitForFunction(() =>
				document.querySelector("dialog.providers-dialog")?.textContent?.includes("Connected · 2 models available"),
			);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			expect(await page.$$eval("dialog[open] > header h2", nodes => nodes.map(node => node.textContent))).toEqual([
				"Settings",
			]);
			expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Manage providers");
			expect(await page.$eval(`${panel} .providers-summary [role=status]`, node => node.textContent)).toBe(
				"1 provider with models · 2 models available",
			);
		} finally {
			await context.close();
		}
	}, 30000);

	test("with models elsewhere, the composer names what is missing and opens the dialog from Manage providers", async () => {
		const { context, page } = await fixture({ holdModelLists: true, options: { zeroModels: false } });
		try {
			await select(page, "Oldest conversation · Idle");
			await answerModelLists(page, 0, []);
			await page.waitForFunction(() => document.querySelector(".composer .model-control-status"));
			// The snapshot has models, so this is not onboarding: the composer says what is missing here.
			expect(await page.$(NOTICE)).toBeNull();
			expect(await composerStatus(page)).toEqual([
				"No models are available for this conversation.",
				"Manage providers",
			]);
			await page.click(".composer .model-controls > .button:not(.model-trigger)");
			await page.waitForSelector("dialog.providers-dialog[open]");
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			// The catalog has models, but not the one this conversation names.
			const lists = (await heldModelLists(page)).length;
			await page.evaluate(resnapshot);
			await answerModelLists(page, lists, [{ ...fixtureModel, id: "fixture/other", name: "Other" }]);
			await page.waitForFunction(() =>
				document
					.querySelector(".composer .model-control-status")
					?.textContent?.includes("Choose a model to start."),
			);
			expect(await composerStatus(page)).toEqual(["Choose a model to start."]);
		} finally {
			await context.close();
		}
	}, 30000);
});
