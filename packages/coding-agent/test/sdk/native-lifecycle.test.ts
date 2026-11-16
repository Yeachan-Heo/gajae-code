import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { attachExactMcpControls, getExactMcpControls } from "../../src/runtime-mcp/redaction";
import { type EmbeddedWorkSource, getEmbeddedOwnedWork } from "../../src/sdk/embedded-work";
import { ExtensionInteractionService } from "../../src/sdk/extension-interaction";
import { JobObservation } from "../../src/sdk/job-observation";
import {
	createNativeOpenCoordinator,
	createNativeReadonlyHandle,
	type NativeLifecycleDriver,
	type NativeLifecycleHandle,
	type NativeOpenCoordinator,
	type NativeReconcileMode,
	type NativeTerminationConsent,
	prepareNativeDisconnect,
	reconcileNativeHandle,
	recordNativeDisconnectConsent,
	terminateNativeHandle,
} from "../../src/sdk/native-lifecycle";
import type { CreateAgentSessionResult } from "../../src/sdk/session";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { resolveResumeCheckpoint } from "../../src/session/resume-cursor";
import {
	classifyResumeOperation,
	type DurabilityProof,
	type PendingResumeOp,
	type ResumeCapturedEntry,
	type ResumeClosureEvidence,
	type ResumeManifestEntry,
	type ResumeOperationEvidence,
	type ResumeRouting,
} from "../../src/session/resume-operation";
import { type FileEntry, type SessionEntry, SessionManager } from "../../src/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriter,
	type SessionStorageWriterOpenOptions,
	SessionStorageWriterRetryableCloseError,
} from "../../src/session/session-storage";
import { listPendingAsks, openPendingAsk } from "../../src/tools/pending-asks";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timestamp = "2026-11-16T00:00:00.000Z";
const identity = { dev: "1", ino: "42" };
function sha(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
function message(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: id, timestamp: 0 } };
}
function entry(value: SessionEntry, order: number, kind: ResumeManifestEntry["kind"]): ResumeManifestEntry {
	return { id: value.id, parentId: value.parentId, order, kind, payloadDigest: sha(JSON.stringify(value)) };
}

type Stage =
	| "complete"
	| "remaining_conflict"
	| "enrolled_only"
	| "partial_chain"
	| "dependents_absent"
	| "dependents_partial"
	| "not_committed"
	| "unknown";
interface Options {
	policy: "exclusive_native" | "cooperative_tui";
	stage: Stage;
	suffix: "none" | "held" | "unproven" | "published";
	complete: "success" | "partial" | "refused" | "failed";
	proof: boolean;
	closure: boolean;
	retirement: "apply" | "missing" | "wrong";
}

