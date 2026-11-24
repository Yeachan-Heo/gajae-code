import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RESUME_TRANSCRIPT_MAX_BYTES } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, getSessionsDir, getSidecarCacheRootDir, getTerminalSessionsDir } from "@gajae-code/utils";

// A real transcript above the eager-load cap, exported in a child process so its peak RSS is
// the export's own and not this test's (which hashes the source and parses the HTML).
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TARGET_BYTES = RESUME_TRANSCRIPT_MAX_BYTES + 8 * 1024 * 1024;
const EXPORT_MODULE = path.resolve(import.meta.dir, "../../src/export/html/index.ts");
const SESSION_MODULE = path.resolve(import.meta.dir, "../../src/session/session-manager.ts");
// "baseline" loads the same modules and does nothing; "hold" opens the snapshot and waits to be interrupted.
const CHILD_SCRIPT = `import { exportFromFile } from ${JSON.stringify(EXPORT_MODULE)};
import { SessionManager } from ${JSON.stringify(SESSION_MODULE)};
const [mode, input, output] = process.argv.slice(2);
if (mode === "export") await exportFromFile(input, { outputPath: output });
if (mode === "hold") {
	await SessionManager.openReadOnlySnapshot(input);
	process.stdout.write("ready\\n");
	await Bun.sleep(120_000);
}
process.stdout.write(JSON.stringify({ maxRssKiB: process.resourceUsage().maxRSS }));
process.exit(0);
`;

/** Runs the child script to completion and returns its peak RSS in bytes. */
async function runChild(mode: "export" | "baseline", outputPath = ""): Promise<number> {
	const child = Bun.spawn([process.execPath, childScript, mode, sessionFile, outputPath], {
		cwd: workDir,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ mode, exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ mode, exitCode: 0, stderr: "" });
	return (JSON.parse(stdout) as { maxRssKiB: number }).maxRssKiB * 1024;
}

interface TreeNode {
	kind: "file" | "directory" | "other";
	size: number;
	mtimeNs: bigint;
	ino: bigint;
	sha256?: string;
}

function sha256File(file: string): string {
	const hash = crypto.createHash("sha256");
	const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
	const fd = fs.openSync(file, "r");
	try {
		for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer))
			hash.update(buffer.subarray(0, read));
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("hex");
}

/** Every file and directory under `root` with size, mtime, inode, and content hash. */
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
			sha256: kind === "file" ? sha256File(absolute) : undefined,
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

function sidecarCacheInstances(): string[] {
	const root = getSidecarCacheRootDir(getAgentDir());
	return fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.startsWith("i-")) : [];
}

/**
 * Instances created since `before`. Opening an instance schedules a sweep that may reap an older
 * stale one, so assertions only ever look at what is new.
 */
function newSidecarCacheInstances(before: readonly string[]): string[] {
	return sidecarCacheInstances().filter(name => !before.includes(name));
}

/**
 * Streams a linear v5 transcript of user/assistant turns to just past `targetBytes`, then a
 * compaction and a kept suffix: the shape the bounded loader serves. Returns the entry ids.
 */
async function writeLargeTranscript(file: string, targetBytes: number): Promise<{ ids: string[]; leafId: string }> {
	const writer = Bun.file(file).writer();
	const ids: string[] = [];
	let bytes = 0;
	const write = (record: Record<string, unknown>): void => {
		const line = `${JSON.stringify(record)}\n`;
		bytes += Buffer.byteLength(line);
		writer.write(line);
		if (typeof record.id === "string" && record.type !== "session") ids.push(record.id);
	};
	write({ type: "session", version: 5, id: "large-export", timestamp: TIMESTAMP, cwd: "/cwd" });
	const filler = "y".repeat(4_000);
	let parentId: string | null = null;
	const append = (role: "user" | "assistant", text: string): string => {
		const id = `e-${ids.length}`;
		const message =
			role === "user"
				? { role, content: text, timestamp: ids.length }
				: {
						role,
						provider: "openai",
						model: "test",
						timestamp: ids.length,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						content: [{ type: "text", text }],
					};
		write({ type: "message", id, parentId, timestamp: TIMESTAMP, message });
		parentId = id;
		return id;
	};
	while (bytes < targetBytes) {
		append("user", `question ${ids.length} ${filler}`);
		append("assistant", `answer ${ids.length} ${filler}`);
		if (ids.length % 2_048 === 0) await writer.flush();
	}
	const keptId = append("user", "kept question");
	write({
		type: "compaction",
		id: "compaction",
		parentId: keptId,
		timestamp: TIMESTAMP,
		summary: "summary",
		shortSummary: "short",
		firstKeptEntryId: keptId,
		tokensBefore: ids.length,
	});
	parentId = "compaction";
	const leafId = append("assistant", "final answer");
	await writer.end();
	return { ids, leafId };
}

let workDir: string;
let sourceDir: string;
let sessionFile: string;
let generated: { ids: string[]; leafId: string };
let childScript: string;

