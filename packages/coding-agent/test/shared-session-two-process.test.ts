import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Two processes writing one managed transcript (single-owner step 10a). Every writer takes the legacy
// route. Under the default `enforce` the second opener is refused, naming the holder. Below it
// (`observe`, `off`, or a writer gjc cannot see) both open, and the managed transcript's identity
// fence stops the writer whose view is stale: it reports the identity-mismatch message, and the
// other's entries stay on disk.
//
// Each case gives its children their own HOME, so their ownership claims never reach the user's.

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];

afterEach(async () => {
	// Reap every child before removing any transcript or signal directory.
	const childResults = await Promise.allSettled(
		children.splice(0).map(async child => {
			try {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			} finally {
				await child.exited;
			}
		}),
	);
	const rootResults = await Promise.allSettled(
		roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
	);
	const failures = [...childResults, ...rootResults].filter(result => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map(result => result.reason),
			"harness cleanup failed",
		);
});

const worker = path.join(import.meta.dirname, "fixtures", "shared-session-append-worker.ts");
type Outcome = { label: string; index?: number; kind: string; id?: string; reason?: string; holderPid?: number };
type Worker = {
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	result: Promise<{ code: number; stdout: string; stderr: string }>;
};

async function bounded<T>(operation: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(reason)), timeoutMs);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

/** A managed transcript with one entry, written by no process that stays open. */
async function seeded() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-two-process-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const home = path.join(root, "home");
	const signals = path.join(root, "signals");
	for (const directory of [cwd, home, signals]) await fs.mkdir(directory, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination, undefined, "exempt");
	writer.appendMessage({ role: "user" as const, content: "seed", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	await writer.closeStrict();
	const spawn = (label: string, mode: "enforce" | "observe" | "off", timeout?: string): Worker => {
		const args = [process.execPath, worker, cwd, agentDir, file, label, "3", signals];
		if (timeout !== undefined) args.push(timeout);
		const child = Bun.spawn(args, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: home, GJC_SESSION_OWNERSHIP: mode },
		});
		children.push(child);
		const result = Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
		return { child, result };
	};
	const waitFor = async (label: string, name: string, owner: Worker) => {
		const target = path.join(signals, `${label}.${name}`);
		const deadline = performance.now() + 15_000;
		while (performance.now() < deadline) {
			if (await Bun.file(target).exists()) return;
			if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
				const output = await bounded(owner.result, 1_000, `timed out reading worker failure for ${target}`);
				throw new Error(`worker exited before ${target}: ${JSON.stringify(output)}`);
			}
			await Bun.sleep(25);
		}
		throw new Error(`timed out waiting for ${target}`);
	};
	const send = (label: string, name: string) => Bun.write(path.join(signals, `${label}.${name}`), `${name}\n`);
	const outcomes = async (owner: Worker, label: string): Promise<Outcome[]> => {
		const { code, stdout, stderr } = await bounded(owner.result, 15_000, `timed out waiting for ${label}`);
		// A worker death has to name its cause, not just report a non-zero status.
		expect({ label, code, stderr }).toMatchObject({ code: 0 });
		return JSON.parse(stdout.trim()) as Outcome[];
	};
	/** What a reader that claims nothing sees on disk now. */
	const onDisk = async () => {
		const reader = await SessionManager.open(file, destination, undefined, undefined, undefined, "exempt");
		try {
			return reader.getEntries();
		} finally {
			await reader.closeStrict();
		}
	};
	return { file, spawn, waitFor, send, outcomes, onDisk };
}

describe("two processes writing one managed transcript", () => {
	// Claims fail open on Windows (no native lock yet), so nothing is refused there.
	it.skipIf(process.platform === "win32")(
		"enforce: the second process's open is refused, naming the holder; the holder's writes land",
		async () => {
			const s = await seeded();
			const a = s.spawn("A", "enforce");
			await s.waitFor("A", "opened", a);
			const before = await Bun.file(s.file).text();
			const b = s.spawn("B", "enforce");
			const [held] = await s.outcomes(b, "B");
			expect(held).toMatchObject({ kind: "held", holderPid: a.child.pid });
			expect(held?.reason).toContain("is open for writing in another process");
			expect(await Bun.file(s.file).text()).toBe(before);
			await s.send("A", "go");
			await s.waitFor("A", "appended", a);
			await s.send("A", "close");
			const written = await s.outcomes(a, "A");
			expect(written.map(outcome => outcome.kind)).toEqual(["committed", "committed", "committed"]);
			const ids = new Set((await s.onDisk()).map(entry => entry.id));
			for (const outcome of written) expect(ids.has(outcome.id ?? "")).toBe(true);
		},
		60_000,
	);

	// The last row is an enforce holder beside a peer it cannot see (ownership off): the holder stops.
	it.each([
		["observe", "observe"],
		["off", "off"],
		["off", "enforce"],
	] as const)(
		"%s writer, %s peer: the peer whose view the writer changed stops with the identity-mismatch message; the writer's entries stay",
		async (writerMode, staleMode) => {
			const s = await seeded();
			const a = s.spawn("A", writerMode);
			await s.waitFor("A", "opened", a);
			const b = s.spawn("B", staleMode);
			await s.waitFor("B", "opened", b);
			// Both opened the same bytes. A writes first, so B's view is stale when it writes.
			await s.send("A", "go");
			await s.waitFor("A", "appended", a);
			await s.send("A", "close");
			const written = await s.outcomes(a, "A");
			expect(written.map(outcome => outcome.kind)).toEqual(["committed", "committed", "committed"]);
			const before = await Bun.file(s.file).text();
			await s.send("B", "go");
			await s.waitFor("B", "appended", b);
			await s.send("B", "close");
			const refused = await s.outcomes(b, "B");
			expect(refused).toHaveLength(1);
			expect(refused[0]).toMatchObject({ kind: "refused", index: 0 });
			expect(refused[0]?.reason).toContain("Another process changed this session's transcript");
			expect(await Bun.file(s.file).text()).toBe(before);
			const entries = await s.onDisk();
			const text = JSON.stringify(entries);
			for (const outcome of written) expect(text).toContain(`A-${outcome.index}`);
			expect(text).not.toContain('"B-0"');
			const ids = new Set(entries.map(entry => entry.id));
			for (const entry of entries) if (entry.parentId) expect(ids.has(entry.parentId)).toBe(true);
		},
		60_000,
	);

	it("fails without a release signal and leaves the transcript unchanged", async () => {
		const s = await seeded();
		const before = await Bun.file(s.file).text();
		const unreleased = s.spawn("unreleased", "observe", "0");
		const result = await bounded(unreleased.result, 15_000, "timed out waiting for unreleased worker");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("timed out waiting for go signal for unreleased");
		expect(result.stdout).toBe("");
		expect(await Bun.file(s.file).text()).toBe(before);
	}, 30_000);
});
