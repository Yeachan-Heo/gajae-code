import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface RecoveryResult {
	found: boolean;
	stats: {
		autoDisabledReason?: string;
		currentCommitTransition?: { kind: string; reason: string };
	};
}

function runWorker(worker: string, root: string, mode: string) {
	return Bun.spawnSync({
		cmd: [process.execPath, worker],
		env: {
			...process.env,
			GJC_SESSION_MEMORY_CRASH_MODE: mode,
			GJC_SESSION_MEMORY_CRASH_ROOT: root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("session memory physical crash recovery", () => {
	for (const { crashMode, restoreTail } of [
		{ crashMode: "crash-after-transcript-fsync", restoreTail: false },
		{ crashMode: "crash-after-tail-fsync", restoreTail: false },
		{ crashMode: "crash-before-tail-fsync", restoreTail: true },
		{ crashMode: "crash-before-marker-temp-fsync", restoreTail: false },
		{ crashMode: "crash-after-marker-temp-fsync", restoreTail: false },
		{ crashMode: "crash-before-marker-directory-fsync", restoreTail: false },
		{ crashMode: "crash-after-marker-directory-fsync", restoreTail: false },
	]) {
		it(`recovers authoritative append after ${crashMode}`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-crash-"));
			const worker = path.join(import.meta.dir, "fixtures", "session-memory-crash-worker.ts");
			try {
				const setup = runWorker(worker, root, "setup");
				expect(setup.exitCode, setup.stderr.toString()).toBe(0);
				const fixture = JSON.parse(setup.stdout.toString()) as { sessionFile: string };
				const tailPath = `${fixture.sessionFile.slice(0, -6)}/.session-memory.spill.tail`;
				const durableTailBefore = fs.readFileSync(tailPath);
				const crashed = runWorker(worker, root, crashMode);
				expect(crashed.exitCode).not.toBe(0);
				if (restoreTail) fs.writeFileSync(tailPath, durableTailBefore);
				const recovered = runWorker(worker, root, "recover");
				expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
				const result = JSON.parse(recovered.stdout.toString()) as RecoveryResult;
				expect(fs.readdirSync(fixture.sessionFile.slice(0, -6)).filter(name => name.endsWith(".tmp"))).toEqual([]);
				expect(result.found).toBe(true);
				expect(result.stats.currentCommitTransition).toEqual({
					kind: "exact",
					reason: "descriptor_and_proof_match",
				});
				const reopened = runWorker(worker, root, "recover");
				expect(reopened.exitCode, reopened.stderr.toString()).toBe(0);
				const reopenedResult = JSON.parse(reopened.stdout.toString()) as RecoveryResult;
				expect(reopenedResult.found).toBe(true);
				expect(reopenedResult.stats.autoDisabledReason).toBeUndefined();
				expect(reopenedResult.stats.currentCommitTransition).toEqual({
					kind: "exact",
					reason: "descriptor_and_proof_match",
				});
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}, 30_000);
	}
});

describe("session memory first-marker physical crash recovery", () => {
	for (const crashMode of [
		"create-crash-before-marker-temp-fsync",
		"create-crash-after-marker-temp-fsync",
		"create-crash-before-marker-directory-fsync",
		"create-crash-after-marker-directory-fsync",
	]) {
		it(`recovers first checked marker publication after ${crashMode}`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-create-crash-"));
			const worker = path.join(import.meta.dir, "fixtures", "session-memory-crash-worker.ts");
			try {
				const setup = runWorker(worker, root, "setup-raw");
				expect(setup.exitCode, setup.stderr.toString()).toBe(0);
				const fixture = JSON.parse(setup.stdout.toString()) as { sessionFile: string };
				const crashed = runWorker(worker, root, crashMode);
				expect(crashed.exitCode).not.toBe(0);
				const recovered = runWorker(worker, root, "recover");
				expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
				const result = JSON.parse(recovered.stdout.toString()) as RecoveryResult;
				expect(result.found).toBe(false);
				expect(result.stats.currentCommitTransition).toEqual({
					kind: "exact",
					reason: "descriptor_and_proof_match",
				});
				expect(fs.readdirSync(fixture.sessionFile.slice(0, -6)).filter(name => name.endsWith(".tmp"))).toEqual([]);
				const reopened = runWorker(worker, root, "recover");
				expect(reopened.exitCode, reopened.stderr.toString()).toBe(0);
				const reopenedResult = JSON.parse(reopened.stdout.toString()) as RecoveryResult;
				expect(reopenedResult.found).toBe(false);
				expect(reopenedResult.stats.autoDisabledReason).toBeUndefined();
				expect(reopenedResult.stats.currentCommitTransition).toEqual({
					kind: "exact",
					reason: "descriptor_and_proof_match",
				});
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}, 30_000);
	}
});
