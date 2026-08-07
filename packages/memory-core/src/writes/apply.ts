import * as crypto from "node:crypto";
import { parseFrontmatter } from "../documents/frontmatter";
import type { MemoryEnvironment } from "../env";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { authorizeAccess } from "../policy/access-policy";
import type { MemoryPolicyConfig } from "../policy/config-merge";
import { checkInitializedRoot } from "../policy/initialized";
import { validateSafeRelativePath } from "../policy/path-safety";
import {
	admitMemoryPolicy,
	enforceMemoryApproval,
	enforceMemorySensitivity,
	enforceMemoryWritePolicy,
} from "../policy/policy-admission";
import {
	appendJournalProgress,
	createJournal,
	type JournalEntry,
	type JournalMutationHooks,
	type JournalRecoveryOutcome,
	journalRelPathSet,
	listJournalMutationIds,
	MemoryJournalError,
	publishJournalEntry,
	readContainedBytes,
	readJournal,
	recoverJournalAt,
	removeJournalPlan,
	removeJournalProgress,
	removeJournalTemp,
	stageJournalEntry,
	writeDestinationForPath,
} from "../storage/journal";
import { MemoryLockError, sortMemoryLockPaths, withMemoryWriteLocks } from "../storage/locks";

export type { JournalRecoveryOutcome } from "../storage/journal";
export interface ApplyReceipt {
	readonly schemaVersion: "gajae.memory.apply-receipt.v1";
	readonly proposalId: string;
	readonly mutationId: string;
	readonly applied: boolean;
	readonly changed: readonly string[];
	readonly superseded: readonly string[];
}

export interface ApplyHooks extends JournalMutationHooks {
	readonly afterLocks?: () => void;
	readonly beforeJournalCreate?: () => void;
	readonly afterJournalCreate?: () => void;
	readonly afterStageBoundary?: (index: number) => void;
	readonly afterPublishBegin?: (index: number) => void;
	readonly afterPublishEnd?: (index: number) => void;
	readonly afterCommit?: () => void;
	readonly afterProgressUnlink?: () => void;
}

interface ProposalPayload {
	readonly schemaVersion: "gajae.memory.write-proposal.v1";
	readonly proposalId: string;
	readonly recommendedUri: string;
	readonly recommendedRelPath: string;
	readonly expectedDigest: string | null;
	readonly supersedes: readonly string[];
	readonly mapUpdates: readonly string[];
	readonly requiresApproval: boolean;
}

interface SupersededMutation {
	readonly relPath: string;
	readonly expectedDigest: string;
	readonly content: string;
	readonly uri?: string;
}

interface ProposalRecord {
	readonly schemaVersion: "gajae.memory.staged-write-proposal.v1";
	readonly proposal: ProposalPayload;
	readonly documentRelPath: string;
	readonly documentContent: string;
	readonly superseded: readonly SupersededMutation[];
	readonly mapExpectedDigest: string;
	readonly mapContent: string;
}

interface PlannedEntry extends JournalEntry {
	readonly content: Buffer;
	readonly kind: "canonical" | "superseded" | "proposal" | "receipt" | "map";
}

const PROPOSAL_SCHEMA = "gajae.memory.write-proposal.v1" as const;
const RECEIPT_SCHEMA = "gajae.memory.apply-receipt.v1" as const;

function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalDigest(bytes: Uint8Array): string {
	const raw = Buffer.from(bytes);
	const text = raw.toString("utf8");
	const decoded = Buffer.from(text, "utf8");
	if (!decoded.equals(raw)) return digestBytes(raw);
	return digestBytes(Buffer.from(normalizeText(text), "utf8"));
}

