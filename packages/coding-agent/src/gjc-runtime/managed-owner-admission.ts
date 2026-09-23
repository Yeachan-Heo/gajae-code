import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ManagedOwnerBinding } from "./managed-owner-supervisor";
import { assertSafePathComponent } from "./session-layout";
import { lifecyclePaths } from "./tmux-owner-isolation";

const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const MANAGED_OWNER_GENERATION_ENV = "GJC_TMUX_OWNER_GENERATION";
const MANAGED_OWNER_INCARNATION_ENV = "GJC_MANAGED_OWNER_INCARNATION";
const MANAGED_OWNER_RUN_ID_ENV = "GJC_MANAGED_OWNER_RUN_ID";
const MANAGED_OWNER_SESSION_ID_ENV = "GJC_COORDINATOR_SESSION_ID";
const MANAGED_OWNER_STATE_DIR_ENV = "GJC_TMUX_OWNER_STATE_DIR";

export type ManagedOwnerAdmission = { kind: "fresh" | "supervised" } | { kind: "blocked" };

function ownerEnvironment(): {
	root: string;
	generation: string;
	sessionId: string;
	runId: string;
	incarnation: string;
} | null {
	const stateDir = process.env[MANAGED_OWNER_STATE_DIR_ENV]?.trim();
	const sessionId = process.env[MANAGED_OWNER_SESSION_ID_ENV]?.trim();
	const generation = process.env[MANAGED_OWNER_GENERATION_ENV]?.trim();
	const runId = process.env[MANAGED_OWNER_RUN_ID_ENV]?.trim();
	const incarnation = process.env[MANAGED_OWNER_INCARNATION_ENV]?.trim();
	if (!stateDir && !generation && !runId && !incarnation) return null;
	if (!stateDir || !sessionId || !generation || !runId || !incarnation || !path.isAbsolute(stateDir))
		throw new Error("managed_owner_admission_metadata_invalid");
	for (const [value, label] of [
		[sessionId, "managed owner session id"],
		[generation, "managed owner generation"],
		[runId, "managed owner run id"],
		[incarnation, "managed owner incarnation"],
	] as const)
		assertSafePathComponent(value, label);
	const root = lifecyclePaths(stateDir, sessionId, generation).root;
	if (!root.startsWith(`${path.resolve(stateDir)}${path.sep}`)) throw new Error("managed_owner_admission_path_unsafe");
	return { root, generation, sessionId, runId, incarnation };
}

function isCommand(command: unknown): command is string[] {
	return (
		Array.isArray(command) &&
		command.length > 0 &&
		command.every(value => typeof value === "string" && value.length > 0)
	);
}

function isBinding(
	value: unknown,
	expected: { generation: string; sessionId: string; runId: string; incarnation: string; token: string },
): value is ManagedOwnerBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const binding = value as Partial<ManagedOwnerBinding>;
	return (
		binding.schema_version === 2 &&
		binding.generation === expected.generation &&
		binding.session_id === expected.sessionId &&
		binding.run_id === expected.runId &&
		binding.endpoint_incarnation === expected.incarnation &&
		binding.child_token === expected.token &&
		isCommand(binding.command) &&
		typeof binding.command_sha256 === "string" &&
		binding.command_sha256 === crypto.createHash("sha256").update(JSON.stringify(binding.command)).digest("hex") &&
		typeof binding.supervisor_pid === "number" &&
		Number.isSafeInteger(binding.supervisor_pid) &&
		binding.supervisor_pid > 0 &&
		typeof binding.supervisor_start_time === "string" &&
		typeof binding.created_at === "string"
	);
}

function safeChildToken(value: string): boolean {
	try {
		assertSafePathComponent(value, "managed owner child token");
		return true;
	} catch {
		return false;
	}
}

/**
 * The exact reader needs the Linux-only recovery-fs authority, so an unavailable
 * read has two very different causes. A blocked operator cannot act on either
 * unless the outcome says which one it was, so the unavailable arm names it.
 */
