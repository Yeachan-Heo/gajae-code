import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopMethod, DesktopRequest } from "@gajae-code/desktop-host/protocol";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { browserPath } from "./component-fixture";
import { installNavigationFixture } from "./fixtures/navigation";

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

/** The mounted App on the page-owned navigation transport, with the idle "old" conversation selected. */
async function fixture(): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport({ width: 1400, height: 900 });
		await page.evaluateOnNewDocument(installNavigationFixture, false);
		await page.goto(origin);
		await page.waitForSelector(".session-row");
		await page.click('.session-select[title="Oldest conversation · Idle"]');
		await page.waitForSelector('.session-select[title="Oldest conversation · Idle"][aria-current="page"]');
		for (const method of ["tools.list", "tools.set"] satisfies DesktopMethod[]) {
			await page.evaluate(method => {
				const transport = (
					window as unknown as {
						__TAURI_INTERNALS__: { invoke(command: string, args?: { request?: DesktopRequest }): Promise<unknown> };
					}
				).__TAURI_INTERNALS__;
				const invoke = transport.invoke.bind(transport);
				transport.invoke = (command, args) => {
					if (command === "engine_request" && args?.request?.method === method) {
						window.navigationFixture.requests().push(args.request);
						return Promise.resolve();
					}
					return invoke(command, args);
				};
			}, method);
		}
		return { context, page };
	} catch (error) {
		await context.close();
		throw error;
	}
}

async function held(page: Page, method: DesktopMethod): Promise<DesktopRequest[]> {
	return page.evaluate(
		method => window.navigationFixture.requests().filter(request => request.method === method),
		method,
	);
}

async function waitHeld(page: Page, method: DesktopMethod, count: number): Promise<DesktopRequest[]> {
	await page.waitForFunction(
		(method, count) =>
			window.navigationFixture.requests().filter(request => request.method === method).length >= count,
		{},
		method,
		count,
	);
	return held(page, method);
}

async function answer(page: Page, requests: DesktopRequest[], result: unknown): Promise<void> {
	await page.evaluate(
		(ids, result) => {
			for (const id of ids) window.navigationFixture.emit({ type: "response", id, ok: true, result });
		},
		requests.map(request => request.id),
		result,
	);
}

async function openTools(page: Page): Promise<void> {
	await page.click('button[aria-label="Conversation actions menu"]');
	await page.waitForSelector('dialog[open] [aria-label="Conversation actions"]');
	await page.evaluate(() => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>('[aria-label="Conversation actions"] button'),
		].find(button => button.textContent?.trim() === "Manage active tools");
		if (!button) throw new Error("Missing Manage active tools");
		button.click();
	});
	await page.waitForFunction(() => document.querySelector("dialog[open] h2")?.textContent === "Active tools");
}

interface DialogReading {
	text: string;
	tools: Array<{ name: string; checked: boolean }>;
	saveDisabled: boolean;
	status: string[];
	errors: string[];
}

async function read(page: Page): Promise<DialogReading> {
	return page.$eval("dialog[open]", dialog => ({
		text: dialog.querySelector(".modal-content")?.textContent ?? "",
		tools: [...dialog.querySelectorAll<HTMLLabelElement>("label.checkbox-label")].map(label => ({
			name: label.textContent ?? "",
			checked: label.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked ?? false,
		})),
		saveDisabled:
			[...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
				button => button.textContent?.trim() === "Save tools",
			)?.disabled ?? true,
		status: [...dialog.querySelectorAll('[role="status"]')].map(node => node.textContent ?? ""),
		errors: [...dialog.querySelectorAll(".error-banner")].map(node => node.textContent ?? ""),
	}));
}

