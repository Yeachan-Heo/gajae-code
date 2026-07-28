import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionObserverOverlayComponent } from "../src/modes/components/session-observer-overlay";
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

describe("SessionObserverOverlayComponent source snapshots", () => {
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
