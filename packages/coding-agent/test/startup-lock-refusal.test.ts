import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@gajae-code/natives";
import { renderPublicCommandFailure } from "../src/cli/public-command-errors";
import Sdk from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import { readBrokerStartupExitRecord } from "../src/sdk/broker/broker-exit";
import { brokerProcessIncarnation } from "../src/sdk/broker/discovery";
import { ensureBroker, reapFailedBrokerLaunch } from "../src/sdk/broker/ensure";
import { BrokerLockRefusedError } from "../src/sdk/broker/lock-refusal";
import { BrokerStartupError } from "../src/sdk/broker/startup-failure";
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
			// Guidance mentions running the broker in foreground but does not pass argv (avoid unsafe retry).
			expect(
				rendered.envelope.error.nextSteps.some(step =>
					step.description.includes("Run the broker in the foreground"),
				),
			).toBe(true);
			expect(rendered.envelope.error.nextSteps.every(step => step.argv === undefined)).toBe(true);
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
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
