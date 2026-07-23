import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CoordinatorSessionTransactionV1,
	CoordinatorStatePaths,
	NamespaceDeletionEntryV1,
	OperationRequestV1,
} from "../../src/coordinator-mcp/question-state";
import {
	advanceDeletion,
	coordinatorStatePaths,
	initializeCoordinatorNamespace,
	recordDeletionIntent,
	recoverIncompleteDeletions,
	transactionPath,
} from "../../src/coordinator-mcp/question-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function randomId(): string {
	return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mkTemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-recovery-test-"));
	tempDirs.push(dir);
	return dir;
}

/** Create a temp namespace and return its paths + namespaceId. */
async function createTempNamespace(): Promise<{ paths: CoordinatorStatePaths; namespaceId: string }> {
	const root = mkTemp();
	const namespaceId = `testns-${Math.random().toString(36).slice(2, 8)}`;
	const paths = coordinatorStatePaths(root, namespaceId);
	await initializeCoordinatorNamespace(paths);
	return { paths, namespaceId };
}

/** Build a minimal transaction file with optional stuck stop/reap ops. */
function makeTransaction(
	sessionId: string,
	namespaceId: string,
	incarnation: string,
	opts?: { ops?: { kind: "stop" | "reap"; phase?: "remote_started" }[] },
): CoordinatorSessionTransactionV1 {
	const now = new Date().toISOString();
	const ops: Record<string, OperationRequestV1> = {};
	if (opts?.ops) {
		for (let i = 0; i < opts.ops.length; i++) {
			const op = opts.ops[i];
			ops[`op-${i}`] = {
				operation_id: `op-${i}`,
				tool: op.kind,
				key_digest: `${op.kind}-${sessionId}-${i}`,
				request_digest: `${op.kind}-req-${sessionId}-${i}`,
				local_id: `local-${i}`,
				phase: op.phase ?? "remote_started",
				intent: { kind: op.kind },
				created_at: now,
				updated_at: now,
			};
		}
	}
	return {
		schema_version: 1,
		namespace_id: namespaceId,
		session_id: sessionId,
		revision: 1,
		endpoint: { incarnation, observed_at: now },
		canonical: {
			session: {
				schema_version: 1,
				namespace_id: namespaceId,
				session_id: sessionId,
				cwd: "/tmp",
				created_at: now,
				updated_at: now,
				mpreset: null,
				source: null,
				model: null,
				tmux: { session: null, window: null, pane: null },
				broker: {
					workspace: null,
					endpoint_url: "ws://test",
					endpoint_generation: 1,
					endpoint_incarnation: incarnation,
				},
				ephemeral: true,
				visible: false,
			},
			turns: {},
			queue: { ordered_turn_ids: [], active_turn_id: null, selected_promotion: null },
			desired_session_state: "completed",
			reports: {},
			gate_authorities: {},
			questions: {},
		},
		requests: { prompts: {}, answers: {}, operations: ops },
		outbox: {},
		projection: {
			applied_turns_revision: 0,
			applied_reports_revision: 0,
			applied_session_revision: 0,
			applied_active_revision: 0,
			applied_events_revision: 0,
		},
		recovery: { prompt_watermark_at: null, last_repaired_at: null },
	};
}

/** Write a transaction file to disk at the expected path. */
function writeTransactionFile(paths: CoordinatorStatePaths, transaction: CoordinatorSessionTransactionV1): string {
	const txPath = transactionPath(paths, transaction.session_id);
	fs.mkdirSync(path.dirname(txPath), { recursive: true });
	fs.writeFileSync(txPath, JSON.stringify(transaction));
	return txPath;
}

/** Read the registry JSON directly (bypassing locks). */
function readRegistry(paths: CoordinatorStatePaths): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(paths.registry, "utf8"));
	} catch {
		return null;
	}
}

