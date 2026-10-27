import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	COHORT_MARKER_ENV,
	Cohort,
	type CohortAncestry,
	type CohortDeps,
	gatedTotal,
} from "../bench/multisession/cohort";
import {
	decodeProcArgs2,
	listAllPids,
	parentPid,
	processStartTimeMs,
	processUid,
} from "../bench/multisession/procinfo";
import type { CohortSample, FootprintRead, ProcessEnvRead } from "../bench/multisession/types";
import { observeProcessIncarnation } from "../src/sdk/broker/process-incarnation";

type FakeProcess = {
	pid: number;
	incarnation: string;
	env: ProcessEnvRead;
	startTime: number | null;
	parent: number | null;
	uid: number | null;
	footprint: FootprintRead;
};

function completeEnv(token?: string): ProcessEnvRead {
	return { status: "complete", argv: ["bun", "-e"], env: token ? { [COHORT_MARKER_ENV]: token } : {} };
}

function makeHarness() {
	const processes = new Map<number, FakeProcess>();
	const tracked = new Map<string, { pid: number; incarnation: string }>();
	const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
	const ancestry: CohortAncestry = {
		registerRoot(root) {
			tracked.set(`${root.pid}:${root.incarnation}`, root);
		},
		scan() {
			return { members: [...tracked.values()], complete: true };
		},
	};
	const add = (
		pid: number,
		options: Partial<Omit<FakeProcess, "pid" | "incarnation">> & { incarnation?: string } = {},
	): FakeProcess => {
		const incarnation = options.incarnation ?? `darwin:${pid}:1`;
		const record: FakeProcess = {
			pid,
			incarnation,
			env: options.env ?? completeEnv(),
			startTime: options.startTime ?? 2_000,
			parent: options.parent ?? null,
			uid: options.uid === undefined ? currentUid : options.uid,
			footprint: options.footprint ?? { status: "ok", pid, incarnation, physFootprint: pid * 10, rss: pid * 5 },
		};
		processes.set(pid, record);
		return record;
	};
	const deps: CohortDeps = {
		listAllPids: () => [...processes.keys()],
		readProcessEnv: pid => processes.get(pid)?.env ?? { status: "failed", errno: 3 },
		sampleProcess: pid => processes.get(pid)?.footprint ?? { status: "absent", pid },
		processStartTimeMs: pid => processes.get(pid)?.startTime ?? null,
		// Fake kernel unique ids equal the pid; `parent` is the ORIGINAL parent (pid 1 = launchd).
		uniqueIdentity: pid => {
			const record = processes.get(pid);
			return record ? { uniqueId: BigInt(pid), parentUniqueId: BigInt(record.parent ?? 0) } : null;
		},
		processUid: pid => processes.get(pid)?.uid ?? null,
		observeProcessIncarnation: pid => {
			const record = processes.get(pid);
			return record ? { status: "present", incarnation: record.incarnation } : { status: "absent" };
		},
		ancestry,
		now: () => 500,
	};
	add(100, { incarnation: "darwin:100:1", startTime: 500 });
	const cohort = new Cohort({ token: "run-token", driverPid: 100, runStartEpochMs: 1_000, deps });
	return { cohort, processes, tracked, add, deps };
}

function argsBuffer(argv: string[], env: string[]): Uint8Array {
	const payload = new TextEncoder().encode(
		`/bin/bun\0\0${argv.join("\0")}\0${env.length > 0 ? `${env.join("\0")}\0` : "\0"}`,
	);
	const bytes = new Uint8Array(4 + payload.byteLength);
	new DataView(bytes.buffer).setInt32(0, argv.length, true);
	bytes.set(payload, 4);
	return bytes;
}

function pidMember(sample: CohortSample, pid: number): CohortSample["members"][number][] {
	return sample.members.filter(member => member.pid === pid);
}

