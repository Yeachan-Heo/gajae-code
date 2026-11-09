import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

type Event = {
	worker: string;
	event: string;
	pid?: number;
	logicalId?: string;
	leaf?: string | null;
	cold?: boolean;
	outcome?: { kind: string; id?: string } | string;
	message?: string;
	stack?: string;
	cause?: string;
};
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function bounded<T>(pending: Promise<T>, label: string, ms = 15_000): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${label}`)), ms);
	try {
		return await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

it.skipIf(process.platform === "win32")(
	"opens two independent enabled cold owners on one managed transcript, retaining both branches after A closes",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shared-cold-owner-"));
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: path.join(root, "home"),
			TMPDIR: path.join(root, "tmp"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			XDG_RUNTIME_DIR: path.join(root, "run"),
			GJC_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
			NO_COLOR: "1",
		};
		const children = new Map<string, Child>();
		const events: Event[] = [];
		let changed = Promise.withResolvers<void>();
		const observe = (event: Event) => {
			events.push(event);
			changed.resolve();
			changed = Promise.withResolvers<void>();
		};
		const wait = (worker: string, expected: string) =>
			bounded(
				(async () => {
					for (;;) {
						const event = events.find(
							entry =>
								entry.worker === worker &&
								(entry.event === expected || entry.event === "failed" || entry.event === "cleanup-failed"),
						);
						if (event) return event;
						await changed.promise;
					}
				})(),
				`${worker} ${expected}`,
			);
		const gate = (worker: string, name: string) => children.get(worker)!.send({ gate: name });
		const assertEvent = (event: Event, expected: string) =>
			expect(event.event, `${event.message ?? ""}\n${event.stack ?? ""}\n${event.cause ?? ""}`).toBe(expected);
		let seed: SessionManager | undefined;
		let cleanupError: unknown;
		try {
			await Promise.all(
				[cwd, agentDir, ...Object.values(env).filter(value => value.startsWith(root))].map(dir =>
					fs.mkdir(dir, { recursive: true, mode: 0o700 }),
				),
			);
			seed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			seed.setSessionMemoryMode("off");
			for (let index = 0; index < 16; index++)
				seed.appendMessage({ role: "user", content: `${index}:${"x".repeat(256)}`, timestamp: 1 });
			const kept = seed.appendMessage({ role: "user", content: "kept branch", timestamp: 1 });
			seed.appendCompaction("summary", undefined, kept, 1);
			const anchor = seed.getLeafId();
			expect(anchor).not.toBeNull();
			await seed.ensureOnDisk();
			const file = seed.getSessionFile()!;
			const logicalId = seed.getSessionId();
			expect((await seed.closeStrict()).kind).toBe("closed");
			seed = undefined;
			const original = await Bun.file(file).bytes();
			expect(original.byteLength).toBeLessThan(128 * 1024 * 1024);
			const fixture = path.join(import.meta.dir, "fixtures/shared-cold-opener.ts");
			const spawn = (worker: string) => {
				const child = Bun.spawn([process.execPath, "--no-env-file", fixture, worker, cwd, agentDir, file], {
					cwd,
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					ipc(message) {
						observe(message as Event);
					},
				});
				children.set(worker, child);
				void child.exited.then(code => {
					if (
						!events.some(
							event => event.worker === worker && (event.event === "closed" || event.event === "failed"),
						)
					)
						observe({ worker, event: "failed", message: `Worker exited before reporting outcome (${code})` });
				});
			};
			spawn("a");
			const a = await wait("a", "opened");
			assertEvent(a, "opened");
			expect(a).toMatchObject({ pid: children.get("a")!.pid, logicalId, leaf: anchor, cold: true });
			spawn("b");
			const b = await wait("b", "opened");
			// A remains live: B's admission failure must leave canonical bytes unchanged.
			if (b.event !== "opened") expect(await Bun.file(file).bytes()).toEqual(original);
			assertEvent(b, "opened");
			expect(b).toMatchObject({ pid: children.get("b")!.pid, logicalId, leaf: anchor, cold: true });
			expect(b.pid).not.toBe(a.pid);
			gate("a", "append");
			const first = await wait("a", "appended");
			assertEvent(first, "appended");
			expect(first.outcome).toMatchObject({ kind: "committed" });
			gate("b", "append");
			const second = await wait("b", "appended");
			assertEvent(second, "appended");
			expect(second.outcome).toMatchObject({ kind: "committed" });
			const entries = Bun.JSONL.parse(await Bun.file(file).text()) as Array<{ id: string; parentId: string | null }>;
			for (const result of [first, second]) {
				const id = typeof result.outcome === "object" ? result.outcome.id : undefined;
				if (!id) throw new Error("Missing branch identity");
				expect(entries.find(entry => entry.id === id)?.parentId).toBe(anchor);
			}
			gate("a", "close");
			const aClosed = await wait("a", "closed");
			assertEvent(aClosed, "closed");
			expect(aClosed.outcome).toBe("closed");
			gate("a", "exit");
			expect(await bounded(children.get("a")!.exited, "a exit")).toBe(0);
			gate("b", "continue");
			const continued = await wait("b", "continued");
			assertEvent(continued, "continued");
			expect(continued.outcome).toMatchObject({ kind: "committed" });
			const continuedId = typeof continued.outcome === "object" ? continued.outcome.id : undefined;
			const secondId = typeof second.outcome === "object" ? second.outcome.id : undefined;
			if (!continuedId || !secondId) throw new Error("Missing continued branch identity");
			const updated = Bun.JSONL.parse(await Bun.file(file).text()) as Array<{ id: string; parentId: string | null }>;
			expect(updated.find(entry => entry.id === continuedId)?.parentId).toBe(secondId);
			gate("b", "close");
			const bClosed = await wait("b", "closed");
			assertEvent(bClosed, "closed");
			expect(bClosed.outcome).toBe("closed");
			gate("b", "exit");
			expect(await bounded(children.get("b")!.exited, "b exit")).toBe(0);
		} finally {
			try {
				if (seed) {
					const closed = await seed.closeStrict();
					if (closed.kind !== "closed") cleanupError = new Error(`Seed cleanup: ${closed.kind}`);
				}
				for (const child of children.values()) if (child.exitCode === null) child.kill();
				await Promise.all(Array.from(children.values(), child => bounded(child.exited, "child cleanup", 5_000)));
				if (!cleanupError) await fs.rm(root, { recursive: true, force: true });
			} catch (error) {
				cleanupError ??= error;
			}
		}
		if (cleanupError) throw cleanupError;
	},
	35_000,
);
