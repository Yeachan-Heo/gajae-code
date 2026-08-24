/**
 * G004: the PTY runner owns its session and sink from t0, so the overlay is only
 * an observer view. Folding or dismissing that view must never kill, abort, or
 * re-execute the process, and output must stay continuous across the fold.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
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
}

/** Fake overlay host that exposes the component and the `done` callback. */
function createTestUi(captured?: { component?: CapturedComponent }): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(factory: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				let component: CapturedComponent | undefined;
				const done = (result: T) => {
					component?.dispose?.();
					resolve(result);
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
					reject(error);
				}
			});
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

function tempDir(): string {
	const dir = path.join(os.tmpdir(), `pty-fold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("interactive PTY fold ownership", () => {
	it("settles the foreground on fold while the process keeps running to completion", async () => {
		const dir = tempDir();
		try {
			await Settings.init({ inMemory: true, cwd: dir });
			const artifactPath = path.join(dir, "folded.log");
			let controls: InteractivePtyControls | undefined;

			const result = await runInteractiveBashPty(createTestUi(), {
				command: "printf 'BEFORE-FOLD\\n'; sleep 0.6; printf 'AFTER-FOLD\\n'",
				cwd: dir,
				timeoutMs: 20_000,
				artifactPath,
				artifactId: "folded",
				// Force every chunk to spill so the artifact proves continuity.
				spillThreshold: 1,
				onControls: next => {
					controls = next;
					next.detachObserver(FOLD_RESULT);
				},
			});

			// Controls arrive before the overlay is awaited, and the fold settled the
			// foreground with the fold result rather than the command's own summary.
			expect(controls).toBeDefined();
			expect(result.output).toBe("folded into a background job");

			// The process was NOT killed by folding: its post-fold output still lands
			// in the artifact, so output/artifact state is continuous across the fold.
			await waitFor(() => fs.existsSync(artifactPath) && fs.readFileSync(artifactPath, "utf-8").includes("AFTER-FOLD"));
			const artifact = fs.readFileSync(artifactPath, "utf-8");
			expect(artifact).toContain("BEFORE-FOLD");
			expect(artifact).toContain("AFTER-FOLD");
		} finally {
			resetSettingsForTest();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent: a second detach reports already-settled", async () => {
		const dir = tempDir();
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
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps running when the observer view is disposed mid-run", async () => {
		const dir = tempDir();
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
			const artifact = fs.readFileSync(artifactPath, "utf-8");
			expect(artifact).toContain("START");
			expect(artifact).toContain("SURVIVED");
		} finally {
			resetSettingsForTest();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still completes the run when overlay view init fails", async () => {
		const dir = tempDir();
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
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("has no kill entry point left in the overlay lifecycle", async () => {
		// Structural guard: the overlay's dismiss/dispose handlers used to call
		// session.kill(), and the native session also kills on Drop. Re-introducing
		// either would silently kill folded work.
		const source = await Bun.file(
			new URL("../src/tools/bash-interactive.ts", import.meta.url).pathname,
		).text();
		expect(source).not.toContain("session.kill()");
	});

	it("keeps its original deadline after folding, surfacing the expiry as a real outcome", async () => {
		const dir = tempDir();
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
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