/** Real reducer + byte-range durability classifier, not a table of invented outcomes. */
function fixture(initial: Partial<Options> = {}, manager = SessionManager.inMemory("/native-lifecycle")) {
	const options: Options = {
		policy: "exclusive_native",
		stage: "complete",
		suffix: "none",
		complete: "partial",
		proof: true,
		closure: true,
		retirement: "apply",
		...initial,
	};
	const base = [message("a", null), message("b", null), message("c", null)];
	const planned: SessionEntry[] = [
		{
			type: "custom",
			id: "M",
			parentId: "a",
			timestamp,
			customType: "gjc.owner_enroll",
			data: {
				v: 1,
				bind: "header",
				member: "member",
				runtime: "sdk",
				pid: 42,
				processIncarnation: "inc",
				hostId: "host",
				epoch: "epoch",
			},
		},
	];
	for (let idx = 0; idx < 2; idx++)
		planned.push({
			type: "custom",
			id: `C${idx + 1}`,
			parentId: idx ? "C1" : "a",
			timestamp,
			customType: "gjc.resume_cursor",
			data: {
				v: 1,
				bind: "header",
				op: "op",
				idx,
				member: "member",
				reason: "explicit",
				supersedes: [idx ? "c" : "b"],
			},
		});
	planned.push(message("D1", "C2"), message("D2", "D1"));
	const manifest = planned.map((value, index) =>
		entry(value, index, index === 0 ? "enroll" : index < 3 ? "cursor" : "dependent"),
	);
	const policy = {
		kind: options.policy,
		memberKind: options.policy === "cooperative_tui" ? "tui" : "sdk",
		rev: 1,
		authorityKey: "authority",
		epoch: "epoch",
	};
	const op: PendingResumeOp = {
		op: "op",
		memberToken: "member-token",
		authorityKey: "authority",
		epoch: "epoch",
		policy,
		plan: { enroll: "M", selectionRequested: true, cursorIds: ["C1", "C2"], dependentIds: ["D1", "D2"], target: "a" },
		manifest,
		CB: "C2",
		g0: { fileEntriesIndex0: 3, entryRevision0: 3 },
		durabilityDebt: { ids: manifest.map(value => value.id), fileIdentity: identity, attempts: 1 },
	};
	const calls: Array<NativeReconcileMode | "capture" | "closure" | "retire"> = [];
	const retiredMembers = new Set<string>();
	function evidence(route: ResumeRouting, closure?: ResumeClosureEvidence): ResumeOperationEvidence {
		const count = {
			complete: 5,
			remaining_conflict: 5,
			enrolled_only: 1,
			partial_chain: 2,
			dependents_absent: 3,
			dependents_partial: 4,
			not_committed: 0,
			unknown: 5,
		}[options.stage];
		const own = planned.slice(0, count);
		const local = message("L", own.at(-1)?.id ?? "a");
		const files: FileEntry[] = [
			{ type: "session", id: "header", version: 3, cwd: "/native-lifecycle", timestamp },
			...base,
			...own,
		];
		if (options.suffix === "unproven" || options.suffix === "published") files.push(local);
		const bytes = new TextEncoder().encode(files.map(value => `${JSON.stringify(value)}\n`).join(""));
		const entries: ResumeCapturedEntry[] = [];
		let offset = 0;
		files.forEach((value, order) => {
			const line = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
			if (value.type !== "session")
				entries.push({
					id: value.id,
					parentId: value.parentId,
					payloadDigest: sha(JSON.stringify(value)),
					order,
					range: { id: value.id, idx: order, start: offset, end: offset + line.byteLength, hash: sha(line) },
				});
			offset += line.byteLength;
		});
		const ranges = entries
			.filter(
				value => own.some(item => item.id === value.id) || (options.suffix === "published" && value.id === "L"),
			)
			.map(value => value.range);
		const proof: DurabilityProof = {
			kind: "sync_ok",
			fileIdentity: identity,
			namespaceSynced: true,
			publicationId: "publication",
			snapshotDigest: sha(bytes),
			snapshotByteLength: bytes.byteLength,
			op: op.op,
			idxs: ranges.map(value => value.idx),
			syncSeq: 1,
			ranges,
		};
		const state = manager.getStrictCloseState().kind;
		const terminal = state !== "none_started";
		return {
			pending: op,
			capture:
				options.stage === "unknown"
					? { kind: "read_failed", error: "fixture read failure" }
					: {
							kind: "captured",
							bytes,
							fileIdentity: identity,
							snapshotDigest: sha(bytes),
							fresh: true,
							frozen: true,
							drained: true,
							entries,
							reducerView: resolveResumeCheckpoint(files, sha(bytes)),
						},
			proofs: options.proof ? [proof] : [],
			durabilityState: options.proof ? "proven" : "unproven",
			manager: terminal
				? { kind: "terminal", closeOutcome: state, residentAttempt: "discarded", closure }
				: { kind: "live", strictClosePending: false, residentAttempt: "discarded" },
			residentSuffix:
				options.suffix === "none"
					? []
					: [{ ...entry(local, manifest.length, "dependent"), residentKind: "retainedLocal" }],
			residentTip: options.suffix === "none" ? (own.at(-1)?.id ?? "a") : "L",
			preOpCommittedTail: "c",
			preOpEntries: base.map((value, index) => entry(value, index, "dependent")),
			remainingConflict: options.stage === "remaining_conflict" ? ["foreign-candidate"] : [],
			generation: { gFreeze: op.g0, gPublish: op.g0 },
			debt: {
				rewriteDebt: false,
				heldQueueIds: !terminal && options.suffix === "held" ? ["L"] : [],
				deferredPublicationIds: [],
			},
			readiness: { writer: terminal ? "unusable" : "usable", currentBinding: op, localContextCurrent: true },
			context: terminal ? "POST" : route.context === "runtime" ? "WARM" : "PRE",
			routing: route,
			publishedAfterThaw: [],
		};
	}
	const driver: NativeLifecycleDriver = {
		manager,
		async reconcile(_pending, mode, route) {
			calls.push(mode);
			if (mode === "complete") {
				if (options.complete === "failed") throw new Error("completion failed");
				if (options.complete === "success") {
					options.stage = "complete";
					options.suffix = options.suffix === "none" ? "none" : "published";
					options.proof = true;
				}
			}
			const result = classifyResumeOperation(evidence(route));
			return mode === "complete" && options.complete === "refused"
				? { ...result, refusal: "foreign_progress" }
				: result;
		},
		async captureAfterClose(_pending, route, closure) {
			calls.push("capture");
			return classifyResumeOperation(evidence(route, closure));
		},
		async getClosureEvidence(_pending, authorization) {
			calls.push("closure");
			if (!options.closure || manager.getStrictCloseState().kind !== "closed") return undefined;
			const captured = evidence(readRoute()).capture;
			if (captured.kind !== "captured") return undefined;
			return {
				authorization,
				finalCaptureDigest: captured.snapshotDigest,
				preCloseSnapshotByteLength: captured.bytes ? captured.bytes.byteLength : captured.byteEvidence.byteLength,
				writerClosed: true,
				drained: true,
				writesRejected: true,
				residentReleased: true,
				publishedByFinalDrain: [],
			};
		},
		async retire(pending, result, authorization) {
			calls.push("retire");
			if (options.retirement === "missing") return undefined;
			retiredMembers.add(pending.memberToken);
			const captured = evidence(result.receipt.routing).capture;
			if (captured.kind !== "captured") throw new Error("Cannot retire without capture");
			return {
				kind: "member_retired",
				registryIntentId: authorization.registryIntentId,
				memberToken: pending.memberToken,
				authorityKey: pending.authorityKey,
				epoch: pending.epoch,
				op: options.retirement === "wrong" ? "wrong-op" : pending.op,
				finalCaptureDigest: captured.snapshotDigest,
			};
		},
	};
	const coordinator = createNativeOpenCoordinator(driver);
	const close = spyOn(manager, "closeStrict");
	cleanups.push(async () => {
		close.mockRestore();
		await manager.closeStrict();
	});
	return {
		manager,
		driver,
		op,
		coordinator,
		handle: coordinator.handle,
		options,
		calls,
		close,
		retiredMembers,
		evidence,
	};
}

function readRoute(): ResumeRouting {
	return {
		contextFamily: "live",
		context: "owned_pre",
		closeOutcome: "none_started",
		invocation: "RECON",
		authorization: { tokenValid: true, terminationIntent: "none", intentValid: false },
		action: "RETAIN_LIVE",
		completionResult: "n/a",
		readiness: { prior: "fenced", current: "fenced" },
	};
}

