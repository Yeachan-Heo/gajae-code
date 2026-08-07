import { MEMORY_DOCUMENT_SCHEMA_VERSION } from "../documents/frontmatter";
import { formatMemoryUri } from "../documents/uri";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { CheckpointInput, CheckpointResult, MemoryEnvironment } from "../index";
import { authorizeSessionAccess } from "../policy/access-policy";
import { atomicWrite } from "../storage/atomic-write";

const CHECKPOINT_SCHEMA_VERSION = "gajae.memory.checkpoint.v1" as const;
const CHECKPOINT_RELATIVE_PATH = "checkpoint.md" as const;
const MAX_NEXT_STEPS = 3;

interface CheckpointValues {
	readonly goal: string;
	readonly task: string;
	readonly nextSteps: readonly string[];
	readonly constraints: readonly string[];
	readonly decisions: readonly string[];
	readonly risks: readonly string[];
}

function scopeUnresolved(detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "scope-unresolved",
			exitCode: MEMORY_EXIT_CODES.scopeUnresolved,
			detail,
		},
	};
}

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "checkpoint",
			reason,
		},
	};
}

function normalizedText(value: unknown, field: string): MemoryResult<string> {
	if (typeof value !== "string") return invalidInput(`checkpoint ${field} must be a string`);
	const normalized = value.normalize("NFC").trim();
	if (normalized.length === 0) return invalidInput(`checkpoint ${field} must not be empty`);
	if (
		[...normalized].some(character => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && codePoint < 0x20 && character !== "\n" && character !== "\t";
		})
	) {
		return invalidInput(`checkpoint ${field} contains a control character`);
	}
	return { ok: true, value: normalized };
}

function normalizedList(value: unknown, field: string): MemoryResult<readonly string[]> {
	if (value === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(value)) return invalidInput(`checkpoint ${field} must be an array of strings`);
	const values: string[] = [];
	for (const [index, item] of value.entries()) {
		const normalized = normalizedText(item, `${field}[${index}]`);
		if (!normalized.ok) return normalized;
		values.push(normalized.value);
	}
	return { ok: true, value: Object.freeze(values) };
}

function checkpointValues(input: CheckpointInput): MemoryResult<CheckpointValues> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalidInput("checkpoint input must be an object");
	}
	const candidate = input as unknown as Readonly<Record<string, unknown>>;
	const goal = normalizedText(candidate.goal, "goal");
	if (!goal.ok) return goal;
	const task = normalizedText(candidate.task, "task");
	if (!task.ok) return task;
	const nextSteps = normalizedList(candidate.nextSteps, "nextSteps");
	if (!nextSteps.ok) return nextSteps;
	if (nextSteps.value.length > MAX_NEXT_STEPS) {
		return invalidInput("checkpoint nextSteps accepts at most three entries");
	}
	const constraints = normalizedList(candidate.constraints, "constraints");
	if (!constraints.ok) return constraints;
	const decisions = normalizedList(candidate.decisions, "decisions");
	if (!decisions.ok) return decisions;
	const risks = normalizedList(candidate.risks, "risks");
	if (!risks.ok) return risks;
	return {
		ok: true,
		value: Object.freeze({
			goal: goal.value,
			task: task.value,
			nextSteps: nextSteps.value,
			constraints: constraints.value,
			decisions: decisions.value,
			risks: risks.value,
		}),
	};
}

function strictTimestamp(environment: MemoryEnvironment): MemoryResult<string> {
	const timestamp = environment.asOf ?? environment.now.toISOString();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
		return invalidInput("checkpoint timestamp must be strict UTC");
	}
	return { ok: true, value: timestamp };
}

function yamlString(value: string): string {
	const normalized = value.normalize("NFC");
	return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : JSON.stringify(normalized);
}

function normalizedLines(value: string): readonly string[] {
	return value.replace(/\r\n?/g, "\n").normalize("NFC").split("\n");
}

function bulletLines(values: readonly string[], fallback: string): readonly string[] {
	if (values.length === 0) return [`- ${fallback}`];
	const result: string[] = [];
	for (const value of values) {
		const lines = normalizedLines(value);
		result.push(`- ${lines[0] ?? ""}`);
		for (const line of lines.slice(1)) result.push(`  ${line}`);
	}
	return result;
}

