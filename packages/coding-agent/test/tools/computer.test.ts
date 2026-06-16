import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	BUILTIN_CAPABILITY_CATALOG,
	ComputerTool,
	computerSchema,
	createTools,
	isComputerCallable,
	isComputerLoadablePlatform,
	setComputerControllerFactoryForTests,
	setComputerPlatformForTests,
	type ToolSession,
} from "@gajae-code/coding-agent/tools";
import { summarizeComputerDetails } from "@gajae-code/coding-agent/tools/computer/render";
import { toolRenderers } from "@gajae-code/coding-agent/tools/renderers";

function createSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(c => c.text ?? "").join("\n");
}

describe("computer tool schema", () => {
	const validCases = [
		{ action: "screenshot" },
		{ action: "click", x: 1, y: 2, button: "left" },
		{ action: "double_click", x: 1, y: 2, button: "right" },
		{ action: "move", x: 1, y: 2, button: "middle" },
		{ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 },
		{ action: "scroll", x: 1, y: 2, scroll_x: 0, scroll_y: -10 },
		{ action: "type", text: "hello" },
		{ action: "keypress", keys: ["Meta", "K"] },
		{ action: "wait", ms: 250 },
	];

	it("accepts exactly the nine OpenAI snake_case actions", () => {
		expect(validCases.map(value => computerSchema.parse(value).action)).toEqual([
			"screenshot",
			"click",
			"double_click",
			"move",
			"drag",
			"scroll",
			"type",
			"keypress",
			"wait",
		]);
	});

	it("rejects camelCase actions and fields", () => {
		expect(() => computerSchema.parse({ action: "doubleClick", x: 1, y: 2 })).toThrow();
		expect(() => computerSchema.parse({ action: "drag", x: 1, y: 2, toX: 3, toY: 4 })).toThrow();
		expect(() => computerSchema.parse({ action: "scroll", x: 1, y: 2, scrollX: 0, scrollY: 1 })).toThrow();
		expect(() => computerSchema.parse({ action: "screenshot", includeScreenshot: true })).toThrow();
	});
});

describe("computer tool gating", () => {
	afterEach(() => {
		setComputerControllerFactoryForTests(undefined);
		setComputerPlatformForTests(undefined);
	});

	it("is metadata-only by default and not callable/discoverable", async () => {
		const session = createSession(Settings.isolated({ "tools.discoveryMode": "all" }));
		const tools = await createTools(session);
		const names = tools.map(t => t.name);
		expect(names).not.toContain("computer");
		const catalogEntry = BUILTIN_CAPABILITY_CATALOG.find(entry => entry.name === "computer");
		if (isComputerLoadablePlatform()) {
			expect(catalogEntry).toMatchObject({ callableBuiltin: false, defaultEnabled: false });
		} else {
			expect(catalogEntry).toBeUndefined();
		}
		const discoverable = tools.filter(t => t.loadMode === "discoverable").map(t => t.name);
		expect(discoverable).not.toContain("computer");
	});

	it("is callable with per-session enable or alwaysOn on macOS", async () => {
		setComputerPlatformForTests("darwin");
		const enabledNames = (await createTools(createSession(Settings.isolated({ "computer.enabled": true })))).map(
			t => t.name,
		);
		const alwaysOnNames = (await createTools(createSession(Settings.isolated({ "computer.alwaysOn": true })))).map(
			t => t.name,
		);
		expect(enabledNames).toContain("computer");
		expect(alwaysOnNames).toContain("computer");
	});

	it("is absent on non-macOS even when settings enable it", () => {
		expect(isComputerCallable(createSession(Settings.isolated({ "computer.enabled": true })), "linux")).toBe(false);
	});

	it("is loadable on macOS and Linux but not loaded at all on Windows", () => {
		expect(isComputerLoadablePlatform("darwin")).toBe(true);
		expect(isComputerLoadablePlatform("linux")).toBe(true);
		expect(isComputerLoadablePlatform("win32")).toBe(false);
	});

	it("returns COMPUTER_DISABLED without constructing native controller when directly invoked while disabled", async () => {
		let constructed = false;
		setComputerControllerFactoryForTests(() => {
			constructed = true;
			return {};
		});
		const tool = new ComputerTool(createSession());
		const result = await tool.execute("call", { action: "screenshot" });
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe("COMPUTER_DISABLED");
		expect(textOf(result)).toContain("COMPUTER_DISABLED");
		expect(constructed).toBe(false);
	});
});

describe("computer tool dispatch", () => {
	afterEach(() => {
		setComputerControllerFactoryForTests(undefined);
		setComputerPlatformForTests(undefined);
	});

	it("maps snake_case model actions to native controller methods positionally", async () => {
		setComputerPlatformForTests("darwin");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => {
				calls.push({ method: "screenshot", args: [] });
				return { widthPx: 20, heightPx: 10, png: new Uint8Array([1, 2, 3]), captureId: "cap-1" };
			},
			doubleClick: (...args) => {
				calls.push({ method: "doubleClick", args });
			},
			drag: (...args) => {
				calls.push({ method: "drag", args });
			},
			scroll: (...args) => {
				calls.push({ method: "scroll", args });
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const shot = await tool.execute("shot", { action: "screenshot", timeout: 2 });
		await tool.execute("dbl", { action: "double_click", x: 1, y: 2, button: "right" });
		await tool.execute("drag", { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
		await tool.execute("scroll", { action: "scroll", x: 1, y: 2, scroll_x: 5, scroll_y: -6 });

		expect(shot.details?.screenshot).toMatchObject({ widthPx: 20, heightPx: 10, pngBytes: 3, captureId: "cap-1" });
		expect(calls.map(call => call.method)).toEqual(["screenshot", "doubleClick", "drag", "scroll"]);
		// Positional native ABI: (expectedEpoch, x, y, ...rest)
		expect(calls[1].args).toEqual([undefined, 1, 2, "right"]);
		expect(calls[2].args).toEqual([undefined, 1, 2, 3, 4, "left"]);
		expect(calls[3].args).toEqual([undefined, 1, 2, 5, -6]);
	});

	it("maps native COMPUTER_* errors carried in the message into bounded tool errors", async () => {
		setComputerPlatformForTests("darwin");
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				// Mirror the real NAPI error: stable code in the message, generic .code.
				const error = new Error("COMPUTER_SUPERVISOR_NOT_LIVE: supervisor is not live") as Error & {
					code: string;
				};
				error.code = "GenericFailure";
				throw error;
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const result = await tool.execute("click", { action: "click", x: 1, y: 2 });
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe("COMPUTER_SUPERVISOR_NOT_LIVE");
		expect(textOf(result)).toContain("supervisor is not live");
	});
});

describe("computer renderer", () => {
	it("renders bounded output without raw screenshot data", () => {
		const renderer = toolRenderers.computer;
		expect(renderer).toBeDefined();
		const fakeTheme = {
			fg: (_name: string, text: string) => text,
			format: { bracketLeft: "[", bracketRight: "]" },
			styledSymbol: () => "!",
			sep: { dot: " · " },
		} as never;
		const output = summarizeComputerDetails(
			{
				action: "screenshot",
				status: "success",
				screenshot: { widthPx: 640, heightPx: 480, pngBytes: 1234, captureId: "cap-1" },
			},
			false,
			fakeTheme,
		);
		expect(output).toContain("640x480");
		expect(output).toContain("1234 bytes");
		expect(output).not.toContain("iVBOR");
	});
});