/** Actual session, inventory, request addresses and job controls. No provider is invoked or credential installed. */
async function runtime(
	manager: SessionManager,
	native?: { coordinator: NativeOpenCoordinator; op: PendingResumeOp },
): Promise<EmbeddedWorkSource> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-lifecycle-"));
	const auth = await AuthStorage.create(path.join(directory, "isolated.db"));
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	const observation = new JobObservation(jobs, `native-lifecycle-${crypto.randomUUID()}`);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		initialState: { model, systemPrompt: ["local lifecycle fixture"], tools: [], messages: [] },
		convertToLlm,
		streamFn: () => {
			throw new Error("Provider traffic forbidden in lifecycle tests");
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		agentDir: directory,
		settings: Settings.isolated({ "compaction.enabled": false, "sessionMemory.mode": "off" }),
		modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
		discoveryMode: "off",
		workflowGatePublication: "local",
	});
	const service = new ExtensionInteractionService(session.sessionId);
	const connection = service.connect();
	// Only the actual runtime and actual observation are consulted by work controls.
	const result = { session, jobObservation: observation } as CreateAgentSessionResult;
	const source: EmbeddedWorkSource = {
		result,
		interaction: { service, connectionId: connection.connectionId, ownership: "owned" },
	};
	cleanups.push(async () => {
		try {
			if (native && session.getDisposeResourceState() === "not_started") {
				const preparation = await prepareNativeDisconnect(native.coordinator.handle, native.op);
				const inventory = preparation.inventory!;
				const consent = recordNativeDisconnectConsent(native.coordinator.handle, preparation, {
					stopAndJoin: true,
					discardUnpublished: { ids: preparation.heldIds },
					work: {
						inventory,
						targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
					},
				});
				await terminateNativeHandle(native.coordinator.handle, native.op, consent);
			} else if (!native) await session.dispose();
			if (session.getDisposeResourceState() === "not_started")
				throw new Error("Native fixture cleanup was not authorized");
			await session.awaitDisposeCompletion();
		} catch (error) {
			if (
				session.getDisposeResourceState() !== "settled" ||
				(!native && manager.getStrictCloseState().kind !== "closed")
			)
				throw error;
		} finally {
			service.dispose();
			observation.dispose();
			await jobs.dispose();
			auth.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	return source;
}

async function consentFor(f: { handle: NativeLifecycleHandle; op: PendingResumeOp }, ids: readonly string[] = []) {
	const preparation = await prepareNativeDisconnect(f.handle, f.op);
	const consent = recordNativeDisconnectConsent(f.handle, preparation, { discardUnpublished: { ids } });
	if (!consent) throw new Error("Missing actual consent receipt");
	return consent;
}

const stages: readonly Stage[] = [
	"complete",
	"remaining_conflict",
	"enrolled_only",
	"partial_chain",
	"dependents_absent",
	"dependents_partial",
	"not_committed",
	"unknown",
];

describe("native registry live dispatch A1-A7", () => {
	for (const stage of stages)
		for (const mode of ["verify", "verifyReadOnly", "repairDurability", "complete"] as const) {
			test(`RECON ${stage}/${mode} never closes or retires, same manager remains reusable`, async () => {
				const f = fixture({ stage });
				const consent = await consentFor(f);
				const before = f.close.mock.calls.length;
				const result = await reconcileNativeHandle(f.handle, f.op, mode);
				expect(result.receipt.routing).toMatchObject({
					invocation: "RECON",
					action: "RETAIN_LIVE",
					authorization: { terminationIntent: "none", intentValid: false },
				});
				expect(f.close.mock.calls.length).toBe(before);
				expect(f.calls).not.toContain("retire");
				expect(f.manager.getStrictCloseState().kind).toBe("none_started");
				expect((await reconcileNativeHandle(f.handle, f.op)).receipt.routing.action).toBe("RETAIN_LIVE");
				expect(consent).toBeDefined();
			});
		}

	for (const stage of stages)
		for (const variant of ["absent", "forged", "clone", "stale", "wrong_ids", "foreign"] as const) {
			test(`invalid TERM ${stage}/${variant} preserves readiness and all effects`, async () => {
				const f = fixture({ stage, suffix: variant === "wrong_ids" ? "held" : "none" });
				const prior = await reconcileNativeHandle(f.handle, f.op);
				let consent: NativeTerminationConsent | undefined;
				if (variant === "forged") consent = {} as NativeTerminationConsent;
				if (variant === "clone") consent = structuredClone(await consentFor(f)) as NativeTerminationConsent;
				if (variant === "stale") {
					consent = await consentFor(f);
					await prepareNativeDisconnect(f.handle, f.op);
				}
				if (variant === "wrong_ids") consent = await consentFor(f, ["not-current-L"]);
				if (variant === "foreign") consent = await consentFor(fixture());
				const result = await terminateNativeHandle(f.handle, f.op, consent);
				expect(result.refusal).toBe("termination_not_authorized");
				expect(result.receipt.routing.readiness.current).toBe(prior.receipt.routing.readiness.current);
				expect(f.close.mock.calls).toHaveLength(0);
				expect(f.calls).not.toContain("repairDurability");
				expect(f.calls).not.toContain("complete");
				expect(f.calls).not.toContain("retire");
				expect(f.manager.getStrictCloseState().kind).toBe("none_started");
			});
		}

	for (const stage of stages)
		test(`owned_pre valid TERM ${stage} closes by authorization, not classification`, async () => {
			const f = fixture({ stage });
			const result = await terminateNativeHandle(f.handle, f.op, await consentFor(f));
			expect(f.close.mock.calls).toHaveLength(1);
			expect(result.receipt.routing).toMatchObject({
				invocation: "TERM",
				action: "POST_READONLY",
				authorization: { terminationIntent: "consented_teardown", intentValid: true },
			});
			expect(f.calls).not.toContain("complete");
			if (stage === "unknown") expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
		});

	test("actual manager is claimed once, cloned handles cannot acquire authority", async () => {
		const f = fixture();
		expect(() => createNativeOpenCoordinator(f.driver)).toThrow("already registered");
		expect(() => reconcileNativeHandle(structuredClone(f.handle), f.op)).toThrow("Unknown native lifecycle handle");
	});

	for (const suffix of ["held", "unproven"] as const)
		for (const completion of ["success", "refused", "failed", "partial"] as const) {
			test(`OPEN ${suffix}/${completion} completes exactly once, never cleanup on failure`, async () => {
				const f = fixture({ suffix, complete: completion });
				const result = await f.coordinator.resumeOpen(f.op);
				expect(f.calls.filter(call => call === "complete")).toHaveLength(1);
				expect(result.receipt.routing.action).toBe(completion === "success" ? "PROCEED" : "RETAIN_LIVE");
				expect(f.close.mock.calls).toHaveLength(0);
				expect(f.calls).not.toContain("retire");
			});
		}

	test("held prefix beats prefix cleanup, plain proven prefix gets one completion then TERM", async () => {
		const held = fixture({ stage: "partial_chain", suffix: "held" });
		expect((await held.coordinator.resumeOpen(held.op)).receipt.routing.action).toBe("RETAIN_LIVE");
		expect(held.close.mock.calls).toHaveLength(0);
		const prefix = fixture({ stage: "partial_chain" });
		const result = await prefix.coordinator.resumeOpen(prefix.op);
		expect(prefix.calls.filter(call => call === "complete")).toHaveLength(1);
		expect(prefix.close.mock.calls).toHaveLength(1);
		expect(result.outcome.kind).toBe("partial_chain");
		expect(result.receipt.routing.authorization.terminationIntent).toBe("coordinator_abort");
		expect(result.receipt.terminalDisposition.kind).toBe("retired");
	});

	for (const stage of ["not_committed", "remaining_conflict"] as const) {
		test(`owned OPEN ${stage} performs actual authorized closure and retirement`, async () => {
			const f = fixture({ stage });
			const result = await f.coordinator.resumeOpen(f.op);
			expect(f.close.mock.calls).toHaveLength(1);
			expect(f.retiredMembers.has(f.op.memberToken)).toBe(true);
			expect(result.receipt.routing.action).toBe("POST_READONLY");
			expect(result.receipt.terminalDisposition.kind).toBe("retired");
		});
	}

	test("missing D retains OPEN; valid TERM attempts repair before real close and fresh F wins", async () => {
		const f = fixture({ proof: false });
		expect((await f.coordinator.resumeOpen(f.op)).receipt.routing.action).toBe("RETAIN_LIVE");
		const consent = await consentFor(f);
		const result = await terminateNativeHandle(f.handle, f.op, consent);
		expect(f.calls.indexOf("repairDurability")).toBeLessThan(f.calls.indexOf("capture"));
		expect(f.close.mock.calls).toHaveLength(1);
		expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
		expect(f.calls).not.toContain("retire");
	});

	test("missing closure evidence retains actual membership even after confirmed writer close", async () => {
		const f = fixture({ closure: false });
		const result = await terminateNativeHandle(f.handle, f.op, await consentFor(f));
		expect(f.manager.getStrictCloseState().kind).toBe("closed");
		expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
		expect(f.calls).not.toContain("retire");
	});

	test("fresh final classification replaces the complete pre-close result", async () => {
		const f = fixture();
		const captureClosure = f.driver.getClosureEvidence;
		f.driver.getClosureEvidence = async (op, authorization) => {
			f.options.stage = "dependents_absent";
			return captureClosure(op, authorization);
		};
		const result = await terminateNativeHandle(f.handle, f.op, await consentFor(f));
		expect(result.outcome.kind).toBe("dependents_absent");
		expect(result.receipt.commitment).toMatchObject({ selectionCommitted: true, operationComplete: false });
		expect(result.receipt.terminalDisposition.kind).toBe("retired");
	});

	for (const retirement of ["missing", "wrong"] as const)
		test(`retirement ${retirement} receipt is not permission applied`, async () => {
			const f = fixture({ retirement });
			const result = await terminateNativeHandle(f.handle, f.op, await consentFor(f));
			expect(f.calls.filter(call => call === "retire")).toHaveLength(1);
			expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
		});
});

class CloseStorage extends MemorySessionStorage {
	mode: "normal" | "retryable" | "unknown" = "normal";
	closeCalls = 0;
	override openWriter(file: string, options?: SessionStorageWriterOpenOptions): SessionStorageWriter {
		return super.openWriter(file, {
			...options,
			closeAdapter: {
				close: () => {
					this.closeCalls++;
					if (this.mode === "retryable") throw new SessionStorageWriterRetryableCloseError("before dispatch");
					if (this.mode === "unknown") throw new Error("dispatched close uncertain");
				},
			},
		});
	}
}
async function storageFixture(storage = new CloseStorage()) {
	const manager = SessionManager.create("/native-lifecycle", `/sessions-${crypto.randomUUID()}`, storage);
	manager.setSessionMemoryMode("off");
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: "real writer", timestamp: 1 });
	await manager.flush();
	return { ...fixture({}, manager), storage };
}

