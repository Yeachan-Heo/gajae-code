import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopMethod,
	DesktopRequest,
} from "@gajae-code/desktop-host/protocol";
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

const provider = (id: string, name: string, overrides: Partial<DesktopAuthProvider> = {}): DesktopAuthProvider => ({
	id,
	name,
	configured: false,
	stored: false,
	credentialKinds: [],
	canSignIn: true,
	canStoreKey: true,
	...overrides,
});
const fixtureProviders: DesktopAuthProvider[] = [
	provider("fixture", "Fixture Cloud", { canSignIn: false }),
	provider("google-gemini-cli", "Google Cloud Code Assist (Gemini CLI)"),
	provider("openai", "openai", { canSignIn: false }),
];
const GEMINI = "google-gemini-cli";
const FLOW = "00000000-0000-4000-8000-0000000000c1";
const WARNING = "00000000-0000-4000-8000-0000000000c2";
const warningMessage = "⚠️  WARNING: fixture provider risk notice";

/** The mounted App on the page-owned navigation transport, with the idle "old" conversation selected. */
async function fixture(options: NavigationFixtureOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluateOnNewDocument(installNavigationFixture, false, { providers: fixtureProviders, ...options });
		await page.goto(origin);
		await page.waitForSelector(".session-row");
		await page.click('.session-select[title="Oldest conversation · Idle"]');
		await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function emitAuth(page: Page, auth: DesktopAuthState): Promise<void> {
	await page.evaluate(value => window.navigationFixture.emit({ type: "auth", auth: value }), auth);
}
async function sent(page: Page, method: DesktopMethod): Promise<DesktopRequest["params"][]> {
	return page.evaluate(
		method =>
			window.navigationFixture
				.requests()
				.filter(request => request.method === method)
				.map(request => request.params),
		method,
	);
}
async function dialogTitles(page: Page): Promise<string[]> {
	return page.$$eval("dialog[open] > header h2", nodes => nodes.map(node => node.textContent ?? ""));
}
/** Opens the Providers dialog from the model picker's add-providers action. */
async function openFromModelPicker(page: Page): Promise<void> {
	await page.waitForSelector(".model-trigger:not([disabled])");
	await page.click(".model-trigger");
	await page.waitForSelector("dialog[open] .model-provider-actions button");
	await page.click("dialog[open] .model-provider-actions button");
	await page.waitForFunction(() => document.querySelector("dialog.providers-dialog[open]"));
	await page.waitForFunction(
		() => !document.querySelector(".providers-panel .provider-summary")?.textContent?.includes("Loading"),
	);
}
async function clickInDialog(page: Page, text: string): Promise<void> {
	await page.evaluate(label => {
		const button = [...document.querySelectorAll<HTMLButtonElement>("dialog.providers-dialog[open] button")].find(
			node => node.textContent?.trim() === label,
		);
		if (!button) throw new Error(`Missing button: ${label}`);
		button.click();
	}, text);
}
async function dialogButtons(page: Page): Promise<string[]> {
	return page.$$eval("dialog.providers-dialog[open] .providers-panel button", nodes =>
		nodes.map(node => node.textContent?.trim() ?? ""),
	);
}
async function waitDialogText(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		value => document.querySelector("dialog.providers-dialog[open]")?.textContent?.includes(value),
		{},
		text,
	);
}

