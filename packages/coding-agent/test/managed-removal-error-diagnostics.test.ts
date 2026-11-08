import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NativeDirectoryTreeSnapshot } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import {
	classifyManagedTreePayloadRetirement,
	type ManagedFileSnapshot,
	ManagedPreparedFileRemovalError,
	ManagedTreeRemovalError,
	type ManagedTreeRemovalOutcome,
} from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")(
	"logs only bounded diagnostics, never tree graphs or secret transcript bytes",
	async () => {
		const root = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-prepared-diagnostics-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { mode: 0o700 });
		const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
		managers.push(manager);
		const stage = await manager.prepareNewSession();
		const secret = "PRIVATE_TRANSCRIPT_DO_NOT_LOG".repeat(1000);
		manager.appendPreparedCustomMessageEntry(stage, "secret", secret, true);
		await manager.ensurePreparedNewSessionOnDisk(stage);
		if (!stage.artifactsDir) throw new Error("missing prepared artifacts");
		fs.mkdirSync(stage.artifactsDir, { recursive: true, mode: 0o700 });
		for (let index = 0; index < 128; index++)
			await Bun.write(path.join(stage.artifactsDir, `private-tree-entry-${index}`), secret, { mode: 0o600 });
		const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// closeStrict drives the actual manager retry/report callsite.
		await manager.closeStrict();
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
	},
);

const secret = "TRANSCRIPT_PRIVATE_CONTENT";
const snapshot: ManagedFileSnapshot = {
	bytes: Buffer.from(secret.repeat(10_000)),
	identity: {
		dev: 1n,
		ino: 2n,
		nlink: 1n,
		size: Buffer.byteLength(secret) * 10_000,
		mtimeNs: 3n,
		ctimeNs: 4n,
		sha256: "private-digest",
	},
};
const tree: NativeDirectoryTreeSnapshot = {
	rootDev: "1",
	rootIno: "2",
	entries: Array.from({ length: 10_000 }, (_, index) => ({
		relativePath: `private-tree-entry-${index}`,
		kind: "file",
		dev: "1",
		ino: String(index + 3),
		nlink: "1",
		size: "123",
		mtimeNs: "4",
		ctimeNs: "5",
	})),
};

function logged(error: Error): string {
	// The logger serializes metadata via JSON.stringify(entry).
	return JSON.stringify({ level: "error", message: "cleanup failed", metadata: { error } });
}

function expectBounded(error: Error, phase: string, code: string, targetName: string): void {
	const serialized = logged(error);
	expect(serialized.length).toBeLessThan(2_048);
	const diagnostic = JSON.parse(serialized).metadata.error;
	expect(diagnostic).toEqual({ name: error.name, message: error.message, phase, code, targetName });
	for (const forbidden of [
		"expected",
		"outcome",
		"bytes",
		"entries",
		"cause",
		"stack",
		"authorityCheckFailure",
		secret,
		"private-tree-entry",
		"private-digest",
		"private-parent",
	]) {
		expect(serialized).not.toContain(forbidden);
	}
}

describe("managed removal error JSON diagnostics", () => {
	test("prepared transcript evidence remains accessible without entering metadata", () => {
		const cause = new Error(secret);
		const outcome: ManagedTreeRemovalOutcome = { route: "exact", result: { ok: false, code: "identity_mismatch" } };
		const error = new ManagedPreparedFileRemovalError(
			path.join("private-parent", "stage.jsonl"),
			snapshot,
			"private-detached",
			"native_returned",
			outcome,
			cause,
		);
		// Source-backed pre-fix control: constructor parameter properties are enumerable.
		// Before toJSON, JSON.stringify(error) traversed this same snapshot (and threw on bigint).
		expect(Object.keys(error)).toContain("expected");
		expect(() => JSON.stringify({ ...error })).toThrow();
		expect(logged(error)).not.toContain(JSON.stringify([...Buffer.from(secret)]).slice(1, -1));
		expect(error.expected).toBe(snapshot);
		expect(error.expected.bytes.toString()).toBe(secret.repeat(10_000));
		expect(error.outcome).toBe(outcome);
		expect(error.cause).toBe(cause);
		expectBounded(error, "native_returned", "identity_mismatch", "stage.jsonl");
	});

	test("large tree and native graphs stay native, including retirement classification", () => {
		const target = path.join("private-parent", "stage");
		const outcome: ManagedTreeRemovalOutcome = {
			route: "exact",
			result: { ok: false, code: "cleanup_pending", payloadDurable: true, detachedPath: `${target}.removing` },
		};
		const cause = { secret, tree };
		const error = new ManagedTreeRemovalError(target, tree, "native_returned", outcome, cause, cause);
		// Without the explicit projection, enumerable snapshot fields leak every tree entry.
		expect(JSON.stringify({ ...error })).toContain("private-tree-entry-9999");
		expect(error.expected).toBe(tree);
		expect(error.outcome).toBe(outcome);
		expect(error.authorityCheckFailure).toBe(cause);
		expect(error.cause).toBe(cause);
		const classification = classifyManagedTreePayloadRetirement(error);
		expect(classification?.kind).toBe("payload_retired");
		expect(classification?.evidence).toBe(error);
		expect(classification?.detachedPath).toBe(`${target}.removing`);
		expectBounded(error, "native_returned", "cleanup_pending", "stage");
		expect(classifyManagedTreePayloadRetirement(error)?.evidence.outcome).toBe(outcome);
	});

	test("missing outcomes and circular causes never require traversing forensic evidence", () => {
		const cause: { self?: unknown } = {};
		cause.self = cause;
		for (const phase of ["native_threw", "post_effect_authority_check"] as const) {
			for (const error of [
				new ManagedTreeRemovalError("stage", tree, phase, undefined, cause, cause),
				new ManagedPreparedFileRemovalError("stage", snapshot, undefined, phase, undefined, cause),
			]) {
				expectBounded(error, phase, "managed_remove_failed", "stage");
				expect(error.cause).toBe(cause);
			}
		}
	});

	test("untrusted names and codes are sanitized and capped for both classes", () => {
		const target = path.join("private-parent", `stage\n\x1b${"x".repeat(5_000)}`);
		const code = `bad\n\x1b${"c".repeat(5_000)}`;
		const outcome: ManagedTreeRemovalOutcome = { route: "exact", result: { ok: false, code } };
		for (const error of [
			new ManagedTreeRemovalError(target, tree, "native_returned", outcome),
			new ManagedPreparedFileRemovalError(target, snapshot, undefined, "native_returned", outcome),
		]) {
			const serialized = logged(error);
			const diagnostic = JSON.parse(serialized).metadata.error;
			expect(serialized.length).toBeLessThan(2_048);
			expect(diagnostic.targetName).toBe(`stage??${"x".repeat(153)}`);
			expect(diagnostic.code).toBe(`bad??${"c".repeat(59)}`);
			expect(diagnostic.message.length).toBe(160);
			expect(diagnostic.message).not.toMatch(/[\x00-\x1f\x7f]/);
			expect(error.targetPath).toBe(target);
			expect(error.outcome).toBe(outcome);
		}
	});
});
