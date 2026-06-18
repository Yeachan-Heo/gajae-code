import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	BUILTIN_CAPABILITY_CATALOG,
	ComputerTool,
	computerSchema,
	createTools,
	isComputerCallable,
	isComputerLoadablePlatform,
	setComputerArchForTests,
	setComputerControllerFactoryForTests,
	setComputerPlatformForTests,
	type ToolSession,
} from "@gajae-code/coding-agent/tools";
import { summarizeComputerDetails } from "@gajae-code/coding-agent/tools/computer/render";
import { toolRenderers } from "@gajae-code/coding-agent/tools/renderers";

function createSession(settings = Settings.isolated(), sessionFile: string | null = null): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => sessionFile,
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

	it("accepts a batch of single actions", () => {
		const parsed = computerSchema.parse({
			action: "batch",
			actions: [{ action: "screenshot" }, { action: "click", x: 1, y: 2 }, { action: "type", text: "hello" }],
		});
		expect(parsed.action).toBe("batch");
		if (parsed.action !== "batch") throw new Error("expected batch");
		expect(parsed.actions).toHaveLength(3);
	});

	it("rejects an empty batch", () => {
		expect(() => computerSchema.parse({ action: "batch", actions: [] })).toThrow();
	});

	it("rejects a batch containing invalid actions", () => {
		expect(() =>
			computerSchema.parse({
				action: "batch",
				actions: [{ action: "click", x: 1 }],
			}),
		).toThrow();
	});

	it("rejects camelCase actions and fields", () => {
		expect(() => computerSchema.parse({ action: "doubleClick", x: 1, y: 2 })).toThrow();
		expect(() => computerSchema.parse({ action: "drag", x: 1, y: 2, toX: 3, toY: 4 })).toThrow();
		expect(() => computerSchema.parse({ action: "scroll", x: 1, y: 2, scrollX: 0, scrollY: 1 })).toThrow();
		expect(() => computerSchema.parse({ action: "screenshot", includeScreenshot: true })).toThrow();
	});

	it("keeps runtime validation authoritative for action-specific fields", () => {
		expect(() => computerSchema.parse({ action: "screenshot", x: 1 })).toThrow();
		expect(() => computerSchema.parse({ action: "screenshot", text: "ignored" })).toThrow();

		expect(() => computerSchema.parse({ action: "click", y: 2 })).toThrow();
		expect(() => computerSchema.parse({ action: "click", x: 1 })).toThrow();
		expect(() => computerSchema.parse({ action: "move", y: 2 })).toThrow();
		expect(() => computerSchema.parse({ action: "move", x: 1 })).toThrow();

		expect(() => computerSchema.parse({ action: "drag", x: 1, y: 2, to_y: 4 })).toThrow();
		expect(() => computerSchema.parse({ action: "drag", x: 1, y: 2, to_x: 3 })).toThrow();

		expect(() => computerSchema.parse({ action: "type" })).toThrow();

		expect(() => computerSchema.parse({ action: "keypress" })).toThrow();
		expect(() => computerSchema.parse({ action: "keypress", keys: [] })).toThrow();

		expect(() => computerSchema.parse({ action: "wait" })).toThrow();
		expect(() => computerSchema.parse({ action: "wait", ms: 1.5 })).toThrow();
		expect(() => computerSchema.parse({ action: "wait", ms: -1 })).toThrow();

		expect(() => computerSchema.parse({ action: "launch" })).toThrow();
	});
});

