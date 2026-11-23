import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "../src/config/file-lock";
import { awaitSpawnHostRegistration, type SpawnRegistrationRequest } from "../src/sdk/broker/broker";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import {
	resolveSessionLocator,
	SESSION_HEARTBEAT_INTERVAL_MS,
	SessionIndex,
	type SessionIndexEvent,
} from "../src/sdk/broker/session-index";
import { trackTempDirs } from "./helpers/tracked-temp-dirs";

const trackedTemp = trackTempDirs();

type RegistrationInput = Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts"> &
	Partial<Pick<SessionIndexEvent, "ts">>;

/**
 * An isolated agent root with the broker's index reader and a separate index
 * writer standing in for the child host. The host row names this test process
 * (live pid, real OS incarnation) so the projection's liveness and incarnation
 * checks run for real.
 */
async function fixture(childId: string) {
	const agentDir = await trackedTemp.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-registration-"));
	const cwd = path.join(agentDir, "workspace");
	const stateRoot = path.join(cwd, ".gjc", "state");
	await fs.mkdir(stateRoot, { recursive: true });
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("this platform cannot observe the test process incarnation");
	const owner = { pid: process.pid, incarnation };
	const effectMarker = `marker-${childId}`;
	const locator = await resolveSessionLocator(cwd, stateRoot);
	const observer = await new SessionIndex(agentDir).open();
	const host = await new SessionIndex(agentDir).open();
	const registration = (overrides: Partial<RegistrationInput> = {}): RegistrationInput => ({
		type: "host_registered",
		sessionId: childId,
		locator,
		endpointGeneration: 1,
		pid: owner.pid,
		processIncarnation: owner.incarnation,
		hostIncarnation: owner.incarnation,
		lifecycleRequestId: effectMarker,
		...overrides,
	});
	const request = (deadlineAt: number): SpawnRegistrationRequest => ({
		childId,
		cwd,
		stateRoot,
		owner,
		effectMarker,
		deadlineAt,
	});
	return { agentDir, cwd, stateRoot, owner, effectMarker, locator, observer, host, registration, request };
}

describe("awaitSpawnHostRegistration", () => {
	it("admits a timely registration whose in-budget read is evaluated after the deadline", async () => {
		const f = await fixture("child-late-evaluation");
		await f.host.append(f.registration());
		const deadlineAt = Date.now() + 1_000;
		// The read itself starts well inside the budget. A synchronous stall right
		// after it (the shape of the broker's synchronous tmux probing on macOS)
		// pushes its evaluation past the deadline.
		const refresh = f.observer.refresh.bind(f.observer);
		const spy = vi.spyOn(f.observer, "refresh").mockImplementation(async options => {
			await refresh(options);
			Bun.sleepSync(Math.max(0, deadlineAt - Date.now()) + 50);
		});
		try {
			const result = await awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
			expect(Date.now()).toBeGreaterThan(deadlineAt);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result).toEqual({
				ok: true,
				registration: {
					sessionId: "child-late-evaluation",
					endpointGeneration: 1,
					pid: f.owner.pid,
					processIncarnation: f.owner.incarnation,
					lifecycleRequestId: f.effectMarker,
					cwd: f.locator.cwd,
					stateRoot: f.locator.stateRoot,
				},
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("admits a registration the host publishes while the broker is already polling", async () => {
		const f = await fixture("child-concurrent");
		const deadlineAt = Date.now() + 5_000;
		const waiting = awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
		await Bun.sleep(150);
		await f.host.append(f.registration());
		const result = await waiting;
		expect(result).toMatchObject({ ok: true, registration: { sessionId: "child-concurrent" } });
		expect(Date.now()).toBeLessThan(deadlineAt);
	});

	it("stops waiting on a held index lock at the deadline and reports the miss as inconclusive", async () => {
		const f = await fixture("child-lock-held");
		await f.host.append(f.registration());
		const acquired = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const holder = withFileLock(path.join(f.agentDir, "sdk", "sessions", "index.jsonl"), async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		const releaseTimer = setTimeout(() => release.resolve(), 3_000);
		try {
			const started = Date.now();
			const deadlineAt = started + 400;
			const result = await awaitSpawnHostRegistration(f.observer, f.request(deadlineAt));
			// Without the bound, the read waits for the holder (3 s) and only then
			// reports a bare miss.
			expect(Date.now() - deadlineAt).toBeLessThan(1_000);
			expect(result).toEqual({ ok: false, reason: "inconclusive" });
		} finally {
			clearTimeout(releaseTimer);
			release.resolve();
			await holder;
		}
		// The registration was there all along: once the index is readable again
		// the same exact predicate admits it.
		const recovered = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 2_000));
		expect(recovered).toMatchObject({ ok: true, registration: { sessionId: "child-lock-held" } });
	});

	it("reports absent when no row for the child was ever published", async () => {
		const f = await fixture("child-absent");
		await f.host.append({ ...f.registration(), sessionId: "unrelated-session" });
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "absent" });
	});

	it("reports inconclusive when the deadline has already passed before any read", async () => {
		const f = await fixture("child-expired");
		await f.host.append(f.registration());
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() - 1));
		expect(result).toEqual({ ok: false, reason: "inconclusive" });
	});

	for (const control of [
		{ name: "wrong lifecycle marker", overrides: { lifecycleRequestId: "marker-other" } },
		{ name: "wrong host incarnation", overrides: { hostIncarnation: "other-incarnation" } },
		{ name: "supervisor pid", overrides: { pid: process.ppid } },
		{ name: "generation 0 transcript row", overrides: { endpointGeneration: 0 } },
		{
			name: "stale registration with an early timestamp",
			overrides: { ts: Date.now() - 10 * SESSION_HEARTBEAT_INTERVAL_MS },
		},
	] as const) {
		it(`refuses a ${control.name} even though it was published before the deadline`, async () => {
			const f = await fixture(`child-${control.name.replaceAll(" ", "-")}`);
			await f.host.append(f.registration(control.overrides));
			const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
			expect(result).toEqual({
				ok: false,
				reason: control.overrides.endpointGeneration === 0 ? "absent" : "mismatch",
			});
		});
	}

	it("refuses a row from another workspace's state root", async () => {
		const f = await fixture("child-foreign-root");
		const foreign = path.join(f.agentDir, "foreign", ".gjc", "state");
		await fs.mkdir(foreign, { recursive: true });
		await f.host.append(f.registration({ locator: { ...f.locator, stateRoot: foreign } }));
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a registration the host already unregistered", async () => {
		const f = await fixture("child-unregistered");
		await f.host.append(f.registration());
		await f.host.append(f.registration({ type: "host_unregistered" }));
		const result = await awaitSpawnHostRegistration(f.observer, f.request(Date.now() + 300));
		expect(result).toEqual({ ok: false, reason: "mismatch" });
	});
});