function normalizeText(value: string): string {
	return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function lockConflict(relPath: string): MemoryResult<never> {
	return {
		ok: false,
		error: { code: "lock-conflict", exitCode: MEMORY_EXIT_CODES.lockConflict, relPath },
	};
}

function notFound(uri: string): MemoryResult<never> {
	return { ok: false, error: { code: "not-found", exitCode: MEMORY_EXIT_CODES.notFound, uri } };
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function malformed(relPath: string, detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: { code: "malformed-document", exitCode: MEMORY_EXIT_CODES.malformedDocument, relPath, detail },
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function proposalIdPath(proposalId: unknown): MemoryResult<string> {
	if (
		typeof proposalId !== "string" ||
		proposalId.length === 0 ||
		proposalId.length > 200 ||
		proposalId.includes("\u0000") ||
		proposalId.includes("/") ||
		proposalId.includes("\\") ||
		proposalId === "." ||
		proposalId === ".."
	) {
		return invalidInput("proposalId is malformed");
	}
	return { ok: true, value: proposalId.normalize("NFC") };
}

function safeRelPath(value: unknown, label: string): MemoryResult<string> {
	const result = validateSafeRelativePath(value);
	if (!result.ok || result.value.length === 0) return invalidInput(`${label} must be a safe relative path`);
	return { ok: true, value: result.value };
}

function parseStringArray(value: unknown, label: string): MemoryResult<readonly string[]> {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string"))
		return invalidInput(`${label} must be an array of strings`);
	return { ok: true, value: Object.freeze(value.map(item => item.normalize("NFC"))) };
}

function parseProposal(proposalId: string, bytes: Buffer): MemoryResult<ProposalRecord> {
	let parsed: unknown;
	const artifactPath = `global/proposals-${proposalId}.json`;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		return malformed(artifactPath, "staged proposal JSON is malformed");
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== "gajae.memory.staged-write-proposal.v1") {
		return malformed(artifactPath, "staged proposal schema is invalid");
	}
	if (!isRecord(parsed.proposal)) return malformed(artifactPath, "staged proposal payload is malformed");
	const payload = parsed.proposal;
	if (payload.schemaVersion !== PROPOSAL_SCHEMA || payload.proposalId !== proposalId) {
		return malformed(artifactPath, "staged proposal identity is invalid");
	}
	if (typeof payload.recommendedUri !== "string") return malformed(artifactPath, "staged proposal URI is malformed");
	const relPathResult = safeRelPath(payload.recommendedRelPath, "staged proposal recommendedRelPath");
	if (!relPathResult.ok) return relPathResult;
	const expectedDigestValue = payload.expectedDigest;
	if (
		expectedDigestValue !== null &&
		(typeof expectedDigestValue !== "string" || !/^[0-9a-f]{64}$/u.test(expectedDigestValue))
	) {
		return malformed(artifactPath, "staged proposal expectedDigest is malformed");
	}
	const expectedDigest = expectedDigestValue === null ? null : (expectedDigestValue as string);
	const supersedes = parseStringArray(payload.supersedes, "staged proposal supersedes");
	if (!supersedes.ok) return supersedes;
	const mapUpdates = parseStringArray(payload.mapUpdates, "staged proposal mapUpdates");
	if (!mapUpdates.ok) return mapUpdates;
	if (typeof payload.requiresApproval !== "boolean")
		return malformed(artifactPath, "staged proposal approval requirement is malformed");
	if (typeof parsed.documentRelPath !== "string" || typeof parsed.documentContent !== "string") {
		return malformed(artifactPath, "staged document payload is malformed");
	}
	const documentPath = safeRelPath(parsed.documentRelPath, "staged document path");
	if (!documentPath.ok) return documentPath;
	if (documentPath.value !== relPathResult.value)
		return malformed(artifactPath, "staged document path disagrees with proposal");
	if (typeof parsed.mapExpectedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.mapExpectedDigest)) {
		return malformed(artifactPath, "staged MAP digest is malformed");
	}
	const mapExpectedDigest = parsed.mapExpectedDigest as string;
	if (typeof parsed.mapContent !== "string" || !Array.isArray(parsed.superseded)) {
		return malformed(artifactPath, "staged mutation set is malformed");
	}
	const superseded: SupersededMutation[] = [];
	for (const value of parsed.superseded) {
		if (
			!isRecord(value) ||
			typeof value.relPath !== "string" ||
			typeof value.expectedDigest !== "string" ||
			typeof value.content !== "string"
		) {
			return malformed(artifactPath, "staged supersession mutation is malformed");
		}
		const supersededPath = safeRelPath(value.relPath, "staged superseded path");
		if (!supersededPath.ok) return supersededPath;
		if (!/^[0-9a-f]{64}$/u.test(value.expectedDigest))
			return malformed(artifactPath, "staged superseded digest is malformed");
		superseded.push({
			relPath: supersededPath.value,
			expectedDigest: value.expectedDigest,
			content: normalizeText(value.content),
			uri: typeof value.uri === "string" ? value.uri : undefined,
		});
	}
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.staged-write-proposal.v1",
			proposal: Object.freeze({
				schemaVersion: PROPOSAL_SCHEMA,
				proposalId,
				recommendedUri: payload.recommendedUri.normalize("NFC"),
				recommendedRelPath: relPathResult.value,
				expectedDigest,
				supersedes: supersedes.value,
				mapUpdates: mapUpdates.value,
				requiresApproval: payload.requiresApproval,
			}),
			documentRelPath: documentPath.value,
			documentContent: normalizeText(parsed.documentContent),
			superseded: Object.freeze(superseded),
			mapExpectedDigest,
			// The MAP is not a memory document: bytes outside the AUTO markers must
			// survive byte-for-byte, so never normalize it.
			mapContent: parsed.mapContent,
		}),
	};
}

