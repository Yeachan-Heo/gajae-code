import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DesktopMethod, DesktopRequest, DesktopSession } from "@gajae-code/desktop-host/protocol";
import type { DesktopToolList } from "@gajae-code/desktop-host/tool-protocol";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { editedToolNames, parseToolList } from "../src/ToolCatalogDialog";
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
						__TAURI_INTERNALS__: {
							invoke(command: string, args?: { request?: DesktopRequest }): Promise<unknown>;
						};
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
	await page.waitForFunction(() => document.querySelector("dialog[open] h2")?.textContent === "Tools");
}

interface DialogReading {
	text: string;
	sections: string[];
	tools: Array<{ name: string; checked: boolean; disabled: boolean; tags: string[] }>;
	saveDisabled: boolean;
	status: string[];
	errors: string[];
}

async function read(page: Page): Promise<DialogReading> {
	return page.$eval("dialog[open]", dialog => ({
		text: dialog.querySelector(".modal-content")?.textContent ?? "",
		sections: [...dialog.querySelectorAll(".tool-catalog-section > h3")].map(node => node.textContent ?? ""),
		tools: [...dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox][data-tool-name]")].map(box => ({
			name: box.dataset.toolName ?? "",
			checked: box.checked,
			disabled: box.disabled,
			tags: [...(box.closest("li")?.querySelectorAll(".tool-catalog-tag") ?? [])].map(tag => tag.textContent ?? ""),
		})),
		saveDisabled:
			[...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
				button => button.textContent?.trim() === "Save tools",
			)?.disabled ?? true,
		status: [...dialog.querySelectorAll('[role="status"]')].map(node => node.textContent ?? "").filter(Boolean),
		errors: [...dialog.querySelectorAll(".error-banner")].map(node => node.textContent ?? ""),
	}));
}

async function toggle(page: Page, name: string): Promise<void> {
	await page.click(`dialog[open] input[data-tool-name="${name}"]`);
}

async function clickButton(page: Page, text: string): Promise<void> {
	await page.evaluate(text => {
		const button = [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(
			button => button.textContent?.trim() === text,
		);
		if (!button) throw new Error(`Missing button ${text}`);
		button.click();
	}, text);
}

async function focusedTool(page: Page): Promise<string | null> {
	return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.toolName ?? null);
}

/** Replaces the "old" conversation in the fixture snapshot, the way a Host session frame does. */
async function updateSession(page: Page, patch: Partial<DesktopSession>): Promise<void> {
	await page.evaluate(patch => {
		const session = window.navigationFixture.snapshot().sessions.find(item => item.id === "old");
		if (!session) throw new Error("Missing old session");
		window.navigationFixture.emit({ type: "session", session: { ...session, ...patch } });
	}, patch);
}

const catalog = {
	available: ["read", "bash", "todo_write", "mcp_github_search"],
	active: ["read", "bash"],
	tools: [
		{
			name: "read",
			label: "Read",
			description: "Read files and URLs",
			active: true,
			origin: "essential",
			discovered: false,
		},
		{
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			active: true,
			origin: "essential",
			discovered: false,
		},
		{
			name: "todo_write",
			label: "Todo Write",
			description: "작업 목록을 단계별로 기록합니다.",
			active: false,
			origin: "discoverable",
			discovered: false,
			hidden: true,
		},
		{
			name: "mcp_github_search",
			label: "github/search",
			description: "Search GitHub issues",
			active: false,
			origin: "discoverable",
			discovered: false,
			hidden: true,
			mcpServer: "github",
		},
	],
	discovery: { enabled: true },
} satisfies DesktopToolList;

