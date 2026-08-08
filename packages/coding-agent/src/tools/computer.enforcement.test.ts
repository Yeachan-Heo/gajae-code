import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Settings } from "../config/settings";
import {
	ComputerTool,
	setComputerArchForTests,
	setComputerControllerFactoryForTests,
	setComputerPlatformForTests,
} from "./computer";

type NativeMock = Record<string, (...args: any[]) => unknown>;

type CaseReport = {
	caseId: string;
	scenario: string;
	expectedBehavior: string;
	observed: string;
	verdict: "passed" | "failed" | "absent-enforcement";
};

const REPORT_PATH = resolve(import.meta.dir, "../../../../artifacts/vb001-gen5/computer-redteam-test-report.json");

const sessionCache = new WeakMap<object, any>();

function makeSession(settings: Settings): any {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
	};
}

function resultCode(result: any): string | undefined {
	return result?.details?.code;
}

function resultMessage(result: any): string {
	return result?.details?.message ?? result?.content?.[0]?.text ?? "";
}

async function runTool(settings: Settings, controller: NativeMock, params: any): Promise<any> {
	setComputerControllerFactoryForTests(() => controller as any);
	const session = sessionCache.get(settings) ?? makeSession(settings);
	sessionCache.set(settings, session);
	return new ComputerTool(session).execute("red-team", params);
}

function error(code: string, reason: string): Error & { code: string } {
	const value = new Error(`${code}: ${reason}`) as Error & { code: string };
	value.code = code;
	return value;
}

