import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import { SessionManager } from "../../src/session/session-manager";
import { makeAssistantMessage } from "./helpers";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function scenario(phase: "pending" | "replacement" | "cleanup"): Promise<void> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "receipt-interleaving-"));
	roots.push(root);
	const cwd = path.join(root, "work");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const destination = SessionManager.managedDestination(cwd, agentDir);
	if (destination.kind !== "managed") throw new Error("Expected managed destination");
	const manager = SessionManager.create(cwd, destination);
	manager.appendMessage({ role: "user", content: "x".repeat(430_000), timestamp: Date.now() });
	manager.appendMessage(makeAssistantMessage());
	manager.setSessionMemoryMode("auto");
	manager.appendModeChange("goal", {
		goal: {
			id: "goal-fixture",
			objective: "Verify publication interleaving",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "goal-fixture",
		toolName: "goal",
		content: [{ type: "text", text: "created" }],
		isError: false,
		timestamp: Date.now(),
	});
	await manager.flush();
	const transcript = manager.getSessionFile()!;
	const priorBytes = fs.readFileSync(transcript);
	const identity = manager.captureState().managedPersistExpectedIdentity;
	expect(String(identity!.ino)).toBe(String(fs.statSync(transcript).ino));
	const peerDirectory = destination.directory;
	const peer = new ManagedSessionDescendantStore(managedDirectoryRoot(peerDirectory), peerDirectory);
	const originalRename = native.renameNoReplacePath;
	const originalReplace = native.exactReplacePath;
	const originalUnlink = native.exactUnlink;
	let interleavings = 0;
	let sourceSurvivedPeer = false;
	let receiptPath: string | undefined;
	const interleave = () => {
		if (interleavings > 0) return;
		interleavings++;
		if (!receiptPath) throw new Error("Expected live receipt");
		const before = fs.readFileSync(receiptPath);
		const beforeInode = fs.statSync(receiptPath).ino;
		peer.ensureDirectory("peer-output");
		sourceSurvivedPeer = fs.existsSync(receiptPath);
		expect(fs.statSync(receiptPath).ino).toBe(beforeInode);
		expect(fs.readFileSync(receiptPath).equals(before)).toBe(true);
	};
	vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) => {
		if (
			path.basename(source).startsWith(".gjc-replace-receipt-pending-") &&
			path.basename(target).startsWith(".gjc-replace-cleanup-")
		) {
			receiptPath = source;
			if (phase === "pending") interleave();
			const renamed = originalRename(source, target);
			receiptPath = target;
			return renamed;
		}
		return originalRename(source, target);
	});
	vi.spyOn(native, "exactReplacePath").mockImplementation((source, target, from, to) => {
		if (target === transcript && phase === "replacement") interleave();
		return originalReplace(source, target, from, to);
	});
	vi.spyOn(native, "exactUnlink").mockImplementation((target, expected) => {
		if (target === receiptPath && phase === "cleanup") interleave();
		return originalUnlink(target, expected);
	});
	let observedError: unknown;
	try {
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
	} catch (error) {
		observedError = error;
	} finally {
		vi.restoreAllMocks();
	}
	expect(interleavings).toBe(1);
	expect(observedError).toBeUndefined();
	expect(sourceSurvivedPeer).toBe(true);
	expect(fs.statSync(transcript).size).toBeGreaterThan(priorBytes.byteLength);
	expect(String(manager.captureState().managedPersistExpectedIdentity!.ino)).toBe(String(fs.statSync(transcript).ino));
	await manager.close().catch(() => {});
	peer.close();
}

// Linux retained-authority appends do not enter this replacement-receipt path.
describe.skipIf(process.platform === "linux")("installed-native receipt publication interleaving", () => {
	for (const phase of ["pending", "replacement", "cleanup"] as const)
		it(`preserves the active writer's receipt at ${phase}`, async () => {
			await scenario(phase);
		});
});