describe("tools to save", () => {
	test("keep every active tool, including those past the catalog's description bound", () => {
		// The Host describes only the first 400 tools; activity always comes from the full lists.
		const names = Array.from({ length: 405 }, (_, index) => `tool_${index}`);
		const parsed = parseToolList({ available: names, active: names, tools: [] })!;
		expect(editedToolNames(parsed, new Map([["tool_2", false]]))).toEqual(names.filter(name => name !== "tool_2"));
		expect(editedToolNames(parsed, new Map())).toHaveLength(405);
	});
});

suite("Tools dialog", () => {
	test("lists the conversation's tools, saves the edited set and re-reads it", async () => {
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

			// An older Host's names-only answer still lists every tool.
			await answer(page, reads, { available: ["read", "bash", "python"], active: ["read"] });
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			// Save stays off until something changes: an unchanged save would still record an explicit selection.
			expect(await read(page)).toMatchObject({
				sections: ["Active 1", "Available 2"],
				tools: [
					{ name: "read", checked: true },
					{ name: "bash", checked: false },
					{ name: "python", checked: false },
				],
				saveDisabled: true,
				status: [],
				errors: [],
			});
			// The search field takes focus once the list lands.
			expect(await page.evaluate(() => document.activeElement?.closest(".model-search") !== null)).toBe(true);

			await toggle(page, "bash");
			expect(await read(page)).toMatchObject({
				sections: ["Active 1", "Available 2"],
				tools: [
					{ name: "read", checked: true },
					{ name: "bash", checked: true },
					{ name: "python", checked: false },
				],
				saveDisabled: false,
				status: ["1 unsaved change"],
			});
			await clickButton(page, "Save tools");
			// Save first reads the tools active now, then applies the edit to them.
			const [, current] = await waitHeld(page, "tools.list", 2);
			await answer(page, [current!], { available: ["read", "bash", "python"], active: ["read"] });
			const [save] = await waitHeld(page, "tools.set", 1);
			expect(save!.params).toEqual({ sessionId: "old", names: ["read", "bash"] });
			// The list stays in place while saving, so the query, scroll and focus survive; it is locked meanwhile.
			expect(await read(page)).toMatchObject({
				tools: [
					{ name: "read", disabled: true },
					{ name: "bash", disabled: true },
					{ name: "python", disabled: true },
				],
				saveDisabled: true,
				status: ["Saving tools…"],
			});

			await answer(page, [save!], null);
			// A save is followed by one fresh read, which replaces the edits with what the SDK applied.
			const [reread] = (await waitHeld(page, "tools.list", 3)).slice(2);
			expect(reread!.params).toEqual({ sessionId: "old" });
			await answer(page, [reread!], { available: ["read", "bash", "python"], active: ["read", "bash"] });
			await page.waitForFunction(
				() => document.querySelector("dialog[open] .tool-catalog-section > h3")?.textContent === "Active 2",
			);
			expect(await read(page)).toMatchObject({
				sections: ["Active 2", "Available 1"],
				tools: [
					{ name: "bash", checked: true, disabled: false },
					{ name: "read", checked: true, disabled: false },
					{ name: "python", checked: false, disabled: false },
				],
				saveDisabled: true,
				status: ["Tools saved."],
				errors: [],
			});
			expect(await held(page, "tools.set")).toHaveLength(1);
			expect(await held(page, "tools.list")).toHaveLength(3);

			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
			// Closing returns focus to the toolbar control that opened Conversation actions.
			await page.waitForFunction(
				() => document.activeElement?.getAttribute("aria-label") === "Conversation actions menu",
			);
		} finally {
			await context.close();
		}
	}, 30000);

	test("searches names, labels and descriptions, and moves between rows with the arrow keys", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			await answer(page, await waitHeld(page, "tools.list", 1), catalog);
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			expect(await read(page)).toMatchObject({
				sections: ["Active 2", "Available 2"],
				tools: [
					{ name: "bash", tags: ["Essential"] },
					{ name: "read", tags: ["Essential"] },
					{ name: "mcp_github_search", tags: ["Hidden until searched", "MCP · github"] },
					{ name: "todo_write", tags: ["Hidden until searched"] },
				],
			});
			expect((await read(page)).text).toContain("2 active · 2 available");

			const search = "dialog[open] .model-search input";
			await page.type(search, "단계");
			expect((await read(page)).tools.map(tool => tool.name)).toEqual(["todo_write"]);
			expect((await read(page)).sections).toEqual(["Available 1"]);
			await page.$eval(search, input => {
				(input as HTMLInputElement).select();
			});
			await page.type(search, "ＧＩＴＨＵＢ");
			expect((await read(page)).tools.map(tool => tool.name)).toEqual(["mcp_github_search"]);
			await page.$eval(search, input => {
				(input as HTMLInputElement).select();
			});
			await page.type(search, "zzz");
			expect(await read(page)).toMatchObject({ tools: [], sections: [] });
			expect((await read(page)).text).toContain("No tools match “zzz”.");

			await page.$eval(search, input => {
				(input as HTMLInputElement).select();
			});
			await page.keyboard.press("Backspace");
			await page.focus(search);
			await page.keyboard.press("ArrowDown");
			expect(await focusedTool(page)).toBe("bash");
			await page.keyboard.press("ArrowDown");
			expect(await focusedTool(page)).toBe("read");
			// Navigation crosses from Active into Available like one list.
			await page.keyboard.press("ArrowDown");
			expect(await focusedTool(page)).toBe("mcp_github_search");
			await page.keyboard.press("End");
			expect(await focusedTool(page)).toBe("todo_write");
			await page.keyboard.press("ArrowDown");
			expect(await focusedTool(page)).toBe("todo_write");
			await page.keyboard.press("Home");
			expect(await focusedTool(page)).toBe("bash");
			await page.keyboard.press("Space");
			expect((await read(page)).tools[0]).toMatchObject({ name: "bash", checked: false });
			expect((await read(page)).sections).toEqual(["Active 2", "Available 2"]);
		} finally {
			await context.close();
		}
	}, 30000);

	test("Save waits while a turn runs, and a new tool-search result re-reads the list", async () => {
		const { context, page } = await fixture();
		try {
			await updateSession(page, {
				messages: [{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" }],
			});
			await openTools(page);
			await answer(page, await waitHeld(page, "tools.list", 1), catalog);
			await page.waitForSelector("dialog[open] input[data-tool-name]");

			// A turn starts while the dialog is open. A tool-search row that is still running is not a result yet.
			await updateSession(page, {
				status: "running",
				messages: [
					{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" },
					{
						id: "call:search-1",
						role: "tool",
						toolName: "search_tool_bm25",
						text: "",
						tool: { callId: "search-1", status: "running", family: "tool-search", detail: false },
					},
				],
			});
			await toggle(page, "todo_write");
			await page.waitForFunction(() => document.body.textContent?.includes("You can save when this turn ends."));
			expect(await read(page)).toMatchObject({ saveDisabled: true });
			await toggle(page, "todo_write");
			expect((await read(page)).status).toEqual([]);

			// With nothing edited, a settled tool-search result re-reads the list.
			await updateSession(page, {
				status: "running",
				messages: [
					{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" },
					{
						id: "search-result-1",
						role: "tool",
						toolName: "search_tool_bm25",
						text: '{"activated_tools":["todo_write"]}',
					},
				],
			});
			const [reread] = (await waitHeld(page, "tools.list", 2)).slice(1);
			await answer(page, [reread!], {
				...catalog,
				active: ["read", "bash", "todo_write"],
				tools: catalog.tools.map(tool =>
					tool.name === "todo_write" ? { ...tool, active: true, discovered: true, hidden: undefined } : tool,
				),
			});
			await page.waitForFunction(
				() => document.querySelector("dialog[open] .tool-catalog-section > h3")?.textContent === "Active 3",
			);
			expect((await read(page)).tools.find(tool => tool.name === "todo_write")).toMatchObject({
				checked: true,
				tags: ["Found by tool search"],
			});
			// The focused row moved to Active and was remounted there; focus followed it.
			expect(await focusedTool(page)).toBe("todo_write");

			// Over unsaved edits, the next result does not move rows under the user: Save waits for a reload.
			await toggle(page, "read");
			await updateSession(page, {
				status: "idle",
				messages: [
					{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" },
					{ id: "search-result-1", role: "tool", toolName: "search_tool_bm25", text: "{}" },
					{ id: "search-result-2", role: "tool", toolName: "search_tool_bm25", text: "{}" },
				],
			});
			await page.waitForFunction(() =>
				document.body.textContent?.includes("A tool search changed this conversation"),
			);
			await Bun.sleep(100);
			expect(await held(page, "tools.list")).toHaveLength(2);
			expect(await read(page)).toMatchObject({ saveDisabled: true });
			await page.click("dialog[open] .tool-catalog-changed button");
			const [reload] = (await waitHeld(page, "tools.list", 3)).slice(2);
			await answer(page, [reload!], {
				...catalog,
				active: ["read", "bash", "todo_write", "mcp_github_search"],
				tools: catalog.tools.map(tool =>
					tool.name === "todo_write"
						? { ...tool, active: true, discovered: true, hidden: undefined }
						: tool.name === "mcp_github_search"
							? { ...tool, active: true, hidden: undefined }
							: tool,
				),
			});
			await page.waitForFunction(
				() => document.querySelector("dialog[open] .tool-catalog-section > h3")?.textContent === "Active 4",
			);
			// The reload keeps the edit on top of the new list, and focus returns to the search field.
			expect(await read(page)).toMatchObject({ saveDisabled: false, status: ["1 unsaved change"] });
			expect((await read(page)).tools.find(tool => tool.name === "read")).toMatchObject({ checked: false });
			expect((await read(page)).tools.find(tool => tool.name === "mcp_github_search")).toMatchObject({
				checked: true,
				tags: ["MCP · github"],
			});
			expect(await page.evaluate(() => document.activeElement?.closest(".model-search") !== null)).toBe(true);
			await clickButton(page, "Save tools");
			const [current] = (await waitHeld(page, "tools.list", 4)).slice(3);
			await answer(page, [current!], {
				...catalog,
				active: ["read", "bash", "todo_write", "mcp_github_search"],
			});
			const [save] = await waitHeld(page, "tools.set", 1);
			expect(save!.params).toEqual({ sessionId: "old", names: ["bash", "todo_write", "mcp_github_search"] });
		} finally {
			await context.close();
		}
	}, 30000);

	test("Save re-reads the tools and applies only the user's changes to the ones active now", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			await answer(page, await waitHeld(page, "tools.list", 1), catalog);
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			await toggle(page, "bash");
			await toggle(page, "todo_write");
			await clickButton(page, "Save tools");
			// Nothing is saved from the list read when the dialog opened.
			const [, before] = await waitHeld(page, "tools.list", 2);
			await Bun.sleep(100);
			expect(await held(page, "tools.set")).toHaveLength(0);
			expect((await read(page)).status).toEqual(["Saving tools…"]);
			// Meanwhile an MCP reconnect turned a tool on; the save keeps it and applies the two changes.
			await answer(page, [before!], { ...catalog, active: ["read", "bash", "mcp_github_search"] });
			const [save] = await waitHeld(page, "tools.set", 1);
			expect(save!.params).toEqual({ sessionId: "old", names: ["read", "mcp_github_search", "todo_write"] });
			await answer(page, [save!], null);
			const [, , after] = await waitHeld(page, "tools.list", 3);
			await answer(page, [after!], { ...catalog, active: ["read", "mcp_github_search", "todo_write"] });
			await page.waitForFunction(() => document.body.textContent?.includes("Tools saved."));

			// A re-read that fails saves nothing and keeps the changes.
			await toggle(page, "read");
			await clickButton(page, "Save tools");
			const [, , , failing] = await waitHeld(page, "tools.list", 4);
			await page.evaluate(id => {
				window.navigationFixture.emit({ type: "response", id, ok: false, error: "Session changed" });
			}, failing!.id);
			await page.waitForFunction(() => document.querySelector("dialog[open] .error-banner") !== null);
			expect(await held(page, "tools.set")).toHaveLength(1);
			expect(await read(page)).toMatchObject({ errors: ["Session changed"], status: ["1 unsaved change"] });

			// A malformed re-read saves nothing either: the list from the earlier read is not used instead.
			await clickButton(page, "Save tools");
			const [, , , , malformed] = await waitHeld(page, "tools.list", 5);
			await answer(page, [malformed!], { available: "read", active: ["read"] });
			// Wait for either outcome, so a save from the stale list fails here rather than timing out.
			await page.waitForFunction(
				() =>
					document.querySelector("dialog[open] .error-banner")?.textContent?.includes("format is invalid") ||
					window.navigationFixture.requests().filter(request => request.method === "tools.set").length > 1,
			);
			await Bun.sleep(100);
			expect(await held(page, "tools.set")).toHaveLength(1);
			expect(await read(page)).toMatchObject({
				errors: ["The tool list response format is invalid."],
				status: ["1 unsaved change"],
			});
			expect((await read(page)).tools.find(tool => tool.name === "read")).toMatchObject({ checked: false });
		} finally {
			await context.close();
		}
	}, 30000);

	test("only the list scrolls: search, the tool-search notice and Save stay in view in small windows and at 20 px text", async () => {
		const { context, page } = await fixture();
		try {
			const many = Array.from({ length: 30 }, (_, index) => ({
				name: `tool_${String(index).padStart(2, "0")}`,
				label: `Tool ${index}`,
				description: "A tool with a one-line description for the list.",
				active: index < 10,
				origin: "discoverable" as const,
				discovered: false,
			}));
			await updateSession(page, {
				messages: [{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" }],
			});
			await openTools(page);
			await answer(page, await waitHeld(page, "tools.list", 1), {
				available: many.map(tool => tool.name),
				active: many.filter(tool => tool.active).map(tool => tool.name),
				tools: many,
				discovery: { enabled: true },
			});
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			// An unsaved edit, then a new tool-search result: the notice that holds Save appears.
			await toggle(page, "tool_12");
			await updateSession(page, {
				messages: [
					{ id: "earlier-search", role: "tool", toolName: "search_tool_bm25", text: "{}" },
					{ id: "search-result-1", role: "tool", toolName: "search_tool_bm25", text: "{}" },
				],
			});
			await page.waitForSelector("dialog[open] .tool-catalog-changed");
			const layouts: Record<string, unknown> = {};
			const controls: Record<string, number[]> = {};
			for (const [width, height, text] of [
				[720, 520, 20],
				[720, 520, 14],
				[390, 844, 20],
				[390, 844, 14],
			] as const) {
				await page.setViewport({ width, height });
				await page.evaluate(size => document.documentElement.style.setProperty("--text-size", `${size}px`), text);
				await Bun.sleep(50);
				controls[`${width}x${height}@${text}`] = await page.evaluate(() =>
					["dialog[open] input[data-tool-name]", "dialog[open] .tool-catalog-head svg"].map(
						selector => document.querySelector(selector)!.getBoundingClientRect().width,
					),
				);
				layouts[`${width}x${height}@${text}`] = await page.evaluate(() => {
					const dialog = document.querySelector("dialog[open]")!;
					const inside = (node: Element | null | undefined) => {
						const box = node?.getBoundingClientRect();
						const frame = dialog.getBoundingClientRect();
						return !!box && box.top >= frame.top - 0.5 && box.bottom <= Math.min(frame.bottom, window.innerHeight) + 0.5;
					};
					const panel = dialog.querySelector(".tool-catalog")!;
					const list = dialog.querySelector(".tool-catalog-list")!;
					const save = [...dialog.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save tools");
					return {
						panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
						listScrolls: list.scrollHeight > list.clientHeight + 1,
						listShowsARow: list.clientHeight >= 48,
						pinned: [
							inside(dialog.querySelector(".tool-catalog-head input")),
							inside(dialog.querySelector(".tool-catalog-changed button")),
							inside(dialog.querySelector(".tool-catalog-status")),
							inside(save),
						],
					};
				});
			}
			const pinned = { panelScrolls: false, listScrolls: true, listShowsARow: true, pinned: [true, true, true, true] };
			expect(layouts).toEqual({
				"720x520@20": pinned,
				"720x520@14": pinned,
				"390x844@20": pinned,
				"390x844@14": pinned,
			});
			// Checkboxes and the search icon grow with the text size like the rest of the dialog.
			for (const [index, size] of controls["720x520@20"]!.entries())
				expect(size / controls["720x520@14"]![index]!).toBeGreaterThan(1.35);
		} finally {
			await context.close();
		}
	}, 30000);

	test("opens while a turn runs, so tool search can be watched, and holds Save until the turn ends", async () => {
		const { context, page } = await fixture();
		try {
			await updateSession(page, { status: "running" });
			await page.waitForSelector('.session-select[title="Oldest conversation · Working"]');
			await openTools(page);
			await answer(page, await waitHeld(page, "tools.list", 1), catalog);
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			await toggle(page, "todo_write");
			expect(await read(page)).toMatchObject({ saveDisabled: true });
			expect((await read(page)).text).toContain("You can save when this turn ends.");

			await updateSession(page, { status: "done" });
			await page.waitForFunction(() => !document.body.textContent?.includes("You can save when this turn ends."));
			expect(await read(page)).toMatchObject({ saveDisabled: false, status: ["1 unsaved change"] });
		} finally {
			await context.close();
		}
	}, 30000);

	test("a failed read offers a retry; a malformed read is refused", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			const failed = await waitHeld(page, "tools.list", 1);
			await page.evaluate(
				ids => {
					for (const id of ids)
						window.navigationFixture.emit({
							type: "response",
							id,
							ok: false,
							error: "Tool registry unavailable",
						});
				},
				failed.map(request => request.id),
			);
			await page.waitForSelector("dialog[open] .error-banner");
			expect(await read(page)).toMatchObject({
				tools: [],
				saveDisabled: true,
				errors: ["Tool registry unavailable"],
			});
			// A failed read is not an empty registry.
			expect((await read(page)).text).not.toContain("No tools are available.");
			await clickButton(page, "Try again");
			const [retry] = (await waitHeld(page, "tools.list", 2)).slice(1);
			await answer(page, [retry!], catalog);
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			expect(await read(page)).toMatchObject({ errors: [] });

			await page.keyboard.press("Escape");
			await page.waitForSelector("dialog[open]", { hidden: true });
			const before = (await held(page, "tools.list")).length;
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

	test("a conversation owned by another process shows the catalog as unavailable", async () => {
		const { context, page } = await fixture();
		try {
			await openTools(page);
			const reads = await waitHeld(page, "tools.list", 1);
			await page.evaluate(
				ids => {
					for (const id of ids)
						window.navigationFixture.emit({
							type: "response",
							id,
							ok: false,
							error: "The SDK owner does not support desktop tools.list. Use its original control surface.",
						});
				},
				reads.map(request => request.id),
			);
			await page.waitForSelector("dialog[open] .tool-catalog-unavailable");
			expect(await read(page)).toMatchObject({ tools: [], errors: [], saveDisabled: true });
			expect((await read(page)).text).toContain("Another gjc process owns this conversation");
			expect((await read(page)).text).not.toContain("Save tools");
		} finally {
			await context.close();
		}
	}, 30000);

	test("the showcase renders every Tools dialog and tool-search state without widening a 390 px page", async () => {
		const context = await browser.createBrowserContext();
		try {
			const page = await context.newPage();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(String(error)));
			await page.setViewport({ width: 390, height: 844 });
			await page.goto(`${origin}/?showcase`);
			await page.waitForSelector("#showcase-tool-catalog-empty");
			// Tool-search states render the real card, which loads its details like the app does.
			await page.waitForFunction(() => document.querySelectorAll("#showcase-tool-search .tool-search-body").length === 3);
			const layout = await page.evaluate(() => ({
				states: [...document.querySelectorAll("#showcase-tool-catalog .tool-catalog-showcase")].map(
					node => node.id,
				),
				searchStates: [...document.querySelectorAll("#showcase-tool-search .tool-catalog-showcase")].map(
					node => node.id,
				),
				searchCards: [...document.querySelectorAll("#showcase-tool-search .tool-catalog-showcase")].map(node => [
					node.querySelector(".tool-call .tool-call-line")?.textContent?.replace(/\s+/g, " ").trim(),
					node.querySelector(".tool-search-body") ? "matches" : node.querySelector(".tool-output") ? "output" : "none",
				]),
				nav: [
					document.querySelector('.showcase-index a[href="#showcase-tool-catalog"]')?.textContent,
					document.querySelector('.showcase-index a[href="#showcase-tool-search"]')?.textContent,
				],
				// The showcase main scrolls on its own, so the page width cannot reveal overflow: measure
				// the scroller, each section and every element inside them against their containers.
				overflow: [
					document.querySelector(".showcase"),
					...document.querySelectorAll("#showcase-tool-catalog, #showcase-tool-search"),
					...document.querySelectorAll(
						"#showcase-tool-catalog .tool-catalog-frame, #showcase-tool-catalog .tool-catalog-list, #showcase-tool-search .tool-disclosure, #showcase-tool-search .tool-search-body",
					),
				]
					.filter((node): node is Element => node !== null)
					.filter(node => node.scrollWidth > node.clientWidth)
					.map(node => node.id || node.className),
				sections: document.querySelectorAll("#showcase-tool-catalog, #showcase-tool-search").length,
				// Only a state's list scrolls; the panel around it keeps search, notices and Save in view.
				scrollingPanels: [...document.querySelectorAll("#showcase-tool-catalog .tool-catalog")]
					.filter(node => node.scrollHeight > node.clientHeight + 1)
					.map(node => node.closest(".tool-catalog-showcase")?.id),
			}));
			expect(layout.states).toEqual(
				[
					"loading",
					"error",
					"populated",
					"long",
					"korean",
					"no-matches",
					"running",
					"saving",
					"search-changed",
					"discovery-off",
					"disconnected",
					"unavailable",
					"empty",
				].map(state => `showcase-tool-catalog-${state}`),
			);
			expect(layout.searchStates).toEqual(
				["populated", "capped", "empty", "fallback"].map(state => `showcase-tool-search-${state}`),
			);
			expect(layout.searchCards).toEqual([
				["Searched tools todo list activated 2", "matches"],
				["Searched tools todo list", "matches"],
				["Searched tools kubernetes rollout", "matches"],
				["Searched tools todo list", "output"],
			]);
			expect(layout.nav).toEqual(["Tools dialog", "Tool search results"]);
			expect(layout.sections).toBe(2);
			expect(layout.overflow).toEqual([]);
			expect(layout.scrollingPanels).toEqual([]);
			expect(errors).toEqual([]);
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
			await page.waitForSelector("dialog[open] input[data-tool-name]");
			expect((await read(page)).tools).toMatchObject([{ name: "read", checked: false }]);
		} finally {
			await context.close();
		}
	}, 30000);
});
