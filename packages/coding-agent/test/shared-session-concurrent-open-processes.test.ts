import { expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "../src/session/session-manager";

type Event = {
	worker: string;
	event: string;
	pid?: number;
	file?: string;
	logicalId?: string;
	parent?: string;
	bytes?: string;
	currentBytes?: string;
	digest?: string;
	size?: number;
	outcome?: string | { kind: string; reason?: string };
	attemptedId?: string | null;
	id?: string;
	leaf?: string;
	error?: string;
};
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
type TranscriptRecord = {
	type: string;
	id: string;
	version?: number;
	parentId?: string | null;
	message?: { content: string };
};

async function bounded<T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Timed out: ${label}`)), ms);
	try {
		return await Promise.race([promise, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// POSIX managed directory/descriptor identity contracts are not supported on Windows.
// This is process-level SessionManager coverage, not production TUI activation.
// Linux evidence remains pending until this exact test is actually run on Linux.
for (const scenario of ["hydration", "finalize"] as const)
	it.skipIf(process.platform === "win32")(
		scenario === "hydration"
			? "serializes two real-process opens and a peer append during hydration"
			: "serializes legacy migration finalization against a real-process peer append",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shared-open-processes-"));
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
				PI_NO_TITLE: "1",
			};
			const children = new Map<string, Child>();
			const output = new Map<string, Promise<string[]>>();
			const events: Event[] = [];
			let changed = Promise.withResolvers<void>();
			const observe = (event: Event) => {
				events.push(event);
				changed.resolve();
				changed = Promise.withResolvers<void>();
			};
			const wait = (label: string, predicate: (event: Event) => boolean) =>
				bounded(
					(async () => {
						for (;;) {
							const failure = events.find(event => event.event === "error");
							if (failure) throw new Error(`${failure.worker}: ${failure.error}`);
							const found = events.find(predicate);
							if (found) return found;
							await changed.promise;
						}
					})(),
					label,
				);
			const gate = (worker: string, name: string, detail: Record<string, string> = {}) => {
				const child = children.get(worker);
				if (!child) throw new Error(`Missing worker ${worker}`);
				child.send({ gate: name, ...detail });
			};
			let failure: unknown;
			try {
				await Promise.all(
					[cwd, agentDir, ...Object.values(env).filter(value => value.startsWith(root))].map(directory =>
						fs.mkdir(directory, { recursive: true, mode: 0o700 }),
					),
				);
				const fixture = path.join(import.meta.dir, "fixtures/shared-session-concurrent-open-process-worker.ts");
				for (const worker of ["a", "b"]) {
					const child = Bun.spawn([process.execPath, "--no-env-file", fixture, worker, cwd, agentDir, scenario], {
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
					output.set(worker, Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]));
					void child.exited.then(code => {
						if (code !== 0 || !events.some(event => event.worker === worker && event.event === "done")) {
							observe({ worker, event: "error", error: `Unexpected exit ${code}` });
						}
					});
				}
				const a = await wait("a ready", event => event.worker === "a" && event.event === "ready");
				const b = await wait("b ready", event => event.worker === "b" && event.event === "ready");
				expect(a.pid).toBe(children.get("a")!.pid);
				expect(b.pid).toBe(children.get("b")!.pid);
				expect(a.pid).not.toBe(b.pid);
				gate("a", "seed");
				const seed = await wait("synthetic seed", event => event.event === "seeded");
				if (!seed.file || !seed.logicalId || !seed.parent || !seed.bytes)
					throw new Error("Incomplete seed receipt");
				// Both processes already exist. Release the same logical start gate without awaiting either open.
				for (const worker of children.keys()) gate(worker, "open", { file: seed.file, logicalId: seed.logicalId });
				for (const worker of children.keys())
					await wait(`${worker} opening`, event => event.worker === worker && event.event === "opening");
				let migratedBytes: string | undefined;
				let legacyEntries: TranscriptRecord[] = [];
				let first: string;
				if (scenario === "finalize") {
					const seedClosed = await wait("seed strictly closed", event => event.event === "seed-closed");
					expect(seedClosed.outcome).toBe("closed");
					if (!seed.currentBytes) throw new Error("Missing current seed bytes");
					const current = Bun.JSONL.parse(seed.currentBytes) as TranscriptRecord[];
					const legacy = Bun.JSONL.parse(seed.bytes) as TranscriptRecord[];
					expect(legacy[0]).toEqual({ ...current[0], version: 4 });
					expect(seed.bytes.slice(seed.bytes.indexOf("\n"))).toBe(
						seed.currentBytes.slice(seed.currentBytes.indexOf("\n")),
					);
					legacyEntries = legacy.slice(1);
					expect(legacyEntries).toHaveLength(3);
					expect(legacy[1].parentId).toBeNull();
					expect(legacy[2].parentId).toBe(legacy[1].id);
					expect(legacy[3].parentId).toBe(legacy[1].id);
					expect(legacy[3].id).toBe(seed.parent);
					for (const worker of children.keys()) {
						const opened = await wait(
							`${worker} legacy opened`,
							event => event.worker === worker && event.event === "opened",
						);
						expect(opened.leaf).toBe(seed.parent);
						expect(opened.logicalId).toBe(seed.logicalId);
						expect(opened.bytes).toBe(seed.bytes);
					}
					expect(await Bun.file(seed.file).text()).toBe(seed.bytes);
					gate("a", "finalize");
					const snapshot = await wait(
						"finalize snapshot under lease",
						event => event.worker === "a" && event.event === "snapshot-observed",
					);
					expect(snapshot.digest).toBe(crypto.createHash("sha256").update(seed.bytes).digest("hex"));
					expect(snapshot.size).toBe(Buffer.byteLength(seed.bytes));
					gate("b", "append");
					const contention = await wait(
						"peer append contention during finalization",
						event => event.worker === "b" && ["append-contention", "refused", "appended"].includes(event.event),
					);
					expect(contention.event).toBe("append-contention");
					expect(await Bun.file(seed.file).text()).toBe(seed.bytes);
					gate("a", "snapshot-release");
					const finalized = await wait(
						"migration publication",
						event => event.worker === "a" && event.event === "finalized",
					);
					expect(finalized.outcome).toBe("published");
					expect(finalized.leaf).toBe(seed.parent);
					if (!finalized.bytes) throw new Error("Missing migration bytes");
					migratedBytes = finalized.bytes;
					const migrated = Bun.JSONL.parse(migratedBytes) as TranscriptRecord[];
					expect(migrated[0]).toEqual({ ...legacy[0], version: CURRENT_SESSION_VERSION });
					expect(migrated.slice(1)).toEqual(legacyEntries);
					const refused = await wait(
						"legacy append refusal",
						event => event.worker === "b" && event.event === "refused",
					);
					expect(refused.outcome).toEqual({ kind: "stale", reason: "rewrite_required" });
					expect(refused.attemptedId).toBeNull();
					expect(refused.leaf).toBe(seed.parent);
					expect(refused.bytes).toBe(migratedBytes);
					gate("b", "stale-finalize");
					const stale = await wait(
						"legacy finalization refusal",
						event => event.worker === "b" && event.event === "stale-finalized",
					);
					expect(stale.outcome).toBe("stale");
					expect(stale.leaf).toBe(seed.parent);
					expect(stale.bytes).toBe(migratedBytes);
					gate("b", "reopen");
					const closed = await wait(
						"legacy strict close",
						event => event.worker === "b" && event.event === "legacy-closed",
					);
					expect(closed.outcome).toBe("closed");
					expect(closed.bytes).toBe(migratedBytes);
					const reopened = await wait(
						"supported reopen",
						event => event.worker === "b" && event.event === "reopened",
					);
					expect(reopened.outcome).toBe("unchanged");
					expect(reopened.leaf).toBe(seed.parent);
					expect(reopened.logicalId).toBe(seed.logicalId);
					expect(reopened.bytes).toBe(migratedBytes);
					first = "b";
					gate(first, "publish");
				} else {
					first = (await wait("first hydration", event => event.event === "hydrating")).worker;
					const second = first === "a" ? "b" : "a";
					const openOrdering = await wait(
						"peer open contention",
						event => event.worker === second && ["open-contention", "hydrating", "opened"].includes(event.event),
					);
					// An unfenced implementation enters both hydration hooks and fails here, not by hanging.
					expect(openOrdering.event).toBe("open-contention");
					gate(first, "hydrate");
					await wait("second hydration", event => event.worker === second && event.event === "hydrating");
					const openedFirst = await wait(
						"first opened",
						event => event.worker === first && event.event === "opened",
					);
					expect(openedFirst.leaf).toBe(seed.parent);
					expect(openedFirst.logicalId).toBe(seed.logicalId);
					gate(first, "append");
					const appendOrdering = await wait(
						"append contention versus publication",
						event => event.worker === first && ["append-contention", "appended"].includes(event.event),
					);
					expect(appendOrdering.event).toBe("append-contention");
					gate(second, "hydrate");
					const openedSecond = await wait(
						"second opened",
						event => event.worker === second && event.event === "opened",
					);
					expect(openedSecond.leaf).toBe(seed.parent);
					expect(openedSecond.logicalId).toBe(seed.logicalId);
				}
				const second = first === "a" ? "b" : "a";
				const firstAppend = await wait(
					"first publication",
					event => event.worker === first && event.event === "appended",
				);
				const afterFirst = await Bun.file(seed.file).text();
				expect(afterFirst.startsWith(migratedBytes ?? seed.bytes)).toBe(true);
				gate(second, scenario === "finalize" ? "publish" : "append");
				const secondAppend = await wait(
					"second publication",
					event => event.worker === second && event.event === "appended",
				);
				for (const worker of children.keys())
					await wait(`${worker} done`, event => event.worker === worker && event.event === "done");
				for (const worker of children.keys()) {
					const closed = await wait(
						`${worker} strict close`,
						event => event.worker === worker && event.event === "closed",
					);
					expect(closed.outcome).toBe("closed");
				}
				for (const child of children.values()) expect(await bounded(child.exited, "worker exit")).toBe(0);
				const bytes = await Bun.file(seed.file).text();
				expect(bytes.startsWith(afterFirst)).toBe(true);
				const records = Bun.JSONL.parse(bytes) as TranscriptRecord[];
				const headers = records.filter(record => record.type === "session");
				expect(headers).toHaveLength(1);
				expect(headers[0]!.id).toBe(seed.logicalId);
				expect(firstAppend.id).toBeTruthy();
				expect(secondAppend.id).toBeTruthy();
				expect(firstAppend.id).not.toBe(secondAppend.id);
				for (const receipt of [firstAppend, secondAppend]) {
					expect(receipt.logicalId).toBe(seed.logicalId);
					expect(receipt.leaf).toBe(receipt.id);
					const matching = records.filter(record => record.id === receipt.id);
					expect(matching).toHaveLength(1);
					expect(matching[0]!.parentId).toBe(seed.parent);
					expect(matching[0]!.message?.content).toBe(`branch ${receipt.worker}`);
				}
				const entries = records.filter(record => record.type !== "session");
				expect(entries).toHaveLength(scenario === "finalize" ? 5 : 3);
				if (scenario === "finalize") expect(entries.slice(0, 3)).toEqual(legacyEntries);
				const ids = new Set(entries.map(entry => entry.id));
				expect(ids.size).toBe(entries.length);
				for (const entry of entries)
					if (entry.parentId !== null && entry.parentId !== undefined) expect(ids.has(entry.parentId)).toBe(true);
				const jsonl = (await fs.readdir(root, { recursive: true })).filter(name => name.endsWith(".jsonl"));
				expect(jsonl).toEqual([path.relative(root, seed.file)]);
			} catch (error) {
				failure = error;
			}

			// Resolve every barrier before killing pinned handles. Never remove a live child's root.
			for (const [worker, child] of children) {
				if (child.exitCode !== null) continue;
				for (const name of [
					"seed",
					"open",
					"hydrate",
					"append",
					"finalize",
					"snapshot-release",
					"stale-finalize",
					"reopen",
					"publish",
				]) {
					try {
						gate(worker, name);
					} catch {
						/* The IPC channel may already be closed. */
					}
				}
				try {
					child.kill("SIGKILL");
				} catch {
					/* Exit may race the signal. */
				}
			}
			const termination = await Promise.allSettled(
				[...children.values()].map(child => bounded(child.exited, "cleanup exit", 5_000)),
			);
			if (termination.some(result => result.status === "rejected")) {
				throw new Error(`Child termination unknown; retained ${root}. Original failure: ${String(failure)}`);
			}
			const transcripts = await bounded(
				Promise.all([...output].map(async ([worker, stream]) => ({ worker, output: await stream }))),
				"child output",
			);
			await fs.rm(root, { recursive: true, force: true });
			if (failure)
				throw new Error(
					`${String(failure)}\nEvents: ${JSON.stringify(events)}\nOutput: ${JSON.stringify(transcripts)}`,
					{ cause: failure },
				);
		},
		45_000,
	);
