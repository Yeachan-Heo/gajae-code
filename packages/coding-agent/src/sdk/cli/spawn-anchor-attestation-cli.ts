import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@gajae-code/utils";
import { PublicCommandFailure } from "../../cli/public-command-errors";
import { brokerIdentityPath, deriveSpawnAnchorIdentities, MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH } from "../broker/identity";
import { decodeLifecycleUtf8, parseLifecycleJson } from "../broker/lifecycle-codec";
import { hasValidTerminalDigests, isLifecycleLedgerEntry, type LifecycleLedgerEntry } from "../broker/lifecycle-ledger";
import {
	createSpawnAuthorityJournalState,
	replaySpawnAuthorityJournalRow,
	validateSpawnAuthorityJournalAliases,
} from "../broker/spawn-authority";
import { assertSupportedStateVersion } from "../broker/state-version";

const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
const MAX_STATE_LINE_BYTES = 8 * 1024 * 1024;
const TOKEN_SEPARATOR_BYTES = new Set(Buffer.from(" \t\n\r\v\f\"'`\\,;|=()[]{}<>"));
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
export const SPAWN_ANCHOR_ATTESTATION_RESTART_NOTICE =
	"Takes effect at the next broker start. Restart through your supervisor for gjc sdk broker run, or use bun run restart:sdk-broker for an on-demand broker.";

export interface SpawnAnchorAttestationOptions {
	agentDir?: string;
	evidence: readonly string[];
	write?: boolean;
}

export interface SpawnAnchorAttestationResult {
	candidates: number;
	proven: number;
	unproven: number;
	alreadyAttested: number;
	filesScanned: number;
	filesSkipped: number;
	written: boolean;
	attestationPath: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Streaming, read-only parsing. Never opens the mutating ledger/store implementations. */
async function* jsonLines(file: string, optional = false, json5 = false): AsyncGenerator<unknown> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile()) throw new Error("State source must be a regular file.");
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let pending = Buffer.alloc(0);
	for await (const chunk of Bun.file(file).stream()) {
		const bytes = Buffer.concat([pending, chunk]);
		let start = 0;
		for (let offset = 0; offset < bytes.length; offset++) {
			if (bytes[offset] !== 0x0a) continue;
			const line = bytes.subarray(start, offset);
			start = offset + 1;
			if (line.length > MAX_STATE_LINE_BYTES) throw new Error("State row exceeds the read limit.");
			if (line.length > 0) yield json5 ? Bun.JSON5.parse(decodeLifecycleUtf8(line)) : parseLifecycleJson(line);
		}
		pending = Buffer.from(bytes.subarray(start));
		if (pending.length > MAX_STATE_LINE_BYTES) throw new Error("State row exceeds the read limit.");
	}
	if (pending.length > 0) yield json5 ? Bun.JSON5.parse(decodeLifecycleUtf8(pending)) : parseLifecycleJson(pending);
}

async function existingAttestation(file: string): Promise<Set<string>> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error("Invalid attestation source.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: "pre-effect",
			diagnostics: ["spawn_anchor_attestation_invalid"],
		});
	}
	try {
		const value = record(parseLifecycleJson(await Bun.file(file).bytes()));
		if (value?.version !== 1 || !Array.isArray(value.identities)) throw new Error("Invalid attestation.");
		const identities = value.identities;
		if (!identities.every((identity): identity is string => typeof identity === "string"))
			throw new Error("Invalid identities.");
		return new Set(identities);
	} catch {
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: "pre-effect",
			diagnostics: ["spawn_anchor_attestation_invalid"],
		});
	}
}

async function candidateIdentities(ledgerPath: string): Promise<Set<string>> {
	const histories = new Map<string, { row: LifecycleLedgerEntry; count: number; valid: boolean }>();
	try {
		for await (const value of jsonLines(ledgerPath)) {
			assertSupportedStateVersion(ledgerPath, value);
			// A malformed shape makes prior pending rows corruption-uncertain on broker open.
			// Refuse the entire source rather than attest identities that open would quarantine.
			if (!isLifecycleLedgerEntry(value)) throw new Error("Invalid ledger row.");
			const prior = histories.get(value.identity);
			histories.set(value.identity, {
				row: value,
				count: (prior?.count ?? 0) + 1,
				valid: (prior?.valid ?? true) && hasValidTerminalDigests(value),
			});
		}
	} catch {
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: "pre-effect",
			diagnostics: ["spawn_anchor_ledger_invalid"],
		});
	}
	const candidates = new Set<string>();
	for (const [identity, { row, count, valid }] of histories) {
		if (
			count === 1 &&
			valid &&
			row.state === "accepted" &&
			row.operationKey === undefined &&
			row.spawnAnchor === undefined &&
			row.fingerprint === undefined &&
			row.intendedSessionId === undefined &&
			row.closeAuthorityBound === undefined
		)
			candidates.add(identity);
	}
	return candidates;
}