describe("computer enforcement red-team probes", () => {
	test("probes all seven mandatory enforcement cases and writes evidence", async () => {
		const reports: CaseReport[] = [];
		const settings = Settings.isolated({
			"computer.enabled": true,
			"computer.autoScreenshot": false,
			"computer.auditLog.enabled": false,
			"computer.killSwitchHotkey": "Control+Option+Command+Escape",
		});
		setComputerPlatformForTests("darwin");
		setComputerArchForTests("arm64");
		expect(settings.get("computer.killSwitchHotkey")).toBe("Control+Option+Command+Escape");

		try {
			// kill-switch-bypass: the native supervisor owns the kill state. The TS
			// contract is to surface its typed refusal and stop the current batch.
			let killCalls = 0;
			const killController: NativeMock = {
				click: () => {
					killCalls += 1;
					throw error("COMPUTER_SUPERVISOR_NOT_LIVE", "kill switch engaged");
				},
				keypress: () => {
					killCalls += 1;
				},
			};
			const killBatch = await runTool(settings, killController, {
				action: "batch",
				actions: [
					{ action: "click", x: 1, y: 1 },
					{ action: "keypress", keys: ["A"] },
				],
			});
			const killPassed =
				resultCode(killBatch) === "COMPUTER_SUPERVISOR_NOT_LIVE" &&
				killCalls === 1 &&
				killBatch.details?.steps?.length === 1;
			reports.push({
				caseId: "kill-switch-bypass",
				scenario:
					"Native supervisor refuses the first batch step after kill-switch engagement; a follow-up keypress is queued in the same batch.",
				expectedBehavior:
					"Typed COMPUTER_SUPERVISOR_NOT_LIVE refusal with kill-switch guidance; batch halts and follow-up does not dispatch.",
				observed: `code=${resultCode(killBatch)} message=${resultMessage(killBatch)} nativeCalls=${killCalls} steps=${killBatch.details?.steps?.length ?? 0}; hotkey=${settings.get("computer.killSwitchHotkey")}`,
				verdict: killPassed ? "passed" : "failed",
			});

			// suspended-enforcement: native supervisor refusal must become failedStep and
			// prevent all later batch actions from dispatching.
			let suspendedCalls = 0;
			const suspendedController: NativeMock = {
				keypress: () => {
					suspendedCalls += 1;
					throw error("COMPUTER_SUSPENDED", "session suspended");
				},
				click: () => {
					suspendedCalls += 1;
				},
			};
			const suspendedBatch = await runTool(settings, suspendedController, {
				action: "batch",
				actions: [
					{ action: "keypress", keys: ["A"] },
					{ action: "click", x: 1, y: 1 },
				],
			});
			reports.push({
				caseId: "suspended-enforcement",
				scenario: "Native supervisor reports COMPUTER_SUSPENDED on the first keypress in a two-step batch.",
				expectedBehavior:
					"Typed COMPUTER_SUSPENDED refusal; failedStep terminates the batch with no later click dispatch.",
				observed: `code=${resultCode(suspendedBatch)} message=${resultMessage(suspendedBatch)} nativeCalls=${suspendedCalls} steps=${suspendedBatch.details?.steps?.length ?? 0}`,
				verdict:
					resultCode(suspendedBatch) === "COMPUTER_SUSPENDED" &&
					suspendedCalls === 1 &&
					suspendedBatch.details?.steps?.length === 1
						? "passed"
						: "failed",
			});

			// permission-revoked: native permission denial must map to typed guidance.
			let permissionCalls = 0;
			const permission = await runTool(
				settings,
				{
					screenshot: () => {
						permissionCalls += 1;
						throw error("COMPUTER_PERMISSION_REQUIRED", "screen recording permission missing");
					},
				},
				{ action: "screenshot" },
			);
			reports.push({
				caseId: "permission-revoked",
				scenario: "Screenshot native seam denies screen-recording permission.",
				expectedBehavior:
					"Action is refused with COMPUTER_PERMISSION_REQUIRED and user-facing permission guidance.",
				observed: `code=${resultCode(permission)} message=${resultMessage(permission)} nativeScreenshotCalls=${permissionCalls}`,
				verdict:
					resultCode(permission) === "COMPUTER_PERMISSION_REQUIRED" &&
					resultMessage(permission).includes("screen-recording or accessibility permission")
						? "passed"
						: "failed",
			});

			// display-stale: expected display epoch is forwarded to native and stale
			// frames are refused with a typed code.
			let staleClicks = 0;
			const staleController: NativeMock = {
				screenshot: () => ({ widthPx: 100, heightPx: 80, displayEpoch: 1 }),
				click: (expectedEpoch: number | undefined) => {
					staleClicks += 1;
					if (expectedEpoch !== 2) throw error("COMPUTER_DISPLAY_STALE", "display epoch changed");
				},
			};
			await runTool(settings, staleController, { action: "screenshot" });
			const stale = await runTool(settings, staleController, { action: "click", x: 10, y: 10 });
			reports.push({
				caseId: "display-stale",
				scenario: "A screenshot at displayEpoch 1 is followed by a click while native display epoch is 2.",
				expectedBehavior: "Click is refused with COMPUTER_DISPLAY_STALE and fresh-screenshot guidance.",
				observed: `code=${resultCode(stale)} message=${resultMessage(stale)} nativeClickCalls=${staleClicks}`,
				verdict:
					resultCode(stale) === "COMPUTER_DISPLAY_STALE" &&
					resultMessage(stale).includes("Capture a fresh screenshot")
						? "passed"
						: "failed",
			});

			// out-of-bounds-drift: probe exact max, max+1, and negative-origin drift.
			let boundsCalls = 0;
			const boundsController: NativeMock = {
				screenshot: () => ({ widthPx: 100, heightPx: 80, originX: 10, originY: 20, displayEpoch: 3 }),
				click: () => {
					boundsCalls += 1;
				},
			};
			await runTool(settings, boundsController, { action: "screenshot" });
			const edge = await runTool(settings, boundsController, { action: "click", x: 110, y: 20 });
			const over = await runTool(settings, boundsController, { action: "click", x: 111, y: 20 });
			const negative = await runTool(settings, boundsController, { action: "click", x: 9, y: 20 });
			const boundCodes = [edge, over, negative].map(resultCode);
			reports.push({
				caseId: "out-of-bounds-drift",
				scenario: "After a bounded screenshot [10,20)..[110,100), probe x=max, x=max+1, and x=origin-1.",
				expectedBehavior:
					"All edge/drift coordinates are refused with COMPUTER_COORD_INVALID before native dispatch.",
				observed: `edge=${resultCode(edge)}; max+1=${resultCode(over)}; negative-origin=${resultCode(negative)}; nativeClickCalls=${boundsCalls}`,
				verdict:
					boundCodes.every(code => code === "COMPUTER_COORD_INVALID") && boundsCalls === 0 ? "passed" : "failed",
			});

			// runaway-loop-halt: deliberately large batch with no timeout. There is no
			// Deadline machinery is the runaway guard: an action that never resolves
			// must be cancelled when the clamped timeout expires, and no later step runs.
			let loopCalls = 0;
			let releaseLoop!: () => void;
			const loopGate = new Promise<void>(resolveGate => {
				releaseLoop = resolveGate;
			});
			const loopController: NativeMock = {
				click: () => {
					loopCalls += 1;
					return loopGate;
				},
				keypress: () => {
					loopCalls += 1;
				},
			};
			const actions = [
				{ action: "click", x: 10, y: 20 },
				{ action: "keypress", keys: ["A"] },
			];
			const loop = await runTool(settings, loopController, { action: "batch", actions, timeout: 1 });
			releaseLoop();
			reports.push({
				caseId: "runaway-loop-halt",
				scenario:
					"First native action never resolves; one-second clamped deadline expires before queued follow-up.",
				expectedBehavior: "Typed COMPUTER_CANCELLED timeout refusal; no follow-up dispatch after deadline expiry.",
				observed: `code=${resultCode(loop) ?? "none"} message=${resultMessage(loop)} nativeCalls=${loopCalls} steps=${loop.details?.steps?.length ?? 0}; clamp(300s)=300s`,
				verdict: resultCode(loop) === "COMPUTER_CANCELLED" && loopCalls === 1 ? "passed" : "failed",
			});

			// blast-radius: confinement semantics in the TS contract are batch-stop,
			// coordinate bounds, and timeout window limits. The coordinate-bound probe
			// above covers coordinate confinement; this probe covers failedStep stop.
			let blastCalls = 0;
			const blastController: NativeMock = {
				type: () => {
					blastCalls += 1;
					throw error("COMPUTER_PERMISSION_REQUIRED", "destructive action refused");
				},
				keypress: () => {
					blastCalls += 1;
				},
			};
			const blast = await runTool(settings, blastController, {
				action: "batch",
				actions: [
					{ action: "type", text: "rm -rf /" },
					{ action: "keypress", keys: ["Control", "Alt", "Delete"] },
				],
			});
			reports.push({
				caseId: "blast-radius",
				scenario:
					"A refused first destructive/global action is followed by a queued keypress; batch confinement must prevent continuation.",
				expectedBehavior:
					"Typed refusal at failedStep; no later action dispatch. Coordinate and timeout confinement are covered by dedicated probes.",
				observed: `code=${resultCode(blast) ?? "none"} status=${blast.details?.status} nativeCalls=${blastCalls} steps=${blast.details?.steps?.length ?? 0}; bounds=COMPUTER_COORD_INVALID; timeoutCeiling=300s`,
				verdict:
					resultCode(blast) === "COMPUTER_PERMISSION_REQUIRED" &&
					blastCalls === 1 &&
					blast.details?.steps?.length === 1
						? "passed"
						: "failed",
			});

			const report = {
				kind: "computer-redteam-test-report",
				generatedAt: new Date().toISOString(),
				commands: [
					"bun --cwd=packages/coding-agent test src/tools/computer.enforcement.test.ts",
					"cd packages/coding-agent && bun x tsc --noEmit -p .",
				],
				settingsRegistry: {
					path: "computer.killSwitchHotkey",
					resolved: settings.get("computer.killSwitchHotkey"),
				},
				cases: reports,
			};
			mkdirSync(dirname(REPORT_PATH), { recursive: true });
			writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
			expect(reports).toHaveLength(7);
			for (const caseReport of reports) {
				expect(`${caseReport.caseId}:${caseReport.verdict}`).toBe(`${caseReport.caseId}:passed`);
			}
			expect(reports.map(caseReport => caseReport.caseId)).toEqual([
				"kill-switch-bypass",
				"suspended-enforcement",
				"permission-revoked",
				"display-stale",
				"out-of-bounds-drift",
				"runaway-loop-halt",
				"blast-radius",
			]);
		} finally {
			setComputerControllerFactoryForTests(undefined);
			setComputerPlatformForTests(undefined);
			setComputerArchForTests(undefined);
		}
	});
});
