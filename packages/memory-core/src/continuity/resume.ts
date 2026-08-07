import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import type { MarkdownSection } from "../documents/markdown-sections";
import { formatMemoryUri } from "../documents/uri";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { MemoryEnvironment, ResumeInput, ResumeResult } from "../index";
import { resolveReadableResource } from "../resources/resolve-readable-resource";

const HANDOFF_SCHEMA_VERSION = "gajae.memory.handoff.v1" as const;
const CHECKPOINT_RELATIVE_PATH = "checkpoint.md" as const;
const EXPECTED_SECTION_ORDER = Object.freeze([
	"Goal",
	"Task",
	"Current Branch and Worktree",
	"Completed",
	"Current Blockers",
	"Modified Files",
	"Verification",
	"Pending Decisions",
	"Next Three Steps",
	"Files To Read First",
	"Last Known Good Command",
] as const);
const MAX_NEXT_STEPS = 3;

interface CheckpointSections {
	readonly goal: string;
	readonly task: string;
	readonly currentBranchAndWorktree: readonly string[];
	readonly completed: readonly string[];
	readonly currentBlockers: readonly string[];
	readonly modifiedFiles: readonly string[];
	readonly verification: readonly string[];
	readonly pendingDecisions: readonly string[];
	readonly nextSteps: readonly string[];
	readonly filesToReadFirst: readonly string[];
	readonly lastKnownGoodCommand: readonly string[];
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
			destination: "global-canonical",
			reason,
		},
	};
}

function malformed(relPath: string, detail: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "malformed-document",
			exitCode: MEMORY_EXIT_CODES.malformedDocument,
			relPath,
			detail,
		},
	};
}

function normalizedSessionId(environment: MemoryEnvironment, input: ResumeInput | undefined): MemoryResult<string> {
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return { ok: false, error: validatedEnvironment.error };
	if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
		return invalidInput("resume input must be an object");
	}
	const candidate = input as Readonly<{ readonly sessionId?: unknown }> | undefined;
	const requested = candidate?.sessionId;
	if (requested !== undefined && typeof requested !== "string")
		return invalidInput("resume sessionId must be a string");
	const sessionId = (requested ?? validatedEnvironment.value.sessionId)?.normalize("NFC");
	if (sessionId === undefined || sessionId.length === 0) {
		return scopeUnresolved("resume requires a session id from the input or injected environment");
	}
	return { ok: true, value: sessionId };
}

function checkpointUri(sessionId: string): MemoryResult<string> {
	return formatMemoryUri({ scheme: "session", path: [sessionId, CHECKPOINT_RELATIVE_PATH], fragment: null, href: "" });
}

function sectionMap(
	document: ParsedMemoryDocument,
	relPath: string,
): MemoryResult<Readonly<Record<(typeof EXPECTED_SECTION_ORDER)[number], MarkdownSection>>> {
	const headings = document.sections;
	const levelOne = headings.filter(section => section.level === 1);
	if (levelOne.length !== 1 || levelOne[0]?.heading !== "Checkpoint" || headings[0] !== levelOne[0]) {
		return malformed(relPath, "checkpoint must contain exactly one level-1 Checkpoint heading");
	}
	const levelTwo = headings.filter(section => section.level === 2);
	if (levelTwo.length !== EXPECTED_SECTION_ORDER.length) {
		return malformed(relPath, "checkpoint level-2 section set is incomplete or contains an extra section");
	}
	if (headings.some(section => section.level > 2)) {
		return malformed(relPath, "checkpoint may not contain headings below level 2");
	}
	const mapped: Partial<Record<(typeof EXPECTED_SECTION_ORDER)[number], MarkdownSection>> = {};
	for (const [index, expected] of EXPECTED_SECTION_ORDER.entries()) {
		const section = levelTwo[index];
		if (section === undefined || section.heading !== expected) {
			return malformed(relPath, `checkpoint section ${expected} is missing or out of order`);
		}
		if (mapped[expected] !== undefined) return malformed(relPath, `checkpoint section ${expected} is duplicated`);
		mapped[expected] = section;
	}
	return { ok: true, value: mapped as Readonly<Record<(typeof EXPECTED_SECTION_ORDER)[number], MarkdownSection>> };
}

function sectionLines(section: MarkdownSection): readonly string[] {
	const normalized = section.body.replace(/\r\n?/g, "\n").normalize("NFC");
	const lines = normalized.split("\n");
	while (lines[0]?.trim() === "") lines.shift();
	while (lines.at(-1)?.trim() === "") lines.pop();
	const values: string[] = [];
	let current: string | null = null;
	for (const line of lines) {
		if (line.startsWith("- ")) {
			if (current !== null) values.push(current);
			current = line.slice(2);
		} else if (line === "-") {
			if (current !== null) values.push(current);
			current = "";
		} else if (line.startsWith("  ") && current !== null) {
			current = `${current}\n${line.slice(2)}`;
		} else {
			if (current !== null) {
				values.push(current);
				current = null;
			}
			values.push(line.startsWith("> ") ? line.slice(2) : line);
		}
	}
	if (current !== null) values.push(current);
	return Object.freeze(values);
}