async function excludeCurrentClaims(candidates: Set<string>, file: string, key: Uint8Array): Promise<void> {
	try {
		const state = createSpawnAuthorityJournalState();
		for await (const value of jsonLines(file, true, true)) replaySpawnAuthorityJournalRow(state, value, key);
		validateSpawnAuthorityJournalAliases(state);
		for (const identity of state.latest.keys()) candidates.delete(identity);
	} catch {
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: "pre-effect",
			diagnostics: ["spawn_anchor_journal_invalid"],
		});
	}
}

/** Bounded streaming tokenizer. Raw evidence and caller keys never enter output or durable state. */
function tokenSeparatorLength(bytes: Uint8Array, offset: number): number {
	const first = bytes[offset]!;
	if (TOKEN_SEPARATOR_BYTES.has(first)) return 1;
	const second = bytes[offset + 1];
	const third = bytes[offset + 2];
	// The remaining UTF-8 encodings of JavaScript whitespace (ASCII is handled above).
	if (first === 0xc2 && second === 0xa0) return 2;
	if (
		(first === 0xe1 && second === 0x9a && third === 0x80) ||
		(first === 0xe2 &&
			second === 0x80 &&
			third !== undefined &&
			((third >= 0x80 && third <= 0x8a) || third === 0xa8 || third === 0xa9 || third === 0xaf)) ||
		(first === 0xe2 && second === 0x81 && third === 0x9f) ||
		(first === 0xe3 && second === 0x80 && third === 0x80) ||
		(first === 0xef && second === 0xbb && third === 0xbf)
	)
		return 3;
	return 0;
}

async function evidenceTokens(file: string, visit: (token: string) => void): Promise<void> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = Buffer.alloc(0);
	let oversized = false;
	let bytesRead = 0;
	let tail = Buffer.alloc(0);
	const append = (fragment: Uint8Array) => {
		if (oversized || fragment.length === 0) return;
		// UTF-8 uses at most four bytes per caller-key character.
		if (pending.length + fragment.length > MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH * 4) {
			pending = Buffer.alloc(0);
			oversized = true;
		} else pending = Buffer.concat([pending, fragment]);
	};
	const finish = () => {
		if (!oversized && pending.length === 0) return;
		if (!oversized && pending.length > 0) {
			try {
				const token = decoder.decode(pending);
				if (token.length > 0 && token.length <= MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH && !CONTROL_CHARACTER.test(token))
					visit(token);
			} catch {
				// Invalid UTF-8 disqualifies this token, not unrelated tokens in a binary file.
			}
		}
		pending = Buffer.alloc(0);
		oversized = false;
	};
	const consume = (chunk: Uint8Array, final = false) => {
		const bytes = Buffer.concat([tail, chunk]);
		// Retain two bytes so a three-byte whitespace encoding can span stream chunks.
		const limit = final ? bytes.length : Math.max(0, bytes.length - 2);
		let start = 0;
		let offset = 0;
		while (offset < limit) {
			const length = tokenSeparatorLength(bytes, offset);
			if (length === 0) offset++;
			else {
				append(bytes.subarray(start, offset));
				finish();
				offset += length;
				start = offset;
			}
		}
		append(bytes.subarray(start, offset));
		tail = Buffer.from(bytes.subarray(offset));
	};
	for await (const chunk of Bun.file(file).stream()) {
		bytesRead += chunk.length;
		if (bytesRead > MAX_EVIDENCE_BYTES) throw new Error("Evidence exceeds the read limit.");
		consume(chunk);
	}
	consume(new Uint8Array(), true);
	finish();
}

