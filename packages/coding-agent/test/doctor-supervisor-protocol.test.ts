import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import type { DoctorReport } from "../src/cli/doctor/types";
import { acceptWorkerReport, createSupervisorChannel } from "../src/cli/doctor-supervisor";

const RUN_ID = "run-1";

function workerReport(overrides: Record<string, unknown> = {}): unknown {
	const report: DoctorReport = {
		schemaVersion: 1,
		command: "doctor",
		runId: RUN_ID,
		mode: "diagnose",
		generatedAt: new Date(0).toISOString(),
		durationMs: 1,
		subject: { gjcVersion: "v", platform: "p", arch: "a", channel: "source", rootIds: [] },
		selection: { checks: [] },
		coverage: { requested: 0, expanded: 0, attempted: 0, completed: 0, blocked: 0, timedOut: 0, unsupported: 0 },
		summary: { verdict: "healthy", exitCode: 0 },
		checks: [],
		repairs: [],
		limits: {},
	};
	return { ...report, ...overrides };
}

const initMessage = {
	type: "init",
	token: "t",
	argv: [],
	cwd: "/",
	tty: false,
	runId: "run-1",
	timeoutMs: 1,
	deadlineAt: 1,
} as const;

describe("supervisor worker-report acceptance", () => {
	test("accepts a report bound to this run", () => {
		expect(acceptWorkerReport(workerReport(), { runId: RUN_ID, mode: "diagnose" })).toBeDefined();
	});

	test.each([
		["missing selection", { selection: undefined }],
		["null selection", { selection: null }],
		["array selection", { selection: [] }],
		["string selection", { selection: "config.set-validated" }],
		["selection without a checks array", { selection: { repair: "config.set-validated" } }],
		["non-string repair", { selection: { checks: [], repair: 7 } }],
		["non-string targetId", { selection: { checks: [], targetId: { id: 1 } } }],
		["missing mode", { mode: undefined }],
	])("rejects a malformed report (%s) instead of throwing", (_label, overrides) => {
		let accepted: DoctorReport | undefined;
		expect(() => {
			accepted = acceptWorkerReport(workerReport(overrides), { runId: RUN_ID, mode: "diagnose" });
		}).not.toThrow();
		expect(accepted).toBeUndefined();
	});

	test("rejects a report whose selection does not match the requested repair", () => {
		const report = workerReport({
			mode: "fix",
			selection: { checks: [], repair: "mcp.set-startup-policy", targetId: "t1" },
		});
		expect(
			acceptWorkerReport(report, { runId: RUN_ID, mode: "fix", repair: "config.set-validated", targetId: "t1" }),
		).toBeUndefined();
	});

	test("rejects a report from a foreign run id or mode", () => {
		expect(acceptWorkerReport(workerReport(), { runId: "other", mode: "diagnose" })).toBeUndefined();
		expect(acceptWorkerReport(workerReport(), { runId: RUN_ID, mode: "fix" })).toBeUndefined();
	});
});

describe("supervisor protocol channel", () => {
	test("writes protocol lines while the worker is live", () => {
		const stdin = new PassThrough();
		const written: string[] = [];
		stdin.on("data", chunk => written.push(String(chunk)));
		let closed = 0;
		const channel = createSupervisorChannel(stdin, () => closed++);

		channel.send(initMessage);

		expect(written.join("")).toBe(`${JSON.stringify(initMessage)}\n`);
		expect(closed).toBe(0);
		expect(channel.settled).toBe(false);
	});

	test("refuses to write after the worker settled and reports a contained failure", () => {
		const stdin = new PassThrough();
		const written: string[] = [];
		stdin.on("data", chunk => written.push(String(chunk)));
		let closed = 0;
		const channel = createSupervisorChannel(stdin, () => closed++);

		channel.settle();
		channel.send(initMessage);

		expect(written).toEqual([]);
		expect(closed).toBe(1);
	});

	test("converts a destroyed stdin into a worker-failure outcome instead of throwing", () => {
		const stdin = new PassThrough();
		let closed = 0;
		const channel = createSupervisorChannel(stdin, () => closed++);
		stdin.destroy();

		expect(() => channel.send(initMessage)).not.toThrow();
		expect(closed).toBeGreaterThanOrEqual(1);
		expect(channel.settled).toBe(true);
	});

	test("contains a synchronous EPIPE from write", () => {
		const stdin = new Writable({
			write() {
				throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
			},
		});
		let closed = 0;
		const channel = createSupervisorChannel(stdin, () => closed++);

		expect(() => channel.send(initMessage)).not.toThrow();
		expect(closed).toBe(1);
		expect(channel.settled).toBe(true);
	});

	test("contains an asynchronous stdin error event rather than crashing the parent", () => {
		const stdin = new PassThrough();
		let closed = 0;
		createSupervisorChannel(stdin, () => closed++);

		expect(() => stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))).not.toThrow();
		expect(closed).toBe(1);
	});
});