function entries(section: MarkdownSection): readonly string[] {
	const values = sectionLines(section).map(value => value.normalize("NFC").trim());
	if (values.length === 1 && values[0] === "Not recorded") return Object.freeze([]);
	return Object.freeze(values.filter(value => value.length > 0));
}

function text(section: MarkdownSection, field: string, relPath: string): MemoryResult<string> {
	const values = sectionLines(section);
	const joined = values.join("\n").normalize("NFC").trim();
	if (joined.length === 0 || joined === "Not recorded")
		return malformed(relPath, `checkpoint ${field} must not be empty`);
	return { ok: true, value: joined };
}

function parseCheckpoint(content: string, relPath: string, uri: string): MemoryResult<CheckpointSections> {
	const parsed = parseMemoryDocument({ content, relPath, uri });
	if (!parsed.ok) return { ok: false, error: parsed.error };
	if (
		parsed.value.metadata.schemaVersion !== "gajae.memory.document.v1" ||
		parsed.value.metadata.type !== "task-state" ||
		parsed.value.metadata.scope !== "session" ||
		parsed.value.metadata.authority !== "session-observed" ||
		parsed.value.metadata.status !== "active" ||
		parsed.value.metadata.volatility !== "volatile" ||
		parsed.value.metadata.sensitivity !== "public-safe"
	) {
		return malformed(relPath, "checkpoint frontmatter does not match the continuity contract");
	}
	const sections = sectionMap(parsed.value, relPath);
	if (!sections.ok) return sections;
	const goal = text(sections.value.Goal, "Goal", relPath);
	if (!goal.ok) return goal;
	const task = text(sections.value.Task, "Task", relPath);
	if (!task.ok) return task;
	const nextSteps = entries(sections.value["Next Three Steps"]);
	if (nextSteps.length > MAX_NEXT_STEPS)
		return malformed(relPath, "checkpoint Next Three Steps contains more than three entries");
	const currentBranchAndWorktree = entries(sections.value["Current Branch and Worktree"]);
	const completed = entries(sections.value.Completed);
	const currentBlockers = entries(sections.value["Current Blockers"]);
	const modifiedFiles = entries(sections.value["Modified Files"]);
	const verification = entries(sections.value.Verification);
	const pendingDecisions = entries(sections.value["Pending Decisions"]);
	const filesToReadFirst = entries(sections.value["Files To Read First"]);
	const lastKnownGoodCommand = entries(sections.value["Last Known Good Command"]);
	return {
		ok: true,
		value: Object.freeze({
			goal: goal.value,
			task: task.value,
			currentBranchAndWorktree,
			completed,
			currentBlockers,
			modifiedFiles,
			verification,
			pendingDecisions,
			nextSteps,
			filesToReadFirst,
			lastKnownGoodCommand,
		}),
	};
}

async function readResumePacketUnchecked(
	environment: MemoryEnvironment,
	input: ResumeInput | undefined,
): Promise<MemoryResult<ResumeResult>> {
	const sessionId = normalizedSessionId(environment, input);
	if (!sessionId.ok) return sessionId;
	const selectedEnvironment = validateMemoryEnvironment({ ...environment, sessionId: sessionId.value });
	if (!selectedEnvironment.ok) return { ok: false, error: selectedEnvironment.error };
	const uri = checkpointUri(sessionId.value);
	if (!uri.ok) return { ok: false, error: uri.error };
	const resource = await resolveReadableResource(selectedEnvironment.value, { uri: uri.value });
	if (!resource.ok) return { ok: false, error: resource.error };
	const relPath = `sessions/${sessionId.value}/${CHECKPOINT_RELATIVE_PATH}`;
	if (resource.value.relPath !== relPath || resource.value.uri !== uri.value) {
		return malformed(relPath, "checkpoint resource identity does not match the requested session");
	}
	const parsed = parseCheckpoint(resource.value.content, relPath, uri.value);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: HANDOFF_SCHEMA_VERSION,
			sessionId: sessionId.value,
			goal: parsed.value.goal,
			task: parsed.value.task,
			nextSteps: parsed.value.nextSteps,
		}),
	};
}

/** Read a policy-approved checkpoint and return only its non-volatile handoff fields. */
export async function readResumePacket(
	environment: MemoryEnvironment,
	input?: ResumeInput,
): Promise<MemoryResult<ResumeResult>> {
	try {
		return await readResumePacketUnchecked(environment, input);
	} catch {
		return policyDenied("resume checkpoint read failed closed");
	}
}