describe("computer tool gating", () => {
	afterEach(() => {
		setComputerControllerFactoryForTests(undefined);
		setComputerPlatformForTests(undefined);
		setComputerArchForTests(undefined);
	});

	it("is callable and discoverable by default on Apple Silicon macOS", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const session = createSession(Settings.isolated({ "tools.discoveryMode": "all" }));
		const tools = await createTools(session);
		const names = tools.map(t => t.name);
		expect(names).toContain("computer");
		const discoverable = tools.filter(t => t.loadMode === "discoverable").map(t => t.name);
		expect(discoverable).toContain("computer");
	});

	it("exposes honest static capability catalog metadata for computer", () => {
		const catalogEntry = BUILTIN_CAPABILITY_CATALOG.find(entry => entry.name === "computer");
		if (isComputerLoadablePlatform()) {
			expect(catalogEntry).toMatchObject({ callableBuiltin: false, defaultEnabled: true });
			expect(catalogEntry?.summary ?? "").not.toBe("");
			expect((catalogEntry?.summary ?? "").toLowerCase()).not.toContain("off by default");
			expect(catalogEntry?.summary ?? "").not.toContain("Explicitly enabled");
		} else {
			expect(catalogEntry).toBeUndefined();
		}
	});

	it("is callable with per-session enable or alwaysOn on macOS", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const enabledNames = (await createTools(createSession(Settings.isolated({ "computer.enabled": true })))).map(
			t => t.name,
		);
		const alwaysOnNames = (await createTools(createSession(Settings.isolated({ "computer.alwaysOn": true })))).map(
			t => t.name,
		);
		expect(enabledNames).toContain("computer");
		expect(alwaysOnNames).toContain("computer");
	});

	it("is not callable on unsupported platform/arch even when settings enable it", () => {
		const enabled = createSession(Settings.isolated({ "computer.enabled": true }));
		const alwaysOn = createSession(Settings.isolated({ "computer.alwaysOn": true }));
		expect(isComputerCallable(enabled, "darwin", "x64")).toBe(false);
		expect(isComputerCallable(alwaysOn, "darwin", "x64")).toBe(false);
		expect(isComputerCallable(enabled, "linux", "arm64")).toBe(false);
		expect(isComputerCallable(enabled, "win32", "arm64")).toBe(false);
	});

	it("is loadable on macOS and Linux but not loaded at all on Windows", () => {
		expect(isComputerLoadablePlatform("darwin")).toBe(true);
		expect(isComputerLoadablePlatform("linux")).toBe(true);
		expect(isComputerLoadablePlatform("win32")).toBe(false);
	});

	it("is disabled when alwaysOn=false and enabled=false on Apple Silicon macOS (off-switch)", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const session = createSession(Settings.isolated({ "computer.alwaysOn": false, "computer.enabled": false }));
		expect(isComputerCallable(session)).toBe(false);
		const names = (await createTools(session)).map(t => t.name);
		expect(names).not.toContain("computer");
		let constructed = false;
		setComputerControllerFactoryForTests(() => {
			constructed = true;
			return {};
		});
		const tool = new ComputerTool(session);
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
		setComputerArchForTests(undefined);
	});

	it("maps snake_case model actions to native controller methods positionally", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
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
		expect(shot.content.some(block => block.type === "image")).toBe(true);
		const image = shot.content.find(block => block.type === "image");
		expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: "AQID" });
		expect(shot.details?.screenshot?.path).toBeTruthy();
		expect(await fs.stat(shot.details?.screenshot?.path ?? "")).toMatchObject({ size: 3 });
		expect(calls.map(call => call.method)).toEqual(["screenshot", "doubleClick", "drag", "scroll"]);
		// Positional native ABI: (expectedEpoch, x, y, ...rest)
		expect(calls[1].args).toEqual([undefined, 1, 2, "right"]);
		expect(calls[2].args).toEqual([undefined, 1, 2, 3, 4, "left"]);
		expect(calls[3].args).toEqual([undefined, 1, 2, 5, -6]);
	});

	it("persists screenshot fallbacks in private per-session directories with restrictive file modes", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 20, heightPx: 10, png: new Uint8Array([1, 2, 3]) }),
		}));
		const firstTool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const secondTool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const first = await firstTool.execute("first", { action: "screenshot" });
		const second = await secondTool.execute("second", { action: "screenshot" });
		const firstPath = first.details?.screenshot?.path;
		const secondPath = second.details?.screenshot?.path;
		expect(firstPath).toBeTruthy();
		expect(secondPath).toBeTruthy();
		if (!firstPath || !secondPath) throw new Error("expected persisted screenshot paths");
		const firstDir = path.dirname(firstPath);
		const secondDir = path.dirname(secondPath);

		try {
			expect(firstDir).not.toBe(path.join(os.tmpdir(), "gjc-computer-screenshots"));
			expect(path.basename(firstDir)).toStartWith("gjc-computer-screenshots-");
			expect(firstDir).not.toBe(secondDir);
			expect((await fs.stat(firstPath)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(firstDir)).mode & 0o777).toBe(0o700);
		} finally {
			await fs.rm(firstDir, { recursive: true, force: true });
			await fs.rm(secondDir, { recursive: true, force: true });
		}
	});

	it("executes batch actions sequentially and reports per-step results", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => {
				calls.push({ method: "screenshot", args: [] });
				return { widthPx: 100, heightPx: 50, png: new Uint8Array([1, 2, 3]) };
			},
			click: (...args) => {
				calls.push({ method: "click", args });
			},
			type: (...args) => {
				calls.push({ method: "type", args });
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const result = await tool.execute("batch", {
			action: "batch",
			actions: [{ action: "screenshot" }, { action: "click", x: 10, y: 20 }, { action: "type", text: "hello" }],
		});

		expect(result.isError).not.toBe(true);
		expect(result.details?.action).toBe("batch");
		expect(result.details?.steps).toHaveLength(3);
		expect(result.details?.steps?.map(s => s.action)).toEqual(["screenshot", "click", "type"]);
		expect(result.details?.steps?.every(s => s.status === "success")).toBe(true);
		expect(result.details?.screenshot).toMatchObject({ widthPx: 100, heightPx: 50 });
		expect(result.content.some(block => block.type === "image")).toBe(true);
		const image = result.content.find(block => block.type === "image");
		expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: "AQID" });
		expect(result.details?.screenshot?.path).toBeTruthy();
		expect(await fs.stat(result.details?.screenshot?.path ?? "")).toMatchObject({ size: 3 });
		expect(calls.map(call => call.method)).toEqual(["screenshot", "click", "type"]);
	});

	it("stops batch execution on first failure and reports the failing step", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				const error = new Error("COMPUTER_COORD_INVALID: coordinates out of bounds") as Error & { code: string };
				error.code = "GenericFailure";
				throw error;
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const result = await tool.execute("batch", {
			action: "batch",
			actions: [
				{ action: "click", x: 10, y: 20 },
				{ action: "type", text: "skipped" },
			],
		});

		expect(result.isError).toBe(true);
		expect(result.details?.action).toBe("batch");
		expect(result.details?.steps).toHaveLength(1);
		expect(result.details?.steps?.[0]?.status).toBe("error");
		expect(result.details?.steps?.[0]?.code).toBe("COMPUTER_COORD_INVALID");
		expect(result.details?.code).toBe("COMPUTER_COORD_INVALID");
	});

	it("validates batch coordinates against the latest screenshot bounds", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => {
				calls.push({ method: "screenshot", args: [] });
				return { widthPx: 100, heightPx: 50, png: new Uint8Array([1, 2, 3]) };
			},
			click: (...args) => {
				calls.push({ method: "click", args });
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const result = await tool.execute("batch", {
			action: "batch",
			actions: [{ action: "screenshot" }, { action: "click", x: 150, y: 60 }],
		});

		expect(result.isError).toBe(true);
		expect(result.details?.action).toBe("batch");
		expect(result.details?.steps?.[0]?.status).toBe("success");
		expect(result.details?.steps?.[1]?.status).toBe("error");
		expect(result.details?.steps?.[1]?.code).toBe("COMPUTER_COORD_INVALID");
		expect(result.details?.steps?.[1]?.message).toContain("outside the latest screenshot bounds");
		expect(result.details?.code).toBe("COMPUTER_COORD_INVALID");
		expect(calls.map(call => call.method)).toEqual(["screenshot"]);
	});

	it("writes an audit log record when computer.auditLog.enabled is true", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "computer-audit-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		const auditPath = path.join(tmpDir, ".computer-audit.jsonl");
		try {
			setComputerControllerFactoryForTests(() => ({
				screenshot: () => ({ widthPx: 10, heightPx: 10, png: new Uint8Array([1, 2, 3]) }),
				click: () => undefined,
			}));
			const tool = new ComputerTool(
				createSession(
					Settings.isolated({ "computer.enabled": true, "computer.auditLog.enabled": true }),
					sessionFile,
				),
			);
			await tool.execute("audit", { action: "click", x: 1, y: 2 });
			const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
			expect(lines.length).toBe(1);
			const record = JSON.parse(lines[0]!);
			expect(record.action).toBe("click");
			expect(record.status).toBe("success");
			expect(record.x).toBe(1);
			expect(record.y).toBe(2);
			expect(record.timestamp).toBeTruthy();
			expect(record).not.toHaveProperty("screenshotPng");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("maps native COMPUTER_* errors carried in the message into bounded tool errors", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
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

	it("summarizes batch results with step counts", () => {
		const fakeTheme = {
			fg: (_name: string, text: string) => text,
			format: { bracketLeft: "[", bracketRight: "]" },
			styledSymbol: () => "!",
			sep: { dot: " · " },
		} as never;
		const output = summarizeComputerDetails(
			{
				action: "batch",
				status: "success",
				steps: [
					{ action: "click", status: "success" },
					{ action: "type", status: "success" },
				],
				screenshot: { widthPx: 640, heightPx: 480, pngBytes: 1234 },
			},
			false,
			fakeTheme,
		);
		expect(output).toContain("batch 2/2");
		expect(output).toContain("640x480");
	});
});