function repositoryLines(environment: MemoryEnvironment): readonly string[] {
	if (environment.repository === null)
		return ["Branch: not supplied by MemoryEnvironment", "Worktree: not supplied by MemoryEnvironment"];
	const repository = environment.repository;
	return [
		"Branch: not supplied by MemoryEnvironment",
		"Worktree: remembered repository state; verify against the current checkout before relying on it",
		`Linked worktree (remembered): ${repository.isLinkedWorktree ? "true" : "false"}`,
	];
}

function renderBody(environment: MemoryEnvironment, values: CheckpointValues): string {
	const constraintsAndRisks = [
		...values.constraints.map(value => `Constraint: ${value}`),
		...values.risks.map(value => `Risk: ${value}`),
	];
	const sections: readonly [string, readonly string[]][] = [
		["Goal", [values.goal]],
		["Task", [values.task]],
		["Current Branch and Worktree", repositoryLines(environment)],
		["Completed", ["Not recorded by MemoryEnvironment"]],
		["Current Blockers", constraintsAndRisks],
		["Modified Files", []],
		["Verification", []],
		["Pending Decisions", values.decisions],
		["Next Three Steps", values.nextSteps],
		["Files To Read First", []],
		["Last Known Good Command", []],
	];
	const lines = ["# Checkpoint", ""];
	for (const [index, [heading, entries]] of sections.entries()) {
		lines.push(`## ${heading}`);
		const rendered = bulletLines(entries, "Not recorded");
		lines.push(...rendered);
		if (index < sections.length - 1) lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function renderDocument(
	environment: MemoryEnvironment,
	values: CheckpointValues,
	sessionId: string,
): MemoryResult<string> {
	const timestamp = strictTimestamp(environment);
	if (!timestamp.ok) return timestamp;
	const id = `checkpoint-${sessionId}`;
	const body = renderBody(environment, values);
	const lines = [
		"---",
		`schemaVersion: ${yamlString(MEMORY_DOCUMENT_SCHEMA_VERSION)}`,
		`id: ${yamlString(id)}`,
		`type: ${yamlString("task-state")}`,
		`scope: ${yamlString("session")}`,
		`authority: ${yamlString("session-observed")}`,
		`volatility: ${yamlString("volatile")}`,
		`sensitivity: ${yamlString("public-safe")}`,
		`status: ${yamlString("active")}`,
		`created: ${yamlString(timestamp.value)}`,
		`updated: ${yamlString(timestamp.value)}`,
		"---",
		body,
	];
	return { ok: true, value: lines.join("\n").normalize("NFC") };
}

function checkpointUri(sessionId: string): MemoryResult<string> {
	return formatMemoryUri({ scheme: "session", path: [sessionId, CHECKPOINT_RELATIVE_PATH], fragment: null, href: "" });
}

async function writeCheckpointUnchecked(
	environment: MemoryEnvironment,
	input: CheckpointInput,
): Promise<MemoryResult<CheckpointResult>> {
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return { ok: false, error: validatedEnvironment.error };
	const sessionId = validatedEnvironment.value.sessionId?.normalize("NFC");
	if (sessionId === undefined || sessionId.length === 0) {
		return scopeUnresolved("checkpoint requires a session id from the injected environment");
	}
	const values = checkpointValues(input);
	if (!values.ok) return { ok: false, error: values.error };
	const uri = checkpointUri(sessionId);
	if (!uri.ok) return { ok: false, error: uri.error };
	const document = renderDocument(validatedEnvironment.value, values.value, sessionId);
	if (!document.ok) return { ok: false, error: document.error };
	const grant = authorizeSessionAccess({
		environment: validatedEnvironment.value,
		destination: "checkpoint",
		content: document.value,
	});
	if (!grant.ok) return { ok: false, error: grant.error };
	try {
		const receipt = await atomicWrite(grant.value, document.value);
		return {
			ok: true,
			value: Object.freeze({
				schemaVersion: CHECKPOINT_SCHEMA_VERSION,
				uri: uri.value,
				digest: receipt.digest,
				sessionId,
			}),
		};
	} catch {
		return policyDenied("checkpoint atomic publish failed closed");
	}
}

/** Persist one deterministic, policy-authorized session checkpoint document. */
export async function writeCheckpoint(
	environment: MemoryEnvironment,
	input: CheckpointInput,
): Promise<MemoryResult<CheckpointResult>> {
	try {
		return await writeCheckpointUnchecked(environment, input);
	} catch {
		return policyDenied("checkpoint operation failed closed");
	}
}