async function scanEvidence(
	paths: readonly string[],
	key: Uint8Array,
	candidates: ReadonlySet<string>,
	proven: Set<string>,
): Promise<{ filesScanned: number; filesSkipped: number }> {
	const counts = { filesScanned: 0, filesSkipped: 0 };
	const seenPaths = new Set<string>();
	const scan = async (input: string): Promise<void> => {
		const file = path.resolve(input);
		if (seenPaths.has(file)) return;
		seenPaths.add(file);
		try {
			const stat = await fs.lstat(file);
			if (stat.isDirectory()) {
				const children = await fs.readdir(file);
				for (const child of children) await scan(path.join(file, child));
				return;
			}
			// lstat deliberately skips symlinks, including symlinked directories.
			if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) {
				counts.filesSkipped++;
				return;
			}
			const matches = new Set<string>();
			await evidenceTokens(file, token => {
				for (const identity of deriveSpawnAnchorIdentities(key, token))
					if (candidates.has(identity)) matches.add(identity);
			});
			// A partial read never contributes proof: commit only after the entire file succeeds.
			for (const identity of matches) proven.add(identity);
			counts.filesScanned++;
		} catch {
			counts.filesSkipped++;
		}
	};
	for (const file of paths) await scan(file);
	return counts;
}

async function writeAttestation(file: string, identities: ReadonlySet<string>): Promise<void> {
	const temporary = path.join(path.dirname(file), `.spawn-anchor-attestation-${randomUUID()}.tmp`);
	let created = false;
	let renamed = false;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		created = true;
		try {
			await Bun.write(
				Bun.file(handle.fd),
				`${JSON.stringify({ version: 1, identities: [...identities].sort() })}\n`,
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, file);
		renamed = true;
		if (process.platform !== "win32") {
			const directory = await fs.open(path.dirname(file), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} catch {
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: renamed ? "unknown" : "pre-effect",
			diagnostics: [renamed ? "spawn_anchor_publication_uncertain" : "spawn_anchor_write_failed"],
		});
	} finally {
		if (created && !renamed) {
			// Best-effort cleanup of an unpublished 0600 temp file; never mask the primary outcome.
			await fs.rm(temporary, { force: true }).catch((error: unknown) => {
				logger.warn("sdk broker: unpublished spawn-anchor attestation temp file was not removed", {
					code: (error as NodeJS.ErrnoException).code ?? "unknown",
				});
			});
		}
	}
}

export async function runSpawnAnchorAttestation(
	options: SpawnAnchorAttestationOptions,
): Promise<SpawnAnchorAttestationResult> {
	const agentDir = path.resolve(options.agentDir ?? getAgentDir());
	let key: Buffer;
	try {
		// Never call getBrokerIdentityKey here: its missing-key path creates new authority.
		const file = brokerIdentityPath(agentDir);
		if (!(await fs.lstat(file)).isFile()) throw new Error("Invalid key source.");
		const text = (await Bun.file(file).text()).trim();
		if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error("Invalid identity key.");
		key = Buffer.from(text, "hex");
	} catch {
		throw new PublicCommandFailure({
			kind: "operation_failed",
			proof: "pre-effect",
			diagnostics: ["spawn_anchor_identity_unavailable"],
		});
	}
	if (options.evidence.length === 0) throw new PublicCommandFailure({ kind: "usage", proof: "pre-effect" });
	const sdkDir = path.join(agentDir, "sdk");
	const attestationPath = path.join(sdkDir, "lifecycle-ledger.spawn-anchor-attestation.json");
	const attested = await existingAttestation(attestationPath);
	const candidates = await candidateIdentities(path.join(sdkDir, "lifecycle-ledger.jsonl"));
	await excludeCurrentClaims(candidates, path.join(sdkDir, "spawn-authority.jsonl"), key);
	let alreadyAttested = 0;
	for (const identity of attested) {
		if (candidates.delete(identity)) alreadyAttested++;
	}
	const proven = new Set<string>();
	const files = await scanEvidence(options.evidence, key, candidates, proven);
	const written = options.write === true && proven.size > 0;
	if (written) await writeAttestation(attestationPath, new Set([...attested, ...proven]));
	return {
		candidates: candidates.size,
		proven: proven.size,
		unproven: candidates.size - proven.size,
		alreadyAttested,
		...files,
		written,
		attestationPath,
	};
}

export function renderSpawnAnchorAttestation(result: SpawnAnchorAttestationResult, json = false): string {
	if (json) return `${JSON.stringify(result)}\n`;
	return `${[
		`Candidates: ${result.candidates}; proven: ${result.proven}; unproven: ${result.unproven}; already attested: ${result.alreadyAttested}`,
		`Files scanned: ${result.filesScanned}; files skipped: ${result.filesSkipped}`,
		`Written: ${result.written}; attestation path: ${JSON.stringify(result.attestationPath)}`,
		...(result.written ? [SPAWN_ANCHOR_ATTESTATION_RESTART_NOTICE] : []),
	].join("\n")}\n`;
}
