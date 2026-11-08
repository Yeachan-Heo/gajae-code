import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeExactUnlinkResult } from "@gajae-code/natives";
import * as native from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import {
	ManagedPreparedFileRemovalError,
	ManagedSessionDescendantStore,
	ManagedTreeRemovalError,
	type ManagedTreeRemovalOutcome,
	ManagedTreeRemovalTestHooks,
} from "../src/session/internal/managed-session-storage";
import { type PreparedNewSession, SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	delete ManagedTreeRemovalTestHooks.afterNativeRemoval;
	delete ManagedTreeRemovalTestHooks.afterPreparedFileRemoval;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(populated = true) {
	const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-prepared-disposition-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { mode: 0o700 });
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	managers.push(manager);
	const stage = await manager.prepareNewSession();
	manager.appendPreparedCustomMessageEntry(stage, "synthetic", "prepared bytes", true);
	await manager.ensurePreparedNewSessionOnDisk(stage);
	if (!stage.sessionFile || !stage.artifactsDir) throw new Error("missing prepared paths");
	if (populated) {
		fs.mkdirSync(stage.artifactsDir, { recursive: true, mode: 0o700 });
		await Bun.write(path.join(stage.artifactsDir, "payload"), "synthetic secret");
		fs.chmodSync(path.join(stage.artifactsDir, "payload"), 0o600);
	}
	return { manager, stage, file: stage.sessionFile, artifacts: stage.artifactsDir };
}

async function rejected(action: Promise<unknown>): Promise<unknown> {
	try {
		await action;
	} catch (error) {
		return error;
	}
	throw new Error("expected cleanup failure");
}

// Exercise JavaScript mutation, not merely TypeScript readonly annotations.
function attackReceipt(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		attackReceipt(child);
		expect(Reflect.set(value, key, key === "kind" ? "payload_retired" : "complete")).toBe(false);
	}
	expect(Reflect.set(value, "forged", true)).toBe(false);
}

