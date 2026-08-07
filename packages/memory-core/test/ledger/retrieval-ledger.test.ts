import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MemoryEnvironment } from "../../src/env";
import {
	appendRetrievalLedger,
	createRetrievalLedgerEntry,
	type RetrievalLedgerInput,
	type RetrievalLedgerSourceInput,
} from "../../src/ledger/retrieval-ledger";
import { authorizeLedgerAccess } from "../../src/policy/access-policy";
import { retrievalLedgerEntrySchema } from "../../src/schemas";
import { appendJsonl } from "../../src/storage/append-jsonl";
import { createMemoryRootScaffold } from "../../src/storage/bootstrap-init";
import { VerifiedStorageError } from "../../src/storage/verified-open";

const temporaryParents: string[] = [];
const SECRET = "token-abcdefghijkl";

function asObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected a JSON object");
	}
	return value as Record<string, unknown>;
}

const BASE_INPUT: RetrievalLedgerInput = {
	query: "why is retrieval deterministic?",
	intent: "generic-recall",
	scopes: [
		{ scope: "project", digest: "project-digest", startLine: 1, endLine: 4 },
		{ scope: "global", digest: "global-digest", startLine: 2, endLine: 3 },
	],
	mapsRead: [{ uri: "global://map", digest: "map-digest", startLine: 1, endLine: 5 }],
	selectedSources: [
		{
			uri: "project://notes/retrieval",
			digest: "source-digest",
			startLine: 8,
			endLine: 14,
			stage: "lexical",
			authority: "repository-reviewed",
			volatility: "stable",
		},
	],
	rejections: [{ uri: "global://notes/old", reason: "superseded", stage: "metadata" }],
	conflicts: [
		{
			claimKey: "retrieval-order",
			conflict: true,
			requiresUserConfirmation: true,
			dimensions: {
				authority: "repository-reviewed",
				specificity: "project",
				freshness: "equal",
				volatility: "stable",
			},
		},
	],
	volatileClaims: [
		{
			claim: "A volatile claim is represented by its digest.",
			verificationRequired: true,
			verificationHint: { provider: "local", resource: "fixture", id: 7 },
		},
	],
	budget: {
		limits: { maxMaps: 4, maxFiles: 20, maxSections: 8, maxChars: 24_000 },
		usage: { maps: 2, files: 1, sections: 1, chars: 120 },
		truncated: false,
	},
	truncated: false,
};

async function makeRoot(): Promise<string> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-ledger-"));
	temporaryParents.push(parent);
	const root = path.join(parent, "memory-root");
	await createMemoryRootScaffold(root);
	return root;
}

function environment(memoryRoot: string, sessionId: string | null): MemoryEnvironment {
	return {
		memoryRoot,
		repository: null,
		sessionId,
		now: new Date("2026-07-29T00:00:00.000Z"),
		deterministic: true,
		asOf: "2026-07-29T00:00:00.000Z",
	};
}

async function makeSessionRoot(): Promise<{
	readonly root: string;
	readonly sessionId: string;
}> {
	const root = await makeRoot();
	const sessionId = "ledger-session";
	await fs.mkdir(path.join(root, "sessions", sessionId), { mode: 0o700 });
	return { root, sessionId };
}

afterEach(async () => {
	await Promise.all(temporaryParents.splice(0).map(parent => fs.rm(parent, { force: true, recursive: true })));
});