suite("Providers dialog in the mounted app", () => {
	test("the model picker hands over to the dialog, which focuses search and returns focus to the model trigger", async () => {
		const { context, page } = await fixture();
		try {
			await openFromModelPicker(page);
			// The picker closed itself first: only the Providers dialog is open.
			expect(await dialogTitles(page)).toEqual(["Providers"]);
			expect(await page.evaluate(() => document.activeElement?.closest(".model-search") !== null)).toBe(true);
			expect(
				await page.$$eval("dialog.providers-dialog .provider-row", nodes =>
					nodes.map(node => node.getAttribute("data-provider-id")),
				),
			).toEqual(["fixture", GEMINI, "openai"]);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			expect(await page.evaluate(() => document.activeElement?.classList.contains("model-trigger"))).toBe(true);
		} finally {
			await context.close();
		}
	}, 30000);

	test("resumes a waiting provider warning; Continue answers with the literal confirm and Cancel goes through auth.cancel", async () => {
		const { context, page } = await fixture();
		try {
			await emitAuth(page, {
				id: FLOW,
				provider: GEMINI,
				status: "waiting",
				warning: { id: WARNING, message: warningMessage },
			});
			await openFromModelPicker(page);
			await page.waitForSelector("dialog.providers-dialog .provider-warning");
			expect(await page.$eval(".provider-warning p", node => node.textContent)).toBe(warningMessage);
			expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H5");
			await clickInDialog(page, "Continue");
			await page.waitForFunction(() => !document.querySelector(".provider-warning"));
			expect(await sent(page, "auth.answer")).toEqual([{ flowId: FLOW, promptId: WARNING, value: "confirm" }]);
			// Authorizing again: no confirmation is offered even if a warning were still attached.
			await emitAuth(page, {
				id: FLOW,
				provider: GEMINI,
				status: "authorizing",
				warning: { id: WARNING, message: warningMessage },
			});
			await waitDialogText(page, "Notice from");
			expect(await dialogButtons(page)).not.toContain("Continue");
			// Waiting on the warning again: Cancel sign-in declines through auth.cancel.
			await emitAuth(page, {
				id: FLOW,
				provider: GEMINI,
				status: "waiting",
				warning: { id: WARNING, message: warningMessage },
			});
			await page.waitForSelector(".provider-warning button");
			expect((await dialogButtons(page)).filter(label => label === "Cancel sign-in")).toHaveLength(1);
			await clickInDialog(page, "Cancel sign-in");
			await waitDialogText(page, "Sign-in cancelled");
			expect(await sent(page, "auth.cancel")).toEqual([{ flowId: FLOW }]);
			expect(await sent(page, "auth.answer")).toHaveLength(1);
		} finally {
			await context.close();
		}
	}, 30000);

	test("an answer the sign-in waits on takes focus, whether it was pending at opening or arrives while open", async () => {
		const { context, page } = await fixture();
		const activeType = () => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type);
		try {
			await emitAuth(page, {
				id: FLOW,
				provider: GEMINI,
				status: "waiting",
				prompt: { id: "00000000-0000-4000-8000-0000000000c3", message: "Paste the fixture code" },
			});
			await openFromModelPicker(page);
			await page.waitForSelector("dialog.providers-dialog .provider-prompt input");
			expect(await activeType()).toBe("password");
			await emitAuth(page, { id: FLOW, provider: GEMINI, status: "cancelled" });
			await waitDialogText(page, "Sign-in cancelled");
			// A sign-in started in the open dialog whose provider then asks for an answer.
			await clickInDialog(page, "Try again");
			await waitDialogText(page, "Signing in to Google Cloud Code Assist (Gemini CLI)");
			const running = await page.evaluate(() => window.navigationFixture.authState());
			if (!running) throw new Error("Expected the running sign-in");
			await emitAuth(page, {
				...running,
				status: "waiting",
				prompt: { id: "00000000-0000-4000-8000-0000000000c4", message: "Paste the second fixture code" },
			});
			await waitDialogText(page, "Paste the second fixture code");
			expect(await activeType()).toBe("password");
			expect(await page.evaluate(() => document.activeElement?.closest("dialog.providers-dialog") !== null)).toBe(true);
		} finally {
			await context.close();
		}
	}, 30000);

	test("a flow that finished before opening is history; closing never cancels a running sign-in and reopening resumes it", async () => {
		const { context, page } = await fixture();
		try {
			await emitAuth(page, { id: FLOW, provider: GEMINI, status: "error", error: "Authorization failed" });
			await openFromModelPicker(page);
			expect(
				await page.$eval(`.provider-row[data-provider-id="${GEMINI}"] .provider-status`, node => node.textContent),
			).toBe("Not connected");
			await page.click(`.provider-row[data-provider-id="${GEMINI}"]`);
			await page.waitForSelector(".provider-detail");
			expect(await page.$(".provider-flow")).toBeNull();
			await clickInDialog(page, "Sign in");
			await waitDialogText(page, "Signing in to Google Cloud Code Assist (Gemini CLI)");
			expect(await sent(page, "auth.login")).toEqual([{ provider: GEMINI }]);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => !document.querySelector("dialog.providers-dialog"));
			expect(await sent(page, "auth.cancel")).toEqual([]);
			await openFromModelPicker(page);
			await waitDialogText(page, "Signing in to Google Cloud Code Assist (Gemini CLI)");
			// A sign-in this dialog resumed reports its own outcome; a stranger's never does.
			const running = await page.evaluate(() => window.navigationFixture.authState());
			if (!running) throw new Error("Expected the running sign-in");
			await emitAuth(page, { ...running, status: "error", error: "Authorization failed" });
			await waitDialogText(page, "Sign-in failed");
			expect(await dialogButtons(page)).toContain("Try again");
			await emitAuth(page, { id: FLOW, provider: GEMINI, status: "error", error: "Someone else's flow" });
			await page.waitForFunction(() => !document.querySelector(".provider-flow"));
			expect(await dialogButtons(page)).toContain("Sign in");
		} finally {
			await context.close();
		}
	}, 30000);

	test("saves a trimmed key, refuses a command key without a request and reports the provider's models", async () => {
		const { context, page } = await fixture();
		try {
			await openFromModelPicker(page);
			await page.click('.provider-row[data-provider-id="openai"]');
			await page.waitForSelector(".provider-key input");
			await page.type(".provider-key input", "!op read secret");
			await page.keyboard.press("Enter");
			await waitDialogText(page, "terminal command");
			expect(await sent(page, "auth.setKey")).toEqual([]);
			await page.type(".provider-key input", "  sk-fixture-key  ");
			await page.keyboard.press("Enter");
			await waitDialogText(page, "Connected · 1 model available");
			expect(await sent(page, "auth.setKey")).toEqual([{ provider: "openai", key: "sk-fixture-key" }]);
			expect(await page.evaluate(() => document.body.innerHTML.includes("sk-fixture-key"))).toBe(false);
			await clickInDialog(page, "Back to providers");
			await page.waitForSelector('.provider-row[data-provider-id="openai"]');
			// The re-read provider list now places it under Connected.
			await page.waitForFunction(() =>
				document.querySelector('.provider-group[aria-label="Connected"] .provider-row[data-provider-id="openai"]'),
			);
			expect(await page.evaluate(() => document.activeElement?.getAttribute("data-provider-id"))).toBe("openai");
		} finally {
			await context.close();
		}
	}, 30000);
});