const darwin = process.platform === "darwin";
describe("prepared cleanup disposition", () => {
	it.skipIf(!darwin)("logs only bounded diagnostics, never tree graphs or secret transcript bytes", async () => {
		const f = await fixture();
		const secret = "PRIVATE_TRANSCRIPT_DO_NOT_LOG".repeat(1000);
		f.manager.appendPreparedCustomMessageEntry(f.stage, "secret", secret, true);
		await f.manager.ensurePreparedNewSessionOnDisk(f.stage);
		for (let index = 0; index < 128; index++)
			await Bun.write(path.join(f.artifacts, `private-tree-entry-${index}`), secret);
		const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// closeStrict drives the actual manager retry/report callsite.
		await f.manager.closeStrict();
		const reported = warnings.mock.calls.filter(
			([message]) => message === "Prepared session logically discarded with retained namespaces",
		);
		expect(reported).toHaveLength(1);
		const diagnostic = reported[0]![1];
		expect(Object.keys(diagnostic!).sort()).toEqual([
			"artifactCode",
			"kind",
			"phase",
			"retainedCount",
			"retainedNames",
			"transcriptCode",
			"transcriptKind",
		]);
		const encoded = JSON.stringify(diagnostic);
		expect(encoded.length).toBeLessThan(1100);
		for (const forbidden of [
			"PRIVATE_TRANSCRIPT",
			"private-tree-entry",
			"expected",
			"Buffer",
			"entries",
			"outcome",
			"cause",
		])
			expect(encoded).not.toContain(forbidden);
	});
	it.skipIf(!darwin)(
		"reports actual scrubbed namespaces and returns the same receipt without reauthorization",
		async () => {
			const f = await fixture();
			let artifactOutcome: ManagedTreeRemovalOutcome | undefined;
			let transcriptOutcome: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
				artifactOutcome = outcome;
			};
			ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
				transcriptOutcome = outcome;
			};
			const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
			const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
			const capture = vi.spyOn(ManagedSessionDescendantStore.prototype, "captureTree");
			const [result, concurrent] = await Promise.all([
				f.manager.discardPreparedNewSession(f.stage),
				f.manager.discardPreparedNewSession(f.stage),
			]);
			expect(concurrent).toBe(result);
			const beforeMutation = JSON.stringify(result);
			attackReceipt(result);
			expect(JSON.stringify(await f.manager.discardPreparedNewSession(f.stage))).toBe(beforeMutation);
			expect(result.kind).toBe("discarded");
			expect(result.artifactRetirement?.outcome).toEqual(artifactOutcome);
			expect(result.transcriptRemoval?.outcome).toEqual(transcriptOutcome);
			expect(result.transcriptRemoval?.kind).toBe("payload_retired");
			expect(result.retainedNamespaces).toContain(`${f.artifacts}.removing`);
			expect(fs.readFileSync(path.join(`${f.artifacts}.removing`, "payload")).length).toBe(0);
			expect(fs.existsSync(f.file)).toBe(false);
			for (const retained of result.transcriptRemoval!.retainedNamespaces)
				expect(fs.statSync(retained).size).toBe(0);
			const captures = capture.mock.calls.length;
			// A newly published original is not authorized by the old stage receipt.
			fs.mkdirSync(f.artifacts);
			await Bun.write(path.join(f.artifacts, "successor"), "keep");
			expect(await f.manager.discardPreparedNewSession(f.stage)).toBe(result);
			expect(capture.mock.calls.length).toBe(captures);
			expect(tree).toHaveBeenCalledTimes(1);
			expect(transcript).toHaveBeenCalledTimes(1);
			expect(await Bun.file(path.join(f.artifacts, "successor")).text()).toBe("keep");
		},
	);

	it.skipIf(!darwin)("keeps artifact-free cleanup positive with actual transcript retirement evidence", async () => {
		const f = await fixture(false);
		const result = await f.manager.discardPreparedNewSession(f.stage);
		expect(result.kind).toBe("discarded");
		expect(result.artifactRetirement).toBeUndefined();
		expect(result.transcriptRemoval?.kind).toBe("payload_retired");
		expect(result.retainedNamespaces.length).toBeGreaterThan(0);
		expect(fs.existsSync(f.file)).toBe(false);
	});

	it.skipIf(process.platform !== "win32")(
		"reports physical transcript removal without inventing retained evidence",
		async () => {
			const f = await fixture(false);
			const result = await f.manager.discardPreparedNewSession(f.stage);
			expect(result.transcriptRemoval?.kind).toBe("removed");
			expect(result.transcriptRemoval?.physicalCleanup).toBe("complete");
			expect(result.retainedNamespaces).toEqual([]);
			expect(fs.existsSync(f.file)).toBe(false);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"never erases retained Linux uncertainty when the original disappears",
		async () => {
			const f = await fixture();
			const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
			const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
			const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
			expect(error).toBeInstanceOf(ManagedTreeRemovalError);
			if (!(error instanceof ManagedTreeRemovalError) || error.outcome?.route !== "retained") throw error;
			expect(error.outcome.result.recoveryPath).toBeDefined();
			expect(fs.existsSync(f.artifacts)).toBe(false);
			expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
			expect(tree).toHaveBeenCalledTimes(1);
			expect(transcript).not.toHaveBeenCalled();
			expect(await Bun.file(f.file).text()).toContain("prepared bytes");
		},
	);

	it.skipIf(process.platform !== "linux")(
		"reports an artifact-free detached transcript as UNSCRUBBED with native identity",
		async () => {
			const f = await fixture(false);
			const bytes = await Bun.file(f.file).text();
			const removal = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
			let observed: ManagedTreeRemovalOutcome | undefined;
			ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
				observed = outcome;
			};
			const result = await f.manager.discardPreparedNewSession(f.stage);
			const beforeMutation = JSON.stringify(result);
			attackReceipt(result);
			const repeated = await Promise.all([
				f.manager.discardPreparedNewSession(f.stage),
				f.manager.discardPreparedNewSession(f.stage),
			]);
			for (const receipt of repeated) expect(JSON.stringify(receipt)).toBe(beforeMutation);
			expect(removal).toHaveBeenCalledTimes(1);
			expect(result.transcriptRemoval?.kind).toBe("detached_retained");
			expect(result.transcriptRemoval?.physicalCleanup).toBe("pending");
			expect(result.transcriptRemoval?.outcome).toEqual(observed);
			if (observed?.route !== "retained") throw new Error("expected retained native evidence");
			expect(observed.result.identity?.nlink).toBe("1");
			expect(observed.result.recoveryPath).toBeDefined();
			expect(fs.existsSync(f.file)).toBe(false);
			expect(await Bun.file(result.retainedNamespaces[0]!).text()).toBe(bytes);
			expect(result.retainedNamespaces[0]).toBe(observed.result.recoveryPhysicalPath!);
			expect(fs.lstatSync(result.retainedNamespaces[0]!, { bigint: true }).ino.toString()).toBe(
				observed.result.identity!.ino,
			);
			expect(await f.manager.discardPreparedNewSession(f.stage)).toBe(result);
			await f.manager.closeStrict();
			expect(await Bun.file(result.retainedNamespaces[0]!).text()).toBe(bytes);
		},
	);

	for (const invalid of ["identity", "path", "location", "namespace"] as const) {
		it.skipIf(process.platform !== "linux")(`refuses retained transcript missing ${invalid} proof`, async () => {
			const f = await fixture(false);
			ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
				if (outcome.route !== "retained") throw new Error("expected retained route");
				if (invalid === "identity") outcome.result.identity = undefined;
				else if (invalid === "location") outcome.result.recoveryPhysicalPath = undefined;
				else if (invalid === "namespace") outcome.result.recoveryNamespaceIdentity = undefined;
				else outcome.result.recoveryPath = "../foreign";
			};
			const removal = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
			const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
			expect(error).toBeInstanceOf(ManagedPreparedFileRemovalError);
			expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
			expect(removal).toHaveBeenCalledTimes(1);
		});
	}

	const invalidProofs: [string, Partial<NativeExactUnlinkResult>][] = [
		["missing durability", { payloadDurable: undefined }],
		["missing detached name", { detachedPath: undefined }],
		["wrong detached name", { detachedPath: "/foreign/retained" }],
		["successor", { retainedSuccessorPath: "/foreign/successor" }],
		["unknown", { retainedUnknownPath: "/foreign/unknown" }],
	];
	for (const [name, patch] of invalidProofs) {
		it.skipIf(!darwin)(
			`blocks artifact ${name} before transcript cleanup, including absent-original retry`,
			async () => {
				const f = await fixture();
				ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
					if (outcome.route === "exact") Object.assign(outcome.result, patch);
				};
				const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
				const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
				const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
				expect(error).toBeInstanceOf(ManagedTreeRemovalError);
				expect(fs.existsSync(f.artifacts)).toBe(false);
				expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
				expect(transcript).not.toHaveBeenCalled();
				expect(tree).toHaveBeenCalledTimes(1);
				expect(await Bun.file(f.file).text()).toContain("prepared bytes");
				expect(() => f.manager.commitPreparedNewSession(f.stage)).toThrow("no longer available");
			},
		);

		it.skipIf(!darwin)(
			`blocks transcript ${name} after artifact certification without repeating either effect`,
			async () => {
				const f = await fixture();
				ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = (_target, outcome) => {
					if (outcome.route === "exact") Object.assign(outcome.result, patch);
				};
				const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
				const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
				const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
				expect(error).toBeInstanceOf(ManagedPreparedFileRemovalError);
				expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
				expect(tree).toHaveBeenCalledTimes(1);
				expect(transcript).toHaveBeenCalledTimes(1);
				expect(fs.readFileSync(path.join(`${f.artifacts}.removing`, "payload")).length).toBe(0);
			},
		);
	}

	it.skipIf(!darwin)("preserves artifact and transcript receipts across temporary writer close failure", async () => {
		const f = await fixture();
		let observed: ManagedTreeRemovalOutcome | undefined;
		ManagedTreeRemovalTestHooks.afterNativeRemoval = (_target, outcome) => {
			observed = outcome;
		};
		const close = vi.fn(async () => {});
		close.mockRejectedValueOnce(new Error("synthetic temporary close failure"));
		// Synthetic staging writer: no active transcript descriptor is fabricated.
		(f.stage as PreparedNewSession & { persistenceWriter: { close: () => Promise<void> } }).persistenceWriter = {
			close,
		};
		const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
		const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
		await expect(f.manager.discardPreparedNewSession(f.stage)).rejects.toThrow("synthetic temporary close failure");
		const result = await f.manager.discardPreparedNewSession(f.stage);
		expect(result.artifactRetirement?.outcome).toEqual(observed);
		expect(result.retainedNamespaces).toContain(`${f.artifacts}.removing`);
		expect(result.transcriptRemoval?.kind).toBe("payload_retired");
		expect(tree).toHaveBeenCalledTimes(1);
		expect(transcript).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(2);
	});

	for (const phase of ["artifact", "transcript"] as const) {
		it.skipIf(!darwin)(`preserves native ${phase} evidence on actual post-effect parent rebinding`, async () => {
			const f = await fixture();
			let observed: ManagedTreeRemovalOutcome | undefined;
			const rebound = (target: string, outcome: ManagedTreeRemovalOutcome) => {
				observed = outcome;
				const parent = path.dirname(target);
				fs.renameSync(parent, `${parent}-displaced`);
				fs.mkdirSync(parent, { mode: 0o700 });
			};
			if (phase === "artifact") ManagedTreeRemovalTestHooks.afterNativeRemoval = rebound;
			else ManagedTreeRemovalTestHooks.afterPreparedFileRemoval = rebound;
			const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
			const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
			const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
			if (!(error instanceof ManagedTreeRemovalError) && !(error instanceof ManagedPreparedFileRemovalError))
				throw error;
			expect(error.phase).toBe("post_effect_authority_check");
			expect(error.outcome).toBe(observed);
			expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
			expect(tree).toHaveBeenCalledTimes(1);
			expect(transcript).toHaveBeenCalledTimes(phase === "artifact" ? 0 : 1);
		});
	}

	it.skipIf(!darwin)("records a transcript native throw without losing certified artifact outcome", async () => {
		const f = await fixture();
		const failure = new Error("synthetic native throw");
		const original = native.exactUnlink;
		const removal = vi.spyOn(native, "exactUnlink").mockImplementation((target, identity) => {
			if (target === f.file) throw failure;
			return original(target, identity);
		});
		const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected");
		const error = await rejected(f.manager.discardPreparedNewSession(f.stage));
		if (!(error instanceof ManagedPreparedFileRemovalError)) throw error;
		expect(error.phase).toBe("native_threw");
		expect(error.cause).toBe(failure);
		expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
		expect(tree).toHaveBeenCalledTimes(1);
		expect(removal.mock.calls.filter(([target]) => target === f.file)).toHaveLength(1);
		expect(await Bun.file(f.file).text()).toContain("prepared bytes");
	});

	it.skipIf(!darwin)("does not turn a bare cleanup_pending into certification", async () => {
		const f = await fixture();
		const error = new Error("cleanup_pending");
		const tree = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeTreeExpected").mockImplementation(() => {
			throw error;
		});
		const transcript = vi.spyOn(ManagedSessionDescendantStore.prototype, "removeExpectedForPreparedDiscard");
		expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
		expect(await rejected(f.manager.discardPreparedNewSession(f.stage))).toBe(error);
		expect(tree).toHaveBeenCalledTimes(1);
		expect(transcript).not.toHaveBeenCalled();
	});
});
