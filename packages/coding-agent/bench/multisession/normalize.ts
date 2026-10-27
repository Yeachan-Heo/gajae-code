import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseJsonl } from "./jsonl";

const EVIDENCE_STREAMS = ["transcript.jsonl", "requests.jsonl", "tools.jsonl", "events.jsonl"] as const;
const NORMALIZED_TIMESTAMP = "<timestamp>";
const NORMALIZED_PID = "<pid>";
const VOLATILE_PROJECT_CONTEXT_STATIC_BODY =
	"Timestamps in files, logs, git history, and API responses are often UTC; convert timestamps that are explicitly UTC to the local timezone above when reporting times to the user. Preserve timestamps that already include an explicit offset or timezone, and do not treat this host wall clock as authenticated event-time evidence. The timezone follows the runtime's process timezone configuration (which may include project environment settings), so treat it as display context rather than trusted location evidence. The full IANA zone may reveal geographic information; do not infer more about the user than the displayed context states.";

/** Explicit volatility rules. Transcript and request payload content stays compared unless a rule below names it. */
export const NORMALIZATION_ALLOWLIST = [
	{ field: "session, entry, tool-call, message, response, job, and compaction entry IDs", reason: "Runtime-generated identities differ between isolated runs; each distinct ID maps to <id:N> by first appearance across the evidence directory, so references between entries stay compared." },
	{ field: "timestamp/time fields", reason: "Wall-clock timestamps differ between otherwise identical runs." },
	{ field: "pid fields", reason: "Operating-system process identifiers differ between runs." },
	{ field: "*duration* fields", reason: "Elapsed execution time differs between repeated workload runs." },
	{ field: "promptPrefix.hash", reason: "This hash covers full messages including generated IDs and timestamps; message payloads remain compared separately." },
	{ field: "promptPrefix message-count fields", reason: "Prefix message/reuse counts shift with the per-turn volatile host context; request messages remain compared after excluding only that host-only context." },
	{ field: "temporary-root paths, absolute or home-abbreviated (~/…)", reason: "Each isolated run uses a distinct temporary filesystem root; the per-turn reminder renders a root under the home directory as ~/…." },
	{ field: "task-completion notice duration and job ID tokens", reason: "The system-generated task notice embeds elapsed time and job identity in text; its remaining content is preserved." },
	{ field: "session transcript filenames beneath the isolated root", reason: "Session files embed a generated timestamp and session UUID in their basename." },
	{ field: "host date and local clock in the per-turn project-context reminder", reason: "The reminder renders the wall-clock minute, so runs that straddle a minute boundary differ; the surrounding reminder text stays compared." },
	{ field: "exact date/time/cwd-only reminders in requests.jsonl context.messages", reason: "The per-turn runtime reminder may be injected at different workload turns when isolated runs cross a wall-clock refresh; it carries no tree or task-specific context and is excluded only from that captured request-message array." },
] as const;

function idField(key: string, objectType: string | undefined, isSessionEntry: boolean): boolean {
	const normalized = key.replaceAll("_", "").toLowerCase();
	if (
		[
			"sessionid",
			"entryid",
			"toolcallid",
			"messageid",
			"responseid",
			"parentid",
			"jobid",
			"compactionentryid",
			"firstkeptentryid",
		].includes(normalized)
	) {
		return true;
	}
	if (normalized !== "id") return false;
	return isSessionEntry || objectType === "session" || objectType === "message" || objectType === "toolcall";
}

function timestampField(key: string): boolean {
	return ["timestamp", "time", "createdat", "updatedat", "startedat", "endedat", "evictedat", "t"].includes(
		key.replaceAll("_", "").toLowerCase(),
	);
}

function pidField(key: string): boolean {
	return ["pid", "parentpid", "processid"].includes(key.replaceAll("_", "").toLowerCase());
}

function durationField(key: string): boolean {
	return key.replaceAll("_", "").toLowerCase().includes("duration");
}

