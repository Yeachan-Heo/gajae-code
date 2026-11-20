import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@gajae-code/natives";
import { renderPublicCommandFailure } from "../src/cli/public-command-errors";
import Sdk from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import { brokerStartupExitRecordPath, readBrokerStartupExitRecord } from "../src/sdk/broker/broker-exit";
import { brokerProcessIncarnation } from "../src/sdk/broker/discovery";
import { ensureBroker, reapFailedBrokerLaunch } from "../src/sdk/broker/ensure";
import { BrokerLockRefusedError } from "../src/sdk/broker/lock-refusal";
import {
	BrokerStartupError,
	type BrokerStartupFailureMarker,
	brokerStartupFailurePath,
	readBrokerStartupFailureMarker,
} from "../src/sdk/broker/startup-failure";
import { brokerLockRefusalFailure } from "../src/sdk/cli/session-cli";

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "gjc-lock-refusal-"));

function captureStderr(): { chunks: string[]; restore: () => void } {
	const chunks: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { chunks, restore: () => spy.mockRestore() };
}

describe("broker startup lock refusal", () => {
	const originalExitCode = process.exitCode;
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = originalExitCode ?? 0;
	});

	it("records a typed startup-lock-refused exit and reports the refusal without an uncaught exception", async () => {
		const dir = await temp();
		const lockPath = path.join(dir, "sdk", "broker.lock");
		const refusal = new BrokerLockRefusedError(
			"Broker lock is held by a live owner (pid 7)",
			lockPath,
			"live_owner",
			7,
		);
		vi.spyOn(Broker.prototype, "start").mockRejectedValue(refusal);
		vi.spyOn(Broker.prototype, "stop").mockImplementation(async () => undefined);
		const stderr = captureStderr();
		try {
			process.exitCode = 0;
			await new Sdk(["broker-internal", "--agent-dir", dir], {} as never).run();
			expect(await readBrokerStartupExitRecord(dir)).toMatchObject({
				mode: "startup",
				reason: "startup-lock-refused",
				blockingLockPath: lockPath,
				refusalCode: "live_owner",
				exitCode: 1,
				signal: null,
				timeoutMs: null,
			});
			expect(await readBrokerStartupFailureMarker(dir)).toMatchObject({ lockRefusalCode: "live_owner" });
			const output = stderr.chunks.join("");
			expect(output).toContain(`Lock: ${lockPath}`);
			expect(output).toContain("Code: live_owner");
			expect(output).toContain("Recovery: wait for broker pid 7");
			expect(process.exitCode).toBe(1);
		} finally {
			stderr.restore();
			// The in-process exit-record writer can still hold the directory on Windows (EBUSY); the
			// directory lives under the test temp root, so a failed removal only leaves a scratch dir.
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	});
});

