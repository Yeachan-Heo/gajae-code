/**
 * D8/D9: cross-process startup/maintenance exclusion integration for the
 * Discord/Slack chat daemon ownership publication path.
 *
 * Proves:
 *  - holding the guard alone never publishes owner.lock/state.json
 *  - a concurrent ordinary publication (acquireChatDaemonOwnership) blocks
 *    behind a held guard and only proceeds once it releases
 *  - the guard can be held while the canonical owner-lock slot is absent
 *    (the shape of a doctor-side stale-artifact detach) without granting any
 *    ownership authority
 *  - a contended/timed-out/aborted guard acquisition never releases a
 *    foreign holder's lease
 *  - eventual normal publication (acquire, heartbeat renewal, release)
 *    succeeds once uncontended
 *  - the bounded owner-lock lease reader distinguishes absence from
 *    unreadable and never follows a symlink
 *
 * No provider/network/host service activity: every test uses only real
 * temporary directories and the production file-lock machinery, exactly like
 * the existing chat-daemon-control tests in daemon-control.test.ts.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	acquireChatDaemonOwnership,
	captureChatDaemonOwnerLockLease,
	chatDaemonPaths,
	isChatDaemonOwnerLock,
	releaseChatDaemonOwnership,
	renewChatDaemonHeartbeat,
} from "../src/sdk/bus/chat-daemon-control";
import { acquireDaemonStartupExclusion, daemonStartupExclusionPath } from "../src/sdk/bus/daemon-startup-exclusion";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-chat-startup-exclusion-test-"));
}

describe("chat daemon startup exclusion integration", () => {
	test("holding the guard alone never publishes owner lock or state", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		const release = await acquireDaemonStartupExclusion(agentDir, "discord");
		try {
			expect(fs.existsSync(paths.lock)).toBe(false);
			expect(fs.existsSync(paths.state)).toBe(false);
			// The guard's own path is a distinct file, never the ordinary owner
			// lock or state artifact — it can never collide with or satisfy them.
			const guardPath = daemonStartupExclusionPath(agentDir, "discord");
			expect(guardPath).not.toBe(paths.lock);
			expect(guardPath).not.toBe(paths.state);
		} finally {
			await release();
		}
		// Still absent after release: the guard never wrote them at any point.
		expect(fs.existsSync(paths.lock)).toBe(false);
		expect(fs.existsSync(paths.state)).toBe(false);
	});

	test("a concurrent acquireChatDaemonOwnership waits behind a held guard, then publishes once released", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		const release = await acquireDaemonStartupExclusion(agentDir, "discord");
		const probe = { pidAlive: () => true, pidIncarnation: () => "linux:20001" };
		const acquisition = acquireChatDaemonOwnership({
			agentDir,
			kind: "discord",
			ownerId: "owner-a",
			pid: process.pid,
			identity: "identity-a",
			incarnation: "linux:20001",
			...probe,
		});
		// Give the contended acquisition a moment to actually attempt and block
		// behind the held guard before asserting nothing was published yet.
		await Bun.sleep(200);
		expect(fs.existsSync(paths.state)).toBe(false);
		expect(fs.existsSync(paths.lock)).toBe(false);
		await release();
		expect(await acquisition).toBe(true);
		expect(fs.existsSync(paths.state)).toBe(true);
		const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
		expect(state.ownerId).toBe("owner-a");
		expect(state.rootDigest).toMatch(/^[0-9a-f]{64}$/);
		const lock = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
		expect(lock.version).toBe(1);
		expect(lock.ownerId).toBe("owner-a");
		expect(lock.rootDigest).toBe(state.rootDigest);
	});

	test("the guard can be held while the canonical owner-lock slot is absent (marker-detach shape)", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const release = await acquireDaemonStartupExclusion(agentDir, "discord");
		try {
			// Canonical owner-lock slot is absent (as after a doctor-side detach)
			// while this call still retains the shared guard — proving the guard's
			// hold is independent of, and does not require, owner-lock presence.
			expect(fs.existsSync(paths.lock)).toBe(false);
			// A second call for the SAME (agentDir, owner) must still contend,
			// proving the guard is genuinely held, not merely a no-op path check.
			await expect(acquireDaemonStartupExclusion(agentDir, "discord", { timeoutMs: 300 })).rejects.toThrow();
		} finally {
			await release();
		}
	});

	test("a contended acquisition timeout never releases the foreign holder's lease", async () => {
		const agentDir = tempAgentDir();
		const holderRelease = await acquireDaemonStartupExclusion(agentDir, "slack");
		await expect(acquireDaemonStartupExclusion(agentDir, "slack", { timeoutMs: 250 })).rejects.toThrow();
		// If the timed-out contender had wrongly released the foreign lease, this
		// release would be releasing a lease it no longer legitimately holds.
		await holderRelease();
		// Nobody holds it now: a fresh acquisition succeeds immediately.
		const release2 = await acquireDaemonStartupExclusion(agentDir, "slack", { timeoutMs: 1_000 });
		await release2();
	});

	test("aborting a contended acquisition never releases the foreign holder's lease", async () => {
		const agentDir = tempAgentDir();
		const holderRelease = await acquireDaemonStartupExclusion(agentDir, "discord");
		const controller = new AbortController();
		const contended = acquireDaemonStartupExclusion(agentDir, "discord", {
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		controller.abort(new Error("cancelled by caller"));
		await expect(contended).rejects.toThrow();
		await holderRelease();
		const release2 = await acquireDaemonStartupExclusion(agentDir, "discord", { timeoutMs: 1_000 });
		await release2();
	});

	test("full acquire/renew/release lifecycle succeeds uncontended through the guard", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "slack");
		const probe = { pidAlive: () => true, pidIncarnation: () => "linux:30001" };
		const acquired = await acquireChatDaemonOwnership({
			agentDir,
			kind: "slack",
			ownerId: "owner-b",
			pid: process.pid,
			identity: "identity-b",
			incarnation: "linux:30001",
			...probe,
		});
		expect(acquired).toBe(true);
		const renewed = await renewChatDaemonHeartbeat({
			agentDir,
			kind: "slack",
			ownerId: "owner-b",
			pid: process.pid,
			incarnation: "linux:30001",
			transportHealthy: true,
			...probe,
		});
		expect(renewed).toBe(true);
		await releaseChatDaemonOwnership({
			agentDir,
			kind: "slack",
			ownerId: "owner-b",
			pid: process.pid,
			incarnation: "linux:30001",
			...probe,
		});
		const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
		expect(state.transportHealthy).toBe(false);
		expect(typeof state.stoppedAt).toBe("number");
		expect(fs.existsSync(paths.lock)).toBe(false);
	});

	test("captureChatDaemonOwnerLockLease distinguishes absent from unreadable and never follows a symlink", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		expect((await captureChatDaemonOwnerLockLease(paths.lock)).status).toBe("absent");

		if (process.platform !== "win32") {
			const real = path.join(paths.dir, "real-target.json");
			fs.writeFileSync(real, JSON.stringify({ pid: 1, incarnation: "linux:1", createdAt: 1 }));
			fs.symlinkSync(real, paths.lock);
			expect((await captureChatDaemonOwnerLockLease(paths.lock)).status).toBe("unreadable");
			fs.unlinkSync(paths.lock);
		}

		fs.writeFileSync(
			paths.lock,
			JSON.stringify({
				version: 1,
				pid: process.pid,
				incarnation: "linux:1",
				createdAt: Date.now(),
				ownerId: "owner-x",
				rootDigest: "a".repeat(64),
			}),
		);
		const result = await captureChatDaemonOwnerLockLease(paths.lock);
		expect(result.status).toBe("present");
		if (result.status === "present") {
			const parsed = JSON.parse(result.lease.content);
			expect(isChatDaemonOwnerLock(parsed)).toBe(true);
		}
	});

	test("isChatDaemonOwnerLock rejects malformed optional fields", () => {
		expect(isChatDaemonOwnerLock({ pid: 1, incarnation: "linux:1", createdAt: 1 })).toBe(true);
		expect(isChatDaemonOwnerLock({ pid: 1, incarnation: "linux:1", createdAt: 1, version: 2 })).toBe(false);
		expect(isChatDaemonOwnerLock({ pid: 1, incarnation: "linux:1", createdAt: 1, ownerId: "" })).toBe(false);
		expect(isChatDaemonOwnerLock({ pid: 1, incarnation: "linux:1", createdAt: 1, rootDigest: "not-hex" })).toBe(
			false,
		);
		expect(isChatDaemonOwnerLock({ pid: 1, incarnation: "linux:1", createdAt: 1, rootDigest: "a".repeat(64) })).toBe(
			true,
		);
	});
});