suite("Active tools dialog", () => {
	test("lists the conversation's tools and saves the checked names", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			await waitHeld(page, "tools.list", 1);
			await Bun.sleep(100);
			// One read per open, including under the development StrictMode remount.
			const reads = await held(page, "tools.list");
			expect(reads.map(request => request.params)).toEqual([{ sessionId: "old" }]);
			expect(await read(page)).toMatchObject({ tools: [], saveDisabled: true, errors: [] });
			expect((await read(page)).text).toContain("Loading tools…");

			await answer(page, reads, { available: ["read", "bash", "python"], active: ["read"] });
			await page.waitForSelector("dialog[open] label.checkbox-label");
			expect(await read(page)).toMatchObject({
				tools: [
					{ name: "read", checked: true },
					{ name: "bash", checked: false },
					{ name: "python", checked: false },
				],
				saveDisabled: false,
				status: [],
				errors: [],
			});

			await page.evaluate(() => {
				const labels = [...document.querySelectorAll<HTMLLabelElement>("dialog[open] label.checkbox-label")];
				labels.find(label => label.textContent === "bash")?.querySelector("input")?.click();
			});
			await page.waitForFunction(
				() =>
					[...document.querySelectorAll<HTMLLabelElement>("dialog[open] label.checkbox-label")].find(
						label => label.textContent === "bash",
					)?.querySelector("input")?.checked === true,
			);
			await page.evaluate(() => {
				const button = [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(
					button => button.textContent?.trim() === "Save tools",
				);
				button?.click();
			});
			const [save] = await waitHeld(page, "tools.set", 1);
			expect(save!.params).toEqual({ sessionId: "old", names: ["read", "bash"] });
			// The read and the save share one pending state, so the list yields to the loading line.
			expect(await read(page)).toMatchObject({ tools: [], saveDisabled: true });
			expect((await read(page)).text).toContain("Loading tools…");

			await answer(page, [save!], null);
			await page.waitForSelector("dialog[open] label.checkbox-label");
			expect(await read(page)).toMatchObject({
				tools: [
					{ name: "read", checked: true },
					{ name: "bash", checked: true },
					{ name: "python", checked: false },
				],
				saveDisabled: false,
				status: ["Active tools saved."],
				errors: [],
			});
			expect(await held(page, "tools.set")).toHaveLength(1);

			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
		} finally {
			await context.close();
		}
	}, 30000);

	test("a failed or malformed read is shown and keeps Save unavailable", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			const failed = await waitHeld(page, "tools.list", 1);
			await page.evaluate(
				ids => {
					for (const id of ids)
						window.navigationFixture.emit({ type: "response", id, ok: false, error: "Tool registry unavailable" });
				},
				failed.map(request => request.id),
			);
			await page.waitForSelector("dialog[open] .error-banner");
			expect(await read(page)).toMatchObject({
				tools: [],
				saveDisabled: true,
				errors: ["Tool registry unavailable"],
			});
			expect((await read(page)).text).toContain("No tools are available.");

			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
			const before = failed.length;
			await openTools(page);
			const reads = (await waitHeld(page, "tools.list", before + 1)).slice(before);
			expect((await read(page)).errors).toEqual([]);
			await answer(page, reads, { available: ["read", 7], active: [] });
			await page.waitForSelector("dialog[open] .error-banner");
			expect(await read(page)).toMatchObject({
				tools: [],
				saveDisabled: true,
				errors: ["The tool list response format is invalid."],
			});
		} finally {
			await context.close();
		}
	}, 30000);

	test("a read answered after its dialog closed never fills a reopened dialog", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			const stale = await waitHeld(page, "tools.list", 1);
			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
			await openTools(page);
			const reads = (await waitHeld(page, "tools.list", stale.length + 1)).slice(stale.length);
			expect([stale.length, reads.length]).toEqual([1, 1]);

			await answer(page, stale, { available: ["stale-tool"], active: ["stale-tool"] });
			await Bun.sleep(100);
			expect((await read(page)).text).toContain("Loading tools…");

			await answer(page, reads, { available: ["read"], active: [] });
			await page.waitForSelector("dialog[open] label.checkbox-label");
			expect((await read(page)).tools).toEqual([{ name: "read", checked: false }]);
		} finally {
			await context.close();
		}
	}, 30000);
});
