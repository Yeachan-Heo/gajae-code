import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(compacted = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-family-reservation-"));
	roots.push(root);
	const source = path.join(root, "source.jsonl");
	const timestamp = new Date(0).toISOString();
	const entries = [
		{ type: "session", version: 5, id: "source", timestamp, cwd: root },
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp,
			message: { role: "user", content: "history", timestamp: 0 },
		},
		...(compacted
			? [
					{
						type: "compaction",
						id: "compact",
						parentId: "user",
						timestamp,
						summary: "summary",
						firstKeptEntryId: "user",
						tokensBefore: 10,
					},
				]
			: []),
	];
	const bytes = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
	await Bun.write(source, bytes);
	return { root, source, bytes };
}

describe("reserved session identity", () => {
	it("uses explicit identity for creation, memory, and prepared successors", async () => {
		const { root } = await fixture();
		const manager = SessionManager.create(root, path.join(root, "sessions"), undefined, {
			sessionId: "reserved.create",
		});
		managers.push(manager);
		expect(manager.getSessionId()).toBe("reserved.create");
		const memory = SessionManager.inMemory(root, undefined, { sessionId: "reserved.memory" });
		managers.push(memory);
		expect(memory.getSessionId()).toBe("reserved.memory");
		const prepared = await manager.prepareNewSession({
			parentSession: "reserved.create",
			identityAllocation: { sessionId: "reserved.next" },
		});
		expect(manager.getSessionId()).toBe("reserved.create");
		expect(prepared.sessionId).toBe("reserved.next");
		manager.commitPreparedNewSession(prepared);
		expect(manager.getHeader()).toMatchObject({ id: "reserved.next", parentSession: "reserved.create" });
		await memory.newSession({ identityAllocation: { sessionId: "reserved.new" } });
		expect(memory.getSessionId()).toBe("reserved.new");
	});

	it("uses the reserved identity for an unpublished staged task", async () => {
		const { root } = await fixture();
		const finalFile = path.join(root, "task.jsonl");
		const staged = await SessionManager.openStaged(finalFile, undefined, "attempt", { sessionId: "reserved.task" });
		try {
			expect(staged.getSessionId()).toBe("reserved.task");
			expect(await Bun.file(finalFile).exists()).toBe(false);
		} finally {
			await staged.discardStaged();
			await staged.close();
		}
	});

	for (const mode of ["off", "enabled"] as const) {
		for (const compacted of [true, false]) {
			it(`preserves reserved fork identity and source (${mode}, compacted=${compacted})`, async () => {
				const { root, source, bytes } = await fixture(compacted);
				const destination = path.join(root, "forks");
				await fs.mkdir(destination);
				const capture = SessionManager.captureTranscriptStrict(source);
				if (capture.kind !== "captured") throw new Error(`Capture failed: ${capture.reason}`);
				const result = await SessionManager.forkFromCaptured(
					capture.snapshot,
					root,
					destination,
					"copy-retain",
					mode,
					{ sessionId: "reserved.fork" },
				);
				if (result.kind !== "forked") throw new Error(`Fork failed: ${result.reason}`);
				managers.push(result.manager);
				expect(result.manager.getHeader()).toMatchObject({ id: "reserved.fork", parentSession: "source" });
				const file = result.manager.getSessionFile()!;
				await result.manager.close();
				const inspection = await SessionManager.inspectSessionTailReadOnly(file);
				if (inspection.kind === "error") throw new Error(`Inspection failed: ${inspection.reason}`);
				const reopened = await SessionManager.openExistingStrict(inspection.identity, destination);
				if (reopened.kind !== "opened") throw new Error(`Reopen failed: ${reopened.reason}`);
				managers.push(reopened.manager);
				expect(reopened.manager.getHeader()).toMatchObject({ id: "reserved.fork", parentSession: "source" });
				const ids = new Set<string>();
				for (let attempt = 0; attempt < 2; attempt++) {
					const fork = await SessionManager.forkFromCaptured(
						capture.snapshot,
						root,
						destination,
						"copy-retain",
						mode,
					);
					if (fork.kind !== "forked") throw new Error(`Fork failed: ${fork.reason}`);
					managers.push(fork.manager);
					ids.add(fork.manager.getSessionId());
				}
				expect(ids.size).toBe(2);
				expect(ids.has("reserved.fork")).toBe(false);
				expect(await Bun.file(source).text()).toBe(bytes);
			});
		}
	}

	it("rejects invalid allocations before creating destinations or writing breadcrumbs", async () => {
		const { root, source } = await fixture();
		const capture = SessionManager.captureTranscriptStrict(source);
		if (capture.kind !== "captured") throw new Error(`Capture failed: ${capture.reason}`);
		const storage = new FileSessionStorage();
		for (const sessionId of ["", "../escape", "a/b", " white ", "x".repeat(129), "bad\n"]) {
			const destination = path.join(root, "never-created");
			const allocation = { sessionId };
			expect(() => SessionManager.create(root, destination, storage, allocation)).toThrow(
				"Invalid reserved session id",
			);
			expect(() => SessionManager.inMemory(root, undefined, allocation)).toThrow("Invalid reserved session id");
			await expect(
				SessionManager.openStaged(path.join(destination, "task.jsonl"), storage, "attempt", allocation),
			).rejects.toThrow("Invalid reserved session id");
			await expect(
				SessionManager.forkFromCaptured(capture.snapshot, root, destination, "copy-retain", "enabled", allocation),
			).rejects.toThrow("Invalid reserved session id");
			expect(await fs.readdir(root)).toEqual(["source.jsonl"]);
		}
	});

	it("keeps lifecycle adoption consume-once and independent of explicit allocations", async () => {
		const { root } = await fixture();
		const modulePath = path.resolve(import.meta.dir, "../src/session/session-manager.ts");
		const script = `import { SessionManager } from ${JSON.stringify(modulePath)};
const explicit = SessionManager.inMemory(${JSON.stringify(root)}, undefined, { sessionId: "explicit" });
if (explicit.getSessionId() !== "explicit") throw Error("explicit ignored");
await explicit.newSession({ identityAllocation: { sessionId: "lifecycle-child" } });
await explicit.newSession();
if (explicit.getSessionId() !== "lifecycle-child") throw Error("explicit consumed lifecycle adoption");
await explicit.newSession();
if (explicit.getSessionId() === "lifecycle-child") throw Error("lifecycle adopted twice");
const ordinary = SessionManager.inMemory(${JSON.stringify(root)});
if (ordinary.getSessionId() !== "lifecycle-child") throw Error("default adoption changed");
await ordinary.close(); await explicit.close();`;
		const child = Bun.spawn([process.execPath, "--eval", script], {
			env: { ...process.env, GJC_LIFECYCLE_REQUEST_ID: "reservation-test", GJC_SESSION_ID: "lifecycle-child" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
	});
});