/** Find a deletion entry by session_id in the raw registry JSON. */
function findDeletionEntry(paths: CoordinatorStatePaths, sessionId: string): Record<string, unknown> | undefined {
	const reg = readRegistry(paths);
	if (!reg) return undefined;
	const deletions = reg.deletions as Record<string, Record<string, unknown>>;
	return Object.values(deletions).find(d => d.session_id === sessionId);
}

/** Check if a transaction file exists on disk. */
function txExists(paths: CoordinatorStatePaths, sessionId: string): boolean {
	return fs.existsSync(transactionPath(paths, sessionId));
}

/** Build a minimal NamespaceDeletionEntryV1 for testing. */
function deletionEntry(
	sessionId: string,
	incarnation: string,
	phase: NamespaceDeletionEntryV1["phase"],
): NamespaceDeletionEntryV1 {
	const now = new Date().toISOString();
	const delId = `del-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	return {
		deletion_id: delId,
		session_id: sessionId,
		endpoint_incarnation: incarnation,
		operation_id: `stop-${sessionId}`,
		key_digest: `key-${sessionId}`,
		request_digest: `req-${sessionId}`,
		close_key: `close-${sessionId}`,
		phase,
		cleanup: { wal: false, turns: false, reports: false, session: false, events: false },
		authority_digest: "test-auth",
		created_at: now,
		updated_at: now,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoverIncompleteDeletions", () => {
	test("Scenario 1: Registry entry at intent phase with matching stuck tx", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc1";

		// Write tx with stuck reap op
		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "reap", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		// Record deletion entry at intent
		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "intent"));

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 1, orphaned: 0, errors: 0 });

		// Tx file deleted
		expect(txExists(paths, sessionId)).toBe(false);

		// Entry advanced to completed
		const entry = findDeletionEntry(paths, sessionId);
		expect(entry).toBeDefined();
		expect(entry!.phase).toBe("completed");
		expect((entry!.cleanup as Record<string, boolean>).wal).toBe(true);
	});

	test("Scenario 2: Registry entry at broker_closed phase, no tx file", async () => {
		const { paths } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc2";

		// Deletion entry at broker_closed, no tx file
		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "broker_closed"));

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 1, orphaned: 0, errors: 0 });

		// Entry advanced to completed
		const entry = findDeletionEntry(paths, sessionId);
		expect(entry).toBeDefined();
		expect(entry!.phase).toBe("completed");
	});

	test("Scenario 3: Registry entry at cleanup_pending with matching stuck tx", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc3";

		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "cleanup_pending"));

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 1, orphaned: 0, errors: 0 });

		expect(txExists(paths, sessionId)).toBe(false);

		const entry = findDeletionEntry(paths, sessionId);
		expect(entry!.phase).toBe("completed");
	});

	test("Scenario 4: Registry entry at completed phase with matching stuck tx", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc4";

		// Entry at completed
		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "intent"));
		await advanceDeletion(
			paths,
			(findDeletionEntry(paths, sessionId) as Record<string, unknown>).deletion_id as string,
			"completed",
		);

		// Tx with stuck ops exists
		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		const result = await recoverIncompleteDeletions(paths);

		// The tx's identity pair exists in registry at "completed".
		// Implementation: Pass 1 scans tx with stuck ops, finds no non-completed entry → orphaned.
		expect(result).toEqual({ recovered: 0, orphaned: 1, errors: 0 });

		// Tx deleted
		expect(txExists(paths, sessionId)).toBe(false);

		// Entry still at completed
		const entry = findDeletionEntry(paths, sessionId);
		expect(entry!.phase).toBe("completed");
	});

	test("Scenario 5: Registry entry at uncertain phase with matching stuck tx", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc5";

		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "reap", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "uncertain"));

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 1, orphaned: 0, errors: 0 });

		expect(txExists(paths, sessionId)).toBe(false);

		const entry = findDeletionEntry(paths, sessionId);
		expect(entry!.phase).toBe("completed");
	});

	test("Scenario 6: Orphaned tx — stuck ops, no registry entry", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc6";

		// Tx with stuck reap, no registry entry for this session
		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "reap", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 0, orphaned: 1, errors: 0 });

		// Orphaned tx deleted
		expect(txExists(paths, sessionId)).toBe(false);
	});

	test("Scenario 7: Orphaned tx — no stuck ops, no registry entry", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc7";

		// Tx with no stop/reap ops
		const tx = makeTransaction(sessionId, namespaceId, inc);
		writeTransactionFile(paths, tx);

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 0, orphaned: 0, errors: 0 });

		// Tx NOT deleted
		expect(txExists(paths, sessionId)).toBe(true);
	});

	test("Scenario 8: Stale incarnation — entry for incA, tx for incB", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const incA = "inc8a";
		const incB = "inc8b";

		// Entry for (sessionD, incA) at intent
		await recordDeletionIntent(paths, deletionEntry(sessionId, incA, "intent"));

		// Tx for same session but incB with stuck ops
		const tx = makeTransaction(sessionId, namespaceId, incB, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		const result = await recoverIncompleteDeletions(paths);
		// recovered=1 (entry advanced), orphaned=1 (tx orphaned — no entry for incB)
		expect(result).toEqual({ recovered: 1, orphaned: 1, errors: 0 });

		// Tx deleted
		expect(txExists(paths, sessionId)).toBe(false);

		// Entry advanced to completed
		const entry = findDeletionEntry(paths, sessionId);
		expect(entry).toBeDefined();
		expect(entry!.phase).toBe("completed");
	});

	test("Scenario 9: Empty sessions directory", async () => {
		const { paths } = await createTempNamespace();

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 0, orphaned: 0, errors: 0 });
	});

	test("Scenario 10: No registry (fresh namespace)", async () => {
		const root = mkTemp();
		const namespaceId = `fresh-${Math.random().toString(36).slice(2, 6)}`;
		const paths = coordinatorStatePaths(root, namespaceId);
		// Initialize but don't create registry — actually initializeCoordinatorNamespace creates it.
		// For "no registry" we need a namespace where the registry file truly doesn't exist.
		// Skip initializeCoordinatorNamespace; the sessions dir doesn't exist either.
		fs.mkdirSync(path.join(root, "v1", namespaceId, "sessions"), { recursive: true });

		const result = await recoverIncompleteDeletions(paths);
		expect(result).toEqual({ recovered: 0, orphaned: 0, errors: 0 });
	});

	test("Scenario 11: Corrupt transaction file", async () => {
		const { paths } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc11";

		// Write invalid JSON to tx path
		const txPath = transactionPath(paths, sessionId);
		fs.mkdirSync(path.dirname(txPath), { recursive: true });
		fs.writeFileSync(txPath, "not-valid-json{{{");

		// Add entry at intent
		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "intent"));

		const result = await recoverIncompleteDeletions(paths);

		// Implementation: pass 1 tries readJson on corrupt file → caught → errors++
		// Pass 2 tries readJson on corrupt file → caught → errors++ (but entry not advanced)
		// The entry stays at 'intent' — the function never re-throws
		expect(result.errors).toBe(2);
		expect(result.recovered).toBe(0);
		expect(result.orphaned).toBe(0);

		// Entry NOT advanced (implementation skips advance on read error)
		const entry = findDeletionEntry(paths, sessionId);
		expect(entry!.phase).toBe("intent");

		// Corrupt file still exists
		expect(txExists(paths, sessionId)).toBe(true);
	});

	test("Scenario 12: Multiple entries in different phases", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionA = randomId();
		const sessionB = randomId();
		const sessionC = randomId();
		const inc = "inc12";

		// Entry at intent + matching tx with stuck ops
		await recordDeletionIntent(paths, deletionEntry(sessionA, inc, "intent"));
		const txA = makeTransaction(sessionA, namespaceId, inc, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, txA);

		// Entry at broker_closed + matching tx with stuck ops
		await recordDeletionIntent(paths, deletionEntry(sessionB, inc, "broker_closed"));
		const txB = makeTransaction(sessionB, namespaceId, inc, {
			ops: [{ kind: "reap", phase: "remote_started" }],
		});
		writeTransactionFile(paths, txB);

		// Entry at completed + matching tx with stuck ops
		await recordDeletionIntent(paths, deletionEntry(sessionC, inc, "intent"));
		await advanceDeletion(
			paths,
			(findDeletionEntry(paths, sessionC) as Record<string, unknown>).deletion_id as string,
			"completed",
		);
		const txC = makeTransaction(sessionC, namespaceId, inc, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, txC);

		const result = await recoverIncompleteDeletions(paths);

		// intent + broker_closed recovered = 2
		// completed entry's tx treated as orphaned (no non-completed entry match)
		expect(result).toEqual({ recovered: 2, orphaned: 1, errors: 0 });

		// Session A and B tx files deleted
		expect(txExists(paths, sessionA)).toBe(false);
		expect(txExists(paths, sessionB)).toBe(false);
		// Session C tx also deleted (orphaned cleanup)
		expect(txExists(paths, sessionC)).toBe(false);

		// Session A and B entries advanced to completed
		expect((findDeletionEntry(paths, sessionA) as Record<string, unknown>).phase).toBe("completed");
		expect((findDeletionEntry(paths, sessionB) as Record<string, unknown>).phase).toBe("completed");
		// Session C entry stays at completed
		expect((findDeletionEntry(paths, sessionC) as Record<string, unknown>).phase).toBe("completed");
	});

	test("Scenario 13: Idempotency — second run does nothing", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionId = randomId();
		const inc = "inc13";

		const tx = makeTransaction(sessionId, namespaceId, inc, {
			ops: [{ kind: "reap", phase: "remote_started" }],
		});
		writeTransactionFile(paths, tx);

		await recordDeletionIntent(paths, deletionEntry(sessionId, inc, "intent"));

		// First run
		const first = await recoverIncompleteDeletions(paths);
		expect(first).toEqual({ recovered: 1, orphaned: 0, errors: 0 });

		// Second run — everything already completed/cleaned
		const second = await recoverIncompleteDeletions(paths);
		expect(second).toEqual({ recovered: 0, orphaned: 0, errors: 0 });
	});

	test("Scenario 14: Per-entry error isolation", async () => {
		const { paths, namespaceId } = await createTempNamespace();
		const sessionA = randomId();
		const sessionB = randomId();
		const inc = "inc14";

		// First entry: make tx path unreadable by writing a directory at the tx path,
		// then add entry at intent.
		const txPathA = transactionPath(paths, sessionA);
		fs.mkdirSync(path.dirname(txPathA), { recursive: true });
		// Create a directory where the tx file should be — causes readJson to fail
		fs.mkdirSync(txPathA, { recursive: true });

		await recordDeletionIntent(paths, deletionEntry(sessionA, inc, "intent"));

		// Second entry: normal tx with stuck ops
		const txB = makeTransaction(sessionB, namespaceId, inc, {
			ops: [{ kind: "stop", phase: "remote_started" }],
		});
		writeTransactionFile(paths, txB);
		await recordDeletionIntent(paths, deletionEntry(sessionB, inc, "intent"));

		const result = await recoverIncompleteDeletions(paths);

		// The first entry's read fails (errors++ in both passes)
		// The second entry recovers normally
		expect(result.recovered).toBe(1);
		expect(result.errors).toBeGreaterThanOrEqual(1);

		// Second entry's tx deleted and advanced to completed
		expect(txExists(paths, sessionB)).toBe(false);
		const entryB = findDeletionEntry(paths, sessionB);
		expect(entryB).toBeDefined();
		expect(entryB!.phase).toBe("completed");
	});
});
