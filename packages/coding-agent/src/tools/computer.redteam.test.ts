/**
 * Genuine computer-use red-team suite for the GJC `computer` tool safety envelope.
 *
 * Required because any edit to `src/config/settings-schema.ts` — the file that
 * defines computer.enabled / computer.alwaysOn / computer.killSwitchHotkey /
 * computer.autoScreenshot / computer.screenshotMaxBytes / computer.auditLog.enabled /
 * computer.screenshotGc.* — must be proven not to weaken computer-control safety.
 *
 * Invariant ids (fixed by the gate contract) map to test titles by prefix:
 *   1. kill-switch-bypass    → "kill-switch-bypass: ..."
 *   2. suspended-enforcement → "suspended-enforcement: ..."
 *   3. permission-revoked    → "permission-revoked: ..."
 *   4. display-stale         → "display-stale: ..."
 *   5. out-of-bounds-drift   → "out-of-bounds-drift: ..."
 *   6. runaway-loop-halt     → "runaway-loop-halt: ..."
 *   7. blast-radius          → "blast-radius: ..."
 * plus "settings-envelope: ..." — the direct falsification test for edits to
 * settings-schema.ts.
 *
 * Every test asserts observable behavior of the real policy / validation / GC /
 * audit layers. Real desktop input is never invoked: the native controller is
 * always the test seam `setComputerControllerFactoryForTests`, and platform/arch
 * overrides pin the host to darwin/arm64.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { zlibSync } from "fflate";
import { Settings, getDefault, getType } from "../config/settings";
import {
	ComputerTool,
	isComputerCallable,
	isComputerEnabled,
	isComputerLoadablePlatform,
	isComputerSupportedPlatform,
	setComputerArchForTests,
	setComputerControllerFactoryForTests,
	setComputerPlatformForTests,
	type ComputerParams,
	type ComputerToolDetails,
} from "./computer";
import {
	cleanupStaleScreenshotFallbackDirs,
	resetScreenshotFallbackGcForTest,
	SCREENSHOT_FALLBACK_DIR_PREFIX,
} from "./computer-gc";
import {
	__resetResourceGcForTest,
	__setResourceGcDepsForTest,
	registerResourceGcSession,
	resolveComputerGcPolicy,
	sweepOnce,
	type ResourceGcDeps,
} from "./resource-gc";
import { ToolAbortError } from "./tool-errors";
import type { ToolSession } from "./index";

type ToolResult = AgentToolResult<ComputerToolDetails>;

function makeSession(settings: Settings, sessionFile: string | null = null): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionSpawns: () => "*",
		getSessionFile: () => sessionFile,
	};
}

function nativeError(code: string, reason: string): Error & { code: string } {
	const value = new Error(`${code}: ${reason}`) as Error & { code: string };
	value.code = code;
	return value;
}

function resultCode(result: ToolResult): string | undefined {
	return result.details?.code;
}

function resultMessage(result: ToolResult): string {
	return result.details?.message ?? result.content.find(block => block.type === "text")?.text ?? "";
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = performance.now();
	return new Promise((resolve, reject) => {
		const poll = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (performance.now() - startedAt > timeoutMs) {
				reject(new Error(`waitFor condition not met within ${timeoutMs}ms`));
				return;
			}
			setTimeout(poll, 1);
		};
		poll();
	});
}

async function pathExists(filePath: string): Promise<boolean> {
	return fs
		.stat(filePath)
		.then(() => true)
		.catch(() => false);
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

interface AuditRecordShape {
	action?: string;
	status?: string;
	code?: string;
	x?: number;
	y?: number;
	timestamp?: string;
	message?: string;
}

function parseAuditRecord(line: string): AuditRecordShape {
	return JSON.parse(line) as AuditRecordShape;
}

afterEach(() => {
	setComputerControllerFactoryForTests(undefined);
	setComputerPlatformForTests(undefined);
	setComputerArchForTests(undefined);
	resetScreenshotFallbackGcForTest();
	__resetResourceGcForTest();
});

describe("computer red-team 1: kill-switch-bypass", () => {
	test("kill-switch-bypass: a disabled surface refuses every action and never constructs the native controller", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({
			"computer.enabled": false,
			"computer.alwaysOn": false,
			"computer.killSwitchHotkey": "Control+Option+Command+Escape",
		});
		const session = makeSession(settings);
		expect(isComputerCallable(session)).toBe(false);

		let factoryCalls = 0;
		setComputerControllerFactoryForTests(() => {
			factoryCalls += 1;
			throw new Error("native controller constructed despite kill switch");
		});
		const tool = new ComputerTool(session);

		const result = await tool.execute("probe", { action: "click", x: 10, y: 10 });

		expect(result.isError).toBe(true);
		expect(resultCode(result)).toBe("COMPUTER_DISABLED");
		expect(resultMessage(result)).toContain("disabled or unsupported");
		expect(factoryCalls).toBe(0); // no code path reached native dispatch
	});

	test("kill-switch-bypass: a supervisor refusal surfaces the configured hotkey and stops the batch", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({
			"computer.enabled": true,
			"computer.killSwitchHotkey": "Control+Option+Command+Escape",
		});
		let nativeCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				nativeCalls += 1;
				throw nativeError("COMPUTER_SUPERVISOR_NOT_LIVE", "kill switch engaged");
			},
			keypress: () => {
				nativeCalls += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		const result = await tool.execute("probe", {
			action: "batch",
			actions: [
				{ action: "click", x: 1, y: 1 },
				{ action: "keypress", keys: ["A"] },
			],
		});

		expect(result.isError).toBe(true);
		expect(resultCode(result)).toBe("COMPUTER_SUPERVISOR_NOT_LIVE");
		expect(resultMessage(result)).toContain("Control+Option+Command+Escape");
		expect(nativeCalls).toBe(1); // follow-up keypress never dispatched
		expect(result.details?.steps?.length).toBe(1);
	});
});

describe("computer red-team 2: suspended-enforcement", () => {
	test("suspended-enforcement: a disabled session refuses repeated single and batch attempts consistently", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": false, "computer.alwaysOn": false });
		let factoryCalls = 0;
		setComputerControllerFactoryForTests(() => {
			factoryCalls += 1;
			return { click: () => undefined };
		});
		const tool = new ComputerTool(makeSession(settings));

		const first = await tool.execute("attempt-1", { action: "click", x: 1, y: 1 });
		const second = await tool.execute("attempt-2", { action: "keypress", keys: ["A"] });
		const third = await tool.execute("attempt-3", {
			action: "batch",
			actions: [
				{ action: "click", x: 1, y: 1 },
				{ action: "wait", ms: 1 },
			],
		});

		for (const result of [first, second, third]) {
			expect(result.isError).toBe(true);
			expect(resultCode(result)).toBe("COMPUTER_DISABLED");
		}
		expect(factoryCalls).toBe(0); // enforcement is not one-shot and not bypassed by a batch
	});

	test("suspended-enforcement: a native COMPUTER_SUSPENDED refusal halts the batch with no follow-up dispatch", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({
			"computer.enabled": true,
			"computer.killSwitchHotkey": "Control+Option+Command+Escape",
		});
		let nativeCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			keypress: () => {
				nativeCalls += 1;
				throw nativeError("COMPUTER_SUSPENDED", "session suspended");
			},
			click: () => {
				nativeCalls += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		const result = await tool.execute("probe", {
			action: "batch",
			actions: [
				{ action: "keypress", keys: ["A"] },
				{ action: "click", x: 1, y: 1 },
			],
		});

		expect(result.isError).toBe(true);
		expect(resultCode(result)).toBe("COMPUTER_SUSPENDED");
		expect(resultMessage(result)).toContain("Control+Option+Command+Escape");
		expect(nativeCalls).toBe(1);
		expect(result.details?.steps?.length).toBe(1);
	});
});

describe("computer red-team 3: permission-revoked", () => {
	test("permission-revoked: revoking computer.enabled mid-session takes effect on the next action (no stale permission cache)", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		let clickCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				clickCalls += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		const allowed = await tool.execute("before-revocation", { action: "click", x: 1, y: 1 });
		expect(allowed.isError).toBeFalsy();
		expect(clickCalls).toBe(1);

		settings.set("computer.enabled", false);

		const revoked = await tool.execute("after-revocation", { action: "click", x: 2, y: 2 });
		expect(revoked.isError).toBe(true);
		expect(resultCode(revoked)).toBe("COMPUTER_DISABLED");
		expect(clickCalls).toBe(1); // no dispatch after revocation
	});

	test("permission-revoked: unsetting computer.enabled mid-session disables through the has() fallback", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true, "computer.alwaysOn": false });
		let clickCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				clickCalls += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		const allowed = await tool.execute("before-unset", { action: "click", x: 1, y: 1 });
		expect(allowed.isError).toBeFalsy();
		expect(clickCalls).toBe(1);

		settings.unset("computer.enabled");

		const revoked = await tool.execute("after-unset", { action: "click", x: 3, y: 3 });
		expect(revoked.isError).toBe(true);
		expect(resultCode(revoked)).toBe("COMPUTER_DISABLED");
		expect(clickCalls).toBe(1);
	});
});

describe("computer red-team 4: display-stale", () => {
	const NOW = 10_000_000_000;
	const STALE_MS = 1000;

	test("display-stale: stale screenshot fallback dirs are cleaned; recent and non-matching dirs are preserved", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-computer-redteam-gc-"));
		try {
			const makeDir = async (name: string, ageMs: number): Promise<string> => {
				const dir = path.join(base, name);
				await fs.mkdir(dir, { recursive: true });
				const mtimeSeconds = (NOW - ageMs) / 1000;
				await fs.utimes(dir, mtimeSeconds, mtimeSeconds);
				return dir;
			};
			const staleDir = await makeDir(`${SCREENSHOT_FALLBACK_DIR_PREFIX}stale`, 5000);
			const recentDir = await makeDir(`${SCREENSHOT_FALLBACK_DIR_PREFIX}recent`, 100);
			const foreignDir = await makeDir("unrelated-tool-dir-old", 5000);

			const result = await cleanupStaleScreenshotFallbackDirs({
				now: () => NOW,
				staleMs: STALE_MS,
				tmpDir: base,
			});

			expect(result).toEqual({ scanned: 2, removed: 1 });
			expect(await pathExists(staleDir)).toBe(false); // stale artifact cleaned, not served as fresh
			expect(await pathExists(recentDir)).toBe(true);
			expect(await pathExists(foreignDir)).toBe(true); // outside GC scope

			// A follow-up sweep sees nothing stale to reuse.
			const second = await cleanupStaleScreenshotFallbackDirs({
				now: () => NOW,
				staleMs: STALE_MS,
				tmpDir: base,
			});
			expect(second).toEqual({ scanned: 1, removed: 0 });
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	test("display-stale: the resource-GC sweep wires screenshotGc.enabled/staleMs/scanIntervalMs and rate-limits scans", async () => {
		const cleanupScreenshots = vi.fn(async (_opts: { now: () => number; staleMs: number }) => ({
			scanned: 1,
			removed: 1,
		}));
		const deps: Partial<ResourceGcDeps> = {
			now: () => NOW,
			rssBytes: () => 1,
			memorySnapshot: async () => ({
				hardCapBytes: 1024 * 1024 * 1024,
				totalUsageBytes: 1,
				parentBytes: 1,
				source: "host",
			}),
			runGc: () => undefined,
			logWarn: () => undefined,
			listTabs: () => [],
			releaseTab: async () => true,
			cleanupScreenshots,
			screenshotArmed: () => true,
		};
		__setResourceGcDepsForTest(deps);

		const settings = Settings.isolated({
			"resourceGc.sweepIntervalMs": 30_000,
			"memoryGuard.enabled": false,
			"computer.screenshotGc.enabled": true,
			"computer.screenshotGc.staleMs": 7_000,
			"computer.screenshotGc.scanIntervalMs": 60_000,
		});
		expect(resolveComputerGcPolicy(settings)).toEqual({
			enabled: true,
			staleMs: 7_000,
			scanIntervalMs: 60_000,
		});

		const unregister = registerResourceGcSession({
			sessionId: "computer-redteam-display-stale",
			settings,
			cwd: process.cwd(),
		});
		try {
			await sweepOnce();
			expect(cleanupScreenshots.mock.calls.length).toBe(1);
			expect(cleanupScreenshots.mock.calls[0]?.[0]?.staleMs).toBe(7_000);

			// Rate limit: a second sweep inside the scanIntervalMs window must not rescan.
			await sweepOnce();
			expect(cleanupScreenshots.mock.calls.length).toBe(1);

			// Past the scanIntervalMs window the sweep runs again.
			__setResourceGcDepsForTest({ ...deps, now: () => NOW + 60_001 });
			await sweepOnce();
			expect(cleanupScreenshots.mock.calls.length).toBe(2);
		} finally {
			unregister();
		}

		// With screenshotGc.enabled=false the sweep contributes no cleanup at all.
		const disabledSettings = Settings.isolated({
			"resourceGc.sweepIntervalMs": 30_000,
			"memoryGuard.enabled": false,
			"computer.screenshotGc.enabled": false,
			"computer.screenshotGc.staleMs": 7_000,
			"computer.screenshotGc.scanIntervalMs": 60_000,
		});
		const disabledUnregister = registerResourceGcSession({
			sessionId: "computer-redteam-display-stale-disabled",
			settings: disabledSettings,
			cwd: process.cwd(),
		});
		try {
			__setResourceGcDepsForTest({ ...deps, now: () => NOW + 120_000 });
			await sweepOnce();
			expect(cleanupScreenshots.mock.calls.length).toBe(2); // unchanged
		} finally {
			disabledUnregister();
		}
	});

	test("display-stale: the expected display epoch is forwarded to native and stale frames are refused with guidance", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		let receivedEpoch: number | undefined;
		let nativeCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 100, heightPx: 80, displayEpoch: 7 }),
			click: (expectedEpoch: number | undefined) => {
				nativeCalls += 1;
				receivedEpoch = expectedEpoch;
				throw nativeError("COMPUTER_DISPLAY_STALE", "display epoch changed");
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		await tool.execute("fresh-shot", { action: "screenshot" });
		const stale = await tool.execute("stale-click", { action: "click", x: 10, y: 10 });

		expect(receivedEpoch).toBe(7); // the epoch of the last screenshot is what native must validate against
		expect(nativeCalls).toBe(1);
		expect(stale.isError).toBe(true);
		expect(resultCode(stale)).toBe("COMPUTER_DISPLAY_STALE");
		expect(resultMessage(stale)).toContain("Capture a fresh screenshot");
	});
});

describe("computer red-team 5: out-of-bounds-drift", () => {
	test("out-of-bounds-drift: every pointer action is refused pre-dispatch outside CoordinateBounds; boundary values are exact", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		const nativeCalls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 100, heightPx: 80, originX: 10, originY: 20, displayEpoch: 1 }),
			click: () => {
				nativeCalls.push("click");
			},
			doubleClick: () => {
				nativeCalls.push("double_click");
			},
			move: () => {
				nativeCalls.push("move");
			},
			drag: () => {
				nativeCalls.push("drag");
			},
			scroll: () => {
				nativeCalls.push("scroll");
			},
		}));
		const tool = new ComputerTool(makeSession(settings));
		await tool.execute("shot", { action: "screenshot" });

		// Frame is x∈[10,110), y∈[20,100): origin offset, exclusive max, negatives.
		const refusalCases: Array<{ name: string; params: ComputerParams }> = [
			{ name: "click x=max", params: { action: "click", x: 110, y: 50 } },
			{ name: "click y=max", params: { action: "click", x: 50, y: 100 } },
			{ name: "click negative y", params: { action: "click", x: 50, y: -1 } },
			{ name: "click x=origin-1", params: { action: "click", x: 9, y: 50 } },
			{ name: "double_click x=max+1", params: { action: "double_click", x: 111, y: 50 } },
			{ name: "move y=max+1", params: { action: "move", x: 50, y: 101 } },
			{ name: "drag start out of bounds", params: { action: "drag", x: 9, y: 50, to_x: 50, to_y: 50 } },
			{ name: "drag end out of bounds", params: { action: "drag", x: 50, y: 50, to_x: 50, to_y: 100 } },
			{ name: "scroll negative x", params: { action: "scroll", x: -5, y: 50, scroll_x: 0, scroll_y: -10 } },
			{ name: "scroll y=max+1", params: { action: "scroll", x: 50, y: 101, scroll_x: 0, scroll_y: -10 } },
		];
		for (const { name, params } of refusalCases) {
			const before = nativeCalls.length;
			const result = await tool.execute(name, params);
			expect(result.isError).toBe(true);
			expect(resultCode(result)).toBe("COMPUTER_COORD_INVALID");
			expect(nativeCalls.length).toBe(before); // native layer never invoked on rejection
		}
		expect(nativeCalls).toEqual([]);

		// Exactly-on-the-edge vs one-past: max-1 and origin dispatch; max itself does not.
		const boundaryCases: Array<{ name: string; params: ComputerParams; expectedNative: string }> = [
			{ name: "click x=max-1", params: { action: "click", x: 109, y: 50 }, expectedNative: "click" },
			{ name: "click y=max-1", params: { action: "click", x: 50, y: 99 }, expectedNative: "click" },
			{ name: "click x=origin", params: { action: "click", x: 10, y: 50 }, expectedNative: "click" },
		];
		for (const { name, params, expectedNative } of boundaryCases) {
			const before = nativeCalls.length;
			const result = await tool.execute(name, params);
			expect(result.isError).toBeFalsy();
			expect(nativeCalls.length).toBe(before + 1);
			expect(nativeCalls[nativeCalls.length - 1]).toBe(expectedNative);
		}
	});

	test("out-of-bounds-drift: a batch containing one out-of-bounds action is refused with zero native dispatch", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		const nativeCalls: string[] = [];
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 100, heightPx: 80, originX: 0, originY: 0, displayEpoch: 2 }),
			click: () => {
				nativeCalls.push("click");
			},
			move: () => {
				nativeCalls.push("move");
			},
		}));
		const tool = new ComputerTool(makeSession(settings));
		await tool.execute("shot", { action: "screenshot" });

		const result = await tool.execute("bad-batch", {
			action: "batch",
			actions: [
				{ action: "click", x: 50, y: 50 },
				{ action: "move", x: 120, y: 50 }, // out of bounds — must veto the whole batch pre-dispatch
				{ action: "click", x: 51, y: 51 },
			],
		});

		expect(result.isError).toBe(true);
		expect(resultCode(result)).toBe("COMPUTER_COORD_INVALID");
		expect(nativeCalls).toEqual([]); // nothing, not even the first in-bounds click, dispatched
	});
});

describe("computer red-team 6: runaway-loop-halt", () => {
	test("runaway-loop-halt: a never-resolving action is cancelled at the clamped deadline and the batch halts", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		let dispatched = 0;
		let releaseGate!: () => void;
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				dispatched += 1;
				return gate;
			},
			keypress: () => {
				dispatched += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));

		const result = await tool.execute("stuck-batch", {
			action: "batch",
			actions: [
				{ action: "click", x: 10, y: 20 },
				{ action: "keypress", keys: ["A"] },
			],
			timeout: 1, // clamped to the 1s floor
		});
		releaseGate();

		expect(result.isError).toBe(true);
		expect(resultCode(result)).toBe("COMPUTER_CANCELLED");
		expect(dispatched).toBe(1); // the queued follow-up never ran after the deadline
		expect(result.details?.steps?.length).toBe(1);
	});

	test("runaway-loop-halt: aborting stops dispatch mid-sequence", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		let dispatched = 0;
		let releaseGate!: () => void;
		const gate = new Promise<void>(resolve => {
			releaseGate = resolve;
		});
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				dispatched += 1;
				return gate;
			},
			keypress: () => {
				dispatched += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));
		const controller = new AbortController();

		const pending = tool.execute(
			"abort-batch",
			{
				action: "batch",
				actions: [
					{ action: "click", x: 10, y: 20 },
					{ action: "keypress", keys: ["A"] },
				],
				timeout: 5,
			},
			controller.signal,
		);
		await waitFor(() => dispatched === 1);
		controller.abort();
		releaseGate();

		const result = await pending;
		expect(result.isError).toBe(true);
		expect(dispatched).toBe(1); // abort stopped the sequence; the keypress never ran
		expect(resultMessage(result)).toContain("Operation aborted");
	});

	test("runaway-loop-halt: a pre-aborted signal prevents any dispatch", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const settings = Settings.isolated({ "computer.enabled": true });
		let nativeCalls = 0;
		setComputerControllerFactoryForTests(() => ({
			click: () => {
				nativeCalls += 1;
			},
		}));
		const tool = new ComputerTool(makeSession(settings));
		const controller = new AbortController();
		controller.abort();

		const outcome = await tool
			.execute("aborted-before-dispatch", { action: "click", x: 1, y: 1 }, controller.signal)
			.then(
				() => "resolved" as const,
				(error: unknown) => (error instanceof ToolAbortError ? "aborted" : "other"),
			);

		expect(outcome).toBe("aborted");
		expect(nativeCalls).toBe(0);
	});
});

describe("computer red-team 7: blast-radius", () => {
	test("blast-radius: inline screenshot payloads respect computer.screenshotMaxBytes", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const maxBytes = 300 * 1024;
		const png = makeNoisePng(1024, 1024);
		expect(png.length).toBeGreaterThan(maxBytes); // native payload itself exceeds the budget
		setComputerControllerFactoryForTests(() => ({
			screenshot: () => ({ widthPx: 1024, heightPx: 1024, png }),
		}));
		const tool = new ComputerTool(
			makeSession(Settings.isolated({ "computer.enabled": true, "computer.screenshotMaxBytes": maxBytes })),
		);

		const result = await tool.execute("bounded-shot", { action: "screenshot" });

		expect(result.isError).toBeFalsy();
		expect(result.details?.screenshot?.pngBytes).toBe(png.length);
		const image = result.content.find(block => block.type === "image");
		expect(image?.type).toBe("image");
		if (image?.type !== "image") throw new Error("expected a bounded inline image");
		expect(Buffer.byteLength(image.data, "base64")).toBeLessThanOrEqual(maxBytes);

		// The full-resolution artifact stays inside the GC-scoped fallback dir.
		const artifactPath = result.details?.screenshot?.path;
		expect(artifactPath).toBeTruthy();
		if (artifactPath) {
			expect(path.dirname(artifactPath)).toContain(SCREENSHOT_FALLBACK_DIR_PREFIX);
			await fs.rm(path.dirname(artifactPath), { recursive: true, force: true });
		}
	});

	test("blast-radius: audit records are written with shape when computer.auditLog.enabled is true and skipped when false", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-computer-audit-redteam-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		const auditPath = path.join(tmpDir, ".computer-audit.jsonl");
		try {
			setComputerControllerFactoryForTests(() => ({
				screenshot: () => ({ widthPx: 100, heightPx: 80, displayEpoch: 3 }),
				click: () => undefined,
				keypress: () => undefined,
			}));

			const enabledTool = new ComputerTool(
				makeSession(
					Settings.isolated({ "computer.enabled": true, "computer.auditLog.enabled": true }),
					sessionFile,
				),
			);
			const single = await enabledTool.execute("audited-click", { action: "click", x: 5, y: 6 });
			expect(single.isError).toBeFalsy();

			const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
			expect(lines).toHaveLength(1);
			const record = parseAuditRecord(lines[0]!);
			expect(record.action).toBe("click");
			expect(record.status).toBe("success");
			expect(record.x).toBe(5);
			expect(record.y).toBe(6);
			expect(record.timestamp).toBeTruthy();
			expect(record).not.toHaveProperty("screenshotPng");

			// A batch writes one record per step plus the batch record.
			const batch = await enabledTool.execute("audited-batch", {
				action: "batch",
				actions: [
					{ action: "click", x: 1, y: 1 },
					{ action: "keypress", keys: ["A"] },
				],
			});
			expect(batch.isError).toBeFalsy();
			const afterBatch = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
			expect(afterBatch).toHaveLength(4);
			expect(afterBatch.some(line => parseAuditRecord(line).action === "batch")).toBe(true);
			expect(afterBatch.filter(line => parseAuditRecord(line).action === "click")).toHaveLength(2);
			expect(afterBatch.filter(line => parseAuditRecord(line).action === "keypress")).toHaveLength(1);

			// Refusals are audited with status and code when audit logging is on.
			await enabledTool.execute("shot", { action: "screenshot" }); // establishes coordinate bounds
			const refused = await enabledTool.execute("audited-refusal", { action: "click", x: -1, y: 6 });
			expect(refused.isError).toBe(true);
			expect(resultCode(refused)).toBe("COMPUTER_COORD_INVALID");
			const auditContent = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
			expect(auditContent).toHaveLength(6);
			const lastRecord = parseAuditRecord(auditContent.at(-1)!);
			expect(lastRecord.status).toBe("error");
			expect(lastRecord.code).toBe("COMPUTER_COORD_INVALID");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("blast-radius: audit logging disabled writes nothing", async () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-computer-audit-off-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		const auditPath = path.join(tmpDir, ".computer-audit.jsonl");
		try {
			setComputerControllerFactoryForTests(() => ({
				click: () => undefined,
			}));
			const tool = new ComputerTool(
				makeSession(
					Settings.isolated({ "computer.enabled": true, "computer.auditLog.enabled": false }),
					sessionFile,
				),
			);
			const result = await tool.execute("un-audited-click", { action: "click", x: 5, y: 6 });
			expect(result.isError).toBeFalsy();
			expect(await pathExists(auditPath)).toBe(false);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("computer safety envelope settings registry", () => {
	test("settings-envelope: every computer safety key exists in the settings schema with the expected type and default", () => {
		const settings = Settings.isolated();
		expect(getType("computer.enabled")).toBe("boolean");
		expect(getDefault("computer.enabled")).toBe(false);
		expect(settings.get("computer.enabled")).toBe(false);

		expect(getType("computer.alwaysOn")).toBe("boolean");
		expect(getDefault("computer.alwaysOn")).toBe(false);
		expect(settings.get("computer.alwaysOn")).toBe(false);

		expect(getType("computer.killSwitchHotkey")).toBe("string");
		expect(getDefault("computer.killSwitchHotkey")).toBe("Control+Option+Command+Escape");
		expect(settings.get("computer.killSwitchHotkey")).toBe("Control+Option+Command+Escape");

		expect(getType("computer.autoScreenshot")).toBe("boolean");
		expect(getDefault("computer.autoScreenshot")).toBe(false);
		expect(settings.get("computer.autoScreenshot")).toBe(false);

		expect(getType("computer.screenshotMaxBytes")).toBe("number");
		expect(getDefault("computer.screenshotMaxBytes")).toBe(5_000_000);
		expect(settings.get("computer.screenshotMaxBytes")).toBe(5_000_000);

		expect(getType("computer.auditLog.enabled")).toBe("boolean");
		expect(getDefault("computer.auditLog.enabled")).toBe(true);
		expect(settings.get("computer.auditLog.enabled")).toBe(true);

		expect(getType("computer.screenshotGc.enabled")).toBe("boolean");
		expect(getDefault("computer.screenshotGc.enabled")).toBe(true);
		expect(settings.get("computer.screenshotGc.enabled")).toBe(true);
	});

	test("settings-envelope: the policy layer consumes the registry for the enablement decision", () => {
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		expect(isComputerSupportedPlatform("darwin", "arm64")).toBe(true);
		expect(isComputerSupportedPlatform("linux", "arm64")).toBe(false);
		expect(isComputerLoadablePlatform("win32")).toBe(false);
		expect(isComputerLoadablePlatform("darwin")).toBe(true);

		expect(isComputerEnabled(makeSession(Settings.isolated({ "computer.enabled": true })))).toBe(true);
		expect(isComputerEnabled(makeSession(Settings.isolated({ "computer.enabled": false })))).toBe(false);
		expect(isComputerEnabled(makeSession(Settings.isolated({ "computer.alwaysOn": true })))).toBe(true);
		expect(
			isComputerEnabled(makeSession(Settings.isolated({ "computer.enabled": false, "computer.alwaysOn": false }))),
		).toBe(false);
		expect(
			isComputerEnabled(makeSession(Settings.isolated({ "computer.enabled": true, "computer.alwaysOn": false }))),
		).toBe(true);

		// Absent keys fall back to enabled-on-supported-host (documented posture); explicit off wins.
		expect(isComputerCallable(makeSession(Settings.isolated()), "darwin", "arm64")).toBe(true);
		expect(
			isComputerCallable(
				makeSession(Settings.isolated({ "computer.enabled": false, "computer.alwaysOn": false })),
				"darwin",
				"arm64",
			),
		).toBe(false);
		expect(isComputerCallable(makeSession(Settings.isolated({ "computer.enabled": true })), "linux", "arm64")).toBe(
			false,
		);
		expect(isComputerCallable(makeSession(Settings.isolated({ "computer.enabled": true })), "darwin", "x64")).toBe(
			false,
		);
	});
});