function normalizeTaskCompletionNotice(value: string): string {
	if (!value.includes("<system-notice>") || !value.includes("<task-summary>")) return value;
	return value
		.replace(/(Background job )[^ ]+( has completed)/gu, "$1<job-id>$2")
		.replace(/(<agent id=")[^"]+(" agent=)/gu, "$1<job-id>$2")
		.replace(/(<synopsis ref="agent:\/\/)[^"]+("\s*\/?>)/gu, "$1<job-id>$2")
		.replace(/(<header>[^<]*\[)[0-9]+(?:\.[0-9]+)?(?:ms|s)(\]<\/header>)/gu, "$1<duration>$2");
}

function normalizeHostWallClock(value: string): string {
	if (!value.includes("the local time is")) return value;
	return value.replace(
		/(Today is )[^,\n]+(, the local time is )[^,\n]+(, and the current working directory is )/gu,
		"$1<date>$2<local-time>$3",
	);
}

function isVolatileProjectContextMessage(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const message = value as Record<string, unknown>;
	if (message.role !== "user" && message.role !== "custom") return false;
	const content = message.content;
	let text: string | undefined;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content) && content.length === 1) {
		const block = content[0];
		if (block !== null && typeof block === "object" && !Array.isArray(block)) {
			const textBlock = block as Record<string, unknown>;
			if (textBlock.type === "text" && typeof textBlock.text === "string") text = textBlock.text;
		}
	}
	return (
		typeof text === "string" &&
		text.startsWith("<system-reminder>\nToday is ") &&
		!text.includes("<workspace-tree>") &&
		/^<system-reminder>\nToday is [^,\n]+, the local time is [^,\n]+, and the current working directory is '[^'\n]*'\.\n([\s\S]*)\n<\/system-reminder>$/u.exec(
			text,
		)?.[1] === VOLATILE_PROJECT_CONTEXT_STATIC_BODY
	);
}

/** The root as it can appear in evidence: absolute, and home-abbreviated when it lies under the home directory. */
function rootSpellings(tempRoot: string): string[] {
	const home = os.homedir();
	if (!tempRoot.startsWith(home + path.sep)) return [tempRoot];
	return [tempRoot, `~${tempRoot.slice(home.length)}`];
}

function replaceRootPath(value: string, tempRoot: string): string {
	let rooted = value;
	for (const spelling of rootSpellings(tempRoot)) {
		const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		rooted = rooted.replace(new RegExp(`${escaped}(?=$|[/\\\\])`, "gu"), "<root>");
	}
	// The session basename includes a generated timestamp and UUID beneath the isolated root.
	return rooted.replace(/(<root>[/\\]sessions[/\\])[^/\\]+/gu, "$1<session>");
}

function normalizeArgumentPayload(value: unknown, tempRoot: string): unknown {
	if (typeof value === "string") return replaceRootPath(value, path.resolve(tempRoot));
	if (Array.isArray(value)) return value.map(item => normalizeArgumentPayload(item, tempRoot));
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [key, normalizeArgumentPayload(item, tempRoot)]),
	);
}

/** Bijective ID canonicalization: the same raw ID always maps to the same token. */
function canonicalId(item: unknown, ids: Map<string, string>): unknown {
	if (item === undefined || item === null) return item;
	const raw = JSON.stringify(item);
	let token = ids.get(raw);
	if (token === undefined) {
		token = `<id:${ids.size + 1}>`;
		ids.set(raw, token);
	}
	return token;
}

/**
 * Normalize only explicit identity, time, pid, temporary-root, and derived-hash
 * volatility. `ids` is shared across one evidence directory's streams.
 */
