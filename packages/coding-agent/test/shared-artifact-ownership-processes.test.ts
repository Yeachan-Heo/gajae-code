import { expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

type Event = {
	worker: string;
	event: string;
	pid?: number;
	logicalId?: string;
	dir?: string;
	id?: string;
	name?: string;
	size?: number;
	message?: string;
	outcome?: string;
	files?: Array<{ name: string; text: string; digest: string }>;
	error?: string;
};
type Child = Bun.Subprocess<"ignore", "pipe", "pipe">;
const gateNames = ["save", "release-claim", "read-before", "read-after", "close", "exit"];
const digest = (bytes: string | Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

async function bounded<T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> {
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => expired.reject(new Error(`Timed out: ${label}`)), ms);
	try {
		return await Promise.race([promise, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// POSIX retained directory authority; not production activation or canonical GC coverage.
it.skipIf(process.platform === "win32")(
	"retries a real cross-process artifact claim and retains ownership after peer close",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shared-artifacts-"));
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
		const wait = (worker: string, names: string[]) =>
			bounded(
				(async () => {
					for (;;) {
						const failure = events.find(event => event.event === "error");
						if (failure) throw new Error(`${failure.worker}: ${failure.error}`);
						const found = events.find(event => event.worker === worker && names.includes(event.event));
						if (found) return found;
						await changed.promise;
					}
				})(),
				`${worker}: ${names.join("/")}`,
			);
		const gate = (worker: string, name: string) => children.get(worker)!.send({ gate: name });
		const payloads = [
			`payload-A-${"a".repeat(65536)}`,
			`payload-B-${"b".repeat(65536)}`,
			`payload-C-${"c".repeat(65536)}`,
		];
		const expectedFiles = payloads.map((text, id) => ({ name: `${id}.ownership.log`, text, digest: digest(text) }));
		let seed: SessionManager | undefined;
		let failure: unknown;
		const cleanupErrors: string[] = [];
		try {
			await Promise.all(
				[cwd, agentDir, ...Object.values(env).filter(value => value.startsWith(root))].map(directory =>
					fs.mkdir(directory, { recursive: true, mode: 0o700 }),
				),
			);
			seed = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
			seed.appendMessage({ role: "user", content: "artifact ownership root", timestamp: 1 });
			await seed.ensureOnDisk();
			const file = seed.getSessionFile()!;
			const logicalId = seed.getSessionId();
			expect((await seed.closeStrict()).kind).toBe("closed");
			seed = undefined;
			const transcript = await Bun.file(file).text();
			const transcriptDigest = digest(transcript);
			const fixture = path.join(import.meta.dir, "fixtures/shared-artifact-ownership-process-worker.ts");
			for (const worker of ["a", "b"]) {
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
				output.set(worker, Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]));
				void child.exited.then(code => {
					if (code !== 0 || !events.some(event => event.worker === worker && event.event === "done"))
						observe({ worker, event: "error", error: `Unexpected exit ${code}` });
				});
			}
			const a = await wait("a", ["opened"]);
			const b = await wait("b", ["opened"]);
			expect(a.pid).toBe(children.get("a")!.pid);
			expect(b.pid).toBe(children.get("b")!.pid);
			expect(a.pid).not.toBe(b.pid);
			expect(a.logicalId).toBe(logicalId);
			expect(b.logicalId).toBe(logicalId);
			expect(a.dir).toBe(file.slice(0, -6));
			expect(b.dir).toBe(a.dir);
			const dir = a.dir!;
			const checkDisk = async (count: number) => {
				for (let id = 0; id < count; id++) {
					const bytes = await Bun.file(path.join(dir, `${id}.ownership.log`)).bytes();
					expect(Buffer.from(bytes).toString("utf8")).toBe(payloads[id]);
					expect(digest(bytes)).toBe(expectedFiles[id].digest);
					expect(await Bun.file(path.join(dir, `.artifact-id-${id}`)).bytes()).toEqual(new Uint8Array());
				}
			};
			gate("b", "save");
			const ready = await wait("b", ["claim-ready", "saved"]);
			expect(ready.event).toBe("claim-ready");
			expect(ready.name).toBe(".artifact-id-0");
			expect(ready.size).toBe(0);
			expect(
				events
					.filter(event => event.worker === "b" && event.event.startsWith("claim-"))
					.map(event => [event.event, event.name]),
			).toEqual([
				["claim-call", ".artifact-id-0"],
				["claim-ready", ".artifact-id-0"],
			]);
			gate("a", "save");
			expect((await wait("a", ["saved"])).id).toBe("0");
			await checkDisk(1);
			gate("b", "release-claim");
			expect((await wait("b", ["saved"])).id).toBe("1");
			expect(
				events
					.filter(event => event.worker === "b" && event.event.startsWith("claim-"))
					.map(event => [event.event, event.name, event.message ?? null]),
			).toEqual([
				["claim-call", ".artifact-id-0", null],
				["claim-ready", ".artifact-id-0", null],
				["claim-conflict", ".artifact-id-0", "destination_conflict"],
				["claim-call", ".artifact-id-1", null],
				["claim-success", ".artifact-id-1", null],
			]);
			await checkDisk(2);
			gate("b", "read-before");
			expect((await wait("b", ["read-before"])).files).toEqual(expectedFiles.slice(0, 2));
			gate("a", "close");
			expect((await wait("a", ["closed"])).outcome).toBe("closed");
			await checkDisk(2);
			gate("a", "exit");
			await wait("a", ["done"]);
			expect(await bounded(children.get("a")!.exited, "a exit")).toBe(0);
			gate("b", "read-after");
			expect((await wait("b", ["read-after"])).files).toEqual(expectedFiles.slice(0, 2));
			expect((await wait("b", ["continued"])).id).toBe("2");
			expect((await wait("b", ["read-three"])).files).toEqual(expectedFiles);
			gate("b", "close");
			expect((await wait("b", ["closed"])).outcome).toBe("closed");
			gate("b", "exit");
			await wait("b", ["done"]);
			expect(await bounded(children.get("b")!.exited, "b exit")).toBe(0);
			await checkDisk(3);
			expect(new Set(expectedFiles.map(entry => entry.digest)).size).toBe(3);
			expect((await fs.readdir(dir)).sort()).toEqual([
				".artifact-id-0",
				".artifact-id-1",
				".artifact-id-2",
				"0.ownership.log",
				"1.ownership.log",
				"2.ownership.log",
			]);
			const after = await Bun.file(file).text();
			expect(after).toBe(transcript);
			expect(digest(after)).toBe(transcriptDigest);
			const records = Bun.JSONL.parse(after) as Array<{ type: string; id: string }>;
			expect(records.filter(record => record.type === "session").map(record => record.id)).toEqual([logicalId]);
			expect((await fs.readdir(root, { recursive: true })).filter(name => name.endsWith(".jsonl"))).toEqual([
				path.relative(root, file),
			]);
		} catch (error) {
			failure = error;
		}
		for (const [worker, child] of children) {
			if (child.exitCode !== null) continue;
			for (const name of gateNames) {
				try {
					gate(worker, name);
				} catch {
					/* IPC may already be closed. */
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
		if (termination.some(result => result.status === "rejected"))
			throw new Error(`Child termination unknown; retained ${root}. Original failure: ${String(failure)}`, {
				cause: failure,
			});
		if (seed) {
			try {
				const closed = await seed.closeStrict();
				if (closed.kind !== "closed") cleanupErrors.push(`Seed cleanup: ${closed.kind}`);
			} catch (error) {
				cleanupErrors.push(`Seed cleanup: ${String(error)}`);
			}
		}
		let transcripts: unknown;
		try {
			transcripts = await bounded(
				Promise.all([...output].map(async ([worker, stream]) => ({ worker, output: await stream }))),
				"child output",
			);
		} catch (error) {
			cleanupErrors.push(`Output cleanup: ${String(error)}`);
		}
		if (cleanupErrors.length === 0) {
			try {
				await fs.rm(root, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(`Root cleanup: ${String(error)}`);
			}
		}
		if (failure || cleanupErrors.length)
			throw new Error(
				`${String(failure)}\nCleanup: ${cleanupErrors.join("; ")}\nRoot: ${root}\nEvents: ${JSON.stringify(events)}\nOutput: ${JSON.stringify(transcripts)}`,
				{ cause: failure },
			);
	},
	45_000,
);
