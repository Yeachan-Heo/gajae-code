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
import { zlibSync } from "fflate";

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

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	Buffer.from(data).copy(chunk, 8);
	const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
	chunk.writeUInt32BE(crc32(crcInput), 8 + data.length);
	return chunk;
}

function makeNoisePng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const stride = 1 + width * 4;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * stride;
		raw[row] = 0;
		for (let x = 0; x < width; x += 1) {
			const offset = row + 1 + x * 4;
			const seed = (x * 1103515245 + y * 12345) >>> 0;
			raw[offset] = seed & 0xff;
			raw[offset + 1] = (seed >>> 8) & 0xff;
			raw[offset + 2] = (seed >>> 16) & 0xff;
			raw[offset + 3] = 0xff;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlibSync(raw, { level: 0 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
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
				return { widthPx: 20, heightPx: 10, png: new Uint8Array([1, 2, 3]), displayEpoch: 42, captureId: "cap-1" };
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
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.screenshotMaxBytes": 500 * 1024 })),
		);
		const shot = await tool.execute("shot", { action: "screenshot", timeout: 2 });
		await tool.execute("dbl", { action: "double_click", x: 1, y: 2, button: "right" });
		await tool.execute("drag", { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
		await tool.execute("scroll", { action: "scroll", x: 1, y: 2, scroll_x: 5, scroll_y: -6 });

		expect(shot.details?.screenshot).toMatchObject({
			widthPx: 20,
			heightPx: 10,
			displayEpoch: 42,
			pngBytes: 3,
			captureId: "cap-1",
		});
		expect(shot.content.some(block => block.type === "image")).toBe(true);
		const image = shot.content.find(block => block.type === "image");
		expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: "AQID" });
		expect(shot.details?.screenshot?.path).toBeTruthy();
		expect(await fs.stat(shot.details?.screenshot?.path ?? "")).toMatchObject({ size: 3 });
		expect(calls.map(call => call.method)).toEqual(["screenshot", "doubleClick", "drag", "scroll"]);
		// Positional native ABI: (expectedEpoch, x, y, ...rest)
		expect(calls[1].args).toEqual([42, 1, 2, "right"]);
		expect(calls[2].args).toEqual([42, 1, 2, 3, 4, "left"]);
		expect(calls[3].args).toEqual([42, 1, 2, 5, -6]);
	});

	it("does not invent a display epoch before any screenshot context exists", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			click: (...args) => {
				calls.push({ method: "click", args });
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("click", { action: "click", x: 1, y: 2 });

		expect(result.isError).not.toBe(true);
		expect(calls).toEqual([{ method: "click", args: [undefined, 1, 2, "left"] }]);
	});

	it("fails closed when native controller methods are missing", async () => {
		const cases: Array<{ name: string; params: Parameters<ComputerTool["execute"]>[1]; method: string }> = [
			{ name: "screenshot", params: { action: "screenshot" }, method: "screenshot" },
			{ name: "click", params: { action: "click", x: 1, y: 2 }, method: "click" },
			{ name: "double-click", params: { action: "double_click", x: 1, y: 2 }, method: "doubleClick" },
			{ name: "move", params: { action: "move", x: 1, y: 2 }, method: "move" },
			{ name: "drag", params: { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 }, method: "drag" },
			{ name: "scroll", params: { action: "scroll", x: 1, y: 2, scroll_x: 0, scroll_y: -1 }, method: "scroll" },
			{ name: "type", params: { action: "type", text: "hello" }, method: "type" },
			{ name: "keypress", params: { action: "keypress", keys: ["Meta", "K"] }, method: "keypress" },
			{ name: "wait", params: { action: "wait", ms: 1 }, method: "wait" },
		];

		for (const testCase of cases) {
			setComputerPlatformForTests("darwin");
			setComputerArchForTests("arm64");
			setComputerControllerFactoryForTests(() => ({}));
			const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

			const result = await tool.execute(`missing-${testCase.name}`, testCase.params);

			expect(result.isError).toBe(true);
			expect(result.details?.code).toBe("COMPUTER_UNAVAILABLE");
			expect(textOf(result)).toContain(`ComputerController.${testCase.method} is unavailable`);
		}
	});

	it("fails closed when a requested post-action screenshot method is missing", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				calls.push("click");
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("missing-post-action-shot", {
			action: "click",
			x: 1,
			y: 2,
			include_screenshot: true,
		});

		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe("COMPUTER_UNAVAILABLE");
		expect(textOf(result)).toContain("ComputerController.screenshot is unavailable");
		expect(calls).toEqual(["click"]);
	});

	it("fails closed when batch auto-screenshot requires a missing screenshot method", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				calls.push("click");
			},
		}));
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.autoScreenshot": true })),
		);

		const result = await tool.execute("missing-batch-auto-shot", {
			action: "batch",
			actions: [{ action: "click", x: 1, y: 2 }],
		});

		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe("COMPUTER_UNAVAILABLE");
		expect(result.details?.steps).toHaveLength(1);
		expect(result.details?.steps?.[0]?.code).toBe("COMPUTER_UNAVAILABLE");
		expect(textOf(result)).toContain("ComputerController.screenshot is unavailable");
		expect(calls).toEqual(["click"]);
	});

	it("bounds oversized screenshot images sent inline while preserving the full-resolution artifact", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const png = makeNoisePng(1024, 1024);
		expect(png.length).toBeGreaterThan(500 * 1024);
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 1024, heightPx: 1024, png }),
		}));
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.screenshotMaxBytes": 500 * 1024 })),
		);

		const result = await tool.execute("oversized-shot", { action: "screenshot" });

		expect(result.isError).not.toBe(true);
		expect(result.details?.screenshot?.pngBytes).toBe(png.length);
		const artifactPath = result.details?.screenshot?.path;
		expect(artifactPath).toBeTruthy();
		if (!artifactPath) throw new Error("expected persisted screenshot path");
		expect((await fs.stat(artifactPath)).size).toBe(png.length);
		const image = result.content.find(block => block.type === "image");
		expect(image).toBeTruthy();
		if (image?.type !== "image") throw new Error("expected inline image");
		expect(Buffer.byteLength(image.data, "base64")).toBeLessThanOrEqual(500 * 1024);
	});

	it("honors computer.screenshotMaxBytes for the inline screenshot budget", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const png = makeNoisePng(1024, 1024);
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 1024, heightPx: 1024, png }),
		}));
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.screenshotMaxBytes": 300 * 1024 })),
		);

		const result = await tool.execute("setting-budget-shot", { action: "screenshot" });

		expect(result.isError).not.toBe(true);
		const image = result.content.find(block => block.type === "image");
		expect(image).toBeTruthy();
		if (image?.type !== "image") throw new Error("expected inline image");
		expect(Buffer.byteLength(image.data, "base64")).toBeLessThanOrEqual(300 * 1024);
	});

	it("omits an oversized inline screenshot safely if resizing cannot decode it", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const invalidPngBase64 = Buffer.alloc(600 * 1024, 0xff).toString("base64");
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 10, heightPx: 10, png: invalidPngBase64 }),
		}));
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.screenshotMaxBytes": 500 * 1024 })),
		);

		const result = await tool.execute("invalid-oversized-shot", { action: "screenshot" });

		expect(result.isError).not.toBe(true);
		expect(result.content.some(block => block.type === "image")).toBe(false);
		expect(textOf(result)).toContain("Inline screenshot omitted");
		const artifactPath = result.details?.screenshot?.path;
		expect(artifactPath).toBeTruthy();
		if (!artifactPath) throw new Error("expected persisted screenshot path");
		expect((await fs.stat(artifactPath)).size).toBe(600 * 1024);
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

	it("captures a bounded post-action screenshot when include_screenshot is requested", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				calls.push("click");
			},
			screenshot: () => {
				calls.push("screenshot");
				return { widthPx: 40, heightPx: 30, png: new Uint8Array([4, 5, 6]) };
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("click-shot", { action: "click", x: 1, y: 2, include_screenshot: true });

		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["click", "screenshot"]);
		expect(result.details?.screenshot).toMatchObject({ widthPx: 40, heightPx: 30, pngBytes: 3 });
		expect(result.content.find(block => block.type === "image")).toMatchObject({
			type: "image",
			mimeType: "image/png",
			data: "BAUG",
		});
	});

	it("uses computer.autoScreenshot for post-action screenshots", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			type: () => {
				calls.push("type");
			},
			screenshot: () => {
				calls.push("screenshot");
				return { widthPx: 80, heightPx: 60, png: new Uint8Array([7, 8, 9]) };
			},
		}));
		const tool = new ComputerTool(
			createSession(Settings.isolated({ "computer.enabled": true, "computer.autoScreenshot": true })),
		);

		const result = await tool.execute("auto-shot", { action: "type", text: "hello" });

		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["type", "screenshot"]);
		expect(result.details?.screenshot).toMatchObject({ widthPx: 80, heightPx: 60, pngBytes: 3 });
		expect(result.content.find(block => block.type === "image")).toMatchObject({ data: "BwgJ" });
	});

	it("captures batch and per-step screenshots according to explicit options", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		let capture = 0;
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				calls.push("click");
			},
			type: () => {
				calls.push("type");
			},
			screenshot: () => {
				capture += 1;
				calls.push(`screenshot-${capture}`);
				return { widthPx: 100 + capture, heightPx: 50 + capture, png: new Uint8Array([capture]) };
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("batch-shot", {
			action: "batch",
			include_screenshot: true,
			actions: [
				{ action: "click", x: 1, y: 2, include_screenshot: true },
				{ action: "type", text: "done" },
			],
		});

		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["click", "screenshot-1", "type", "screenshot-2"]);
		expect(result.details?.steps?.[0]?.screenshot).toMatchObject({ widthPx: 101, heightPx: 51 });
		expect(result.details?.steps?.[1]?.screenshot).toBeUndefined();
		expect(result.details?.screenshot).toMatchObject({ widthPx: 102, heightPx: 52 });
		expect(result.content.find(block => block.type === "image")).toMatchObject({ data: "Ag==" });
	});

	it("honors nested per-step timeout values inside batches", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const waits: number[] = [];
		setComputerControllerFactoryForTests(() => ({
			wait: (_expectedEpoch, ms) => {
				waits.push(ms);
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("batch-timeouts", {
			action: "batch",
			timeout: 5,
			actions: [
				{ action: "wait", ms: 10_000 },
				{ action: "wait", ms: 10_000, timeout: 1 },
			],
		});

		expect(result.isError).not.toBe(true);
		expect(waits).toEqual([5_000, 1_000]);
	});

	it("times out slow native promises instead of reporting success", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: async () => {
				calls.push("screenshot-start");
				await sleep(1_100);
				calls.push("screenshot-end");
				return { widthPx: 10, heightPx: 10, png: new Uint8Array([1, 2, 3]) };
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const started = Date.now();
		const result = await tool.execute("slow-shot", { action: "screenshot", timeout: 1 });

		expect(Date.now() - started).toBeLessThan(1_090);
		expect(result.isError).toBe(true);
		expect(result.details?.code).toBe("COMPUTER_CANCELLED");
		expect(calls).toEqual(["screenshot-start"]);
	});

	it("honors abort signals between batch steps", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			click: async () => {
				calls.push("click-start");
				await sleep(80);
				calls.push("click-end");
			},
			type: () => {
				calls.push("type");
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(
			tool.execute(
				"abort-batch",
				{
					action: "batch",
					actions: [
						{ action: "click", x: 1, y: 2 },
						{ action: "type", text: "skipped" },
					],
				},
				controller.signal,
			),
		).rejects.toThrow("Operation aborted");
		expect(calls).toEqual(["click-start"]);
	});

	it("executes batch actions sequentially and reports per-step results", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => {
				calls.push({ method: "screenshot", args: [] });
				return { widthPx: 100, heightPx: 50, png: new Uint8Array([1, 2, 3]), displayEpoch: 99 };
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
		expect(calls[1].args).toEqual([99, 10, 20, "left"]);
		expect(calls[2].args).toEqual([undefined, "hello"]);
	});

	it("stops batch when native reports a stale display", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const calls: Array<{ method: string; args: unknown[] }> = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => {
				calls.push({ method: "screenshot", args: [] });
				return { widthPx: 100, heightPx: 50, png: new Uint8Array([1, 2, 3]), displayEpoch: 123 };
			},
			click: (...args) => {
				calls.push({ method: "click", args });
				const error = new Error("COMPUTER_DISPLAY_STALE: display epoch changed") as Error & {
					code: string;
				};
				error.code = "GenericFailure";
				throw error;
			},
			type: (...args) => {
				calls.push({ method: "type", args });
			},
		}));
		const tool = new ComputerTool(createSession(Settings.isolated({ "computer.enabled": true })));

		const result = await tool.execute("batch", {
			action: "batch",
			actions: [{ action: "screenshot" }, { action: "click", x: 10, y: 20 }, { action: "type", text: "skipped" }],
		});

		expect(result.isError).toBe(true);
		expect(result.details?.steps).toHaveLength(2);
		expect(result.details?.steps?.[0]?.status).toBe("success");
		expect(result.details?.steps?.[1]?.code).toBe("COMPUTER_DISPLAY_STALE");
		expect(result.details?.code).toBe("COMPUTER_DISPLAY_STALE");
		expect(calls.map(call => call.method)).toEqual(["screenshot", "click"]);
		expect(calls[1].args).toEqual([123, 10, 20, "left"]);
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
		expect(result.details?.screenshot?.path).toBeTruthy();
		expect(await fs.stat(result.details?.screenshot?.path ?? "")).toMatchObject({ size: 3 });
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
