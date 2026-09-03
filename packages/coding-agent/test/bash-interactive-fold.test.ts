/**
 * G004: the PTY runner owns its session and sink from t0, so the overlay is only
 * an observer view. Folding or dismissing that view must never kill, abort, or
 * re-execute the process, and output must stay continuous across the fold.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	type BashInteractiveResult,
	type InteractivePtyControls,
	runInteractiveBashPty,
} from "@gajae-code/coding-agent/tools/bash-interactive";

interface CapturedComponent {
	dispose?: () => void;
	handleInput?: (data: string) => void;
}

/** Fake overlay host that exposes the component and the `done` callback. */
function createTestUi(
	captured?: { component?: CapturedComponent },
	options: { deferDispose?: boolean } = {},
): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(factory: unknown): Promise<T> {
			const result = Promise.withResolvers<T>();
			let component: CapturedComponent | undefined;
			const done = (value: T) => {
				if (!options.deferDispose) component?.dispose?.();
				result.resolve(value);
			};
			try {
				component = (
					factory as (
						tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
						theme: Record<string, never>,
						keybindings: Record<string, never>,
						done: (result: T) => void,
					) => CapturedComponent
				)({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, done);
				if (captured) captured.component = component;
			} catch (error) {
				result.reject(error);
			}
			return result.promise;
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

/** An overlay host whose view init always fails. */
function createFailingUi(): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(): Promise<T> {
			throw new Error("terminal view init failed");
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

const FOLD_RESULT: BashInteractiveResult = {
	exitCode: undefined,
	cancelled: false,
	timedOut: false,
	output: "folded into a background job",
	outputBytes: 0,
	outputLines: 0,
	totalBytes: 0,
	totalLines: 0,
	truncated: false,
};

async function tempDir(): Promise<string> {
	const dir = path.join(os.tmpdir(), `pty-fold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("interactive PTY fold ownership", () => {
	it("settles the foreground on fold while the process keeps running to completion", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			const artifactPath = path.join(dir, "folded.log");
			const controller = new AbortController();
			let controls: InteractivePtyControls | undefined;

			const result = await runInteractiveBashPty(createTestUi(), {
				command: "printf 'BEFORE-FOLD\\n'; sleep 0.6; printf 'AFTER-FOLD\\n'",
				cwd: dir,
				timeoutMs: 20_000,
				artifactPath,
				artifactId: "folded",
				signal: controller.signal,
				// Force every chunk to spill so the artifact proves continuity.
				spillThreshold: 1,
				onControls: next => {
					controls = next;
					next.detachObserver(FOLD_RESULT);
					next.detachForegroundCancellation();
					controller.abort();
				},
			});

			// Controls arrive before the overlay is awaited, and the fold settled the
			// foreground with the fold result rather than the command's own summary.
			expect(controls).toBeDefined();
			expect(result.output).toBe("folded into a background job");

			// The process was NOT killed by folding: its post-fold output still lands
			// in the artifact, so output/artifact state is continuous across the fold.
			await waitFor(async () => {
				try {
					return (await Bun.file(artifactPath).text()).includes("AFTER-FOLD");
				} catch {
					return false;
				}
			});
			const artifact = await Bun.file(artifactPath).text();
			expect(artifact).toContain("BEFORE-FOLD");
			expect(artifact).toContain("AFTER-FOLD");
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent: a second detach reports already-settled", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			const outcomes: string[] = [];
			const result = await runInteractiveBashPty(createTestUi(), {
				command: "printf 'ONE\\n'; sleep 0.3",
				cwd: dir,
				timeoutMs: 20_000,
				onControls: controls => {
					outcomes.push(controls.detachObserver(FOLD_RESULT));
					outcomes.push(controls.detachObserver(FOLD_RESULT));
				},
			});
			expect(outcomes).toEqual(["resolved", "already-settled"]);
			expect(result.output).toBe("folded into a background job");
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps running when the observer view is disposed mid-run", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			const artifactPath = path.join(dir, "dismissed.log");
			const captured: { component?: CapturedComponent } = {};

			const runPromise = runInteractiveBashPty(createTestUi(captured), {
				command: "printf 'START\\n'; sleep 0.5; printf 'SURVIVED\\n'",
				cwd: dir,
				timeoutMs: 20_000,
				artifactPath,
				artifactId: "dismissed",
				spillThreshold: 1,
			});

			// Dismiss the overlay while the command is still running. Under the old
			// ownership this invoked session.kill() through the overlay handlers.
			await waitFor(() => captured.component !== undefined);
			captured.component?.dispose?.();

			const result = await runPromise;
			expect(result.exitCode).toBe(0);
			const artifact = await Bun.file(artifactPath).text();
			expect(artifact).toContain("START");
			expect(artifact).toContain("SURVIVED");
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("still completes the run when overlay view init fails", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			// The session is started before the overlay exists, so a failed view must
			// not orphan it: the run settles the foreground on its own.
			const result = await runInteractiveBashPty(createFailingUi(), {
				command: "printf 'NO-VIEW\\n'",
				cwd: dir,
				timeoutMs: 20_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("NO-VIEW");
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("has no kill entry point left in the overlay lifecycle", async () => {
		// Structural guard: the overlay's dismiss/dispose handlers used to call
		// session.kill(). Owner teardown is allowed to kill the process, but the
		// observer view must remain a non-owning lifecycle participant.
		const source = await Bun.file(new URL("../src/tools/bash-interactive.ts", import.meta.url).pathname).text();
		const overlayStart = source.indexOf("class BashInteractiveOverlayComponent");
		const runnerStart = source.indexOf("export async function runInteractiveBashPty");
		expect(overlayStart).toBeGreaterThanOrEqual(0);
		expect(runnerStart).toBeGreaterThan(overlayStart);
		expect(source.slice(overlayStart, runnerStart)).not.toContain(".kill(");
		expect(source).toContain('getKeybindings().matches(data, "app.tool.backgroundFold")');
	});

	it("keeps its original deadline after folding, surfacing the expiry as a real outcome", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			let controls: InteractivePtyControls | undefined;

			// Fold immediately, then let the ORIGINAL deadline elapse. Folding must not
			// extend or suspend it, and the expiry must still produce a real outcome
			// that can be delivered rather than hanging forever.
			const foreground = await runInteractiveBashPty(createTestUi(), {
				command: "sleep 30",
				cwd: dir,
				timeoutMs: 700,
				onControls: next => {
					controls = next;
					next.detachObserver(FOLD_RESULT);
				},
			});
			expect(foreground.output).toBe("folded into a background job");
			if (!controls) throw new Error("expected live controls");

			const outcome = await controls.terminalCompletion;
			// The run ended on its own deadline, not by being killed at fold time.
			expect(outcome.timedOut || outcome.exitCode !== 0).toBe(true);
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("stops forwarding input immediately after folding while the process keeps producing output", async () => {
		const dir = await tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			const marker = path.join(dir, "folded-input.txt");
			const captured: { component?: CapturedComponent } = {};
			let controls: InteractivePtyControls | undefined;

			const foregroundPromise = runInteractiveBashPty(createTestUi(captured, { deferDispose: true }), {
				command: `if read -r -t 0.5 line; then printf '%s' "$line" > ${marker}; else printf 'NO-INPUT' > ${marker}; fi; printf 'OUTPUT-CONTINUED\\n'`,
				cwd: dir,
				timeoutMs: 20_000,
				onControls: next => {
					controls = next;
				},
			});

			await waitFor(() => captured.component?.handleInput !== undefined && controls !== undefined);
			if (!controls || !captured.component?.handleInput) throw new Error("expected live PTY controls and overlay");
			expect(controls.detachObserver(FOLD_RESULT)).toBe("resolved");
			captured.component.handleInput("MUST-NOT-REACH-PTY\r");
			captured.component.handleInput("\x1b");

			const foreground = await foregroundPromise;
			expect(foreground.output).toBe("folded into a background job");
			const outcome = await controls.terminalCompletion;
			expect(outcome.output).toContain("OUTPUT-CONTINUED");
			expect(await Bun.file(marker).text()).toBe("NO-INPUT");
			captured.component.dispose?.();
		} finally {
			resetSettingsForTest();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