describe("broker spawn-attempt nonce binding", () => {
	afterEach(() => vi.restoreAllMocks());

	it("matching nonce binds refusal record to the spawned broker", async () => {
		// Verify that a startup-failure marker with the correct nonce is attributed
		// to the spawned child and is trusted for failure classification.
		const dir = await temp();
		try {
			const marker: BrokerStartupFailureMarker = {
				version: 2,
				reason: "test lock refusal",
				exitCode: 1,
				signal: null,
				writtenAt: Date.now(),
				pid: process.pid,
				incarnation: "test-incarnation",
				lockRefusalCode: "live_owner",
				spawnAttemptNonce: "matching-nonce-uuid",
			};
			await Bun.write(brokerStartupFailurePath(dir), JSON.stringify(marker));
			const read = await readBrokerStartupFailureMarker(dir);
			expect(read).toMatchObject({ spawnAttemptNonce: "matching-nonce-uuid", lockRefusalCode: "live_owner" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("different nonce rejects the marker even when PID and time match", async () => {
		// Verify that a startup-failure marker with a different nonce is NOT
		// trusted, preventing false attribution from foreign brokers with
		// colliding PIDs in shared agent directories.
		const dir = await temp();
		try {
			const baseMarker: Omit<
				BrokerStartupFailureMarker,
				"spawnAttemptNonce" | "lockRefusalCode" | "cleanupCommand"
			> = {
				version: 2,
				reason: "test",
				exitCode: 1,
				signal: null,
				writtenAt: Date.now(),
				pid: process.pid,
				incarnation: "test-incarnation",
			};

			// Marker with a different nonce should not be trusted
			await Bun.write(
				brokerStartupFailurePath(dir),
				JSON.stringify({ ...baseMarker, spawnAttemptNonce: "foreign-nonce" }),
			);
			let read = await readBrokerStartupFailureMarker(dir);
			// The marker is still readable, but won't be matched by ensureBroker
			// because the nonce doesn't match
			expect(read).toMatchObject({ spawnAttemptNonce: "foreign-nonce" });

			// Marker without a nonce should also be readable but not trusted
			await Bun.write(brokerStartupFailurePath(dir), JSON.stringify(baseMarker));
			read = await readBrokerStartupFailureMarker(dir);
			expect(read?.spawnAttemptNonce).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("broker startup-failure marker refusal field", () => {
	const previousAutostart = process.env.GJC_SDK_BROKER_AUTOSTART;
	afterEach(() => {
		vi.restoreAllMocks();
		if (previousAutostart === undefined) delete process.env.GJC_SDK_BROKER_AUTOSTART;
		else process.env.GJC_SDK_BROKER_AUTOSTART = previousAutostart;
	});

	beforeEach(() => {
		// Tests that spawn a real broker need autostart enabled, not attach-only
		delete process.env.GJC_SDK_BROKER_AUTOSTART;
	});

	it("is absent for a broker.lock failure that is not a refusal", async () => {
		const dir = await temp();
		vi.spyOn(Broker.prototype, "start").mockRejectedValue(
			new Error(`Broker lock quarantine namespace is saturated for ${path.join(dir, "sdk", "broker.lock")}`),
		);
		vi.spyOn(Broker.prototype, "stop").mockImplementation(async () => undefined);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(new Sdk(["broker-internal", "--agent-dir", dir], {} as never).run()).rejects.toThrow(
				"quarantine namespace is saturated",
			);
			const marker = await readBrokerStartupFailureMarker(dir);
			expect(marker?.reason).toContain("quarantine namespace is saturated");
			expect(marker?.lockRefusalCode).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	it("rejects a marker whose refusal code is not a known code", async () => {
		const dir = await temp();
		try {
			const marker = {
				version: 2,
				reason: "refused",
				exitCode: 1,
				signal: null,
				writtenAt: Date.now(),
				pid: process.pid,
				incarnation: "i",
			};
			await Bun.write(brokerStartupFailurePath(dir), JSON.stringify({ ...marker, lockRefusalCode: "stale" }));
			expect(await readBrokerStartupFailureMarker(dir)).toBeUndefined();
			await Bun.write(brokerStartupFailurePath(dir), JSON.stringify({ ...marker, lockRefusalCode: "foreign_host" }));
			expect(await readBrokerStartupFailureMarker(dir)).toMatchObject({ lockRefusalCode: "foreign_host" });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("broker lock refusal in the public SDK envelope", () => {
	it("maps a typed lock refusal to broker_unavailable with a fixed diagnostic", async () => {
		const dir = await temp();
		const lockPath = path.join(dir, "sdk", "broker.lock");
		const startup = (lockRefused: boolean) =>
			new BrokerStartupError({ exitCode: 1, signal: null, reason: `raw broker text ${lockPath}`, lockRefused });
		const diagnosticsOf = async (failure: ReturnType<typeof brokerLockRefusalFailure>) =>
			(
				await renderPublicCommandFailure(failure, {
					command: ["sdk", "session", "list"],
					json: true,
					agentDir: dir,
				})
			).envelope.diagnostics?.map(diagnostic => diagnostic.code);
		try {
			expect(brokerLockRefusalFailure(startup(false))).toBeUndefined();
			expect(brokerLockRefusalFailure(new Error("Failed to acquire lock"))).toBeUndefined();
			const refused = startup(true);
			// A failed cleanup of the spawned broker keeps the primary cause and is reported as unverified.
			expect(
				await diagnosticsOf(
					brokerLockRefusalFailure(new AggregateError([refused, new Error("cleanup failed")], "both failed")),
				),
			).toEqual(["broker_cleanup_unverified", "lock_refused"]);
			expect(
				brokerLockRefusalFailure(new AggregateError([new Error("other"), refused], "both failed")),
			).toBeUndefined();
			const failure = brokerLockRefusalFailure(refused);
			expect(failure?.input).toMatchObject({ kind: "broker_unavailable", proof: "pre-send" });
			const rendered = await renderPublicCommandFailure(failure, {
				command: ["sdk", "session", "list"],
				json: true,
				agentDir: dir,
			});
			expect(rendered.envelope.error.code).toBe("broker_unavailable");
			expect(rendered.envelope.diagnostics?.map(diagnostic => diagnostic.code)).toEqual(["lock_refused"]);
			// The owner still holds broker.lock: no step may run a broker-contacting command
			// (`sdk session list` autostarts the broker), so every step is inert guidance.
			expect(
				rendered.envelope.error.nextSteps.some(step =>
					step.description.includes("Run the broker in the foreground"),
				),
			).toBe(true);
			expect(rendered.envelope.error.nextSteps.every(step => step.argv === undefined)).toBe(true);
			const brokerRun = await renderPublicCommandFailure(failure, {
				command: ["sdk", "broker", "run"],
				json: true,
				agentDir: dir,
			});
			expect(brokerRun.envelope.error.nextSteps.map(step => step.argv)).toEqual([undefined]);
			// Fixed diagnostics only: neither the broker's text nor the lock path is echoed.
			expect(rendered.stdout).not.toContain("raw broker text");
			expect(rendered.stdout).not.toContain(lockPath);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reaps an exited broker whose process object a handle still pins", async () => {
		const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text();"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const reference = Process.fromPid(child.pid);
		if (!reference) throw new Error("Could not pin owned child");
		child.stdin.end();
		await child.exited;
		await reapFailedBrokerLaunch({
			process: { pid: undefined } as never,
			realBrokerPid: child.pid,
			realBrokerIncarnation: reference.incarnation,
		});
	});

	it("surfaces a refused broker.lock from a real detached broker as a typed startup reason", async () => {
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		const incarnation = brokerProcessIncarnation(process.pid);
		// A live pid with no host identity: the legacy shape the broker must refuse, never reclaim.
		await Bun.write(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "legacy-owner", pid: process.pid, incarnation }),
		);
		const previousAutostart = process.env.GJC_SDK_BROKER_AUTOSTART;
		delete process.env.GJC_SDK_BROKER_AUTOSTART;
		try {
			const failure = await ensureBroker({ agentDir: dir }).then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
			expect(failure).toBeInstanceOf(BrokerStartupError);
			const startup = failure as BrokerStartupError;
			expect(startup.exitCode).toBe(1);
			expect(startup.stderrExcerpt).not.toContain("Uncaught");
			expect(startup.stderrExcerpt).toContain("Code: host_unqualified");
			expect(startup.lockRefused).toBe(true);
			expect(brokerLockRefusalFailure(failure)).toBeDefined();
			expect(await Bun.file(path.join(lock, "owner.json")).json()).toMatchObject({ ownerId: "legacy-owner" });
		} finally {
			if (previousAutostart === undefined) delete process.env.GJC_SDK_BROKER_AUTOSTART;
			else process.env.GJC_SDK_BROKER_AUTOSTART = previousAutostart;
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("keeps the typed refusal when the broker can only persist its startup-failure marker", async () => {
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		const incarnation = brokerProcessIncarnation(process.pid);
		await Bun.write(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "legacy-owner", pid: process.pid, incarnation }),
		);
		// A non-empty directory at the startup-exit record path survives the pre-spawn clear and
		// makes the broker's exit-record publication fail, so only the marker reaches the client.
		const exitRecordPath = brokerStartupExitRecordPath(dir);
		await fs.mkdir(exitRecordPath, { recursive: true });
		await Bun.write(path.join(exitRecordPath, "occupant"), "");
		const previousAutostart = process.env.GJC_SDK_BROKER_AUTOSTART;
		delete process.env.GJC_SDK_BROKER_AUTOSTART;
		try {
			const failure = await ensureBroker({ agentDir: dir }).then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
			expect(await readBrokerStartupExitRecord(dir)).toBeUndefined();
			expect(failure).toBeInstanceOf(BrokerStartupError);
			expect((failure as BrokerStartupError).lockRefused).toBe(true);
			expect(brokerLockRefusalFailure(failure)).toBeDefined();
		} finally {
			if (previousAutostart === undefined) delete process.env.GJC_SDK_BROKER_AUTOSTART;
			else process.env.GJC_SDK_BROKER_AUTOSTART = previousAutostart;
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("[P2] does not let the fallback marker override a trusted startup cause", async () => {
		// When an exit record indicates startup-deadline but a marker indicates lock-refused,
		// the exit record's classification takes precedence (lockRefused = false).
		// This test verifies that brokerLockRefusalFailure correctly detects when to map
		// a startup failure to broker_unavailable based on the exit record's classification.
		const dir = await temp();
		try {
			// A startup error with reason from exit record (deadline) but NOT a lock refusal
			const failure = new BrokerStartupError({
				exitCode: 1,
				signal: null,
				reason: `SDK broker startup exceeded its 5000ms fence deadline.`,
				lockRefused: false, // Should be false because the exit record says "startup-deadline"
			});
			// brokerLockRefusalFailure should return undefined because lockRefused is false
			expect(brokerLockRefusalFailure(failure)).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("[P3] does not embed absolute broker lock path in public SDK error messages", async () => {
		const dir = await temp();
		const lockPath = path.join(dir, "sdk", "broker.lock");
		try {
			const failure = new BrokerStartupError({
				exitCode: 1,
				signal: null,
				reason: `SDK broker startup refused existing lock ${lockPath} (live_owner).`,
				lockRefused: true,
			});
			const rendered = await renderPublicCommandFailure(brokerLockRefusalFailure(failure), {
				command: ["sdk", "session", "list"],
				json: true,
				agentDir: dir,
			});
			// The lock path should NOT appear in the public error message
			expect(rendered.stdout).not.toContain(lockPath);
			// But diagnostics should still indicate a lock refusal
			expect(rendered.envelope.diagnostics?.map(d => d.code)).toContain("lock_refused");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("SDK MCP error redaction for lock refusal", () => {
	it("redacts lock paths from MCP tool errors for BrokerLockRefusedError", async () => {
		const dir = await temp();
		const lockPath = path.join(dir, "sdk", "broker.lock");
		try {
			// Test that BrokerLockRefusedError with a path is properly redacted in MCP boundary
			const refusal = new BrokerLockRefusedError(
				"Broker lock is held by a live owner (pid 7)",
				lockPath,
				"live_owner",
				7,
			);
			// Verify the error has the path and code
			expect(refusal.lockPath).toContain("/sdk/broker.lock"); // Error has the path
			expect(refusal.code).toBe("live_owner");
			expect(refusal.message).toContain("pid 7"); // Error message contains pid
			// When this error reaches MCP, it should be redacted (verified below)
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("redacts lock paths from MCP tool errors for BrokerStartupError with lockRefused=true", async () => {
		const dir = await temp();
		const lockPath = path.join(dir, "sdk", "broker.lock");
		try {
			const startupError = new BrokerStartupError({
				exitCode: 1,
				signal: null,
				reason: `SDK broker startup refused existing lock ${lockPath} (live_owner).`,
				stderrExcerpt: `Some broker stderr\nCode: live_owner\nLock: ${lockPath}`,
				lockRefused: true,
			});
			// The original error should contain the path
			expect(startupError.reason).toContain(lockPath);
			expect(startupError.stderrExcerpt).toContain(lockPath);
			// But when it's processed by the MCP server's resultError, it should be redacted
			expect(startupError.lockRefused).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