function canonicalReceipt(receipt: ApplyReceipt): Buffer {
	return Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
}

function currentBytes(root: string, relPath: string): Buffer | null {
	return readContainedBytes(root, relPath);
}

function currentDigest(root: string, relPath: string): string | null {
	const bytes = currentBytes(root, relPath);
	return bytes === null ? null : digestBytes(bytes);
}

function currentCanonicalDigest(root: string, relPath: string): string | null {
	const bytes = currentBytes(root, relPath);
	return bytes === null ? null : canonicalDigest(bytes);
}

function canonicalPreimagePath(relPath: string): boolean {
	return relPath.endsWith(".md") && relPath !== "MEMORY.md";
}

function addPlannedEntry(entries: PlannedEntry[], entry: PlannedEntry): MemoryResult<true> {
	if (entries.some(existing => existing.relPath === entry.relPath))
		return invalidInput(`apply mutation set contains duplicate path ${entry.relPath}`);
	entries.push(entry);
	return { ok: true, value: true };
}

function planEntries(
	root: string,
	proposal: ProposalRecord,
	mutationId: string,
): MemoryResult<{
	readonly entries: readonly PlannedEntry[];
	readonly changed: readonly string[];
	readonly superseded: readonly string[];
}> {
	const entries: PlannedEntry[] = [];
	const changed: string[] = [];
	const superseded: string[] = [];
	const payload = proposal.proposal;
	const canonicalContent = Buffer.from(normalizeText(proposal.documentContent), "utf8");
	const canonicalEntry: PlannedEntry = {
		relPath: proposal.documentRelPath,
		expectedDigest: payload.expectedDigest,
		postDigest: digestBytes(canonicalContent),
		tempPath: `.journal/${mutationId}.pending-canonical.tmp`,
		content: canonicalContent,
		kind: "canonical",
	};
	const canonicalAdded = addPlannedEntry(entries, canonicalEntry);
	if (!canonicalAdded.ok) return canonicalAdded;
	if (currentDigest(root, canonicalEntry.relPath) !== canonicalEntry.postDigest) changed.push(canonicalEntry.relPath);

	for (const mutation of proposal.superseded) {
		const content = Buffer.from(normalizeText(mutation.content), "utf8");
		const entry: PlannedEntry = {
			relPath: mutation.relPath,
			expectedDigest: mutation.expectedDigest,
			postDigest: digestBytes(content),
			tempPath: `.journal/${mutationId}.pending-${entries.length}.tmp`,
			content,
			kind: "superseded",
		};
		const added = addPlannedEntry(entries, entry);
		if (!added.ok) return added;
		if (currentDigest(root, entry.relPath) !== entry.postDigest) changed.push(entry.relPath);
		superseded.push(entry.relPath);
	}

	const mapContent = Buffer.from(proposal.mapContent, "utf8");
	const mapEntry: PlannedEntry = {
		relPath: "MEMORY.md",
		expectedDigest: proposal.mapExpectedDigest,
		postDigest: digestBytes(mapContent),
		tempPath: `.journal/${mutationId}.pending-map.tmp`,
		content: mapContent,
		kind: "map",
	};
	const mapAdded = addPlannedEntry(entries, mapEntry);
	if (!mapAdded.ok) return mapAdded;
	if (currentDigest(root, mapEntry.relPath) !== mapEntry.postDigest) changed.push(mapEntry.relPath);

	// The staged proposal artifact is immutable: it was written at propose time and
	// its digest is the CAS precondition. Re-publishing identical bytes would make
	// the entry a self-republish, which recovery cannot distinguish from
	// pre-existing content. It stays outside the mutation set; the receipt below is
	// the apply-time artifact.

	const receiptPath = `global/proposals-${payload.proposalId}.receipt.json`;
	const mutationReceipt: ApplyReceipt = Object.freeze({
		schemaVersion: RECEIPT_SCHEMA,
		proposalId: payload.proposalId,
		mutationId,
		applied: true,
		changed: Object.freeze(sortMemoryLockPaths(changed)),
		superseded: Object.freeze(sortMemoryLockPaths(superseded)),
	});
	const receiptContent = canonicalReceipt(mutationReceipt);
	const receiptEntry: PlannedEntry = {
		relPath: receiptPath,
		expectedDigest: null,
		postDigest: digestBytes(receiptContent),
		tempPath: `.journal/${mutationId}.pending-receipt.tmp`,
		content: receiptContent,
		kind: "receipt",
	};
	const receiptAdded = addPlannedEntry(entries, receiptEntry);
	if (!receiptAdded.ok) return receiptAdded;

	const ordered = sortMemoryLockPaths(entries.map(entry => entry.relPath));
	const byPath = new Map(entries.map(entry => [entry.relPath, entry]));
	const normalizedEntries: PlannedEntry[] = [];
	for (let index = 0; index < ordered.length; index += 1) {
		const relPath = ordered[index];
		if (relPath === undefined) continue;
		const entry = byPath.get(relPath);
		if (entry === undefined) return invalidInput(`apply mutation set lost ${relPath}`);
		normalizedEntries.push({ ...entry, tempPath: `.journal/${mutationId}.${index}.tmp` });
	}
	return {
		ok: true,
		value: {
			entries: Object.freeze(normalizedEntries),
			changed: Object.freeze(sortMemoryLockPaths(changed)),
			superseded: Object.freeze(sortMemoryLockPaths(superseded)),
		},
	};
}

