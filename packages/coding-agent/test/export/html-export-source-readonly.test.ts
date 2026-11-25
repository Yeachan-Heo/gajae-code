import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportFromFile, exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import {
	BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES,
	RESUME_TRANSCRIPT_MAX_BYTES,
	SessionManager,
	SessionManagerTestHooks,
} from "@gajae-code/coding-agent/session/session-manager";
import type { VerifiedSessionDeleteTarget } from "@gajae-code/coding-agent/session/session-storage";
import { getAgentDir, getSessionsDir, getSidecarCacheRootDir, getTerminalSessionsDir } from "@gajae-code/utils";

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
function coldEligibleTranscript(retired = 2_000): string {
	const records: Record<string, unknown>[] = [header("readonly-cold")];
	let parentId: string | null = null;
	for (let index = 0; index < retired; index++) {
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

/** Compacted history whose retired part holds an assistant turn with stale replay metadata. */
function coldStaleReplayTranscript(): string {
	const records: Record<string, unknown>[] = [
		header("readonly-cold-stale"),
		userEntry("stale-user", null, "question", 0),
		assistantEntry("stale-assistant", "stale-user", {
			content: [
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale-signature" },
				{ type: "text", text: "answer" },
			],
			providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] },
		}),
	];
	let parentId = "stale-assistant";
	for (let index = 0; index < 2_000; index++) {
		const id = `cold-stale-${index}`;
		records.push(userEntry(id, parentId, `cold-${index}-${"x".repeat(512)}`, index + 1));
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

/** `bounded`: whether the bounded loader used above the eager-load cap can serve the fixture. */
const FIXTURES: ReadonlyArray<{ name: string; build: () => string; bounded: boolean }> = [
	{ name: "stale replay metadata", build: staleReplayTranscript, bounded: false },
	{ name: "cold-eligible compacted history", build: coldEligibleTranscript, bounded: true },
	{ name: "pre-v5 transcript", build: legacyVersionTranscript, bounded: false },
	{ name: "existing patch records", build: patchBearingTranscript, bounded: false },
	{ name: "stale replay metadata in compacted history", build: coldStaleReplayTranscript, bounded: true },
];

interface TreeNode {
	kind: "file" | "directory" | "other";
	size: number;
	mtimeNs: bigint;
	ino: bigint;
	sha256?: string;
}

/**
 * Recursive listing of a directory: every file and directory with size, mtime, inode, and (unless
 * `hashFiles` is false, for multi-GiB sparse files) content hash.
 */
function snapshotTree(root: string, hashFiles = true): Record<string, TreeNode> {
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
				kind === "file" && hashFiles
					? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
					: undefined,
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
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = undefined;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Private sidecar-cache instances currently present under the isolated agent dir. */
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

/** Per-test timeout for bounded opens, which build sidecars and can exceed 5 s on a loaded runner. */
const BOUNDED_TEST_TIMEOUT_MS = 30_000;

/** Enough retired history for a bounded open while keeping its 37-row mutation table cheap. */
const SMALL_COLD_ENTRIES = 8;

/** Route every non-empty transcript through the bounded loader, as one above 128 MiB is. */
function forceBoundedSnapshot(): void {
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
}

/** Writes the transcript plus decoy derived files that a cleanup pass would delete. */
function seedSource(content: string): { sourceDir: string; sessionFile: string } {
	const sourceDir = makeTempDir("source");
	const sessionFile = path.join(sourceDir, "session.jsonl");
	fs.writeFileSync(sessionFile, content, { mode: 0o600 });
	const artifactRoot = sessionFile.slice(0, -".jsonl".length);
	fs.mkdirSync(artifactRoot, { mode: 0o700 });
	fs.writeFileSync(path.join(artifactRoot, "tool-output.txt"), "artifact payload", { mode: 0o600 });
	fs.writeFileSync(path.join(artifactRoot, "draft.txt"), "unsent draft", { mode: 0o600 });
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

// Windows lacks the owner-only private sidecar cache, so the bounded-mode cases below are POSIX-only.
const describePosix = describe.skipIf(process.platform === "win32");
const itPosix = it.skipIf(process.platform === "win32");

describePosix("standalone HTML export through the bounded loader leaves its source untouched", () => {
	const appendedAfterOpen: ReadonlyArray<{ name: string; bytes: string }> = [
		{
			name: "a complete message line",
			bytes: `${JSON.stringify(userEntry("appended", "compaction", "appended after open", 9_999))}\n`,
		},
		{ name: "a torn line", bytes: '{"type":"message","id":"torn","parentId":"compaction","timest' },
		{ name: "a header_patch", bytes: `${JSON.stringify({ type: "header_patch", patch: { title: "Later" } })}\n` },
	];
	for (const append of appendedAfterOpen) {
		it(
			`exports exactly the opened transcript when ${append.name} is appended after the open`,
			async () => {
				const content = coldEligibleTranscript(SMALL_COLD_ENTRIES);
				const reference = await referenceHtml(content);
				const { sessionFile } = seedSource(content);
				forceBoundedSnapshot();
				const snapshot = await SessionManager.openReadOnlySnapshot(sessionFile);
				const outputPath = path.join(makeTempDir("output"), "export.html");
				try {
					fs.appendFileSync(sessionFile, append.bytes);
					await exportSessionToHtml(snapshot, undefined, { outputPath });
				} finally {
					await snapshot.close();
				}
				expect(fs.readFileSync(outputPath, "utf8")).toBe(reference);
			},
			BOUNDED_TEST_TIMEOUT_MS,
		);
	}

	it(
		"names both causes of an incomplete last line met during the open",
		async () => {
			const { sourceDir, sessionFile } = seedSource(coldEligibleTranscript(SMALL_COLD_ENTRIES).slice(0, -1));
			const before = snapshotTree(sourceDir);
			const outputPath = path.join(makeTempDir("output"), "export.html");
			forceBoundedSnapshot();

			const refusal = await rejectionMessage(() => exportFromFile(sessionFile, { outputPath }));

			expect(refusal).toContain(
				"Session transcript's last line is incomplete (bounded_scan_unterminated): it is still being written, so retry when the session is idle, or an earlier write was interrupted, which retrying does not fix",
			);
			expect(snapshotTree(sourceDir)).toEqual(before);
			expect(fs.existsSync(outputPath)).toBe(false);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	it(
		"keeps an existing output when a bounded export fails midway through its scan",
		async () => {
			const { sessionFile } = seedSource(coldEligibleTranscript(SMALL_COLD_ENTRIES));
			const outputDir = makeTempDir("output");
			const outputPath = path.join(outputDir, "export.html");
			fs.writeFileSync(outputPath, "previous good export", { mode: 0o600 });
			const outputBefore = snapshotTree(outputDir)["export.html"];
			forceBoundedSnapshot();
			const snapshot = await SessionManager.openReadOnlySnapshot(sessionFile);
			const visit = snapshot.visitEntriesForExport.bind(snapshot);
			// Emit every entry, then fail: the page is already partly written when the scan breaks.
			const spy = vi.spyOn(snapshot, "visitEntriesForExport").mockImplementation(visitor => {
				visit(visitor);
				throw new Error("scan failed midway");
			});
			let refusal: string | undefined;
			try {
				refusal = await rejectionMessage(() => exportSessionToHtml(snapshot, undefined, { outputPath }));
			} finally {
				spy.mockRestore();
				await snapshot.close();
			}
			expect(refusal).toBe("scan failed midway");
			expect(snapshotTree(outputDir)["export.html"]).toEqual(outputBefore);
			expect(fs.readdirSync(outputDir)).toEqual(["export.html"]);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform !== "darwin")(
		"opens a non-regular target in place, as every other export does",
		async () => {
			const { sessionFile } = seedSource(coldEligibleTranscript(SMALL_COLD_ENTRIES));
			forceBoundedSnapshot();
			// Same outcome as the eager path below: the in-place open's fchmod, not a temp file under /dev.
			expect(await rejectionMessage(() => exportFromFile(sessionFile, { outputPath: "/dev/null" }))).toBe(
				"EPERM: operation not permitted, fchmod",
			);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	const changedAfterOpen: ReadonlyArray<{ name: string; change: (sessionFile: string) => void }> = [
		{
			name: "replaced by a rename",
			change: sessionFile => {
				const replacement = `${sessionFile}.replacement`;
				fs.writeFileSync(replacement, coldEligibleTranscript(SMALL_COLD_ENTRIES + 1), { mode: 0o600 });
				fs.renameSync(replacement, sessionFile);
			},
		},
		{ name: "truncated", change: sessionFile => fs.truncateSync(sessionFile, 64) },
	];
	for (const variant of changedAfterOpen) {
		it(
			`refuses a source ${variant.name} after the open and keeps the previous export`,
			async () => {
				const { sessionFile } = seedSource(coldEligibleTranscript(SMALL_COLD_ENTRIES));
				const outputDir = makeTempDir("output");
				const outputPath = path.join(outputDir, "export.html");
				fs.writeFileSync(outputPath, "previous good export", { mode: 0o600 });
				const outputBefore = snapshotTree(outputDir);
				forceBoundedSnapshot();
				const snapshot = await SessionManager.openReadOnlySnapshot(sessionFile);
				let refusal: string | undefined;
				try {
					variant.change(sessionFile);
					refusal = await rejectionMessage(() => exportSessionToHtml(snapshot, undefined, { outputPath }));
				} finally {
					await snapshot.close();
				}
				expect(refusal).toBe("Session transcript was replaced or truncated after the read-only snapshot opened");
				// The previous export is neither truncated nor replaced, and no temp file is left beside it
				// (the directory itself changes: the temp file was created and removed there).
				expect(snapshotTree(outputDir)["export.html"]).toEqual(outputBefore["export.html"]);
				expect(fs.readdirSync(outputDir)).toEqual(["export.html"]);
			},
			BOUNDED_TEST_TIMEOUT_MS,
		);
	}

	it(
		"matches the eager export for a transcript inside the managed session store",
		async () => {
			const content = coldEligibleTranscript();
			const reference = await referenceHtml(content);
			const projectDir = path.join(getSessionsDir(), "--export-bounded-probe--");
			fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
			try {
				const sessionFile = path.join(projectDir, "session.jsonl");
				fs.writeFileSync(sessionFile, content, { mode: 0o600 });
				fs.writeFileSync(`${sessionFile}.spill.idx`, "decoy legacy sidecar", { mode: 0o600 });
				const managedBefore = snapshotTree(getSessionsDir());
				const instancesBefore = sidecarCacheInstances();
				const outputPath = path.join(makeTempDir("output"), "export.html");
				forceBoundedSnapshot();

				await exportFromFile(sessionFile, { outputPath });

				expect(fs.readFileSync(outputPath, "utf8")).toBe(reference);
				expect(snapshotTree(getSessionsDir())).toEqual(managedBefore);
				expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
			} finally {
				fs.rmSync(projectDir, { recursive: true, force: true });
			}
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	for (const fixture of FIXTURES) {
		it(
			`${fixture.bounded ? "matches the eager export" : "refuses"} without touching the source (${fixture.name})`,
			async () => {
				const content = fixture.build();
				const reference = await referenceHtml(content);
				const { sourceDir, sessionFile } = seedSource(content);
				const before = snapshotTree(sourceDir);
				const managedBefore = snapshotTreeIfPresent(getSessionsDir());
				const instancesBefore = sidecarCacheInstances();
				const outputPath = path.join(makeTempDir("output"), "export.html");
				forceBoundedSnapshot();

				const outcome = await rejectionMessage(() => exportFromFile(sessionFile, { outputPath }));

				if (fixture.bounded) {
					expect(outcome).toBeUndefined();
					expect(fs.readFileSync(outputPath, "utf8")).toBe(reference);
				} else {
					expect(outcome).toContain("cannot be streamed (bounded_scan_");
					expect(fs.existsSync(outputPath)).toBe(false);
				}
				expect(fs.readFileSync(sessionFile, "utf8")).toBe(content);
				expect(snapshotTree(sourceDir)).toEqual(before);
				expect(snapshotTreeIfPresent(getSessionsDir())).toEqual(managedBefore);
				expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
			},
			BOUNDED_TEST_TIMEOUT_MS,
		);
	}
});

/** Opens a bounded snapshot of argv[2] in a child process and waits to be interrupted. */
const HOLD_SNAPSHOT_SCRIPT = `import { SessionManager, SessionManagerTestHooks } from ${JSON.stringify(
	path.resolve(import.meta.dir, "../../src/session/session-manager.ts"),
)};
SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
await SessionManager.openReadOnlySnapshot(process.argv[2]);
process.stdout.write("ready\\n");
await Bun.sleep(120_000);
process.stdout.write("not interrupted\\n");
`;

describePosix("bounded read-only snapshot in a separate process", () => {
	it(
		"removes its private sidecar cache when interrupted with SIGINT",
		async () => {
			const { sourceDir, sessionFile } = seedSource(coldEligibleTranscript(SMALL_COLD_ENTRIES));
			const script = path.join(makeTempDir("child"), "hold-snapshot.ts");
			fs.writeFileSync(script, HOLD_SNAPSHOT_SCRIPT);
			const before = snapshotTree(sourceDir);
			const instancesBefore = sidecarCacheInstances();
			const child = Bun.spawn([process.execPath, script, sessionFile], {
				env: process.env,
				stdout: "pipe",
				stderr: "ignore",
			});
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

			// The exit code depends on which SIGINT handler exits first (postmortem's 130, or the LSP
			// client's 0); either way the child stops before its sleep ends and the cache is gone.
			expect({ output, heldInstances, interrupted: [0, 130].includes(exitCode) }).toEqual({
				output: "ready\n",
				heldInstances: 1,
				interrupted: true,
			});
			expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
			expect(snapshotTree(sourceDir)).toEqual(before);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);
});

describe("standalone and live HTML exports below the eager cap write the output in place", () => {
	it("keeps the existing output's inode for an eager snapshot and a live session", async () => {
		const content = staleReplayTranscript();
		const { sessionFile } = seedSource(content);
		const outputDir = makeTempDir("output");
		const outputPath = path.join(outputDir, "export.html");
		fs.writeFileSync(outputPath, "previous export", { mode: 0o600 });
		const inode = fs.statSync(outputPath).ino;

		await exportFromFile(sessionFile, { outputPath });
		expect(fs.statSync(outputPath).ino).toBe(inode);
		expect(fs.readFileSync(outputPath, "utf8")).toBe(await referenceHtml(content));

		const live = await SessionManager.open(sessionFile, undefined, undefined, "copy-retain", "off");
		try {
			await exportSessionToHtml(live, undefined, { outputPath });
		} finally {
			await live.close();
		}
		expect(fs.statSync(outputPath).ino).toBe(inode);
		expect(fs.readdirSync(outputDir)).toEqual(["export.html"]);
	});

	it.skipIf(process.platform !== "darwin")("opens a character device target in place, as before", async () => {
		const { sessionFile } = seedSource(staleReplayTranscript());
		// Unchanged behaviour: macOS refuses the owner-only fchmod on /dev/null, so this export fails there.
		expect(await rejectionMessage(() => exportFromFile(sessionFile, { outputPath: "/dev/null" }))).toBe(
			"EPERM: operation not permitted, fchmod",
		);
	});
});

describe("standalone HTML export side effects outside the source", () => {
	itPosix(
		"refuses a transcript above the eager-load limit that the bounded loader cannot read",
		async () => {
			const { sourceDir, sessionFile } = seedSource(jsonl([header("readonly-oversized")]));
			// Sparse: past the header line the file is NUL bytes, which the bounded scan rejects.
			fs.truncateSync(sessionFile, RESUME_TRANSCRIPT_MAX_BYTES + 1);
			const before = snapshotTree(sourceDir);
			const instancesBefore = sidecarCacheInstances();
			const outputPath = path.join(makeTempDir("output"), "export.html");

			await expect(exportFromFile(sessionFile, { outputPath })).rejects.toThrow(
				`Session transcript is too large to export in full (${RESUME_TRANSCRIPT_MAX_BYTES + 1} bytes; limit ${RESUME_TRANSCRIPT_MAX_BYTES} bytes) and cannot be streamed (bounded_scan_`,
			);

			expect(snapshotTree(sourceDir)).toEqual(before);
			expect(fs.existsSync(outputPath)).toBe(false);
			expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	itPosix(
		"refuses a transcript above the bounded-load limit without reading it",
		async () => {
			const { sourceDir, sessionFile } = seedSource(jsonl([header("readonly-oversized-bounded")]));
			// Sparse: the size check runs on stat before any read.
			fs.truncateSync(sessionFile, BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES + 1);
			const before = snapshotTree(sourceDir, false);
			const instancesBefore = sidecarCacheInstances();
			const outputPath = path.join(makeTempDir("output"), "export.html");

			await expect(exportFromFile(sessionFile, { outputPath })).rejects.toThrow(
				`Session transcript is too large to export (${BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES + 1} bytes; limit ${BOUNDED_RESUME_TRANSCRIPT_MAX_BYTES} bytes)`,
			);

			expect(snapshotTree(sourceDir, false)).toEqual(before);
			expect(fs.existsSync(outputPath)).toBe(false);
			expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	it("does not repoint this terminal's --continue breadcrumb at the exported session", async () => {
		const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
		process.env.TMUX = "export-readonly-test";
		process.env.TMUX_PANE = "%export-readonly";
		try {
			const { sessionFile } = seedSource(staleReplayTranscript());
			const breadcrumbsBefore = snapshotTreeIfPresent(getTerminalSessionsDir());
			const outputPath = path.join(makeTempDir("output"), "export.html");

			await exportFromFile(sessionFile, { outputPath });
			// The breadcrumb write is fire-and-forget; give one that was issued time to land.
			await Bun.sleep(100);

			expect(snapshotTreeIfPresent(getTerminalSessionsDir())).toEqual(breadcrumbsBefore);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

async function rejectionMessage(action: () => unknown): Promise<string | undefined> {
	try {
		await action();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

/** A v1 transcript (no entry ids) with an index-based compaction, migrated on load. */
function legacyV1CompactedTranscript(): string {
	const records: Record<string, unknown>[] = [
		{ type: "session", id: "readonly-v1", timestamp: TIMESTAMP, cwd: "/cwd" },
	];
	for (let index = 0; index < 2_000; index++) {
		records.push({
			type: "message",
			timestamp: TIMESTAMP,
			message: { role: "user", content: `v1-${index}-${"x".repeat(512)}`, timestamp: index },
		});
	}
	records.push({
		type: "message",
		timestamp: TIMESTAMP,
		message: { role: "user", content: "v1 kept", timestamp: 2_001 },
	});
	records.push({
		type: "compaction",
		timestamp: TIMESTAMP,
		summary: "summary",
		firstKeptEntryIndex: 2_001,
		tokensBefore: 2_000,
	});
	return jsonl(records);
}

describe("standalone HTML export of legacy and vanished sources", () => {
	it("exports a v1 transcript with a compaction without touching it", async () => {
		const content = legacyV1CompactedTranscript();
		const { sourceDir, sessionFile } = seedSource(content);
		const before = snapshotTree(sourceDir);
		const outputPath = path.join(makeTempDir("output"), "export.html");

		await exportFromFile(sessionFile, { outputPath });

		expect(snapshotTree(sourceDir)).toEqual(before);
		const encoded = fs
			.readFileSync(outputPath, "utf8")
			.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
		const data = JSON.parse(Buffer.from(encoded?.[1] ?? "", "base64").toString("utf8")) as { entries: unknown[] };
		expect(data.entries).toHaveLength(2_002);
		expect(JSON.stringify(data.entries)).toContain("v1 kept");
	});

	it("reports a missing source as ENOENT instead of creating a session", async () => {
		const sessionFile = path.join(makeTempDir("vanished"), "session.jsonl");
		const error = await rejectionMessage(() => SessionManager.openReadOnlySnapshot(sessionFile));
		expect(error).toStartWith("ENOENT");
		expect(fs.existsSync(sessionFile)).toBe(false);
	});
});

/**
 * Runs every guarded mutation on a fresh snapshot of `transcript` and asserts each is refused and the
 * source tree is unchanged. `targetId` names an entry of `transcript`; `onOpen` inspects each snapshot.
 */
async function assertSnapshotRefusesMutations(
	transcript: string,
	sessionId: string,
	targetId: string,
	onOpen: (snapshot: SessionManager) => void = () => {},
	stateSource?: SessionManager,
): Promise<void> {
	{
		// The header cwd must exist, or moveTo fails for an unrelated reason.
		const cwd = makeTempDir("cwd");
		const content = transcript.replace('"cwd":"/cwd"', `"cwd":${JSON.stringify(cwd)}`);
		const { sourceDir, sessionFile } = seedSource(content);
		const draftPath = path.join(sessionFile.slice(0, -".jsonl".length), "draft.txt");
		// A sibling transcript that discard/delete calls could target.
		const siblingFile = path.join(sourceDir, "sibling.jsonl");
		fs.writeFileSync(siblingFile, jsonl([header("readonly-sibling")]), { mode: 0o600 });
		const moveTarget = makeTempDir("move-target");
		const adoptDir = makeTempDir("adopt");
		const aliasLink = path.join(makeTempDir("alias"), "source-link");
		fs.symlinkSync(sourceDir, aliasLink, "dir");
		const aliasedSessionFile = path.join(aliasLink, path.basename(sessionFile));
		const savedArtifact = path.join(sessionFile.slice(0, -".jsonl".length), "7.bash.log");
		fs.writeFileSync(savedArtifact, "saved artifact", { mode: 0o600 });
		const forkTarget = path.join(makeTempDir("fork-target"), "fork.jsonl");
		const stat = fs.statSync(sessionFile, { bigint: true });
		const deleteTarget: VerifiedSessionDeleteTarget = {
			sessionsRoot: sourceDir,
			transcriptPath: sessionFile,
			sessionId,
			cwd,
			transcriptIdentity: {
				dev: stat.dev,
				ino: stat.ino,
				size: Number(stat.size),
				mtimeNs: stat.mtimeNs,
				sha256: crypto.createHash("sha256").update(content).digest("hex"),
			},
		};
		const mutations: Record<string, (snapshot: SessionManager) => unknown> = {
			appendMessage: snapshot => snapshot.appendMessage({ role: "user", content: "probe", timestamp: 2 }),
			appendCustomEntry: snapshot => snapshot.appendCustomEntry("probe", { value: 1 }),
			appendModelChange: snapshot => snapshot.appendModelChange("openai/test"),
			appendThinkingLevelChange: snapshot => snapshot.appendThinkingLevelChange("high"),
			appendLabelChange: snapshot => snapshot.appendLabelChange(targetId, "label"),
			appendCompaction: snapshot => snapshot.appendCompaction("summary", "short", targetId, 1),
			setSessionName: snapshot => snapshot.setSessionName("Renamed", "user"),
			setSessionStarred: snapshot => snapshot.setSessionStarred(true),
			branch: snapshot => snapshot.branch(targetId),
			resetLeaf: snapshot => snapshot.resetLeaf(),
			rewriteEntries: snapshot => snapshot.rewriteEntries(),
			ensureOnDisk: snapshot => snapshot.ensureOnDisk(),
			newSession: snapshot => snapshot.newSession(),
			sanitizeLoadedOpenAIResponsesReplayMetadata: snapshot =>
				snapshot.sanitizeLoadedOpenAIResponsesReplayMetadata(),
			setSessionMemoryModeEnabled: snapshot => snapshot.setSessionMemoryMode("enabled"),
			fork: snapshot => snapshot.fork(),
			prepareFork: snapshot => snapshot.prepareFork(),
			saveDraftText: snapshot => snapshot.saveDraft("replacement draft"),
			saveDraftEmpty: snapshot => snapshot.saveDraft(""),
			consumeDraft: snapshot => snapshot.consumeDraft(),
			saveArtifact: snapshot => snapshot.saveArtifact("artifact body", "bash"),
			allocateArtifactPath: snapshot => snapshot.allocateArtifactPath("bash"),
			copyArtifactsForFork: snapshot => snapshot.copyArtifactsForFork(sessionFile, forkTarget),
			putBlob: snapshot => snapshot.putBlob(Buffer.from("snapshot blob")),
			stageDefaultModelSelection: snapshot => snapshot.stageDefaultModelSelection("openai/test", undefined),
			deleteSessionVerified: snapshot => snapshot.deleteSessionVerified(deleteTarget),
			discardUncommittedSession: snapshot => snapshot.discardUncommittedSession(siblingFile),
			restoreState: snapshot => snapshot.restoreState((stateSource ?? snapshot).captureState()),
			restoreRollbackState: async snapshot => snapshot.restoreRollbackState(await snapshot.captureRollbackState()),
			adoptArtifactManager: snapshot => snapshot.adoptArtifactManager(new ArtifactManager(adoptDir)),
			stageAdoptedArtifactManagerForTransition: snapshot => snapshot.stageAdoptedArtifactManagerForTransition(),
			// For the two artifact getters, a null manager is the refusal.
			getArtifactManager: async snapshot => {
				const manager = snapshot.getArtifactManager();
				if (manager) await manager.removeNamedBestEffort("draft.txt");
				else throw new Error("read_only_snapshot");
			},
			ensureArtifactManager: async snapshot => {
				const manager = await snapshot.ensureArtifactManager();
				if (manager) await manager.removeNamedBestEffort("draft.txt");
				else throw new Error("read_only_snapshot");
			},
			dropSession: snapshot => snapshot.dropSession(sessionFile),
			dropSessionOther: snapshot => snapshot.dropSession(siblingFile),
			// Near last: without the guard it moves the source transcript away.
			moveTo: snapshot => snapshot.moveTo(moveTarget),
			// Last: opened and dropped through a directory symlink, so the stored canonical path
			// and the requested path differ; without the guard this deletes the source.
			dropSessionViaDirectoryAlias: async () => {
				const aliased = await SessionManager.openReadOnlySnapshot(aliasedSessionFile);
				try {
					await aliased.dropSession(aliasedSessionFile);
				} finally {
					await aliased.close();
				}
			},
		};
		const before = snapshotTree(sourceDir);
		const outcomes: Record<string, { refusal: string | undefined; sourceUnchanged: boolean }> = {};
		for (const [name, mutate] of Object.entries(mutations)) {
			// A fresh snapshot per call, so one accepted mutation cannot mask the next.
			// Without the guard an earlier row may delete the draft; reseed it so each row is judged alone.
			if (!fs.existsSync(draftPath)) fs.writeFileSync(draftPath, "unsent draft", { mode: 0o600 });
			const rowBefore = snapshotTree(sourceDir);
			const snapshot = await SessionManager.openReadOnlySnapshot(sessionFile);
			expect(snapshot.isReadOnlySnapshot()).toBe(true);
			let refusal: string | undefined;
			try {
				onOpen(snapshot);
				refusal = await rejectionMessage(() => mutate(snapshot));
			} finally {
				await snapshot.close();
			}
			outcomes[name] = { refusal, sourceUnchanged: Bun.deepEquals(snapshotTree(sourceDir), rowBefore) };
		}
		expect(outcomes).toEqual(
			Object.fromEntries(
				Object.keys(mutations).map(name => [name, { refusal: "read_only_snapshot", sourceUnchanged: true }]),
			),
		);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(content);
		expect(snapshotTree(sourceDir)).toEqual(before);
		// Artifact path resolution is a read and still works on a snapshot.
		const reader = await SessionManager.openReadOnlySnapshot(sessionFile);
		try {
			expect(await reader.getArtifactPath("7")).toBe(savedArtifact);
		} finally {
			await reader.close();
		}
		expect(snapshotTree(sourceDir)).toEqual(before);
	}
}

describe("read-only session snapshot", () => {
	it("refuses the guarded mutations and leaves the source untouched", async () => {
		await assertSnapshotRefusesMutations(staleReplayTranscript(), "readonly-stale-replay", "user");
	});

	itPosix(
		"refuses the guarded mutations on a bounded snapshot and leaves the source untouched",
		async () => {
			// A cold snapshot cannot capture its state, so restoreState gets one from an eager snapshot
			// of a copy; the read-only guard runs before the state is examined.
			const stateFile = path.join(makeTempDir("state"), "session.jsonl");
			fs.writeFileSync(stateFile, coldEligibleTranscript(SMALL_COLD_ENTRIES), { mode: 0o600 });
			const stateSource = await SessionManager.openReadOnlySnapshot(stateFile);
			const instancesBefore = sidecarCacheInstances();
			forceBoundedSnapshot();
			try {
				await assertSnapshotRefusesMutations(
					coldEligibleTranscript(SMALL_COLD_ENTRIES),
					"readonly-cold",
					"kept",
					snapshot => {
						const stats = snapshot.getSessionMemoryStats();
						expect({ succeeded: stats.lazyReopenSucceeded, cold: stats.coldRetirementActive }).toEqual({
							succeeded: true,
							cold: true,
						});
						// The open snapshot holds exactly one private sidecar cache.
						expect(newSidecarCacheInstances(instancesBefore)).toHaveLength(1);
					},
					stateSource,
				);
			} finally {
				await stateSource.close();
			}
			expect(newSidecarCacheInstances(instancesBefore)).toEqual([]);
		},
		BOUNDED_TEST_TIMEOUT_MS,
	);

	it("leaves normally opened sessions writable", async () => {
		const { sessionFile } = seedSource(staleReplayTranscript());
		const manager = await SessionManager.open(sessionFile, undefined, undefined, "copy-retain", "off");
		try {
			expect(manager.isReadOnlySnapshot()).toBe(false);
			manager.appendMessage({ role: "user", content: "normal append", timestamp: 2 });
			await manager.flush();
		} finally {
			await manager.close();
		}
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("normal append");
	});
});