describe("retrieval ledger", () => {
	it("emits a versioned metadata-only schema without raw query, body, path, or process data", async () => {
		const root = await makeRoot();
		const baseSource = BASE_INPUT.selectedSources?.[0] ?? {};
		const sourceWithUntrustedFields = {
			...baseSource,
			path: process.cwd(),
			sourceBody: `private transcript ${SECRET}`,
		} as unknown as RetrievalLedgerSourceInput;
		const input: RetrievalLedgerInput = {
			...BASE_INPUT,
			query: "private source body should never be copied",
			selectedSources: [sourceWithUntrustedFields],
		};

		const result = createRetrievalLedgerEntry(environment(root, null), input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const serialized = JSON.stringify(result.value);
		expect(result.value.schemaVersion).toBe("gajae.memory.retrieval-ledger-entry.v1");
		expect(result.value.queryDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.value.queryId).toMatch(/^memq_[0-9a-f]{64}$/);
		expect(result.value.ledgerId).toMatch(/^memledger_[0-9a-f]{64}$/);
		expect(serialized).not.toContain(input.query);
		expect(serialized).not.toContain(process.cwd());
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("sourceBody");
		expect(serialized).not.toContain("transcript");
		expect(serialized).not.toContain(String(process.pid));
		expect(result.value.selectedSources[0]).toEqual({
			uri: "project://notes/retrieval",
			digest: "source-digest",
			startLine: 8,
			endLine: 14,
			stage: "lexical",
			authority: "repository-reviewed",
			volatility: "stable",
		});
		expect(result.value.scopes).toEqual([
			{ scope: "global", digest: "global-digest", startLine: 2, endLine: 3 },
			{ scope: "project", digest: "project-digest", startLine: 1, endLine: 4 },
		]);
		expect(result.value.mapsRead).toEqual([{ uri: "global://map", digest: "map-digest", startLine: 1, endLine: 5 }]);
		expect(result.value.budget.usage).toEqual({
			maps: 2,
			files: 1,
			sections: 1,
			chars: 120,
		});
		expect(result.value.truncated).toBe(false);
	});

	it("keeps budget drop dimensions exactly aligned with the checked-in schema", () => {
		const schema = asObject(retrievalLedgerEntrySchema);
		const definitions = asObject(schema.$defs);
		const budgetDrop = asObject(definitions.budgetDrop);
		const properties = asObject(budgetDrop.properties);
		const dimensionSchema = asObject(properties.dimension);
		const dimensions = ["maps", "files", "sections", "chars", null] as const;
		expect(dimensionSchema.enum).toEqual(dimensions);

		for (const dimension of dimensions) {
			const result = createRetrievalLedgerEntry(environment("/unused", null), {
				...BASE_INPUT,
				budget: { drops: [{ candidateId: "candidate", dimension, amount: 1, reason: "limit" }] },
			});
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.budget.drops[0]?.dimension).toBe(dimension);
		}

		for (const malformed of ["map", "MAPS", 1, false, {}, []] as readonly unknown[]) {
			const result = createRetrievalLedgerEntry(environment("/unused", null), {
				...BASE_INPUT,
				budget: { drops: [{ dimension: malformed }] },
			} as unknown as RetrievalLedgerInput);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("invalid-input");
		}
	});
	it("canonicalizes IDs and metadata order independently of input order", async () => {
		const root = await makeRoot();
		const first = createRetrievalLedgerEntry(environment(root, null), BASE_INPUT);
		const second = createRetrievalLedgerEntry(environment(root, null), {
			...BASE_INPUT,
			scopes: [...(BASE_INPUT.scopes ?? [])].reverse(),
			mapsRead: [...(BASE_INPUT.mapsRead ?? [])].reverse(),
			selectedSources: [...(BASE_INPUT.selectedSources ?? [])].reverse(),
			rejections: [...(BASE_INPUT.rejections ?? [])].reverse(),
			conflicts: [...(BASE_INPUT.conflicts ?? [])].reverse(),
			volatileClaims: [...(BASE_INPUT.volatileClaims ?? [])].reverse(),
		});
		expect(first).toEqual(second);
		if (first.ok && second.ok) {
			expect(first.value.queryId).toBe(second.value.queryId);
			expect(first.value.ledgerId).toBe(second.value.ledgerId);
			expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
		}
	});

	it("returns a documented no-ledger result without a session or filesystem mutation", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-ledger-no-session-"));
		temporaryParents.push(parent);
		const root = path.join(parent, "missing-root");
		const result = await appendRetrievalLedger(environment(root, null), BASE_INPUT);
		expect(result).toEqual({
			ok: true,
			value: { ledgerId: null, written: false, relPath: null },
		});
		expect(
			await fs.stat(root).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("refuses secret-bearing query and reason inputs without returning secret bytes", async () => {
		const root = await makeRoot();
		const queryResult = createRetrievalLedgerEntry(environment(root, null), {
			...BASE_INPUT,
			query: SECRET,
		});
		const reasonResult = createRetrievalLedgerEntry(environment(root, null), {
			...BASE_INPUT,
			rejections: [{ reason: `rejected ${SECRET}` }],
		});
		for (const result of [queryResult, reasonResult]) {
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(SECRET);
		}
	});

	it("accepts an empty section heading while rejecting controls and secrets", () => {
		const source = BASE_INPUT.selectedSources?.[0] ?? {};
		const empty = createRetrievalLedgerEntry(environment("/unused", null), {
			...BASE_INPUT,
			selectedSources: [{ ...source, heading: "" }],
		});
		expect(empty.ok).toBe(true);
		if (empty.ok) {
			expect(empty.value.selectedSources[0]).toEqual({
				uri: "project://notes/retrieval",
				digest: "source-digest",
				startLine: 8,
				endLine: 14,
				stage: "lexical",
				authority: "repository-reviewed",
				volatility: "stable",
			});
		}

		const control = createRetrievalLedgerEntry(environment("/unused", null), {
			...BASE_INPUT,
			selectedSources: [{ ...source, heading: "bad\u0000heading" }],
		});
		expect(control.ok).toBe(false);
		if (!control.ok) expect(control.error).toMatchObject({ code: "invalid-input", exitCode: 2 });

		const secret = createRetrievalLedgerEntry(environment("/unused", null), {
			...BASE_INPUT,
			selectedSources: [{ ...source, heading: SECRET }],
		});
		expect(secret.ok).toBe(false);
		if (!secret.ok) expect(secret.error).toMatchObject({ code: "sensitivity-violation", exitCode: 11 });
	});

	it("returns not-initialized after root deletion and writes no ledger bytes", async () => {
		const { root, sessionId } = await makeSessionRoot();
		await fs.rm(root, { force: true, recursive: true });
		const result = await appendRetrievalLedger(environment(root, sessionId), BASE_INPUT);
		expect(result).toEqual({
			ok: false,
			error: {
				code: "not-initialized",
				exitCode: 3,
				memoryRoot: root,
				remedy: "Run `gjc memory init` to create an initialized memory root.",
			},
		});
	});

	it("creates a missing lazy session directory and preserves 200 concurrent ledger lines", async () => {
		const root = await makeRoot();
		const sessionId = "lazy-ledger-session";
		const sessionPath = path.join(root, "sessions", sessionId);
		expect(
			await fs.lstat(sessionPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		const writes = await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				appendRetrievalLedger(environment(root, sessionId), {
					...BASE_INPUT,
					query: `lazy concurrent retrieval ${index}`,
				}),
			),
		);
		expect(writes.every(result => result.ok && result.value.written)).toBe(true);
		const sessionStat = await fs.lstat(sessionPath);
		expect(sessionStat.isDirectory()).toBe(true);
		expect(sessionStat.isSymbolicLink()).toBe(false);
		expect(sessionStat.mode & 0o777).toBe(0o700);
		const ledgerPath = path.join(sessionPath, "retrieval-ledger.jsonl");
		const ledgerBytes = await fs.readFile(ledgerPath);
		expect(ledgerBytes.length).toBeGreaterThan(0);
		expect(ledgerBytes[ledgerBytes.length - 1]).toBe(0x0a);
		const rawLines = ledgerBytes.toString("utf8").split("\n");
		expect(rawLines).toHaveLength(201);
		expect(rawLines.at(-1)).toBe("");
		const lines = rawLines.slice(0, -1);
		expect(lines.every(line => line.length > 0)).toBe(true);
		expect(lines).toHaveLength(200);
		const requiredKeys = [
			"asOf",
			"budget",
			"conflicts",
			"intent",
			"ledgerId",
			"mapsRead",
			"queryDigest",
			"queryId",
			"rejections",
			"schemaVersion",
			"scopes",
			"selectedSources",
			"truncated",
			"volatileClaims",
		].sort();
		const records = lines.map(line => {
			expect(line).not.toContain("\r");
			const record = asObject(JSON.parse(line));
			expect(Object.keys(record).sort()).toEqual(requiredKeys);
			expect(record.schemaVersion).toBe("gajae.memory.retrieval-ledger-entry.v1");
			expect(record.queryId).toMatch(/^memq_[0-9a-f]{64}$/u);
			expect(record.ledgerId).toMatch(/^memledger_[0-9a-f]{64}$/u);
			expect(JSON.stringify(record)).toBe(line);
			return record;
		});
		expect(new Set(records.map(record => record.queryId)).size).toBe(200);
	}, 30_000);

	it("denies symlink, wrong-mode, and raced session parents", async () => {
		const root = await makeRoot();
		const sessionId = "unsafe-ledger-session";
		const sessionPath = path.join(root, "sessions", sessionId);
		await fs.mkdir(sessionPath, { mode: 0o700 });
		await fs.chmod(sessionPath, 0o750);
		const wrongMode = await appendRetrievalLedger(environment(root, sessionId), BASE_INPUT);
		expect(wrongMode.ok).toBe(false);

		await fs.rm(sessionPath, { recursive: true, force: true });
		const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), "memory-core-ledger-outside-"));
		temporaryParents.push(outsideParent);
		const outside = path.join(outsideParent, "outside");
		await fs.mkdir(outside, { mode: 0o700 });
		await fs.symlink(outside, sessionPath, "dir");
		const symlink = await appendRetrievalLedger(environment(root, sessionId), BASE_INPUT);
		expect(symlink.ok).toBe(false);

		await fs.rm(sessionPath, { force: true });
		const safeEnvironment = environment(root, "raced-ledger-session");
		const entry = createRetrievalLedgerEntry(safeEnvironment, BASE_INPUT);
		expect(entry.ok).toBe(true);
		if (!entry.ok) return;
		const line = `${JSON.stringify(entry.value)}\n`;
		const grant = authorizeLedgerAccess({ environment: safeEnvironment, content: line });
		expect(grant.ok).toBe(true);
		if (!grant.ok) return;
		const sessionsPath = path.join(root, "sessions");
		const movedSessionsPath = path.join(outsideParent, "sessions-moved");
		let swapped = false;

		// Approved MVP boundary: same-UID adversarial race prevention/rooted-I/O is
		// explicitly out of scope. This deterministic seam proves detection and fail-closed
		// error evidence only; an external mkdir side effect need not be impossible.
		const failure = await appendJsonl({
			grant: grant.value,
			relPath: "sessions/raced-ledger-session/retrieval-ledger.jsonl",
			record: entry.value,
			beforeAuthorizedParentCreate() {
				fsSync.renameSync(sessionsPath, movedSessionsPath);
				fsSync.symlinkSync(movedSessionsPath, sessionsPath, "dir");
				swapped = true;
			},
		}).then(
			() => null,
			error => error,
		);
		expect(swapped).toBe(true);
		expect(failure).toBeInstanceOf(VerifiedStorageError);
		if (!(failure instanceof VerifiedStorageError)) return;
		expect(failure.code).toBe("policy-denied");
		expect(failure.exitCode).toBe(6);
		expect(failure.destination).toBe("ledger");
		expect(failure.reason).toContain("sessions directory binding");
		expect((await fs.lstat(sessionsPath)).isSymbolicLink()).toBe(true);
		expect(
			await fs.lstat(path.join(sessionsPath, "raced-ledger-session", "retrieval-ledger.jsonl")).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
	it("appends 200 independently parseable lines without losing concurrent entries", async () => {
		const { root, sessionId } = await makeSessionRoot();
		const writes = await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				appendRetrievalLedger(environment(root, sessionId), {
					...BASE_INPUT,
					query: `concurrent retrieval ${index}`,
				}),
			),
		);
		expect(writes.every(result => result.ok && result.value.written)).toBe(true);
		const ledgerPath = path.join(root, "sessions", sessionId, "retrieval-ledger.jsonl");
		const lines = (await fs.readFile(ledgerPath, "utf8")).split("\n").filter(line => line.length > 0);
		expect(lines).toHaveLength(200);
		const records = lines.map(
			line =>
				JSON.parse(line) as {
					readonly schemaVersion: string;
					readonly queryId: string;
				},
		);
		expect(records.every(record => record.schemaVersion === "gajae.memory.retrieval-ledger-entry.v1")).toBe(true);
		expect(new Set(records.map(record => record.queryId)).size).toBe(200);
	}, 30_000);
});