function journalEntries(entries: readonly PlannedEntry[]): JournalEntry[] {
	return entries.map(entry => ({
		relPath: entry.relPath,
		expectedDigest: entry.expectedDigest,
		postDigest: entry.postDigest,
		tempPath: entry.tempPath,
	}));
}

function targetMatchesEntry(root: string, entry: JournalEntry, post = false): boolean {
	const digest =
		post || !canonicalPreimagePath(entry.relPath)
			? currentDigest(root, entry.relPath)
			: currentCanonicalDigest(root, entry.relPath);
	return post
		? digest === entry.postDigest
		: entry.expectedDigest === null
			? digest === null
			: digest === entry.expectedDigest;
}

function errorResult(error: unknown): MemoryResult<never> {
	if (error instanceof MemoryLockError) return lockConflict(error.relPath);
	if (error instanceof MemoryJournalError) return lockConflict(error.relPath);
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === "policy-denied") {
			const reason = (error as { readonly reason?: unknown }).reason;
			return policyDenied(typeof reason === "string" ? reason : "verified storage failed closed");
		}
	}
	return lockConflict(".journal");
}

export async function recoverJournal(
	environment: MemoryEnvironment,
): Promise<MemoryResult<readonly JournalRecoveryOutcome[]>> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	const initialized = checkInitializedRoot(validated.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const root = validated.value.memoryRoot;
	let mutationIds: readonly string[];
	try {
		mutationIds = await listJournalMutationIds(root);
	} catch (error) {
		return errorResult(error);
	}
	const outcomes: JournalRecoveryOutcome[] = [];
	for (const mutationId of mutationIds) {
		try {
			let relPaths: readonly string[] = [];
			try {
				const journal = await readJournal(root, mutationId);
				relPaths = journal.entries.map(entry => entry.relPath);
			} catch {
				// A malformed journal has no trustworthy target set. The root apply
				// lock still serializes the finding and keeps the bytes untouched.
			}
			const outcome = await withMemoryWriteLocks(root, relPaths, () =>
				recoverJournalAt(root, mutationId, validated.value),
			);
			outcomes.push(outcome);
		} catch (error) {
			return errorResult(error);
		}
	}
	return { ok: true, value: Object.freeze(outcomes) };
}

