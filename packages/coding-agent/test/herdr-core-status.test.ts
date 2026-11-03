import { describe, expect, it } from "bun:test";
import {
	createHerdrCoreStatusReporter,
	encodeHerdrCoreStatus,
	type HerdrCoreStatus,
	installHerdrCoreStatusReporter,
	isHerdrCoreTerminal,
} from "../src/utils/herdr-core-status";
import type { HerdrSessionEvent } from "../src/utils/herdr-pane";

/** Emitter standing in for AgentSession.subscribe. */
function eventSource() {
	let listener: ((event: HerdrSessionEvent) => void) | null = null;
	return {
		subscribe(next: (event: HerdrSessionEvent) => void) {
			listener = next;
			return () => {
				listener = null;
			};
		},
		emit(event: HerdrSessionEvent) {
			listener?.(event);
		},
		get attached() {
			return listener !== null;
		},
	};
}

function reports(...states: HerdrCoreStatus[]): string[] {
	return states.map(encodeHerdrCoreStatus);
}

describe("encodeHerdrCoreStatus", () => {
	it("writes the OSC 7501 grammar herdr-core parses", () => {
		expect(encodeHerdrCoreStatus("working")).toBe("\x1b]7501;state=working:app=gjc\x1b\\");
		expect(encodeHerdrCoreStatus("blocked")).toBe("\x1b]7501;state=blocked:kind=question:app=gjc\x1b\\");
		expect(encodeHerdrCoreStatus("clear")).toBe("\x1b]7501;state=clear:app=gjc\x1b\\");
	});
});

describe("isHerdrCoreTerminal", () => {
	it("requires an hc terminal id and a TTY", () => {
		expect(isHerdrCoreTerminal({ env: { HC_TERMINAL_ID: "t7" }, isTTY: () => true })).toBe(true);
		expect(isHerdrCoreTerminal({ env: {}, isTTY: () => true })).toBe(false);
		expect(isHerdrCoreTerminal({ env: { HC_TERMINAL_ID: "  " }, isTTY: () => true })).toBe(false);
		// A nested `gjc -p` inherits the id but its stdout is a captured pipe.
		expect(isHerdrCoreTerminal({ env: { HC_TERMINAL_ID: "t7" }, isTTY: () => false })).toBe(false);
	});
});

describe("createHerdrCoreStatusReporter", () => {
	it("reports idle at startup and each lifecycle change once", () => {
		const source = eventSource();
		const writes: string[] = [];
		const reporter = createHerdrCoreStatusReporter(source.subscribe, { write: data => writes.push(data) });

		source.emit({ type: "agent_start" });
		source.emit({ type: "tool_execution_start", toolName: "read" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		source.emit({ type: "tool_execution_start", toolName: "ask" });
		source.emit({ type: "tool_execution_end", toolName: "ask" });
		expect(reporter.state).toBe("blocked");
		source.emit({ type: "tool_execution_end", toolName: "ask" });
		source.emit({ type: "agent_end" });
		source.emit({ type: "agent_end" });

		expect(writes).toEqual(reports("idle", "working", "blocked", "working", "idle"));
	});

	it("retracts the report synchronously on release and stops listening", () => {
		const source = eventSource();
		const writes: string[] = [];
		const syncWrites: string[] = [];
		const reporter = createHerdrCoreStatusReporter(source.subscribe, {
			write: data => writes.push(data),
			writeSync: data => syncWrites.push(data),
		});
		source.emit({ type: "agent_start" });

		reporter.release();
		reporter.release();
		source.emit({ type: "agent_end" });

		expect(source.attached).toBe(false);
		expect(reporter.state).toBe("clear");
		expect(writes).toEqual(reports("idle", "working"));
		// A buffered stdout write is dropped at process exit, so the retraction is synchronous.
		expect(syncWrites).toEqual(reports("clear"));
	});

	it("keeps tracking state when the terminal write fails", () => {
		const source = eventSource();
		const reporter = createHerdrCoreStatusReporter(source.subscribe, {
			write: () => {
				throw new Error("EIO");
			},
		});
		source.emit({ type: "agent_start" });
		expect(reporter.state).toBe("working");
	});
});

describe("installHerdrCoreStatusReporter", () => {
	it("does nothing outside an hc terminal", () => {
		const source = eventSource();
		const writes: string[] = [];
		const reporter = installHerdrCoreStatusReporter(source.subscribe, {
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" },
			isTTY: () => true,
			write: data => writes.push(data),
		});
		expect(reporter).toBeNull();
		expect(source.attached).toBe(false);
		expect(writes).toEqual([]);
	});

	it("reports inside an hc terminal and registers its release for process exit", () => {
		const source = eventSource();
		const writes: string[] = [];
		const reporter = installHerdrCoreStatusReporter(source.subscribe, {
			env: { HC_TERMINAL_ID: "t7" },
			isTTY: () => true,
			write: data => writes.push(data),
			writeSync: data => writes.push(data),
		});
		if (!reporter) throw new Error("expected a reporter inside an hc terminal");
		try {
			expect(writes).toEqual(reports("idle"));
			const [onExit] = process.listeners("exit").filter(listener => listener === reporter.release);
			expect(onExit).toBe(reporter.release);
			reporter.release();
			expect(writes).toEqual(reports("idle", "clear"));
		} finally {
			process.removeListener("exit", reporter.release);
		}
	});
});