beforeAll(async () => {
	if (process.platform === "win32") return;
	workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-export-large-")));
	sourceDir = path.join(workDir, "source");
	fs.mkdirSync(sourceDir, { mode: 0o700 });
	sessionFile = path.join(sourceDir, "session.jsonl");
	generated = await writeLargeTranscript(sessionFile, TARGET_BYTES);
	fs.chmodSync(sessionFile, 0o600);
	// Decoys a cleanup pass beside the source would delete or overwrite.
	const artifactRoot = sessionFile.slice(0, -".jsonl".length);
	fs.mkdirSync(artifactRoot, { mode: 0o700 });
	fs.writeFileSync(path.join(artifactRoot, "tool-output.txt"), "artifact payload", { mode: 0o600 });
	fs.writeFileSync(path.join(artifactRoot, "leftover.tmp"), "decoy temporary file", { mode: 0o600 });
	fs.writeFileSync(`${sessionFile}.spill.idx`, "decoy legacy sidecar", { mode: 0o600 });
	childScript = path.join(workDir, "export-child.ts");
	fs.writeFileSync(childScript, CHILD_SCRIPT);
}, 120_000);

afterAll(() => {
	if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

// Windows has no bounded loader: export there still refuses transcripts above the eager cap.
describe.skipIf(process.platform === "win32")("standalone HTML export of a transcript above the eager-load cap", () => {
	it("exports every entry with bounded memory and leaves the source and caches untouched", async () => {
		const transcriptBytes = fs.statSync(sessionFile).size;
		expect(transcriptBytes).toBeGreaterThan(RESUME_TRANSCRIPT_MAX_BYTES);
		const before = snapshotTree(sourceDir);
		const managedBefore = snapshotTreeIfPresent(getSessionsDir());
		const breadcrumbsBefore = snapshotTreeIfPresent(getTerminalSessionsDir());
		const instancesBefore = sidecarCacheInstances();
		const outputPath = path.join(workDir, "export.html");

		const baselineRssBytes = await runChild("baseline");
		const peakRssBytes = await runChild("export", outputPath);
		const exportRssBytes = peakRssBytes - baselineRssBytes;
		process.stderr.write(
			`large export: transcript ${transcriptBytes} bytes; child peak RSS ${peakRssBytes} bytes, ${baselineRssBytes} after loading modules only; export adds ${exportRssBytes} bytes (${(exportRssBytes / transcriptBytes).toFixed(2)}x the transcript)\n`,
		);
		// An eager load holds the bytes, the decoded string and the parsed entries at once, so it
		// needs several times the transcript; the bounded export must stay below one transcript.
		expect(exportRssBytes).toBeLessThan(transcriptBytes);

		expect(snapshotTree(sourceDir)).toEqual(before);
		expect(snapshotTreeIfPresent(getSessionsDir())).toEqual(managedBefore);
		expect(snapshotTreeIfPresent(getTerminalSessionsDir())).toEqual(breadcrumbsBefore);
		expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);

		const html = fs.readFileSync(outputPath, "utf8");
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1] ?? "";
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
			header: { id: string };
			entries: Array<{ id: string }>;
			leafId: string;
		};
		expect(data.header.id).toBe("large-export");
		expect(data.leafId).toBe(generated.leafId);
		expect(data.entries.length).toBe(generated.ids.length);
		expect(data.entries.every((entry, index) => entry.id === generated.ids[index])).toBe(true);
	}, 300_000);

	it("removes its private sidecar cache when interrupted with SIGINT", async () => {
		const before = snapshotTree(sourceDir);
		const instancesBefore = sidecarCacheInstances();
		const child = Bun.spawn([process.execPath, childScript, "hold", sessionFile, ""], {
			cwd: workDir,
			env: process.env,
			stdout: "pipe",
			stderr: "ignore",
		});
		// Interrupt once the snapshot is open and holds its private cache.
		const reader = child.stdout.getReader();
		let output = "";
		while (!output.includes("ready")) {
			const chunk = await reader.read();
			if (chunk.done) break;
			output += new TextDecoder().decode(chunk.value);
		}
		const heldInstances = newSidecarCacheInstances(instancesBefore).length;
		child.kill("SIGINT");
		const exitCode = await child.exited;

		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
			output += new TextDecoder().decode(chunk.value);
		// The child exits early, before its sleep ends and it reports RSS. Its code depends on
		// which SIGINT handler exits first (postmortem's 130, or the LSP client's 0), and either
		// way the cache must be gone.
		expect({ ready: output.includes("ready"), heldInstances, interrupted: [0, 130].includes(exitCode) }).toEqual({
			ready: true,
			heldInstances: 1,
			interrupted: true,
		});
		expect(output).not.toContain("maxRssKiB");
		expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
		expect(snapshotTree(sourceDir)).toEqual(before);
	}, 300_000);
});
