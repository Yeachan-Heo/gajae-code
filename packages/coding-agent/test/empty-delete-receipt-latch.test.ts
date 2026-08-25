import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COORDINATOR_JSON_SCAN_CAP, listCoordinatorJsonFiles } from "../src/coordinator-mcp/projection-scan";
import { collectEmptyDeleteReceipts, runEmptyDeleteGc } from "../src/gjc-runtime/empty-delete-gc";
import { runGjcGcCommand } from "../src/gjc-runtime/gc-runtime";
import {
	reclaimStaleSessionStateLock,
	removeVerifiedEmptyQuarantine,
	SessionStateLockTestHooks,
} from "../src/gjc-runtime/session-state-lock";
import {
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";

const tempDirs: string[] = [];
installExactIdentityNatives();

afterEach(async () => {
	SessionStateLockTestHooks.quarantineMints = undefined;
	SessionStateLockTestHooks.lastQuarantineName = undefined;
	SessionStateLockTestHooks.forcedQuarantineName = undefined;
	SessionStateLockTestHooks.probeProcessSignal = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("empty .gjc-delete-* latch", () => {
	it("Test 1: planted 0-byte .gjc-delete-* is never opened or parsed", async () => {
		const dir = await tempRoot("gjc-scan-");
		const live = path.join(dir, "live.json");
		const debris = path.join(dir, ".gjc-delete-session-state-lock-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json");
		await fs.writeFile(live, JSON.stringify({ session_id: "live", state: "ready_for_input" }));
		await fs.writeFile(debris, "");
		const opened: string[] = [];
		const io = {
			readdir: (target: string) => fs.readdir(target),
			lstat: (file: string) => fs.lstat(file),
			readFile: async (file: string, encoding: "utf8") => {
				opened.push(file);
				return fs.readFile(file, encoding);
			},
		};
		const scan = await listCoordinatorJsonFiles(dir, io);
		expect(scan.values).toHaveLength(1);
		expect((scan.values[0] as { session_id: string }).session_id).toBe("live");
		expect(opened.every(file => !file.includes(".gjc-delete-"))).toBe(true);
		expect(scan.skippedDebris).toBeGreaterThan(0);
	});

	it("Test 1 over-cap: debris pile + few valid records succeeds without unreadable", async () => {
		const dir = await tempRoot("gjc-cap-");
		await fs.writeFile(path.join(dir, "a.json"), JSON.stringify({ session_id: "a" }));
		await fs.writeFile(path.join(dir, "b.json"), JSON.stringify({ session_id: "b" }));
		for (let i = 0; i < COORDINATOR_JSON_SCAN_CAP + 5; i++) {
			await fs.writeFile(path.join(dir, `.gjc-delete-session-state-lock-${i}.json`), "");
		}
		const scan = await listCoordinatorJsonFiles(dir);
		expect(scan.capped).toBe(false);
		expect(scan.values).toHaveLength(2);
	});

	it("Test 1 post-filter cap: zero-byte canonical JSON does not consume the parse cap", async () => {
		const dir = await tempRoot("gjc-postcap-");
		await fs.writeFile(path.join(dir, "live.json"), JSON.stringify({ session_id: "live" }));
		for (let i = 0; i < 12; i++) {
			await fs.writeFile(path.join(dir, `empty-${i}.json`), "");
		}
		const scan = await listCoordinatorJsonFiles(dir, undefined, 10);
		expect(scan.capped).toBe(false);
		expect(scan.values).toHaveLength(1);
		expect(scan.skippedEmpty).toBe(12);
	});

	it("Test 2: leftover empty at reserved name is removed before exchange", async () => {
		const dir = await tempRoot("gjc-mint-");
		const reserved = ".gjc-delete-session-state-lock-fixed.json";
		await fs.writeFile(path.join(dir, reserved), "");
		await removeVerifiedEmptyQuarantine(dir, reserved);
		expect(await fs.stat(path.join(dir, reserved)).then(() => "present", () => "gone")).toBe("gone");
		await fs.writeFile(path.join(dir, reserved), "body");
		await removeVerifiedEmptyQuarantine(dir, reserved);
		expect(await fs.readFile(path.join(dir, reserved), "utf8")).toBe("body");
	});

	it("Test 2b: stale reclaim does not refuse a planted leftover at forced quarantine name", async () => {
		const dir = await tempRoot("gjc-reclaim-");
		const stateFile = path.join(dir, "session.json");
		const lockFile = `${stateFile}.lock`;
		const reserved = ".gjc-delete-session-state-lock-forced.json";
		await fs.writeFile(stateFile, JSON.stringify({ state: "running" }));
		await fs.writeFile(path.join(dir, reserved), "");
		await fs.writeFile(
			lockFile,
			JSON.stringify({
				pid: 2 ** 22 - 1,
				start_time: "unknown",
				token: "dead",
				owner_host_id: "local-host",
			}),
		);
		SessionStateLockTestHooks.ownerHostId = () => "local-host";
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = true;
		SessionStateLockTestHooks.probeProcessSignal = () => {
			throw Object.assign(new Error("missing"), { code: "ESRCH" });
		};
		SessionStateLockTestHooks.forcedQuarantineName = reserved;
		await expect(reclaimStaleSessionStateLock(lockFile)).resolves.toBeUndefined();
		expect(await fs.stat(lockFile).then(() => "present", () => "gone")).toBe("gone");
	});

	it("Test 3: turn-start persist then next lock cycle can rewrite off running", async () => {
		const dir = await tempRoot("gjc-running-");
		const stateFile = path.join(dir, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "sid", cwd: dir, sessionFile: null },
		);
		const first = JSON.parse(await fs.readFile(stateFile, "utf8")) as { state: string };
		expect(first.state).toBe("running");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_end", messages: [] },
			{ sessionId: "sid", cwd: dir, sessionFile: null },
		);
		const second = JSON.parse(await fs.readFile(stateFile, "utf8")) as { state: string };
		expect(second.state).not.toBe("running");
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	});

	it("Test 4: gc operands keep non-empty/symlink/missing-root and prune only empty prefix", async () => {
		const root = await tempRoot("gjc-gc-root-");
		const empty = path.join(root, ".gjc-delete-session-state-lock-dead.json");
		const live = path.join(root, "live.json");
		const other = path.join(root, ".gjc-delete-session-state-lock-full.json");
		await fs.writeFile(empty, "");
		await fs.writeFile(live, "{}");
		await fs.writeFile(other, "not-empty");
		const missing = path.join(root, "no-such-root");
		const dry = await runEmptyDeleteGc({ roots: [root, missing], prune: false });
		expect(dry.would_remove).toBe(1);
		expect(dry.records.some(r => r.reason === "missing_root")).toBe(true);
		expect(dry.records.some(r => r.reason === "non_empty")).toBe(true);
		const pruned = await runEmptyDeleteGc({ roots: [root], prune: true });
		expect(pruned.removed).toBe(1);
		await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(other, "utf8")).toBe("not-empty");
		expect(await fs.readFile(live, "utf8")).toBe("{}");
	});

	it("Test 4b: gc keeps symlink root and identity-drifted empty replacement", async () => {
		const root = await tempRoot("gjc-gc-id-");
		const linked = path.join(root, "linked-root");
		await fs.symlink(root, linked);
		const viaLink = await runEmptyDeleteGc({ roots: [linked], prune: false });
		expect(viaLink.records.some(r => r.reason === "symlink_root")).toBe(true);
		const empty = path.join(root, ".gjc-delete-session-state-lock-swap.json");
		await fs.writeFile(empty, "");
		const collected = await collectEmptyDeleteReceipts(root);
		expect(collected.find(r => r.path === empty)?.identity).toBeDefined();
		await fs.unlink(empty);
		await fs.writeFile(empty, "");
		const pruned = await runEmptyDeleteGc({ roots: [root], prune: true });
		const row = pruned.records.find(r => r.path === empty);
		expect(row).toBeDefined();
		if (row?.reason === "identity_drift") {
			expect(await fs.readFile(empty, "utf8")).toBe("");
		}
	});

	it("Test 4 CLI: empty-delete-receipts requires operand", async () => {
		const result = await runGjcGcCommand(["--empty-delete-receipts", "--json"], "/tmp", process.env, []);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("empty_delete_receipts_requires_root_or_manifest");
	});

	it("Test 5: atomic write leaves no 0-byte canonical on crash-before-rename", async () => {
		const { writeCoordinatorAtomic } = await import("../src/coordinator-mcp/durability");
		const dir = await tempRoot("gjc-atomic-");
		const file = path.join(dir, "canonical.json");
		await writeCoordinatorAtomic(file, '{"ok":true}\n');
		expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}\n');
		await expect(
			writeCoordinatorAtomic(file, '{"next":true}\n', {
				rename: async () => {
					throw new Error("injected_rename_fault");
				},
			}),
		).rejects.toThrow("injected_rename_fault");
		expect(await fs.readFile(file, "utf8")).toBe('{"ok":true}\n');
		const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});
});