describe("multi-session process environment classification", () => {
	it("classifies complete env, argv-only, truncated buffers, and malformed argc", () => {
		const complete = decodeProcArgs2(argsBuffer(["bun", "-e", ""], ["A=one", "EMPTY="]), 4096);
		expect(complete).toEqual({
			status: "complete",
			argv: ["bun", "-e", ""],
			env: { A: "one", EMPTY: "" },
		});

		const argvOnly = decodeProcArgs2(argsBuffer(["bun", "-e"], []), 4096);
		expect(argvOnly).toEqual({ status: "argv-only", argv: ["bun", "-e"] });

		const full = argsBuffer(["bun"], ["A=value"]);
		expect(decodeProcArgs2(full.subarray(0, full.byteLength - 1), 4096).status).toBe("truncated");
		expect(decodeProcArgs2(full, full.byteLength).status).toBe("truncated");

		const malformed = argsBuffer(["bun"], ["A=value"]);
		new DataView(malformed.buffer).setInt32(0, -1, true);
		expect(decodeProcArgs2(malformed, 4096)).toEqual({ status: "malformed", reason: "invalid-argc" });
	});

	it.skipIf(process.platform !== "darwin")("reads the process table, start time, parent, and uid from libproc", () => {
		expect(listAllPids()).toContain(process.pid);
		expect(processStartTimeMs(process.pid)).toBeGreaterThan(0);
		expect(parentPid(process.pid)).toBeGreaterThan(0);
		expect(processUid(process.pid)).toBe(typeof process.getuid === "function" ? process.getuid() : null);
	});
});