export function normalizeEvidenceValue(
	value: unknown,
	tempRoot: string,
	parentType?: string,
	ids: Map<string, string> = new Map(),
): unknown {
	if (typeof value === "string")
		return normalizeHostWallClock(normalizeTaskCompletionNotice(replaceRootPath(value, path.resolve(tempRoot))));
	if (Array.isArray(value)) {
		// Only captured request context.messages is a known host-injected message list.
		const messages =
			parentType === "requestContextMessages" ? value.filter(item => !isVolatileProjectContextMessage(item)) : value;
		const childType = parentType === "requestContextMessages" ? undefined : parentType;
		return messages.map(item => normalizeEvidenceValue(item, tempRoot, childType, ids));
	}
	if (value === null || typeof value !== "object") return value;

	const record = value as Record<string, unknown>;
	const objectType = typeof record.type === "string" ? record.type.toLowerCase() : parentType;
	const normalized: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (["args", "arguments", "input"].includes(key)) normalized[key] = normalizeArgumentPayload(item, tempRoot);
		else if (idField(key, objectType, "parentId" in record)) normalized[key] = canonicalId(item, ids);
		else if (timestampField(key)) normalized[key] = item === undefined ? item : NORMALIZED_TIMESTAMP;
		else if (pidField(key)) normalized[key] = item === undefined ? item : NORMALIZED_PID;
		else if (durationField(key)) normalized[key] = item === undefined ? item : NORMALIZED_TIMESTAMP;
		else if (objectType === "promptprefix" && key === "hash") normalized[key] = item === undefined ? item : "<hash>";
		else if (
			objectType === "promptprefix" &&
			["messages", "previousmessages", "reusedmessages"].includes(key.replaceAll("_", "").toLowerCase())
		)
			normalized[key] = item === undefined ? item : "<message-count>";
		else {
			let childType = objectType;
			if (key === "promptPrefix") childType = "promptprefix";
			else if (objectType === "request" && key === "context") childType = "requestContext";
			else if (objectType === "requestContext" && key === "messages") childType = "requestContextMessages";
			normalized[key] = normalizeEvidenceValue(item, tempRoot, childType, ids);
		}
	}
	return normalized;
}

async function readNormalizedLines(
	directory: string,
	stream: (typeof EVIDENCE_STREAMS)[number],
	ids: Map<string, string>,
): Promise<unknown[]> {
	const file = Bun.file(path.join(directory, stream));
	if (!(await file.exists())) throw new Error(`Missing evidence stream ${path.join(directory, stream)}`);
	const contents = await file.text();
	const tempRoot = await fs.realpath(path.resolve(directory, ".."));
	return parseJsonl(contents, path.join(directory, stream)).map(value =>
		normalizeEvidenceValue(value, tempRoot, stream === "requests.jsonl" ? "request" : undefined, ids),
	);
}

function collectDiffs(left: unknown, right: unknown, currentPath: string, diffs: string[]): void {
	if (Object.is(left, right)) return;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) diffs.push(`${currentPath}.length`);
		const length = Math.max(left.length, right.length);
		for (let index = 0; index < length; index += 1) {
			if (index >= left.length || index >= right.length) diffs.push(`${currentPath}[${index}]`);
			else collectDiffs(left[index], right[index], `${currentPath}[${index}]`, diffs);
		}
		return;
	}
	if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
		for (const key of keys) {
			if (!(key in leftRecord) || !(key in rightRecord)) diffs.push(`${currentPath}.${key}`);
			else collectDiffs(leftRecord[key], rightRecord[key], `${currentPath}.${key}`, diffs);
		}
		return;
	}
	diffs.push(currentPath);
}

/** Compare normalized transcript, request, tool, and event streams. Timing metrics are preserved in their own file but excluded from fidelity equality. */
export async function compareEvidence(
	dirA: string,
	dirB: string,
): Promise<{ equal: boolean; diffs: string[] }> {
	const diffs: string[] = [];
	const idsA = new Map<string, string>();
	const idsB = new Map<string, string>();
	for (const stream of EVIDENCE_STREAMS) {
		let left: unknown[];
		let right: unknown[];
		try {
			[left, right] = await Promise.all([readNormalizedLines(dirA, stream, idsA), readNormalizedLines(dirB, stream, idsB)]);
		} catch (error) {
			diffs.push(`${stream}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		collectDiffs(left, right, stream, diffs);
	}
	return { equal: diffs.length === 0, diffs };
}