describe("terminal guard uses actual SessionManager/storage state", () => {
	for (const terminal of ["closed", "retryable", "unknown", "no_manager"] as const) {
		test(`terminal totality ${terminal}: invocation/auth/class product is readonly except one authorized retry`, async () => {
			const f = await storageFixture();
			const consent = await consentFor(f);
			f.storage.mode = terminal === "retryable" ? "retryable" : terminal === "unknown" ? "unknown" : "normal";
			await terminateNativeHandle(f.handle, f.op, consent);
			const handle =
				terminal === "no_manager"
					? createNativeReadonlyHandle({ captureAfterClose: f.driver.captureAfterClose })
					: f.handle;
			for (const stage of stages)
				for (const auth of [undefined, consent, {} as NativeTerminationConsent]) {
					f.options.stage = stage;
					for (const mode of ["verify", "verifyReadOnly", "repairDurability", "complete"] as const) {
						const before = f.close.mock.calls.length;
						const result = await reconcileNativeHandle(handle, f.op, mode);
						expect(result.receipt.routing.action).toBe("POST_READONLY");
						expect(result.refusal).toBe("manager_closed");
						expect(f.close.mock.calls.length).toBe(before);
					}
					if (terminal !== "no_manager")
						expect((await f.coordinator.resumeOpen(f.op)).refusal).toBe("manager_closed");
					const before = f.close.mock.calls.length;
					expect((await terminateNativeHandle(handle, f.op, auth)).receipt.routing.action).toBe("POST_READONLY");
					const retries = terminal === "retryable" && auth === consent ? 1 : 0;
					expect(f.close.mock.calls.length - before).toBe(retries);
				}
			f.storage.mode = "normal";
		});
	}

	test("in-flight joins existing completion and never calls a second close", async () => {
		const f = await storageFixture();
		const freeze = await f.manager.quiesceNonterminalPublication(Symbol("close-gate"));
		const closing = f.manager.closeStrict();
		expect(f.manager.getStrictCloseState().kind).toBe("in_flight");
		const joined = reconcileNativeHandle(f.handle, f.op, "complete");
		await freeze.thaw();
		await closing;
		const result = await joined;
		expect(f.close.mock.calls).toHaveLength(1);
		expect(result.refusal).toBe("manager_closed");
		expect(result.receipt.routing.action).toBe("POST_READONLY");
		expect(f.calls).not.toContain("complete");
		expect(f.calls).not.toContain("retire");
	});

	test("retryable close retries once only with the existing identity-bound intent", async () => {
		const f = await storageFixture();
		const consent = await consentFor(f);
		f.storage.mode = "retryable";
		const first = await terminateNativeHandle(f.handle, f.op, consent);
		expect(first.receipt.routing.closeOutcome).toBe("close_failed_retryable");
		const before = f.close.mock.calls.length;
		await reconcileNativeHandle(f.handle, f.op, "repairDurability");
		await f.coordinator.resumeOpen(f.op);
		await terminateNativeHandle(f.handle, f.op, {} as NativeTerminationConsent);
		expect(f.close.mock.calls.length).toBe(before);
		f.storage.mode = "normal";
		const retried = await terminateNativeHandle(f.handle, f.op, consent);
		expect(f.close.mock.calls.length).toBe(before + 1);
		expect(retried.receipt.routing.closeOutcome).toBe("closed");
		expect((await reconcileNativeHandle(f.handle, f.op, "complete")).refusal).toBe("manager_closed");
	});

	test("unknown close and no-manager are readonly for every invocation", async () => {
		const f = await storageFixture();
		const consent = await consentFor(f);
		f.storage.mode = "unknown";
		expect((await terminateNativeHandle(f.handle, f.op, consent)).receipt.routing.closeOutcome).toBe("close_unknown");
		const before = f.close.mock.calls.length;
		for (const mode of ["verify", "verifyReadOnly", "repairDurability", "complete"] as const)
			await reconcileNativeHandle(f.handle, f.op, mode);
		await terminateNativeHandle(f.handle, f.op, consent);
		await f.coordinator.resumeOpen(f.op);
		expect(f.close.mock.calls.length).toBe(before);
		expect(f.calls).not.toContain("retire");
		const readonly = createNativeReadonlyHandle({ captureAfterClose: f.driver.captureAfterClose });
		const result = await reconcileNativeHandle(readonly, f.op, "complete");
		expect(result.receipt.routing).toMatchObject({ action: "POST_READONLY", closeOutcome: "no_manager" });
		expect(result.refusal).toBe("manager_closed");
	});

	test("real FileSessionStorage manager closes irreversibly and closed handles cannot initialize or repair", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-file-close-"));
		const manager = SessionManager.create(directory, path.join(directory, "sessions"), new FileSessionStorage());
		manager.setSessionMemoryMode("off");
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "file-backed", timestamp: 1 });
		await manager.flush();
		const f = fixture({}, manager);
		cleanups.unshift(async () => {
			await fs.rm(directory, { recursive: true, force: true });
		});
		await terminateNativeHandle(f.handle, f.op, await consentFor(f));
		expect(manager.getStrictCloseState().kind).toBe("closed");
		await expect(manager.ensureOnDisk()).rejects.toThrow("closing");
		const repairCount = f.calls.filter(call => call === "repairDurability").length;
		expect((await reconcileNativeHandle(f.handle, f.op, "repairDurability")).refusal).toBe("manager_closed");
		expect(f.calls.filter(call => call === "repairDurability")).toHaveLength(repairCount);
	});
});

