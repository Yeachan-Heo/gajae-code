import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportFromFile, exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getSessionsDir } from "@gajae-code/utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function header(id: string, version = 5): Record<string, unknown> {
	return { type: "session", version, id, timestamp: TIMESTAMP, cwd: "/cwd" };
}

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp },
	};
}

function assistantEntry(
	id: string,
	parentId: string | null,
	message: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			provider: "openai",
			model: "test",
			timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			...message,
		},
	};
}

function jsonl(records: readonly Record<string, unknown>[]): string {
	return records.map(record => `${JSON.stringify(record)}\n`).join("");
}

/** An assistant turn whose stale OpenAI Responses replay metadata is sanitized on load. */
function staleReplayTranscript(): string {
	return jsonl([
		header("readonly-stale-replay"),
		userEntry("user", null, "question", 1),
		assistantEntry("assistant", "user", {
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale-signature" },
				{ type: "text", text: "answer" },
			],
			providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] },
		}),
	]);
}

/** A linear, compacted v5 transcript that an enabled session-memory open can serve from sidecars. */
function coldEligibleTranscript(): string {
	const records: Record<string, unknown>[] = [header("readonly-cold")];
	let parentId: string | null = null;
	for (let index = 0; index < 2_000; index++) {
		const id = `cold-${index}`;
		records.push(userEntry(id, parentId, `cold-${index}-${"x".repeat(512)}`, index));
		parentId = id;
	}
	records.push(userEntry("kept", parentId, "kept", 2_001));
	records.push({
		type: "compaction",
		id: "compaction",
		parentId: "kept",
		timestamp: TIMESTAMP,
		summary: "summary",
		shortSummary: "short",
		firstKeptEntryId: "kept",
		tokensBefore: 2_000,
	});
	return jsonl(records);
}

/** A v3 transcript; loading migrates it to the current version in memory. */
function legacyVersionTranscript(): string {
	return jsonl([
		header("readonly-legacy", 3),
		userEntry("legacy-user", null, "legacy question", 1),
		assistantEntry("legacy-assistant", "legacy-user", { content: [{ type: "text", text: "legacy answer" }] }),
	]);
}

/** A transcript that already carries header and entry patch records. */
function patchBearingTranscript(): string {
	return jsonl([
		header("readonly-patched"),
		userEntry("patched-user", null, "patched question", 1),
		assistantEntry("patched-assistant", "patched-user", { content: [{ type: "text", text: "original answer" }] }),
		{ type: "header_patch", patch: { title: "Patched title" } },
		{
			type: "entry_patch",
			entryId: "patched-assistant",
			patch: {
				message: {
					role: "assistant",
					provider: "openai",
					model: "test",
					timestamp: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					content: [{ type: "text", text: "patched answer" }],
				},
			},
		},
	]);
}

const FIXTURES: ReadonlyArray<{ name: string; build: () => string }> = [
	{ name: "stale replay metadata", build: staleReplayTranscript },
	{ name: "cold-eligible compacted history", build: coldEligibleTranscript },
	{ name: "pre-v5 transcript", build: legacyVersionTranscript },
	{ name: "existing patch records", build: patchBearingTranscript },
];

interface TreeNode {
	kind: "file" | "directory" | "other";
	size: number;
	mtimeNs: bigint;
	ino: bigint;
	sha256?: string;
}

/** Recursive listing of a directory: every file and directory with size, mtime, inode, and content hash. */
function snapshotTree(root: string): Record<string, TreeNode> {
	const nodes: Record<string, TreeNode> = {};
	const visit = (absolute: string, relative: string): void => {
		const stat = fs.lstatSync(absolute, { bigint: true });
		const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
		nodes[relative || "."] = {
			kind,
			size: Number(stat.size),
			mtimeNs: stat.mtimeNs,
			ino: stat.ino,
			sha256:
				kind === "file" ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : undefined,
		};
		if (kind !== "directory") return;
		for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), path.join(relative, name));
	};
	visit(root, "");
	return nodes;
}

function snapshotTreeIfPresent(root: string): Record<string, TreeNode> | null {
	return fs.existsSync(root) ? snapshotTree(root) : null;
}

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gjc-export-readonly-${label}-`)));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes the transcript plus decoy derived files that a cleanup pass would delete. */
function seedSource(content: string): { sourceDir: string; sessionFile: string } {
	const sourceDir = makeTempDir("source");
	const sessionFile = path.join(sourceDir, "session.jsonl");
	fs.writeFileSync(sessionFile, content, { mode: 0o600 });
	const artifactRoot = sessionFile.slice(0, -".jsonl".length);
	fs.mkdirSync(artifactRoot, { mode: 0o700 });
	fs.writeFileSync(path.join(artifactRoot, "tool-output.txt"), "artifact payload", { mode: 0o600 });
	fs.writeFileSync(path.join(artifactRoot, "leftover.tmp"), "decoy temporary file", { mode: 0o600 });
	fs.writeFileSync(`${sessionFile}.spill.idx`, "decoy legacy sidecar", { mode: 0o600 });
	return { sourceDir, sessionFile };
}

/** Export of a normally opened private copy: the load path every non-export caller uses. */
async function referenceHtml(content: string): Promise<string> {
	const copyDir = makeTempDir("reference");
	const copyFile = path.join(copyDir, "session.jsonl");
	fs.writeFileSync(copyFile, content, { mode: 0o600 });
	const manager = await SessionManager.open(copyFile, undefined, undefined, "copy-retain", "off");
	try {
		const outputPath = path.join(copyDir, "reference.html");
		await exportSessionToHtml(manager, undefined, { outputPath });
		return fs.readFileSync(outputPath, "utf8");
	} finally {
		await manager.close();
	}
}

describe("standalone HTML export leaves its source untouched", () => {
	for (const fixture of FIXTURES) {
		it(`does not change the transcript or its directory tree (${fixture.name})`, async () => {
			const content = fixture.build();
			const { sourceDir, sessionFile } = seedSource(content);
			const before = snapshotTree(sourceDir);
			const managedBefore = snapshotTreeIfPresent(getSessionsDir());
			const outputPath = path.join(makeTempDir("output"), "export.html");

			await exportFromFile(sessionFile, { outputPath });

			expect(fs.readFileSync(sessionFile, "utf8")).toBe(content);
			expect(snapshotTree(sourceDir)).toEqual(before);
			// Nothing is migrated or copied into the managed session store.
			expect(snapshotTreeIfPresent(getSessionsDir())).toEqual(managedBefore);
			expect(fs.readFileSync(outputPath, "utf8")).toBe(await referenceHtml(content));
		});
	}
});