async function loadProposal(
	root: string,
	proposalId: string,
): Promise<MemoryResult<{ readonly proposal: ProposalRecord }>> {
	const relPath = `global/proposals-${proposalId}.json`;
	let bytes: Buffer | null;
	try {
		bytes = readContainedBytes(root, relPath);
	} catch (error) {
		return errorResult(error);
	}
	if (bytes === null) return notFound(`proposal://${proposalId}`);
	const proposal = parseProposal(proposalId, bytes);
	if (!proposal.ok) return proposal;
	return { ok: true, value: { proposal: proposal.value } };
}

function expectedMismatchPaths(root: string, entries: readonly JournalEntry[]): string[] {
	return entries.filter(entry => !targetMatchesEntry(root, entry)).map(entry => entry.relPath);
}

function authorizePlannedContent(environment: MemoryEnvironment, entries: readonly PlannedEntry[]): MemoryResult<true> {
	for (const entry of entries) {
		const content = entry.content.toString("utf8");
		const authorized = authorizeAccess({
			environment,
			destination: writeDestinationForPath(entry.relPath),
			sensitivity: "private",
			relPath: entry.relPath,
			content,
		});
		if (!authorized.ok) return authorized;
	}
	return { ok: true, value: true };
}

async function applyTransaction(
	environment: MemoryEnvironment,
	root: string,
	proposal: ProposalRecord,
	hooks?: ApplyHooks,
): Promise<MemoryResult<ApplyReceipt>> {
	const mutationId = `apply-${proposal.proposal.proposalId}`.normalize("NFC");
	const planResult = planEntries(root, proposal, mutationId);
	if (!planResult.ok) return planResult;
	const planned = planResult.value;
	const entries = journalEntries(planned.entries);
	const lockPaths = entries.map(entry => entry.relPath);
	const receipt = Object.freeze({
		schemaVersion: RECEIPT_SCHEMA,
		proposalId: proposal.proposal.proposalId,
		mutationId,
		applied: true,
		changed: planned.changed,
		superseded: planned.superseded,
	});
	try {
		const transaction = await withMemoryWriteLocks(root, lockPaths, async (): Promise<MemoryResult<ApplyReceipt>> => {
			hooks?.afterLocks?.();
			const mismatches = expectedMismatchPaths(root, entries);
			if (mismatches.length > 0) return lockConflict(journalRelPathSet(mismatches));
			const authorized = authorizePlannedContent(environment, planned.entries);
			if (!authorized.ok) return authorized;
			hooks?.beforeJournalCreate?.();
			await createJournal(root, mutationId, entries);
			hooks?.afterJournalCreate?.();
			for (let index = 0; index < planned.entries.length; index += 1) {
				const entry = planned.entries[index];
				if (entry === undefined) continue;
				await stageJournalEntry(root, entry, entry.content, hooks, index);
				await appendJournalProgress(root, mutationId, { kind: "stage", index });
				hooks?.afterStageBoundary?.(index);
			}
			for (let index = 0; index < planned.entries.length; index += 1) {
				const entry = planned.entries[index];
				if (entry === undefined) continue;
				await appendJournalProgress(root, mutationId, { kind: "publish-begin", index });
				hooks?.afterPublishBegin?.(index);
				await publishJournalEntry(root, entry, hooks, index);
				await appendJournalProgress(root, mutationId, { kind: "publish-end", index });
				hooks?.afterPublishEnd?.(index);
				removeJournalTemp(root, entry);
			}
			await appendJournalProgress(root, mutationId, { kind: "commit" });
			hooks?.afterCommit?.();
			return { ok: true, value: receipt };
		});
		if (!transaction.ok) return transaction;
		await removeJournalProgress(root, mutationId);
		hooks?.afterProgressUnlink?.();
		await removeJournalPlan(root, mutationId);
		return transaction;
	} catch (error) {
		return errorResult(error);
	}
}