describe("native disposal admission uses registry authority, never caller options", () => {
	for (const context of ["owned_pre", "runtime"] as const)
		test(`${context}: raw and forged-option disposal has zero teardown effects`, async () => {
			const f = fixture();
			await f.coordinator.resumeOpen(f.op);
			const source = await runtime(f.manager, f);
			f.coordinator.recordRuntimeStarted(source);
			if (context === "runtime") f.coordinator.publishRuntime();
			const session = source.result.session;
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const mock = createMockModel({
				handler: async () => {
					entered.resolve();
					await released.promise;
					return { content: ["local retained run"] };
				},
			});
			session.agent.streamFn = mock.stream;
			const run = session.agent.prompt("local active run");
			await entered.promise;
			const draft = await session.submitUserMessage("retain queued draft", {
				deliverAs: "followUp",
				trackSubmission: true,
			});
			const queued = session.getQueuedMessageEntries();
			expect(queued).toHaveLength(1);
			const controller = new AbortController();
			const request = source.interaction!.service.request(
				{ kind: "input", title: "retain UI request" },
				{ signal: controller.signal },
			);
			const shutdowns: string[] = [];
			const ask = openPendingAsk(
				session.sessionId,
				{
					questionId: "retain-question",
					question: "Keep pending?",
					options: ["yes"],
					interaction: "selector",
					controls: [],
				},
				undefined,
				controller.signal,
				() => {
					shutdowns.push("shutdown");
				},
			);
			const pendingAsks = listPendingAsks(session.sessionId);
			const controls = {
				grantSource: "root-interactive-exact-config" as const,
				configPath: "/isolated/exact-mcp.json",
			};
			attachExactMcpControls(session, controls);
			const abort = spyOn(session, "abort");
			const agentAbort = spyOn(session.agent, "abort");
			const remove = spyOn(session.agent, "removeQueuedMessages");
			const cancel = spyOn(session, "cancelQueuedMessage");
			const retire = spyOn(session, "retireSessionAgentModelOverrides");
			try {
				for (const options of [
					undefined,
					{ strictCloseAttempts: 1 as const },
					{ strictCloseAttempts: 1 as const, sessionShutdownReason: "detached_idle" as const },
				])
					expect(() => session.dispose(options)).toThrow("Native disposal requires");
				expect(f.close.mock.calls).toHaveLength(0);
				expect(abort).not.toHaveBeenCalled();
				expect(agentAbort).not.toHaveBeenCalled();
				expect(remove).not.toHaveBeenCalled();
				expect(cancel).not.toHaveBeenCalled();
				expect(retire).not.toHaveBeenCalled();
				expect(session.getQueuedMessageEntries()).toEqual(queued);
				expect(session.getDisposeResourceState()).toBe("not_started");
				expect(getExactMcpControls(session)).toBe(controls);
				expect(listPendingAsks(session.sessionId)).toEqual(pendingAsks);
				expect(shutdowns).toEqual([]);
				expect(source.interaction!.service.snapshot().pending).toHaveLength(1);
				expect(() => session.agent.subscribeCanonicalEvents(() => undefined)).toThrow("already subscribed");
			} finally {
				abort.mockRestore();
				agentAbort.mockRestore();
				remove.mockRestore();
				cancel.mockRestore();
				retire.mockRestore();
				controller.abort();
				ask.close();
				await ask.promise;
				await request;
				session.cancelQueuedInputSubmission(draft.submissionId!);
				released.resolve();
				await run;
			}
		});

	test("RECON callbacks and invalid TERM never receive disposal authority", async () => {
		const f = fixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const session = source.result.session;
		const first = await prepareNativeDisconnect(f.handle, f.op);
		const stale = recordNativeDisconnectConsent(f.handle, first, {
			stopAndJoin: true,
			work: { inventory: first.inventory!, targets: [] },
		})!;
		await prepareNativeDisconnect(f.handle, f.op);
		const foreign = await consentFor(fixture());
		const actualReconcile = f.driver.reconcile.bind(f.driver);
		const probes: string[] = [];
		const reconcile = spyOn(f.driver, "reconcile").mockImplementation(async (op, mode, route) => {
			probes.push(route.invocation);
			expect(() => session.dispose({ strictCloseAttempts: 1 })).toThrow("Native disposal requires");
			return actualReconcile(op, mode, route);
		});
		const abort = spyOn(session.agent, "abort");
		try {
			for (const mode of ["verify", "verifyReadOnly", "repairDurability", "complete"] as const)
				await reconcileNativeHandle(f.handle, f.op, mode);
			for (const consent of [undefined, {} as NativeTerminationConsent, structuredClone(stale), stale, foreign])
				expect((await terminateNativeHandle(f.handle, f.op, consent)).refusal).toBe("termination_not_authorized");
			expect(probes.filter(invocation => invocation === "RECON")).toHaveLength(4);
			expect(abort).not.toHaveBeenCalled();
			expect(f.close.mock.calls).toHaveLength(0);
			expect(session.getDisposeResourceState()).toBe("not_started");
		} finally {
			reconcile.mockRestore();
			abort.mockRestore();
		}
	});

	test("authorized synchronous joins succeed; inherited, replayed and successor scopes cannot dispose", async () => {
		const f = fixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const successor = fixture();
		await successor.coordinator.resumeOpen(successor.op);
		const next = await runtime(successor.manager, successor);
		successor.coordinator.recordRuntimeStarted(next);
		successor.coordinator.publishRuntime();
		const session = source.result.session;
		const actualDispose = session.dispose.bind(session);
		let replay: (() => Promise<void>) | undefined;
		let inherited: Promise<string> | undefined;
		const dispose = spyOn(session, "dispose").mockImplementation(options => {
			const captured = AsyncLocalStorage.snapshot();
			replay = () => captured(() => actualDispose({ strictCloseAttempts: 1 }));
			expect(() => next.result.session.dispose({ strictCloseAttempts: 1 })).toThrow("Native disposal requires");
			const running = actualDispose(options);
			expect(actualDispose(options)).toBe(running);
			inherited = Promise.resolve().then(() => {
				expect(f.manager.getStrictCloseState().kind).toBe("none_started");
				expect(() => actualDispose({ strictCloseAttempts: 1 })).toThrow("Native disposal requires");
				return "revoked before close";
			});
			return running;
		});
		try {
			const preparation = await prepareNativeDisconnect(f.handle, f.op);
			const consent = recordNativeDisconnectConsent(f.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory!, targets: [] },
			})!;
			const result = await terminateNativeHandle(f.handle, f.op, consent);
			expect(await inherited).toBe("revoked before close");
			expect(result.receipt.routing.authorization).toMatchObject({
				terminationIntent: "consented_teardown",
				intentValid: true,
			});
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(dispose).toHaveBeenCalledWith({ strictCloseAttempts: 1 });
			expect(f.close.mock.calls).toHaveLength(1);
			expect(successor.close.mock.calls).toHaveLength(0);
			expect(replay).toBeDefined();
			expect(() => replay!()).toThrow("Native disposal requires");
			expect(() => actualDispose()).toThrow("Native disposal requires");
			expect(next.result.session.getDisposeResourceState()).toBe("not_started");
		} finally {
			dispose.mockRestore();
		}
	});

	for (const mode of ["retryable", "unknown"] as const)
		test(`${mode}: terminal raw disposal cannot join or retry even with forged bounds`, async () => {
			const f = await storageFixture();
			await f.coordinator.resumeOpen(f.op);
			const source = await runtime(f.manager, f);
			f.coordinator.recordRuntimeStarted(source);
			f.coordinator.publishRuntime();
			const preparation = await prepareNativeDisconnect(f.handle, f.op);
			const consent = recordNativeDisconnectConsent(f.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory!, targets: [] },
			})!;
			f.storage.mode = mode;
			await terminateNativeHandle(f.handle, f.op, consent);
			expect(source.result.session.getDisposeResourceState()).toBe("settled");
			expect(f.manager.getStrictCloseState().kind).toBe(
				mode === "retryable" ? "close_failed_retryable" : "close_unknown",
			);
			const attempts = f.close.mock.calls.length;
			const abort = spyOn(source.result.session.agent, "abort");
			try {
				expect(() => source.result.session.dispose({ strictCloseAttempts: 1 })).toThrow("Native disposal requires");
				await reconcileNativeHandle(f.handle, f.op, "complete");
				expect(abort).not.toHaveBeenCalled();
				expect(f.close.mock.calls).toHaveLength(attempts);
			} finally {
				abort.mockRestore();
				f.storage.mode = "normal";
			}
		});

	test("the actual default ordinary session retains unregistered disposal behavior", async () => {
		const manager = SessionManager.inMemory("/ordinary-disposal");
		const source = await runtime(manager);
		const abort = spyOn(source.result.session.agent, "abort");
		const close = spyOn(manager, "closeStrict");
		try {
			const first = source.result.session.dispose();
			expect(source.result.session.dispose()).toBe(first);
			await first;
			await source.result.session.awaitDisposeCompletion();
			expect(manager.getStrictCloseState().kind).toBe("closed");
			expect(source.result.session.getDisposeResourceState()).toBe("settled");
			expect(abort.mock.calls.length).toBeGreaterThan(0);
			expect(close).toHaveBeenCalledTimes(1);
			await source.result.session.dispose();
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			abort.mockRestore();
			close.mockRestore();
		}
	});
});

