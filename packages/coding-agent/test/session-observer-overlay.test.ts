import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__sessionObserverProjectionCounters,
	entriesFromMessages,
	SessionObserverOverlayComponent,
} from "../src/modes/components/session-observer-overlay";
import {
	__transcriptViewerPerfCounters,
	TranscriptViewerOverlay,
} from "../src/modes/components/transcript-viewer-overlay";
import { type ObservableSession, SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { initTheme } from "../src/modes/theme/theme";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

beforeAll(() => initTheme());

function registry(session: ObservableSession): SessionObserverRegistry {
	return {
		getSessions: () => [session],
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => 1,
	} as unknown as SessionObserverRegistry;
}

function record(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	});
}

function messageRecord(id: string, message: unknown): string {
	return JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message });
}

function rendered(overlay: SessionObserverOverlayComponent): string {
	return overlay.render(100).join("\n");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function source(id: string, records: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString() })}\n${records}`;
}

function observer(file: string): SessionObserverOverlayComponent {
	return new SessionObserverOverlayComponent(registry({
		id: "observed",
		kind: "subagent",
		label: "Observed",
		status: "active",
		sessionFile: file,
		lastUpdate: 1,
	}), () => {}, ["ctrl+s"]);
}

function assistantRecord(id: string, content: unknown[]): string {
	return messageRecord(id, {
		role: "assistant",
		content,
		timestamp: Date.now(),
		model: "test-model",
	});
}

function toolResultRecord(id: string, toolCallId: string, text: string): string {
	return messageRecord(id, {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	});
}

function modelChangeRecord(model: string): string {
	return JSON.stringify({
		type: "model_change",
		id: `model-${model}`,
		parentId: null,
		model,
		role: "default",
		timestamp: new Date().toISOString(),
	});
}

function parsedMessages(records: string): Parameters<typeof entriesFromMessages>[0] {
	return records
		.trim()
		.split("\n")
		.map(line => JSON.parse(line))
		.filter(entry => entry.type === "message");
}

describe("SessionObserverOverlayComponent source snapshots", () => {
	test("incremental digest matches SHA-256 of the complete concatenated prefix", async () => {
		const dir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "observer-digest-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const prefix = Buffer.from(source("observed", `${record("one", "one €")}\n`));
			await Bun.write(file, prefix);
			const overlay = observer(file);
			const suffix = Buffer.from(`${record("two", "two 한글")}\n`);
			const expected = crypto
				.createHash("sha256")
				.update(Buffer.concat([prefix, suffix]))
				.digest("hex");
			await fsAsync.appendFile(file, suffix);
			const digestSpy = spyOn(crypto.Hash.prototype, "digest");
			try {
				overlay.refreshFromRegistry();
				expect(rendered(overlay)).toContain("two 한글");
				expect(digestSpy.mock.results.map(result => result.value)).toContain(expected);
			} finally {
				digestSpy.mockRestore();
			}
			await fsAsync.appendFile(file, `${record("three", "three")}\n`);
			overlay.refreshFromRegistry();
			expect(occurrences(rendered(overlay), "two 한글")).toBe(1);
			expect(rendered(overlay)).toContain("three");
		} finally {
			await fsAsync.rm(dir, { recursive: true, force: true });
		}
	});
	test("publishes a direct-tail record once when its € bytes are split between writes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-utf8-tail-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("one", "one")}\n`));
			const overlay = observer(file);
			expect(rendered(overlay)).toContain("one");
			const append = Buffer.from(`${record("two", "two €")}\n`);
			const euroOffset = append.indexOf(Buffer.from("€"));
			expect(euroOffset).toBeGreaterThanOrEqual(0);
			fs.appendFileSync(file, append.subarray(0, euroOffset + 1));
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("two €");
			fs.appendFileSync(file, append.subarray(euroOffset + 1));
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).toContain("two €");
			overlay.refreshFromRegistry();
			expect(occurrences(rendered(overlay), "two €")).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("retains valid incomplete JSON syntax while its tail has no newline", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-json-tail-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("one", "one")}\n`));
			const overlay = observer(file);
			fs.appendFileSync(file, '{"type":"message"');
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).toContain("one");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rebuilds a replacement atomically and never retains prior transcript, model, or tool output", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-replacement-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			expect(rendered(overlay)).toContain("old transcript");
			const replacement = path.join(dir, "replacement.jsonl");
			fs.writeFileSync(replacement, source("observed", `${record("new", "new transcript")}\n`));
			fs.renameSync(replacement, file);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("new transcript");
			expect(output).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails closed when a replacement contains a malformed complete JSONL record", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-malformed-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			fs.writeFileSync(file, `${source("observed", "{not json}\n")}`);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test("rebuilds an in-place same-size middle rewrite even when its tail is unchanged", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-middle-rewrite-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const original = source(
				"observed",
				`${record("one", "first")}\n${record("two", "middle old")}\n${record("three", "tail")}\n`,
			);
			const replacement = original.replace("middle old", "middle new");
			expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
			fs.writeFileSync(file, original);
			const overlay = observer(file);
			fs.writeFileSync(file, replacement);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("middle new");
			expect(output).toContain("tail");
			expect(output).not.toContain("middle old");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("recovers a strictly shorter valid in-place replacement from a cached larger offset", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-shorter-valid-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const original = source(
				"observed",
				`${record("alpha", "alpha record content")}\n${record("beta", "beta record content longer")}\n`,
			);
			fs.writeFileSync(file, original);
			const overlay = observer(file);
			expect(rendered(overlay)).toContain("alpha record content");
			expect(rendered(overlay)).toContain("beta record content longer");
			const replacement = source("observed", `${record("new", "new")}\n`);
			expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(original));
			fs.writeFileSync(file, replacement);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("new");
			expect(output).not.toContain("alpha record content");
			expect(output).not.toContain("beta record content longer");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails closed for a strictly shorter invalid UTF-8 in-place replacement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-shorter-invalid-utf8-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const original = source("observed", `${record("old", "old transcript")}\n`);
			fs.writeFileSync(file, original);
			const overlay = observer(file);
			expect(rendered(overlay)).toContain("old transcript");
			const invalid = Buffer.from([0xc3, 0x0a]);
			expect(invalid.length).toBeLessThan(Buffer.byteLength(original));
			fs.writeFileSync(file, invalid);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("clears a truncated source at zero and rebuilds when it regrows beyond the old offset", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-truncate-regrow-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			fs.truncateSync(file, 0);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
			fs.writeFileSync(
				file,
				source("observed", `${record("new", "new transcript that regrows beyond the old offset")}\n`),
			);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("new transcript that regrows beyond the old offset");
			expect(output).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("clears a deleted source before accepting a recreated path", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-recreate-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "deleted transcript")}\n`));
			const overlay = observer(file);
			fs.unlinkSync(file);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("deleted transcript");
			fs.writeFileSync(file, source("observed", `${record("new", "recreated transcript")}\n`));
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("recreated transcript");
			expect(output).not.toContain("deleted transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails closed for a malformed complete append and accepts its repaired replacement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-repaired-append-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			fs.appendFileSync(file, "{not json}\n");
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
			fs.writeFileSync(file, source("observed", `${record("new", "repaired transcript")}\n`));
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("repaired transcript");
			expect(output).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails closed for invalid complete UTF-8 rather than preserving prior entries", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-invalid-utf8-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			fs.appendFileSync(file, Buffer.from([0xc3, 0x0a]));
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("clears an invalid no-newline tail and recovers from a repaired replacement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-invalid-tail-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("old", "old transcript")}\n`));
			const overlay = observer(file);
			fs.appendFileSync(file, Buffer.from([0xff]));
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).not.toContain("old transcript");
			fs.writeFileSync(file, source("observed", `${record("new", "repaired transcript")}\n`));
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("repaired transcript");
			expect(output).not.toContain("old transcript");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rebuilds atomic renames at both equal and unequal sizes", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-rename-"));
		try {
			for (const [oldText, newText] of [
				["same old", "same new"],
				["short old", "a replacement with a different size"],
			]) {
				const file = path.join(dir, `session-${oldText.length}.jsonl`);
				fs.writeFileSync(file, source("observed", `${record("old", oldText)}\n`));
				const overlay = observer(file);
				const replacement = `${file}.replacement`;
				fs.writeFileSync(replacement, source("observed", `${record("new", newText)}\n`));
				fs.renameSync(replacement, file);
				overlay.refreshFromRegistry();
				const output = rendered(overlay);
				expect(output).toContain(newText);
				expect(output).not.toContain(oldText);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("removes stale model and tool-result markers after a replacement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-stale-markers-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const oldAssistant = messageRecord("assistant", {
				role: "assistant",
				content: [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }],
				timestamp: Date.now(),
				model: "old-model",
			});
			const oldResult = messageRecord("result", {
				role: "toolResult",
				toolCallId: "old-call",
				toolName: "read",
				content: [{ type: "text", text: "stale tool result" }],
				isError: false,
				timestamp: Date.now(),
			});
			fs.writeFileSync(
				file,
				source(
					"observed",
					`${JSON.stringify({ type: "model_change", id: "model", parentId: null, model: "old-model", role: "default", timestamp: new Date().toISOString() })}\n${oldAssistant}\n${oldResult}\n`,
				),
			);
			const overlay = observer(file);
			expect(rendered(overlay)).toContain("old-model");
			expect(rendered(overlay)).toContain("stale tool result");
			const replacement = `${file}.replacement`;
			fs.writeFileSync(replacement, source("observed", `${record("new", "replacement transcript")}\n`));
			fs.renameSync(replacement, file);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("replacement transcript");
			expect(output).not.toContain("old-model");
			expect(output).not.toContain("stale tool result");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("preserves viewer state across a transient unstable append snapshot", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-transient-snapshot-"));
	try {
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, source("observed", `${record("seed", "one\ntwo\nthree\nfour\nfive")}\n`));
		const overlay = observer(file);
		overlay.handleInput("\r");
		expect(rendered(overlay)).toContain("five");

		const originalFstat = fs.fstatSync;
		let calls = 0;
		const mockFstat = ((fd: number, options?: fs.StatOptions) => {
			calls++;
			if (calls === 2) fs.appendFileSync(file, " ");
			return originalFstat(fd, options);
		}) as typeof fs.fstatSync;
		const fstatSpy = spyOn(fs, "fstatSync").mockImplementation(mockFstat);
		try {
			overlay.refreshFromRegistry();
		} finally {
			fstatSpy.mockRestore();
		}

		expect(rendered(overlay)).toContain("five");
		overlay.refreshFromRegistry();
		expect(rendered(overlay)).toContain("five");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("clears cached output when the selected registry session disappears", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-missing-session-"));
	try {
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, source("observed", `${record("seed", "stale transcript")}\n`));
		let sessions: ObservableSession[] = [
			{
				id: "observed",
				kind: "subagent",
				label: "Observed",
				status: "active",
				sessionFile: file,
				lastUpdate: 1,
			},
		];
		const mutableRegistry = { getSessions: () => sessions } as SessionObserverRegistry;
		const overlay = new SessionObserverOverlayComponent(mutableRegistry, () => {}, ["ctrl+s"]);
		expect(rendered(overlay)).toContain("stale transcript");
		sessions = [];
		overlay.refreshFromRegistry();
		const output = rendered(overlay);
		expect(output).not.toContain("stale transcript");
		expect(output).toContain("No transcript entries yet.");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("treats a concurrent short read as unstable and preserves viewer state", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-short-read-"));
	try {
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, source("observed", `${record("seed", "one\ntwo\nthree\nfour\nfive")}\n`));
		const overlay = observer(file);
		overlay.handleInput("\r");
		const originalRead = fs.readSync;
		let reads = 0;
		const mockRead = ((...args: unknown[]) => {
			reads++;
			if (reads === 1) return 0;
			return Reflect.apply(originalRead, fs, args) as number;
		}) as typeof fs.readSync;
		const readSpy = spyOn(fs, "readSync").mockImplementation(mockRead);
		try {
			overlay.refreshFromRegistry();
		} finally {
			readSpy.mockRestore();
		}
		expect(rendered(overlay)).toContain("five");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionObserverOverlayComponent incremental projection", () => {
	test("reuses a no-change projection and incrementally appends multi-output messages", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-append-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("seed", "seed")}\n`));
			const overlay = observer(file);
			__sessionObserverProjectionCounters.reset();
			__sessionObserverProjectionCounters.enable();
			__transcriptViewerPerfCounters.reset();
			__transcriptViewerPerfCounters.enable();
			overlay.render(80);
			__transcriptViewerPerfCounters.reset();
			overlay.refreshFromRegistry();
			expect(__sessionObserverProjectionCounters.snapshot()).toEqual({
				projectionFullRuns: 0,
				projectionIncrementalRuns: 0,
				sourceMessagesProjected: 0,
				projectedEntriesAppended: 0,
				resultPatchCount: 0,
			});
			expect(__transcriptViewerPerfCounters.snapshot()).toMatchObject({
				layoutCacheHits: 1,
				layoutCacheMisses: 0,
			});

			fs.appendFileSync(
				file,
				`${assistantRecord("assistant", [
					{ type: "thinking", thinking: "considering" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
				])}\n`,
			);
			overlay.refreshFromRegistry();
			const output = rendered(overlay);
			expect(output).toContain("considering");
			expect(output).toContain("answer");
			expect(output).toContain("read");
			expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
				projectionFullRuns: 0,
				projectionIncrementalRuns: 1,
				sourceMessagesProjected: 1,
				projectedEntriesAppended: 3,
			});
		} finally {
			__sessionObserverProjectionCounters.disable();
			__transcriptViewerPerfCounters.disable();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("patches out-of-order tool results with eager byte parity and narrow layout invalidation", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-results-"));
		try {
			const file = path.join(dir, "session.jsonl");
			const initial = `${record("seed", "seed")}\n${assistantRecord("assistant", [
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "two" } },
			])}\n`;
			fs.writeFileSync(file, source("observed", initial));
			const overlay = observer(file);
			overlay.render(80);
			__sessionObserverProjectionCounters.reset();
			__sessionObserverProjectionCounters.enable();
			__transcriptViewerPerfCounters.reset();
			__transcriptViewerPerfCounters.enable();

			const results = `${toolResultRecord("result-2", "call-2", "second result")}\n${toolResultRecord("result-1", "call-1", "first result")}\n`;
			fs.appendFileSync(file, results);
			overlay.refreshFromRegistry();
			const actual = overlay.render(80).join("\n");
			const layout = __transcriptViewerPerfCounters.snapshot();
			const eagerEntries = entriesFromMessages(parsedMessages(`${initial}${results}`));
			const eagerOverlay = new TranscriptViewerOverlay({
				title: "Session Observer",
				getEntries: () => eagerEntries,
				onClose: () => {},
				enterExpands: true,
				initialSelection: "latest",
				followTail: true,
				maxExpandedLines: 100,
				getHeaderLines: () => ["Observed [active] · test-model"],
				footerControls:
					"j/k:select  Enter:expand  PgUp/PgDn:page  [/]/←→:cycle agents  Esc/Ctrl+S:close  g/G:top/bottom",
			});
			const eager = eagerOverlay.render(80).join("\n");
			expect(actual).toBe(eager);
			expect(actual).toContain("first result");
			expect(actual).toContain("second result");
			expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
				projectionFullRuns: 0,
				projectionIncrementalRuns: 1,
				resultPatchCount: 2,
			});
			expect(layout.layoutCacheHits).toBeGreaterThan(0);
			expect(layout.layoutCacheMisses).toBe(2);
		} finally {
			__sessionObserverProjectionCounters.disable();
			__transcriptViewerPerfCounters.disable();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps orphan results on the eager path until resolved and rejects duplicate call ids", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-fallback-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("seed", "seed")}\n`));
			const overlay = observer(file);
			__sessionObserverProjectionCounters.reset();
			__sessionObserverProjectionCounters.enable();
			fs.appendFileSync(file, `${toolResultRecord("orphan", "missing", "orphan result")}\n`);
			overlay.refreshFromRegistry();
			expect(__sessionObserverProjectionCounters.snapshot().projectionFullRuns).toBe(1);

			fs.appendFileSync(
				file,
				`${assistantRecord("resolved", [{ type: "toolCall", id: "missing", name: "read", arguments: {} }])}\n`,
			);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).toContain("orphan result");
			expect(__sessionObserverProjectionCounters.snapshot().projectionFullRuns).toBe(2);

			fs.appendFileSync(
				file,
				`${assistantRecord("a1", [{ type: "toolCall", id: "duplicate", name: "read", arguments: {} }])}\n${assistantRecord("a2", [{ type: "toolCall", id: "duplicate", name: "read", arguments: {} }])}\n`,
			);
			overlay.refreshFromRegistry();
			expect(__sessionObserverProjectionCounters.snapshot().projectionFullRuns).toBe(3);
		} finally {
			__sessionObserverProjectionCounters.disable();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("resets projection state when cycling between observed sessions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-cycle-"));
		try {
			const fileA = path.join(dir, "a.jsonl");
			const fileB = path.join(dir, "b.jsonl");
			const callA = assistantRecord("call-a", [
				{ type: "toolCall", id: "shared-call", name: "read", arguments: { path: "a" } },
			]);
			const callB = assistantRecord("call-b", [
				{ type: "toolCall", id: "shared-call", name: "read", arguments: { path: "b" } },
			]);
			fs.writeFileSync(
				fileA,
				source(
					"a",
					`${record("user-a", "session A only")}\n${callA}\n${toolResultRecord("result-a", "shared-call", "result A")}\n`,
				),
			);
			fs.writeFileSync(
				fileB,
				source(
					"b",
					`${record("user-b", "session B only")}\n${callB}\n${toolResultRecord("result-b", "shared-call", "result B")}\n`,
				),
			);
			const sessions: ObservableSession[] = [
				{
					id: "a",
					kind: "subagent",
					label: "Session A",
					status: "active",
					sessionFile: fileA,
					lastUpdate: 2,
				},
				{
					id: "b",
					kind: "subagent",
					label: "Session B",
					status: "active",
					sessionFile: fileB,
					lastUpdate: 1,
				},
			];
			const cycleRegistry = { getSessions: () => sessions } as unknown as SessionObserverRegistry;
			const overlay = new SessionObserverOverlayComponent(cycleRegistry, () => {}, ["ctrl+s"]);
			expect(rendered(overlay)).toContain("session A only");
			fs.appendFileSync(fileA, `${record("append-a", "A appended")}\n`);
			overlay.refreshFromRegistry();
			expect(rendered(overlay)).toContain("A appended");

			__sessionObserverProjectionCounters.reset();
			__sessionObserverProjectionCounters.enable();
			overlay.handleInput("]");
			const cycled = rendered(overlay);
			expect(cycled).toContain("session B only");
			expect(cycled).toContain("result B");
			expect(cycled).not.toContain("session A only");
			expect(cycled).not.toContain("result A");
			expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
				projectionFullRuns: 1,
				projectionIncrementalRuns: 0,
			});

			fs.appendFileSync(fileB, `${record("append-b", "B appended once")}\n`);
			overlay.refreshFromRegistry();
			expect(occurrences(rendered(overlay), "B appended once")).toBe(1);
			expect(__sessionObserverProjectionCounters.snapshot().projectionIncrementalRuns).toBe(1);
		} finally {
			__sessionObserverProjectionCounters.disable();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("falls back to full projection for an appended v5 entry patch, then resumes incremental appends", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-entry-patch-"));
	try {
		const file = path.join(dir, "session.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 5,
			id: "observed",
			timestamp: new Date().toISOString(),
		});
		fs.writeFileSync(file, `${header}\n${record("patched", "before patch")}\n`);
		const overlay = observer(file);
		expect(rendered(overlay)).toContain("before patch");
		__sessionObserverProjectionCounters.reset();
		__sessionObserverProjectionCounters.enable();

		const patchedMessage = { role: "user", content: "after patch", timestamp: Date.now() };
		fs.appendFileSync(
			file,
			`${JSON.stringify({ type: "entry_patch", entryId: "patched", patch: { message: patchedMessage } })}\n`,
		);
		overlay.refreshFromRegistry();
		const patchedOutput = rendered(overlay);
		expect(patchedOutput).toContain("after patch");
		expect(patchedOutput).not.toContain("before patch");
		expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
			projectionFullRuns: 1,
			projectionIncrementalRuns: 0,
		});

		fs.appendFileSync(file, `${record("after-patch", "incremental after patch")}\n`);
		overlay.refreshFromRegistry();
		const finalOutput = rendered(overlay);
		expect(finalOutput).toContain("after patch");
		expect(occurrences(finalOutput, "incremental after patch")).toBe(1);
		expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
			projectionFullRuns: 1,
			projectionIncrementalRuns: 1,
			sourceMessagesProjected: 2,
		});
	} finally {
		__sessionObserverProjectionCounters.disable();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("commits a standalone model change once and continues suffix projection", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-projection-model-change-"));
	try {
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, source("observed", `${record("seed", "seed")}\n`));
		const overlay = observer(file);
		__sessionObserverProjectionCounters.reset();
		__sessionObserverProjectionCounters.enable();

		fs.appendFileSync(file, `${modelChangeRecord("new-model")}\n`);
		overlay.refreshFromRegistry();
		expect(rendered(overlay)).toContain("new-model");
		expect(__sessionObserverProjectionCounters.snapshot()).toEqual({
			projectionFullRuns: 0,
			projectionIncrementalRuns: 0,
			sourceMessagesProjected: 0,
			projectedEntriesAppended: 0,
			resultPatchCount: 0,
		});

		fs.appendFileSync(file, `${record("after-model", "after model change")}\n`);
		overlay.refreshFromRegistry();
		const output = rendered(overlay);
		expect(output).toContain("new-model");
		expect(occurrences(output, "after model change")).toBe(1);
		expect(__sessionObserverProjectionCounters.snapshot()).toMatchObject({
			projectionFullRuns: 0,
			projectionIncrementalRuns: 1,
			sourceMessagesProjected: 1,
			projectedEntriesAppended: 1,
		});
		overlay.refreshFromRegistry();
		expect(__sessionObserverProjectionCounters.snapshot().projectionIncrementalRuns).toBe(1);
	} finally {
		__sessionObserverProjectionCounters.disable();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionObserverOverlayComponent explicit refresh ownership", () => {
	test("surfaces an appended record through the registry onChange -> refreshFromRegistry wiring", () => {
		// Integration of the production source-refresh chain: a real EventBus drives a
		// real SessionObserverRegistry, and registry.onChange is wired to
		// overlay.refreshFromRegistry exactly as SelectorController.showSessionObserver
		// does. Because render() no longer refreshes unconditionally, this listener is
		// the sole thing that pulls appended records into view.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-refresh-ownership-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, source("observed", `${record("one", "seed record")}\n`));

			const eventBus = new EventBus();
			const registry = new SessionObserverRegistry();
			registry.subscribeToEventBus(eventBus);

			const lifecycle: SubagentLifecyclePayload = {
				id: "observed",
				agent: "executor",
				agentSource: "bundled",
				description: "Observed",
				status: "started",
				sessionFile: file,
				index: 0,
			};
			// Seed the session via the lifecycle channel so the registry tracks it.
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);

			const overlay = new SessionObserverOverlayComponent(registry, () => {}, ["ctrl+s"]);
			expect(rendered(overlay)).toContain("seed record");

			// Mirror SelectorController.showSessionObserver's wiring verbatim.
			const unsubscribe = registry.onChange(() => overlay.refreshFromRegistry());

			fs.appendFileSync(file, `${record("two", "appended via ownership")}\n`);

			const progress: AgentProgress = {
				index: 0,
				id: "observed",
				agent: "executor",
				agentSource: "bundled",
				status: "running",
				task: "test task",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			const progressPayload: SubagentProgressPayload = {
				index: 0,
				agent: "executor",
				agentSource: "bundled",
				task: "test task",
				progress,
				sessionFile: file,
			};
			// Emitting an event (NOT a direct refreshFromRegistry call) must surface the
			// freshly appended record through the onChange wiring alone.
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
			expect(rendered(overlay)).toContain("appended via ownership");

			// Listener cleanup: once unsubscribed a further event must not refresh, so a
			// third appended record stays invisible without any direct refresh call.
			unsubscribe();
			fs.appendFileSync(file, `${record("three", "post cleanup record")}\n`);
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
			expect(rendered(overlay)).not.toContain("post cleanup record");

			registry.dispose();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
