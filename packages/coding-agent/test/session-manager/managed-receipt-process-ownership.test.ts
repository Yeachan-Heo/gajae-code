import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import * as processIdentity from "../../src/sdk/broker/process-incarnation";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";

type ReceiptWorker = Subprocess<"ignore", "ignore", "pipe">;
let root: string;
const children: ReceiptWorker[] = [];
const worker = path.join(import.meta.dir, "../fixtures/managed-receipt-writer.ts");
beforeEach(() => {
	root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "receipt-process-ownership-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill();
		await child.exited;
	}
	fs.rmSync(root, { recursive: true, force: true });
});
function spawnWorker(lane: string, mode: string): ReceiptWorker {
	const child = Bun.spawn([process.execPath, "--no-env-file", worker, root, lane, mode], {
		cwd: path.resolve(import.meta.dir, "../../../.."),
		env: { ...process.env, GJC_SDK_DISABLE: "1", RAYON_NUM_THREADS: "1", UV_THREADPOOL_SIZE: "1" },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	return child;
}
async function ready(lane: string, child: ReceiptWorker): Promise<string> {
	const marker = path.join(root, `ready-${lane}`);
	const deadline = Date.now() + 15000;
	while (!fs.existsSync(marker)) {
		if (child.exitCode !== null)
			throw new Error(`Fixture exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
		if (Date.now() >= deadline) throw new Error("Fixture readiness timeout");
		await Bun.sleep(10);
	}
	return fs.readFileSync(marker, "utf8");
}
function peerMutation(name: string): void {
	const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	try {
		store.ensureDirectory(name);
	} finally {
		store.close();
	}
}

describe("receipt publisher process ownership", () => {
	it("persists both same-scope writers without stealing their active receipts", async () => {
		const first = spawnWorker("0", "concurrent");
		const second = spawnWorker("1", "concurrent");
		await Promise.all([ready("0", first), ready("1", second)]);
		fs.writeFileSync(path.join(root, "start"), "start\n");
		for (const child of [first, second]) {
			const exit = await child.exited;
			const diagnostic = await new Response(child.stderr).text();
			expect({ exit, diagnostic }).toEqual({ exit: 0, diagnostic: "" });
		}
		for (const lane of ["0", "1"]) {
			const result = JSON.parse(fs.readFileSync(path.join(root, `result-${lane}.json`), "utf8"));
			expect(result.failure).toBeNull();
			expect(result.completedAppends).toBe(40);
			expect(result.actualInode).toBe(result.expectedInode);
		}
	}, 30000);

	it("preserves a live owner's receipt and reconciles it only after verified exit", async () => {
		const child = spawnWorker("orphan", "orphan");
		const { pending } = JSON.parse(await ready("orphan", child));
		const before = fs.readFileSync(pending);
		const ino = fs.statSync(pending).ino;
		peerMutation("while-live");
		expect(fs.statSync(pending).ino).toBe(ino);
		expect(fs.readFileSync(pending).equals(before)).toBe(true);
		fs.writeFileSync(path.join(root, "exit"), "exit\n");
		expect(await child.exited).toBe(0);
		peerMutation("after-exit");
		expect(fs.existsSync(pending)).toBe(false);
		peerMutation("after-reconciliation");
		expect(fs.readFileSync(path.join(root, "transcript.jsonl"), "utf8")).toBe("predecessor\n");
		const records = fs.readdirSync(root).filter(name => name.startsWith(".gjc-replace-cleanup-"));
		for (const record of records) expect(fs.statSync(path.join(root, record)).size).toBe(0);
	}, 30000);

	it("keeps unknown liveness owned but recovers an exact PID-reuse orphan", async () => {
		const child = spawnWorker("orphan", "orphan");
		const { pending, pid } = JSON.parse(await ready("orphan", child));
		fs.writeFileSync(path.join(root, "exit"), "exit\n");
		expect(await child.exited).toBe(0);
		const originalObserve = processIdentity.observeProcessIncarnation;
		const unknown = vi
			.spyOn(processIdentity, "observeProcessIncarnation")
			.mockImplementation((target, options) =>
				target === pid ? { status: "unknown", reasonCode: "permission_denied" } : originalObserve(target, options),
			);
		peerMutation("unknown-owner");
		expect(fs.existsSync(pending)).toBe(true);
		unknown.mockRestore();
		const reuse = vi
			.spyOn(processIdentity, "observeProcessIncarnation")
			.mockImplementation((target, options) =>
				target === pid ? { status: "present", incarnation: "darwin:1:1" } : originalObserve(target, options),
			);
		peerMutation("reused-pid");
		expect(fs.existsSync(pending)).toBe(false);
		reuse.mockRestore();
	}, 30000);

	it("does not reclaim remote ownership or accept an unbound attempt", async () => {
		const child = spawnWorker("orphan", "orphan");
		const { pending } = JSON.parse(await ready("orphan", child));
		fs.writeFileSync(path.join(root, "exit"), "exit\n");
		expect(await child.exited).toBe(0);
		const record = JSON.parse(fs.readFileSync(pending, "utf8"));
		record.publisher.host = `${os.hostname()}-another-host`;
		fs.writeFileSync(pending, JSON.stringify(record));
		const foreignBytes = fs.readFileSync(pending);
		peerMutation("foreign-owner");
		expect(fs.readFileSync(pending).equals(foreignBytes)).toBe(true);
		record.publisher.host = os.hostname();
		record.publisher.attemptId = "00000000-0000-0000-0000-000000000000";
		fs.writeFileSync(pending, JSON.stringify(record));
		const invalidBytes = fs.readFileSync(pending);
		expect(() => peerMutation("invalid-attempt")).toThrow("managed_replace_cleanup_receipt_invalid");
		expect(fs.existsSync(path.join(root, "invalid-attempt"))).toBe(false);
		expect(fs.readFileSync(pending).equals(invalidBytes)).toBe(true);
		expect(fs.readFileSync(path.join(root, "transcript.jsonl"), "utf8")).toBe("predecessor\n");
	}, 30000);
});
