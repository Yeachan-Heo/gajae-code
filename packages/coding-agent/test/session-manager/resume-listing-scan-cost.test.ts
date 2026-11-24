import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	parseStoredSessionEntries,
} from "@gajae-code/coding-agent/sdk/session-readonly/format";
import {
	applySessionListHeaderPatch,
	readSessionListTrailingPatches,
	type SessionListHeader,
} from "@gajae-code/coding-agent/sdk/session-readonly/metadata";
import { FileSessionReader } from "@gajae-code/coding-agent/sdk/session-readonly/storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import fc from "fast-check";

/**
 * Resume listing reads every candidate transcript's trailing bytes to recover a
 * possibly-buried `header_patch` (#3633). A transcript that never emitted one —
 * the common case, since only `/rename` and workspace moves do — cannot be
 * recognized as such without reaching BOF, so the whole file is walked.
 *
 * These tests pin the read cost of that walk. They assert syscall counts rather
 * than wall-clock so they stay deterministic on slow or loaded CI machines.
 */
describe("resume listing trailing-patch scan cost", () => {
	let testDir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	function writeTranscript(
		sessionDir: string,
		cwd: string,
		sessionId: string,
		targetBytes: number,
		starCapable = true,
	): string {
		const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
		const lines: string[] = [
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				...(starCapable ? { starredPatchVersion: 1 } : {}),
				id: sessionId,
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd,
				title: "header-title",
			}),
		];
		let bytes = Buffer.byteLength(`${lines[0]}\n`);
		for (let index = 0; bytes < targetBytes; index++) {
			const line = JSON.stringify({
				type: "message",
				id: `m-${index}`,
				parentId: index === 0 ? null : `m-${index - 1}`,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `payload ${index}: ${"x".repeat(2000)}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "synthetic-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: index + 1,
				},
			});
			lines.push(line);
			bytes += Buffer.byteLength(`${line}\n`);
		}
		fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);
		return sessionFile;
	}

	/** Counts reads issued against the transcript, not against unrelated files. */
	function countReadsFor(target: string): { reads: () => number; bytes: () => number } {
		let reads = 0;
		let bytes = 0;
		const realOpen = fs.promises.open;
		vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
			const handle = await realOpen(...args);
			if (path.resolve(String(args[0])) !== path.resolve(target)) return handle;
			const realRead = handle.read.bind(handle);
			handle.read = (async (...readArgs: unknown[]) => {
				const result = await (realRead as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...readArgs);
				reads++;
				bytes += result.bytesRead;
				return result;
			}) as typeof handle.read;
			return handle;
		});
		return { reads: () => reads, bytes: () => bytes };
	}

	it("does not issue one read syscall per 4 KiB when a transcript has no header patch", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-cost-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-cost", 4 * 1024 * 1024);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-cost")?.title).toBe("header-title");

		// Before the fix the reverse scan borrowed the caller's 4 KiB prefix
		// buffer, so a transcript with no header_patch cost size/4096 reads.
		const readsAtFourKiB = Math.ceil(size / 4096);
		expect(counter.reads()).toBeLessThan(readsAtFourKiB / 4);
	});

	it("does not join scanned chunks into new buffers when a transcript has no header patch", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-copy-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-copy", 4 * 1024 * 1024);
		const size = fs.statSync(sessionFile).size;
		let copiedBytes = 0;
		const realConcat = Buffer.concat;
		vi.spyOn(Buffer, "concat").mockImplementation((...args: Parameters<typeof Buffer.concat>) => {
			const joined = realConcat(...args);
			copiedBytes += joined.byteLength;
			return joined;
		});

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-copy")?.title).toBe("header-title");

		// Counts bytes returned by Buffer.concat during the listing. The walk reaches
		// BOF, so joining each chunk to its carried partial line copied the whole
		// transcript once more on every listing.
		expect(copiedBytes).toBeLessThan(size / 4);
	});

	it("finds a header patch whose marker is split across a scan chunk boundary", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-split-marker-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		// Mirrors the scanner's 64 KiB chunk: chunk edges sit at multiples of it from EOF.
		const chunkBytes = 64 * 1024;
		const marker = "header_patch";
		const splits = Array.from({ length: marker.length - 1 }, (_, index) => index + 1);
		for (const bytesBeforeEdge of splits) {
			const id = `split-${bytesBeforeEdge}`;
			const header = JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id,
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd,
				title: "header-title",
			});
			const padding = JSON.stringify({ type: "custom", customType: "padding", data: "p".repeat(chunkBytes) });
			// Title only, so the temp path cannot add another marker occurrence after the type field.
			const patch = JSON.stringify({ type: "header_patch", patch: { title: `renamed-${bytesBeforeEdge}` } });
			// Size the last line so `bytesBeforeEdge` marker bytes fall before the chunk edge
			// and the rest after it. Offsets are UTF-8 bytes; the temp path may be non-ASCII.
			const markerFromEof = chunkBytes + bytesBeforeEdge;
			const patchBytesFromMarker = Buffer.byteLength(patch.slice(patch.indexOf(marker)));
			const filler = "f".repeat(markerFromEof - patchBytesFromMarker - 2);
			const content = Buffer.from(`${header}\n${padding}\n${patch}\n${filler}\n`);
			expect(content.byteLength - content.lastIndexOf(marker)).toBe(markerFromEof);
			fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), content);
		}

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		for (const bytesBeforeEdge of splits) {
			const listed = candidates.find(item => item.id === `split-${bytesBeforeEdge}`);
			expect(listed?.title).toBe(`renamed-${bytesBeforeEdge}`);
		}
	});

	it("keeps legacy metadata patches bounded when the star capability is absent", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-legacy-patch-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-legacy-patch", 4 * 1024 * 1024, false);
		fs.appendFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "header_patch",
				patch: { cwd, title: "renamed-without-star-state" },
			})}\n`,
		);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-legacy-patch")).toMatchObject({
			title: "renamed-without-star-state",
			starred: false,
		});

		// A transcript without the star capability cannot contain star patches, so
		// resolving its title/cwd patch retains the pre-feature bounded behavior.
		expect(counter.bytes()).toBeLessThan(size / 2);
	});

	it("still stops early when every mutable header field is patched near EOF", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-early-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });

		const sessionFile = writeTranscript(sessionDir, cwd, "scan-early", 4 * 1024 * 1024);
		fs.appendFileSync(
			sessionFile,
			`${[
				{
					type: "header_patch",
					patch: { cwd, title: "renamed-near-eof" },
				},
				{ type: "header_patch", patch: { starred: false } },
			]
				.map(record => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const size = fs.statSync(sessionFile).size;
		const counter = countReadsFor(sessionFile);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "scan-early")?.title).toBe("renamed-near-eof");

		// A patch in the final chunk must not drag the scan across the transcript.
		expect(counter.bytes()).toBeLessThan(size / 2);
	});

	it("recognizes star capability in an oversized header prefix fallback", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-oversized-header-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, "oversized-header.jsonl");
		const records = [
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				starredPatchVersion: 1,
				id: "oversized-header",
				timestamp: "2026-08-16T00:00:00.000Z",
				cwd,
				title: "oversized",
				parentSession: "x".repeat(8 * 1024),
			},
			{
				type: "message",
				id: "message",
				parentId: null,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
			{ type: "header_patch", patch: { starred: true } },
		];
		fs.writeFileSync(sessionFile, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(candidates.find(item => item.id === "oversized-header")).toMatchObject({
			title: "oversized",
			starred: true,
		});
	});

	it("fails closed on inexact or non-top-level oversized header capabilities", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-invalid-capability-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const padding = "x".repeat(8 * 1024);
		const cases = [
			{ id: "fractional", capability: `"starredPatchVersion":1.5,"parentSession":${JSON.stringify(padding)}` },
			{
				id: "nested",
				capability: `"metadata":{"starredPatchVersion":1},"parentSession":${JSON.stringify(padding)}`,
			},
			{
				id: "duplicate",
				capability: `"starredPatchVersion":1,"starredPatchVersion":0,"parentSession":${JSON.stringify(padding)}`,
			},
			{
				id: "late",
				capability: `"parentSession":${JSON.stringify(padding)},"starredPatchVersion":1`,
			},
		];

		for (const { id, capability } of cases) {
			const header = `{"type":"session","version":${CURRENT_SESSION_VERSION},"id":"${id}","timestamp":"2026-08-16T00:00:00.000Z","cwd":${JSON.stringify(cwd)},"title":"${id}",${capability}}`;
			const message = JSON.stringify({
				type: "message",
				id: `${id}-message`,
				parentId: null,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			});
			const starPatch = JSON.stringify({ type: "header_patch", patch: { starred: true } });
			fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), `${header}\n${message}\n${starPatch}\n`);
		}

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		for (const { id } of cases) {
			expect(candidates.find(item => item.id === id)?.starred).toBe(false);
		}
	});

	it("uses top-level last-value semantics for inline star state", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-inline-star-"));
		const cwd = path.join(testDir, "cwd");
		const sessionDir = path.join(testDir, "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		const padding = JSON.stringify("x".repeat(8 * 1024));
		const cases = [
			{ id: "nested-star", fields: '"metadata":{"starred":true}', expected: false },
			{ id: "duplicate-false", fields: '"starred":true,"starred":false', expected: false },
			{ id: "duplicate-true", fields: '"starred":false,"starred":true', expected: true },
		];

		for (const { id, fields } of cases) {
			const header = `{"type":"session","version":${CURRENT_SESSION_VERSION},"starredPatchVersion":1,"id":"${id}","timestamp":"2026-08-16T00:00:00.000Z","cwd":${JSON.stringify(cwd)},"title":"${id}",${fields},"parentSession":${padding}}`;
			const message = JSON.stringify({
				type: "message",
				id: `${id}-message`,
				parentId: null,
				timestamp: "2026-08-16T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			});
			fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), `${header}\n${message}\n`);
		}

		const candidates = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		for (const { id, expected } of cases) {
			expect(candidates.find(item => item.id === id)?.starred).toBe(expected);
		}
	});

	// The listing takes the header line and applies the patches returned by the reverse
	// scan. On any transcript that result must equal the header the canonical loader
	// builds by parsing the whole file, for every field the listing asked for.
	const textArb = fc.oneof(
		fc.string({ unit: "grapheme", maxLength: 24 }),
		fc.string({ unit: "binary", maxLength: 24 }),
		fc.constantFrom("header_patch", '{"type":"header_patch"', "헤더", "가".repeat(30_000), "é"),
	);
	const patchArb = fc.record(
		{
			cwd: textArb,
			title: textArb,
			titleSource: fc.constantFrom("auto", "user"),
			starred: fc.boolean(),
		},
		{ requiredKeys: [] },
	);
	const recordArb = fc.oneof(
		{ weight: 4, arbitrary: patchArb.map(patch => JSON.stringify({ type: "header_patch", patch })) },
		// Rejected by the canonical record check: wrong field type or an unknown key.
		{
			weight: 1,
			arbitrary: patchArb.map(patch =>
				JSON.stringify({ type: "header_patch", patch: { ...patch, starred: "yes" } }),
			),
		},
		{ weight: 1, arbitrary: patchArb.map(patch => JSON.stringify({ type: "header_patch", patch, extra: 1 })) },
		// Lines that are not JSON, some carrying the marker. They start with `#` so the
		// streaming canonical parser cannot read them as the start of a multi-line value.
		{
			weight: 2,
			arbitrary: fc
				.oneof(
					fc.string({ unit: "grapheme", maxLength: 24 }),
					patchArb.map(patch => JSON.stringify({ type: "header_patch", patch })),
				)
				.map(text => `#${text.replace(/[\r\n]/g, " ")}`),
		},
		// Messages, some long enough to cross several 64 KiB scan chunks.
		{
			weight: 4,
			arbitrary: fc.tuple(textArb, fc.nat({ max: 140_000 }), fc.boolean()).map(([text, length, long]) =>
				JSON.stringify({
					type: "message",
					id: `m-${length}`,
					parentId: null,
					timestamp: "2026-08-16T00:00:01.000Z",
					message: { role: "user", content: `${text}${long ? "x".repeat(length) : ""}`, timestamp: 1 },
				}),
			),
		},
	);
	// A last record cut short with no trailing newline, as a crash mid-write leaves it.
	const truncatedTailArb = fc.tuple(patchArb, fc.nat()).map(([patch, cut]) => {
		const line = JSON.stringify({ type: "header_patch", patch: { ...patch, title: "t" } });
		return line.slice(0, 1 + (cut % (line.length - 1)));
	});

	it("property: reverse scan plus header equals the canonical loader, fc.asyncProperty seed 7991, numRuns 120", async () => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-scan-property-"));
		const file = path.join(testDir, "session.jsonl");
		const storage = new FileSessionReader();
		const headerLine = JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			starredPatchVersion: 1,
			id: "property",
			timestamp: "2026-08-16T00:00:00.000Z",
			cwd: "/header-cwd",
			title: "header-title",
			starred: false,
			parentSession: "p".repeat(4096),
		});
		const marker = "header_patch";
		await fc.assert(
			fc.asyncProperty(
				fc.array(recordArb, { maxLength: 40, size: "medium" }),
				fc.oneof(
					fc.constant({ kind: "plain" as const }),
					fc.record({ kind: fc.constant("truncated" as const), tail: truncatedTailArb }),
					// Place the last marker so the first scan chunk starts `offset` bytes into
					// it. Offsets 1 to 11 split the marker between the chunk and the carried
					// fragment, which covers the seam check.
					fc.record({
						kind: fc.constant("seam" as const),
						offset: fc.integer({ min: -(marker.length - 1), max: 16 }),
					}),
				),
				fc.boolean(),
				async (records, ending, includeStarred) => {
					let content = `${[headerLine, ...records].join("\n")}\n`;
					const markerAt = Buffer.from(content).lastIndexOf(marker);
					if (ending.kind === "truncated") content += ending.tail;
					if (ending.kind === "seam" && markerAt > 0) {
						const fillerBase = Buffer.byteLength(
							`${JSON.stringify({ type: "message", id: "fill", message: { role: "user", content: "" } })}\n`,
						);
						const padding = markerAt + 64 * 1024 + ending.offset - Buffer.byteLength(content) - fillerBase;
						if (padding >= 0) {
							content += `${JSON.stringify({ type: "message", id: "fill", message: { role: "user", content: "x".repeat(padding) } })}\n`;
						}
					}
					fs.writeFileSync(file, content);

					const listed = JSON.parse(headerLine) as SessionListHeader;
					for (const patch of await readSessionListTrailingPatches(file, storage, includeStarred)) {
						applySessionListHeaderPatch(listed, patch);
					}
					const canonical = parseStoredSessionEntries(fs.readFileSync(file, "utf8"))[0];
					expect(listed.cwd).toBe(canonical?.cwd);
					expect(listed.title).toBe(canonical?.title);
					if (includeStarred) expect(listed.starred).toBe(canonical?.starred);
				},
			),
			{ seed: 7991, numRuns: 120 },
		);
	});
});