describe("actual runtime ownership boundary and exact work consent", () => {
	for (const policy of ["exclusive_native", "cooperative_tui"] as const)
		test(`${policy}: global conflicts deny Continue without fencing the recovered writer`, async () => {
			const f = fixture({ policy });
			await f.coordinator.resumeOpen(f.op);
			const source = await runtime(f.manager, f);
			f.coordinator.recordRuntimeStarted(source);
			f.coordinator.publishRuntime();
			f.options.stage = "remaining_conflict";
			const result = await reconcileNativeHandle(f.handle, f.op, "complete");
			expect(result.outcome.kind).toBe("committed_with_remaining_conflict");
			expect(result.receipt.routing.readiness.current).toBe("ready");
			expect(result.receipt.commitment.continueEligible).toBe(false);
			expect((await terminateNativeHandle(f.handle, f.op)).receipt.routing.readiness.current).toBe("ready");
			expect((await f.coordinator.resumeOpen(f.op)).receipt.routing.readiness.current).toBe("ready");
			expect(f.close.mock.calls).toHaveLength(0);
			expect(f.calls).not.toContain("retire");
		});

	test("valid consent discards only current held ids and reports their final loss truthfully", async () => {
		const f = fixture({ suffix: "held" });
		const result = await terminateNativeHandle(f.handle, f.op, await consentFor(f, ["L"]));
		expect(f.close.mock.calls).toHaveLength(1);
		expect(result.outcome.kind).toBe("suffix_incomplete");
		expect(result.receipt.commitment).toMatchObject({
			selectionCommitted: true,
			operationComplete: false,
			suffixState: "lost",
			lostResidentIds: ["L"],
		});
		expect(result.receipt.terminalDisposition.kind).toBe("retired");
	});

	test("TERM removes named SDK input before exact active-run abort and waits for the actual run", async () => {
		const f = fixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async (_context, options) => {
				entered.resolve();
				const stop = () => released.resolve();
				if (options?.signal?.aborted) stop();
				else options?.signal?.addEventListener("abort", stop, { once: true });
				try {
					await released.promise;
					return { content: ["local stopped"] };
				} finally {
					options?.signal?.removeEventListener("abort", stop);
				}
			},
		});
		source.result.session.agent.streamFn = mock.stream;
		const run = source.result.session.agent.prompt("local run only");
		await entered.promise;
		const draft = await source.result.session.submitUserMessage("exact queued draft", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const preparation = await prepareNativeDisconnect(f.handle, f.op);
		const inventory = preparation.inventory!;
		const actualAbort = source.result.session.abortPromptAndWait.bind(source.result.session);
		const abort = spyOn(source.result.session, "abortPromptAndWait").mockImplementation(async (id, options) => {
			expect<unknown>(id).toBe(inventory.activeRunId);
			expect(source.result.session.getQueuedMessageEntries()).toHaveLength(0);
			return actualAbort(id, options);
		});
		try {
			const consent = recordNativeDisconnectConsent(f.handle, preparation, {
				stopAndJoin: true,
				work: {
					inventory,
					targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
					timeoutMs: 1_000,
				},
			})!;
			const result = await terminateNativeHandle(f.handle, f.op, consent);
			await run;
			expect((await draft.terminal!).disposition).toBe("removed");
			expect(abort).toHaveBeenCalledTimes(1);
			expect(result.receipt.routing.closeOutcome).toBe("closed");
		} finally {
			abort.mockRestore();
			released.resolve();
			await run;
		}
	});

	test("runtime disposal makes one close attempt, settled resources allow only a later authorized retry", async () => {
		const f = await storageFixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const preparation = await prepareNativeDisconnect(f.handle, f.op);
		const inventory = preparation.inventory!;
		const consent = recordNativeDisconnectConsent(f.handle, preparation, {
			stopAndJoin: true,
			work: { inventory, targets: [] },
		})!;
		f.storage.mode = "retryable";
		const first = await terminateNativeHandle(f.handle, f.op, consent);
		expect(first.receipt.routing.closeOutcome).toBe("close_failed_retryable");
		expect(source.result.session.getDisposeResourceState()).toBe("settled");
		expect(f.close.mock.calls).toHaveLength(1);
		expect(f.calls).not.toContain("retire");
		await reconcileNativeHandle(f.handle, f.op, "complete");
		expect(f.close.mock.calls).toHaveLength(1);
		f.storage.mode = "normal";
		const second = await terminateNativeHandle(f.handle, f.op, consent);
		expect(f.close.mock.calls).toHaveLength(2);
		expect(second.receipt.terminalDisposition.kind).toBe("retired");
	});

	for (const failure of ["startupFailed", "superseded", "abortOpen"] as const)
		test(`${failure} stays owned_pre through born-but-failed runtime and joins actual disposal`, async () => {
			const f = fixture();
			expect((await f.coordinator.resumeOpen(f.op)).receipt.routing.action).toBe("PROCEED");
			const source = await runtime(f.manager, f);
			f.coordinator.recordRuntimeStarted(source);
			const dispose = spyOn(source.result.session, "dispose");
			const join = spyOn(source.result.session, "awaitDisposeCompletion");
			try {
				const result = await f.coordinator[failure](f.op);
				expect(result.receipt.routing.authorization.terminationIntent).toBe("coordinator_abort");
				expect(f.close.mock.calls).toHaveLength(1);
				expect(dispose).toHaveBeenCalledTimes(1);
				expect(dispose).toHaveBeenCalledWith({ strictCloseAttempts: 1 });
				expect(join).toHaveBeenCalledTimes(1);
				expect(f.manager.getStrictCloseState().kind).toBe("closed");
			} finally {
				dispose.mockRestore();
				join.mockRestore();
			}
		});

	for (const stage of stages)
		for (const mode of ["verify", "verifyReadOnly", "repairDurability", "complete"] as const)
			test(`published runtime ${stage}/${mode}: RECON retains, invalid TERM/OPEN preserve readiness`, async () => {
				const f = fixture();
				await f.coordinator.resumeOpen(f.op);
				const source = await runtime(f.manager, f);
				f.coordinator.recordRuntimeStarted(source);
				f.coordinator.publishRuntime();
				f.options.stage = stage;
				const dispose = spyOn(source.result.session, "dispose");
				try {
					const result = await reconcileNativeHandle(f.handle, f.op, mode);
					const readiness = result.receipt.routing.readiness.current;
					expect(result.receipt.routing).toMatchObject({
						context: "runtime",
						invocation: "RECON",
						action: "RETAIN_LIVE",
					});
					expect((await terminateNativeHandle(f.handle, f.op)).receipt.routing.readiness.current).toBe(readiness);
					const denied = await f.coordinator.resumeOpen(f.op);
					expect(denied.refusal).toBe("context_mismatch");
					expect(denied.receipt.routing.readiness.current).toBe(readiness);
					expect((await f.coordinator.startupFailed(f.op)).refusal).toBe("context_mismatch");
					expect(dispose).not.toHaveBeenCalled();
					expect(f.close.mock.calls).toHaveLength(0);
					expect(f.calls).not.toContain("retire");
				} finally {
					dispose.mockRestore();
				}
			});

	for (const stage of stages)
		test(`published runtime valid TERM ${stage} stops and joins only under exact consent`, async () => {
			const f = fixture();
			await f.coordinator.resumeOpen(f.op);
			const source = await runtime(f.manager, f);
			f.coordinator.recordRuntimeStarted(source);
			f.coordinator.publishRuntime();
			f.options.stage = stage;
			const preparation = await prepareNativeDisconnect(f.handle, f.op);
			const inventory = preparation.inventory!;
			const consent = recordNativeDisconnectConsent(f.handle, preparation, {
				stopAndJoin: true,
				work: { inventory, targets: [] },
			})!;
			const dispose = spyOn(source.result.session, "dispose");
			try {
				const result = await terminateNativeHandle(f.handle, f.op, consent);
				expect(dispose).toHaveBeenCalledWith({ strictCloseAttempts: 1 });
				expect(f.close.mock.calls).toHaveLength(1);
				expect(result.receipt.routing.action).toBe("POST_READONLY");
				expect(source.result.session.getDisposeResourceState()).toBe("settled");
			} finally {
				dispose.mockRestore();
			}
		});

	test("warm TERM validates every current request address before disposing and only named cancellation", async () => {
		const f = fixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const service = source.interaction!.service;
		const request = service.request({ kind: "input", title: "exact local request" });
		const preparation = await prepareNativeDisconnect(f.handle, f.op);
		const inventory = preparation.inventory!;
		const targets = inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : []));
		const insufficient = recordNativeDisconnectConsent(f.handle, preparation, {
			stopAndJoin: true,
			work: { inventory, targets: [] },
		})!;
		expect((await terminateNativeHandle(f.handle, f.op, insufficient)).refusal).toBe("termination_not_authorized");
		expect(service.snapshot().pending).toHaveLength(1);
		expect(f.close.mock.calls).toHaveLength(0);
		const consent = recordNativeDisconnectConsent(f.handle, preparation, {
			stopAndJoin: true,
			work: { inventory, targets },
		})!;
		const result = await terminateNativeHandle(f.handle, f.op, consent);
		expect(await request).toEqual({ status: "cancelled", reason: "user" });
		expect(result.receipt.routing.authorization.terminationIntent).toBe("consented_teardown");
		expect(f.manager.getStrictCloseState().kind).toBe("closed");
	});

	test("stale UI address refuses the whole TERM with no dispose or request cancellation", async () => {
		const f = fixture();
		await f.coordinator.resumeOpen(f.op);
		const source = await runtime(f.manager, f);
		f.coordinator.recordRuntimeStarted(source);
		f.coordinator.publishRuntime();
		const service = source.interaction!.service;
		const controller = new AbortController();
		const request = service.request({ kind: "input", title: "keep pending" }, { signal: controller.signal });
		const preparation = await prepareNativeDisconnect(f.handle, f.op);
		const inventory = preparation.inventory!;
		const consent = recordNativeDisconnectConsent(f.handle, preparation, {
			stopAndJoin: true,
			work: { inventory, targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])) },
		})!;
		service.connect();
		const dispose = spyOn(source.result.session, "dispose");
		try {
			expect((await terminateNativeHandle(f.handle, f.op, consent)).refusal).toBe("termination_not_authorized");
			expect(dispose).not.toHaveBeenCalled();
			expect(f.close.mock.calls).toHaveLength(0);
			expect(getEmbeddedOwnedWork(source).pendingRequests.status).toBe("available");
			expect(service.snapshot().pending).toHaveLength(1);
		} finally {
			dispose.mockRestore();
			controller.abort();
			await request;
		}
	});
});