export async function applyMemoryWithHooks(
	environment: MemoryEnvironment,
	input: { readonly proposalId: string },
	hooks?: ApplyHooks,
	policy?: MemoryPolicyConfig,
): Promise<MemoryResult<ApplyReceipt>> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return validated;
	const admitted: MemoryResult<MemoryPolicyConfig> =
		policy === undefined ? admitMemoryPolicy(validated.value) : { ok: true, value: policy };
	if (!admitted.ok) return admitted;
	const writeAllowed = enforceMemoryWritePolicy(admitted.value, "global-canonical", "apply");
	if (!writeAllowed.ok) return writeAllowed;
	const initialized = checkInitializedRoot(validated.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const proposalIdResult = proposalIdPath(input?.proposalId);
	if (!proposalIdResult.ok) return proposalIdResult;
	const root = validated.value.memoryRoot;
	const recovered = await recoverJournal(validated.value);
	if (!recovered.ok) return recovered;
	const loaded = await loadProposal(root, proposalIdResult.value);
	if (!loaded.ok) return loaded;
	const destination = writeDestinationForPath(loaded.value.proposal.documentRelPath);
	const destinationGate = enforceMemoryWritePolicy(admitted.value, destination, "apply");
	if (!destinationGate.ok) return destinationGate;
	const approvalGate = enforceMemoryApproval(
		admitted.value,
		destination,
		loaded.value.proposal.proposal.requiresApproval,
	);
	if (!approvalGate.ok) return approvalGate;
	const parsedDocument = parseFrontmatter(
		loaded.value.proposal.documentContent,
		loaded.value.proposal.documentRelPath,
	);
	if (!parsedDocument.ok) return parsedDocument;
	const sensitivityGate = enforceMemorySensitivity(
		admitted.value,
		destination,
		parsedDocument.value.metadata.sensitivity,
	);
	if (!sensitivityGate.ok) return sensitivityGate;
	try {
		return await applyTransaction(validated.value, root, loaded.value.proposal, hooks);
	} catch (error) {
		return errorResult(error);
	}
}

export async function applyMemory(
	environment: MemoryEnvironment,
	input: { readonly proposalId: string },
	policy?: MemoryPolicyConfig,
): Promise<MemoryResult<ApplyReceipt>> {
	return applyMemoryWithHooks(environment, input, undefined, policy);
}