type ExactJsonRead = { values: unknown[] } | { reader: "unsupported_platform" | "read_failed" };

async function readExactJsons(root: string, files: readonly string[]): Promise<ExactJsonRead> {
	if (process.platform !== "linux") return { reader: "unsupported_platform" };
	try {
		const { openRecoveryFsRoot } = require("@gajae-code/natives") as Pick<
			typeof import("@gajae-code/natives"),
			"openRecoveryFsRoot"
		>;
		const authority = openRecoveryFsRoot(root);
		try {
			const values: unknown[] = [];
			for (const file of files) {
				const result = authority.read(file, 64 * 1024);
				if (!result.ok || !result.data) return { reader: "read_failed" };
				const content = Buffer.from(result.data).toString("utf8");
				if (!content.endsWith("\n") || content.indexOf("\n") !== content.length - 1)
					return { reader: "read_failed" };
				values.push(JSON.parse(content));
			}
			return { values };
		} finally {
			authority.close();
		}
	} catch {
		return { reader: "read_failed" };
	}
}

function exactJsonValues(read: ExactJsonRead): unknown[] {
	return "values" in read ? read.values : [];
}

function exactReaderDetails(read: ExactJsonRead): Record<string, unknown> {
	return "values" in read ? {} : { platform: process.platform, evidence_reader: read.reader };
}

function readerExplanation(details: Record<string, unknown>): string {
	switch (details.evidence_reader) {
		case "unsupported_platform":
			return ` (platform ${process.platform}: exact binding reader unsupported)`;
		case "read_failed":
			return ` (platform ${process.platform}: exact binding evidence unreadable)`;
		default:
			return "";
	}
}

async function durableHandoff(
	root: string,
	generation: string,
	sessionId: string,
	reason: string,
	details: Record<string, unknown> = {},
): Promise<void> {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const file = path.join(root, `admission-handoff-${crypto.randomUUID()}.json`);
	const record = {
		schema_version: 2,
		generation,
		session_id: sessionId,
		state: "fail_closed_handoff",
		reason,
		...details,
		created_at: new Date().toISOString(),
	};
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directory = await fs.open(root, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * Fails closed and says so. The durable handoff is the record of authority, but
 * nothing reads it during an incident, so the same reason also goes to stderr:
 * otherwise a blocked child exits 75 having printed nothing at all.
 */
async function blockAdmission(
	owner: { root: string; generation: string; sessionId: string },
	reason: string,
	details: Record<string, unknown> = {},
): Promise<{ kind: "blocked" }> {
	await durableHandoff(owner.root, owner.generation, owner.sessionId, reason, details);
	process.stderr.write(`child admission blocked: ${reason}${readerExplanation(details)}\n`);
	process.exitCode = 75;
	return { kind: "blocked" };
}

/**
 * This is the pre-CLI barrier. Managed children are admitted only by the exact
 * supervisor-created binding; directory enumeration grants no authority.
 */
export async function admitManagedOwnerBeforeCli(): Promise<ManagedOwnerAdmission> {
	const owner = ownerEnvironment();
	if (!owner) return { kind: "fresh" };
	const childToken = process.env[MANAGED_OWNER_CHILD_TOKEN_ENV]?.trim();
	if (!childToken || !safeChildToken(childToken)) return blockAdmission(owner, "exact_child_binding_unavailable");
	const read = await readExactJsons(owner.root, [`child-${childToken}.binding.json`]);
	const [binding] = exactJsonValues(read);
	if (
		isBinding(binding, {
			generation: owner.generation,
			sessionId: owner.sessionId,
			runId: owner.runId,
			incarnation: owner.incarnation,
			token: childToken,
		})
	)
		return { kind: "supervised" };
	return blockAdmission(owner, "exact_child_binding_unavailable", exactReaderDetails(read));
}