describe("multi-session ownership cohort", () => {
	it("deduplicates root registrations and counts the driver once, including when it is an ancestor", () => {
		const harness = makeHarness();
		const root = harness.add(200, { env: completeEnv("run-token"), parent: 100 });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.tracked.set("100:darwin:100:1", { pid: 100, incarnation: "darwin:100:1" });

		const sample = harness.cohort.sample(0, "active:fixture");
		expect(pidMember(sample, 100)).toHaveLength(1);
		expect(sample.armTotal).toBe(1_000 + 2_000);
		expect(sample.complete).toBe(true);
		harness.cohort.close();
	});

	it("keeps marker ownership after root unregistration and finds residual orphans", () => {
		const harness = makeHarness();
		const root = harness.add(201, { env: completeEnv("run-token") });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.cohort.unregisterRoot(root.pid);

		const scan = harness.cohort.scanOwnership();
		expect(scan.members.some(member => member.pid === root.pid && member.reason === "marker")).toBe(true);
		expect(harness.cohort.orphanCheck()).toEqual({ owned: [root.pid], unresolved: [], complete: true, errors: [] });
		harness.cohort.close();
	});

	it("admits a complete marker-free descendant when the root ancestry is directly provable", () => {
		const harness = makeHarness();
		const root = harness.add(212, { env: completeEnv("run-token") });
		const scrubbed = harness.add(213, { env: completeEnv(), parent: root.pid });
		harness.cohort.registerRoot(root.pid, root.incarnation);

		const scan = harness.cohort.scanOwnership();
		const member = scan.members.find(entry => entry.pid === scrubbed.pid);
		expect(member?.reason).toBe("ancestry");
		expect(member?.flags).toContain("marker-missing");
		harness.cohort.close();
	});

	it("excludes a registered PID replaced by a marker-free incarnation", () => {
		const harness = makeHarness();
		const root = harness.add(202, { env: completeEnv("run-token"), incarnation: "darwin:202:1" });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.add(root.pid, { env: completeEnv(), incarnation: "darwin:202:2" });

		const scan = harness.cohort.scanOwnership();
		expect(scan.excluded).toContainEqual({ pid: root.pid, reason: "pid-reused" });
		expect(scan.members.some(member => member.pid === root.pid)).toBe(false);
		harness.cohort.close();
	});

	it("admits a retained-ancestry descendant with unreadable env, but keeps an unprovable one unresolved and incomplete", () => {
		const harness = makeHarness();
		const root = harness.add(203, { env: completeEnv("run-token") });
		const child = harness.add(204, { env: { status: "failed", errno: 13 }, parent: root.pid });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.tracked.set(`${child.pid}:${child.incarnation}`, { pid: child.pid, incarnation: child.incarnation });

		const settled = harness.cohort.sample(0, "active:fixture");
		expect(pidMember(settled, child.pid)[0]).toMatchObject({
			reason: "ancestry",
			flags: ["marker-missing", "env-failed"],
		});
		expect(settled.complete).toBe(true);

		// Same unreadable env, but its original parent is gone and nothing retained it.
		const stray = harness.add(226, { env: { status: "failed", errno: 13 }, parent: 888 });
		const sample = harness.cohort.sample(1, "active:fixture");
		expect(pidMember(sample, stray.pid)[0]?.reason).toBe("unresolved-ownership");
		expect(sample.complete).toBe(false);
		expect(sample.armTotal).toBeNull();
		expect(harness.cohort.orphanCheck().unresolved).toContain(stray.pid);

		// The same stray exits right after the orphan scan lists it: not an orphan.
		const observe = harness.deps.observeProcessIncarnation!;
		let scanned = false;
		harness.deps.observeProcessIncarnation = pid => {
			if (pid !== stray.pid) return observe(pid);
			const result = scanned ? { status: "absent" as const } : observe(pid);
			scanned = true;
			return result;
		};
		const receipt = harness.cohort.orphanCheck();
		expect(scanned).toBe(true);
		expect(receipt.unresolved).not.toContain(stray.pid);
		expect(receipt.complete).toBe(true);
		harness.cohort.close();
	});

	it("drops a member that exits between ownership scan and footprint read without making the sample incomplete", () => {
		const harness = makeHarness();
		const root = harness.add(240, { env: completeEnv("run-token") });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		// Unprovable ownership, but the process is already gone when its memory is read.
		const gone = harness.add(241, {
			env: { status: "argv-only", argv: ["sh"] },
			parent: 999,
			footprint: { status: "absent", pid: 241 },
		});
		// Same unprovable ownership, still alive: must keep the sample incomplete.
		const live = harness.add(242, { env: { status: "argv-only", argv: ["sh"] }, parent: 999 });

		const both = harness.cohort.sample(0, "active:fixture");
		expect(both.complete).toBe(false);
		expect(both.incompleteReasons).toContain(`unresolved-ownership:${live.pid}`);
		expect(both.incompleteReasons).not.toContain(`unresolved-ownership:${gone.pid}`);

		harness.processes.delete(live.pid);
		const settled = harness.cohort.sample(1, "active:fixture");
		expect(settled.complete).toBe(true);
		expect(settled.armTotal).toBe(100 * 10 + root.pid * 10);
		harness.cohort.close();
	});

	it("re-reads an unknown identity once: a process gone on re-read is skipped, a persistent unknown stays unresolved", () => {
		const harness = makeHarness();
		const transient = harness.add(250, { env: { status: "argv-only", argv: ["sh"] } });
		const stuck = harness.add(251, { env: { status: "argv-only", argv: ["sh"] } });
		const observe = harness.deps.observeProcessIncarnation!;
		let transientReads = 0;
		harness.deps.observeProcessIncarnation = pid => {
			if (pid === transient.pid) {
				transientReads += 1;
				return transientReads === 1
					? { status: "unknown", reasonCode: "identity_unavailable" }
					: { status: "absent" };
			}
			if (pid === stuck.pid) return { status: "unknown", reasonCode: "identity_unavailable" };
			return observe(pid);
		};
		const scan = harness.cohort.scanOwnership();
		expect(transientReads).toBe(2);
		expect(scan.unresolvedPids).toEqual([stuck.pid]);
		expect(scan.errors).toEqual([`identity-unresolved:${stuck.pid}:identity_unavailable`]);
		harness.cohort.close();
	});

	it("does not exclude a post-run argv-only survivor outside tracked ancestry", () => {
		const harness = makeHarness();
		const survivor = harness.add(205, { env: { status: "argv-only", argv: ["bun"] }, startTime: 2_000 });

		const scan = harness.cohort.scanOwnership();
		expect(scan.members.find(member => member.pid === survivor.pid)?.reason).toBe("unresolved-ownership");
		expect(scan.excluded.some(exclusion => exclusion.pid === survivor.pid)).toBe(false);
		expect(harness.cohort.sample(0, "active:fixture").complete).toBe(false);
		harness.cohort.close();
	});

	it("excludes pre-run argv-only processes and fully known non-owned ancestry", () => {
		const harness = makeHarness();
		const preRun = harness.add(206, { env: { status: "argv-only", argv: ["bun"] }, startTime: 999 });
		const unrelated = harness.add(207, {
			env: { status: "failed", errno: 13 },
			startTime: 2_000,
			parent: 1,
		});

		const scan = harness.cohort.scanOwnership();
		expect(scan.excluded).toContainEqual({ pid: preRun.pid, reason: "pre-run" });
		expect(scan.excluded).toContainEqual({ pid: unrelated.pid, reason: "non-owned-ancestry" });
		harness.cohort.close();
	});

	it("excludes a post-run process spawned by an unrelated pre-run shell, by original parent", () => {
		const harness = makeHarness();
		const shell = harness.add(220, { env: { status: "argv-only", argv: ["zsh"] }, startTime: 10, parent: 1 });
		const sleeper = harness.add(221, {
			env: { status: "argv-only", argv: ["sleep", "1"] },
			startTime: 2_000,
			parent: shell.pid,
		});

		const scan = harness.cohort.scanOwnership();
		expect(scan.excluded).toContainEqual({ pid: sleeper.pid, reason: "non-owned-ancestry" });
		expect(scan.members.some(member => member.pid === sleeper.pid)).toBe(false);
		harness.cohort.close();
	});

	it("keeps an orphan whose original parent vanished unresolved even though it now hangs off launchd", () => {
		const harness = makeHarness();
		// Original parent 777 exited before any scan; the kernel reparented the
		// orphan to launchd, but p_puniqueid still names 777, so ownership is unknown.
		const orphan = harness.add(222, { env: { status: "argv-only", argv: ["bun"] }, startTime: 2_000, parent: 777 });

		const scan = harness.cohort.scanOwnership();
		expect(scan.members.find(member => member.pid === orphan.pid)?.reason).toBe("unresolved-ownership");
		expect(harness.cohort.sample(0, "active:fixture").complete).toBe(false);
		harness.cohort.close();
	});

	it("owns an unmarked descendant whose original-parent chain reaches a registered root", () => {
		const harness = makeHarness();
		const root = harness.add(223, { env: completeEnv("run-token") });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		const middle = harness.add(224, { env: { status: "argv-only", argv: ["sh"] }, parent: root.pid });
		const leaf = harness.add(225, { env: { status: "argv-only", argv: ["sleep"] }, parent: middle.pid });
		harness.tracked.clear();

		const scan = harness.cohort.scanOwnership();
		expect(scan.members.find(member => member.pid === leaf.pid)?.flags).toContain("marker-missing");
		harness.cohort.close();
	});

	it("fails visibility when a registered root does not expose the run token", () => {
		const harness = makeHarness();
		const root = harness.add(208, { env: { status: "argv-only", argv: ["bun"] } });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		expect(harness.cohort.visibilityCheck()).toMatchObject({
			passed: false,
			reason: `marker-not-visible:${root.pid}:argv-only`,
		});
		harness.cohort.close();
	});

	it("charges the Broker baseline once without admitting an unmarked process", () => {
		const harness = makeHarness();
		const root = harness.add(209, { env: completeEnv("run-token") });
		harness.add(210, { env: completeEnv() });
		harness.cohort.registerRoot(root.pid, root.incarnation);

		const sample = harness.cohort.sample(0, "active:fixture");
		expect(sample.armTotal).toBe(1_000 + 2_090);
		expect(sample.excluded).toContainEqual({ pid: 210, reason: "marker-free" });
		expect(gatedTotal(sample.armTotal!, 500)).toBe(3_590);
		harness.cohort.close();
	});

	it("makes unresolved and raced reads plus missing ticks incomplete with null totals", () => {
		const harness = makeHarness();
		const root = harness.add(211, { env: completeEnv("run-token") });
		harness.cohort.registerRoot(root.pid, root.incarnation);
		harness.deps.sampleProcess = pid => {
			if (pid === root.pid) return { status: "raced", pid, reason: "identity changed" };
			const record = harness.processes.get(pid);
			return record ? record.footprint : { status: "absent", pid };
		};

		const raced = harness.cohort.sample(0, "active:fixture");
		expect(raced.complete).toBe(false);
		expect(raced.armTotal).toBeNull();
		harness.deps.sampleProcess = pid => {
			if (pid === root.pid) return { status: "unresolved", pid, reason: "rusage denied" };
			const record = harness.processes.get(pid);
			return record ? record.footprint : { status: "absent", pid };
		};
		const unresolved = harness.cohort.sample(1, "active:fixture");
		expect(unresolved.complete).toBe(false);
		expect(unresolved.armTotal).toBeNull();
		harness.deps.sampleProcess = pid => {
			const record = harness.processes.get(pid);
			return record ? record.footprint : { status: "absent", pid };
		};
		const missed = harness.cohort.sample(3, "active:fixture");
		expect(missed.complete).toBe(false);
		expect(missed.incompleteReasons).toContain("missing-tick:2-2");
		expect(missed.armTotal).toBeNull();
		harness.cohort.close();
	});

	it.skipIf(process.platform !== "darwin")(
		"finds a detached grandchild by its marker after its parent exits before scanning",
		async () => {
			const runStartEpochMs = Date.now();
			const tempDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-cohort-"));
			const token = `fixture-${process.pid}-${Date.now()}`;
			const parentExitedFile = path.join(tempDir, "parent-exited");
			const grandchildPidFile = path.join(tempDir, "grandchild-pid");
			const grandchildSource = `await Bun.write(${JSON.stringify(grandchildPidFile)}, String(process.pid)); await Promise.withResolvers().promise;`;
			const parentSource = `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchildSource)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env }); child.unref();`;
			const rootSource = `const parent = Bun.spawn([process.execPath, "-e", ${JSON.stringify(parentSource)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env }); await parent.exited; await Bun.write(${JSON.stringify(parentExitedFile)}, "exited"); await Promise.withResolvers().promise;`;
			const root = Bun.spawn([process.execPath, "-e", rootSource], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: { ...process.env, [COHORT_MARKER_ENV]: token },
			});
			let cohort: Cohort | undefined;
			let grandchildPid: number | undefined;
			let rootIncarnation: string | undefined;
			let grandchildIncarnation: string | undefined;
			try {
				for (let attempt = 0; attempt < 100 && !(await Bun.file(parentExitedFile).exists()); attempt++)
					await Bun.sleep(20);
				expect(await Bun.file(parentExitedFile).exists()).toBe(true);
				for (let attempt = 0; attempt < 100 && !(await Bun.file(grandchildPidFile).exists()); attempt++)
					await Bun.sleep(20);
				expect(await Bun.file(grandchildPidFile).exists()).toBe(true);
				grandchildPid = Number(await Bun.file(grandchildPidFile).text());
				const rootObservation = observeProcessIncarnation(root.pid);
				const grandchildObservation = observeProcessIncarnation(grandchildPid);
				expect(rootObservation.status).toBe("present");
				expect(grandchildObservation.status).toBe("present");
				if (rootObservation.status !== "present" || grandchildObservation.status !== "present")
					throw new Error("fixture root or detached grandchild was not observable");
				rootIncarnation = rootObservation.incarnation;
				grandchildIncarnation = grandchildObservation.incarnation;

				cohort = new Cohort({ token, driverPid: process.pid, runStartEpochMs });
				cohort.registerRoot(root.pid, rootIncarnation);
				expect(cohort.visibilityCheck()).toEqual({ passed: true });
				const scan = cohort.scanOwnership();
				const member = scan.members.find(entry => entry.pid === grandchildPid);
				expect(member?.reason).toBe("marker");
				expect(member?.flags).toContain("ancestry-gap");
			} finally {
				cohort?.close();
				const terminateIfSame = (pid: number | undefined, incarnation: string | undefined): void => {
					if (pid === undefined || incarnation === undefined) return;
					const observed = observeProcessIncarnation(pid);
					if (observed.status === "present" && observed.incarnation === incarnation) process.kill(pid, "SIGKILL");
				};
				terminateIfSame(grandchildPid, grandchildIncarnation);
				const rootObservation = observeProcessIncarnation(root.pid);
				terminateIfSame(root.pid, rootObservation.status === "present" ? rootObservation.incarnation : undefined);
				await Promise.race([root.exited, Bun.sleep(2_000)]);
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
	);
});
