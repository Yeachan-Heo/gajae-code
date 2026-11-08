import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Recorded finding: two opens landing in the same instant can fail with
// `Could not open session: identity-mismatch` (observed in the Linux CI shard, not on macOS). The
// case therefore staggers the opens and releases both children together, so what it pins is
// independent append attempts after a shared release; simultaneous-open safety is not pinned.
//
// Everything before this pinned sibling publication inside one process. The goal is two real
// TUIs, so the same claim is checked across the process boundary here: two children are spawned
// before either is awaited, each opens the same managed transcript, and each publishes three
// appends through the shared seam.
//
// What this pins: every append commits or is refused with a stated reason, all six commits reach
// disk under the ids the children were told, and every parent link resolves.
// What it does not pin: that the two children actually interleave (the run may still serialize as
// "both open, then A commits everything before B commits"), that either is unblocked while the other is
// alive, and anything about interactive TUIs, provider ownership or cleanup ownership.

const roots: string[] = [];
const managers = new Set<SessionManager>();
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];

afterEach(async () => {
	// Reap every child before closing managers or removing any transcript or signal directory.
	const childResults = await Promise.allSettled(
		children.splice(0).map(async child => {
			try {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			} finally {
				await child.exited;
			}
		}),
	);
	const managerResults = await Promise.allSettled([...managers].map(manager => manager.closeStrict()));
	managers.clear();
	const rootResults = await Promise.allSettled(
		roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
	);
	const failures = [...childResults, ...managerResults, ...rootResults].filter(result => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map(result => result.reason),
			"harness cleanup failed",
		);
});

const worker = path.join(import.meta.dirname, "fixtures", "shared-session-append-worker.ts");

function spawnWorker(cwd: string, agentDir: string, file: string, label: string, signals: string, timeout?: string) {
	const args = [process.execPath, worker, cwd, agentDir, file, label, "3", signals];
	if (timeout !== undefined) args.push(timeout);
	const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	children.push(child);
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const result = Promise.all([child.exited, stdout, stderr]).then(([code, stdout, stderr]) => ({
		code,
		stdout,
		stderr,
	}));
	return { child, result };
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(reason)), timeoutMs);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function waitForFile(
	target: string,
	child: Bun.Subprocess<"ignore", "pipe", "pipe">,
	result: Promise<{ code: number; stdout: string; stderr: string }>,
) {
	const deadline = performance.now() + 15_000;
	while (performance.now() < deadline) {
		if (await Bun.file(target).exists()) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			const output = await bounded(result, 1_000, `timed out reading worker failure for ${target}`);
			throw new Error(`worker exited before ${target}: ${JSON.stringify(output)}`);
		}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${target}`);
}

describe("two processes appending to one transcript", () => {
	it("publishes every commit from two concurrently spawned processes", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-process-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const writer = SessionManager.create(cwd, destination);
		managers.add(writer);
		writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
		await writer.ensureOnDisk();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		await writer.closeStrict();
		managers.delete(writer);

		const signals = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-two-process-"));
		roots.push(signals);
		const spawn = (label: string) => spawnWorker(cwd, agentDir, file, label, signals);
		// The opens are staggered - two opens landing in the same instant can fail with
		// identity-mismatch, which is a different property from concurrent appends - and then both
		// children receive a shared release; actual append overlap is not asserted.
		const first = spawn("A");
		await waitForFile(path.join(signals, "A.opened"), first.child, first.result);
		const second = spawn("B");
		await waitForFile(path.join(signals, "B.opened"), second.child, second.result);
		await Promise.all([Bun.write(path.join(signals, "A.go"), "go\n"), Bun.write(path.join(signals, "B.go"), "go\n")]);
		const [firstResult, secondResult] = await bounded(
			Promise.all([first.result, second.result]),
			15_000,
			"timed out waiting for append workers",
		);
		const { code: firstCode, stdout: firstOut, stderr: firstErr } = firstResult;
		const { code: secondCode, stdout: secondOut, stderr: secondErr } = secondResult;
		// A worker death has to name its cause, not just report a non-zero status.
		expect({ label: "A", code: firstCode, stderr: firstErr, stdout: firstOut }).toMatchObject({ code: 0 });
		expect({ label: "B", code: secondCode, stderr: secondErr, stdout: secondOut }).toMatchObject({ code: 0 });

		const parse = (raw: string) =>
			raw
				.trim()
				.split("\n")
				.filter(Boolean)
				.flatMap(
					line =>
						JSON.parse(line) as { label: string; index: number; kind: string; id?: string; reason?: string }[],
				);
		const outcomes = [...parse(firstOut), ...parse(secondOut)];
		expect(outcomes).toHaveLength(6);
		// Every append either committed or was refused with a stated reason; a crash or a silent
		// drop shows up here, and the reason itself is checked rather than discarded.
		for (const outcome of outcomes) {
			if (outcome.kind !== "committed") expect(outcome.reason?.trim().length ?? 0).toBeGreaterThan(0);
		}
		const committed = outcomes.filter(outcome => outcome.kind === "committed");
		// Exact, not a floor: each child publishes three, so a run where one child's chain was
		// truncated mid-flight must fail rather than clear a ">= 4" bar.
		expect(committed).toHaveLength(6);

		// One transcript holds both processes' content, and a fresh reader sees every commit.
		const reopened = await SessionManager.open(file, destination);
		managers.add(reopened);
		const text = JSON.stringify(reopened.getEntries());
		for (const outcome of committed) expect(text).toContain(`${outcome.label}-${outcome.index}`);
		// Each committed outcome is on disk under the id the child was told about, and every
		// parent link in the resulting graph resolves.
		const entries = reopened.getEntries();
		const ids = new Set(entries.map(entry => entry.id));
		for (const outcome of committed) expect(ids.has(outcome.id ?? "")).toBe(true);
		for (const entry of entries) if (entry.parentId) expect(ids.has(entry.parentId)).toBe(true);
		await reopened.closeStrict();
		managers.delete(reopened);
	}, 60_000);

	it("fails without a release signal and leaves the transcript unchanged", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-process-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
		const destination = SessionManager.managedDestination(cwd, agentDir);
		const writer = SessionManager.create(cwd, destination);
		managers.add(writer);
		writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
		await writer.ensureOnDisk();
		const file = writer.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		await writer.closeStrict();
		managers.delete(writer);
		const before = await Bun.file(file).text();
		const signals = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-two-process-"));
		roots.push(signals);
		const worker = spawnWorker(cwd, agentDir, file, "unreleased", signals, "0");
		const result = await bounded(worker.result, 15_000, "timed out waiting for unreleased worker");
		expect(await Bun.file(path.join(signals, "unreleased.opened")).exists()).toBe(true);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("timed out waiting for release signal for unreleased");
		expect(result.stdout).toBe("");
		expect(await Bun.file(file).text()).toBe(before);
		const reopened = await SessionManager.open(file, destination);
		managers.add(reopened);
		expect(JSON.stringify(reopened.getEntries())).not.toContain("unreleased-");
		await reopened.closeStrict();
		managers.delete(reopened);
	}, 30_000);
});
