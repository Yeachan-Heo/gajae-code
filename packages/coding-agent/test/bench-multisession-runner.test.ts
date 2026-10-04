import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as path from "node:path";
import type { Context } from "@gajae-code/ai/core";
import { TempDir } from "@gajae-code/utils";
import { COHORT_MARKER_ENV } from "../bench/multisession/cohort";
import { parseJsonl } from "../bench/multisession/jsonl";
import { createBenchMockProvider } from "../bench/multisession/mock-provider";
import { compareEvidence } from "../bench/multisession/normalize";
import { runSession, setAllowlistedEnvironment } from "../bench/multisession/session-runner";
import { REQUIRED_WORKLOAD_EVENTS, type RunnerEvent, type WorkloadEventKind } from "../bench/multisession/types";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

setDefaultTimeout(60_000);
let tempDir: TempDir | undefined;

afterEach(() => {
	tempDir?.removeSync();
	tempDir = undefined;
});

async function runOne(
	name: string,
	onEvent?: (event: RunnerEvent) => void,
): Promise<{ evidenceDir: string; events: RunnerEvent[] }> {
	if (!tempDir) throw new Error("Test temp directory was not initialized.");
	const events: RunnerEvent[] = [];
	const { evidenceDir } = await runSession({
		sessionIndex: 0,
		rootDir: path.join(tempDir.path(), name),
		idleMs: 0,
		emit: event => {
			events.push(event);
			onEvent?.(event);
		},
	});
	return { evidenceDir, events };
}

function parseJsonLines(text: string): Record<string, unknown>[] {
	return parseJsonl(text, "evidence") as Record<string, unknown>[];
}

describe("multi-session session runner", () => {
	test("allowlist preserves the cohort marker and strips unrelated environment", () => {
		const previousMarker = process.env[COHORT_MARKER_ENV];
		const unrelatedName = "GJC_BENCH_TEST_UNALLOWLISTED";
		const previousUnrelated = process.env[unrelatedName];
		process.env[COHORT_MARKER_ENV] = "cohort-test-token";
		process.env[unrelatedName] = "must-be-removed";
		const restoreEnvironment = setAllowlistedEnvironment();
		try {
			expect(process.env[COHORT_MARKER_ENV]).toBe("cohort-test-token");
			expect(process.env[unrelatedName]).toBeUndefined();
		} finally {
			restoreEnvironment();
			if (previousMarker === undefined) delete process.env[COHORT_MARKER_ENV];
			else process.env[COHORT_MARKER_ENV] = previousMarker;
			if (previousUnrelated === undefined) delete process.env[unrelatedName];
			else process.env[unrelatedName] = previousUnrelated;
		}
	});
	test("runs the complete workload and compares reproducibly normalized evidence", async () => {
		tempDir = TempDir.createSync("@bench-multisession-runner-");
		const first = await runOne("first");
		const second = await runOne("second");

		const observed = new Set(
			first.events
				.filter((event): event is Extract<RunnerEvent, { type: "workload" }> => event.type === "workload")
				.map(event => event.event),
		);
		for (const required of REQUIRED_WORKLOAD_EVENTS) expect(observed.has(required as WorkloadEventKind)).toBe(true);
		expect(first.events.some(event => event.type === "phase" && event.phase === "constructed")).toBe(true);
		expect(first.events.some(event => event.type === "phase" && event.phase === "ready")).toBe(true);
		expect(first.events.some(event => event.type === "phase" && event.phase === "disposing")).toBe(true);
		expect(first.events.some(event => event.type === "phase" && event.phase === "disposed")).toBe(true);
		expect(first.events.filter(event => event.type === "turn")).toHaveLength(10);
		expect(first.events.some(event => event.type === "heap")).toBe(true);
		expect(first.events.some(event => event.type === "lag")).toBe(true);
		expect(first.events.some(event => event.type === "done")).toBe(false);

		for (const evidenceDir of [first.evidenceDir, second.evidenceDir]) {
			for (const filename of [
				"transcript.jsonl",
				"requests.jsonl",
				"tools.jsonl",
				"events.jsonl",
				"timing.jsonl",
				"manifest.json",
			]) {
				expect(await Bun.file(path.join(evidenceDir, filename)).exists()).toBe(true);
			}
			expect((await Bun.file(path.join(evidenceDir, "transcript.jsonl")).text()).length).toBeGreaterThan(0);
			expect((await Bun.file(path.join(evidenceDir, "tools.jsonl")).text()).length).toBeGreaterThan(0);
			const persistedEvents = parseJsonLines(await Bun.file(path.join(evidenceDir, "events.jsonl")).text());
			expect(persistedEvents.filter(event => event.type === "done")).toHaveLength(1);
			expect(persistedEvents.at(-1)?.type).toBe("done");
			const toolEvents = parseJsonLines(await Bun.file(path.join(evidenceDir, "tools.jsonl")).text());
			expect(toolEvents.some(event => "args" in event)).toBe(true);
			const transcript = parseJsonLines(await Bun.file(path.join(evidenceDir, "transcript.jsonl")).text());
			const hasToolCallArguments = transcript.some(record => {
				if (record.type !== "message" || typeof record.message !== "object" || record.message === null)
					return false;
				const message = record.message as Record<string, unknown>;
				return (
					Array.isArray(message.content) &&
					message.content.some(block => typeof block === "object" && block !== null && "arguments" in block)
				);
			});
			expect(hasToolCallArguments).toBe(true);
			const requests = parseJsonLines(await Bun.file(path.join(evidenceDir, "requests.jsonl")).text());
			const hasRequestToolCallArguments = requests.some(record => {
				if (typeof record.context !== "object" || record.context === null) return false;
				const messages = (record.context as Record<string, unknown>).messages;
				if (!Array.isArray(messages)) return false;
				return messages.some(message => {
					if (typeof message !== "object" || message === null) return false;
					const content = (message as Record<string, unknown>).content;
					return (
						Array.isArray(content) &&
						content.some(block => typeof block === "object" && block !== null && "arguments" in block)
					);
				});
			});
			expect(hasRequestToolCallArguments).toBe(true);
		}

		await expect(compareEvidence(first.evidenceDir, second.evidenceDir)).resolves.toEqual({ equal: true, diffs: [] });
	});

	test("trims MockModel calls to two while streaming every emitted request", async () => {
		tempDir = TempDir.createSync("@bench-multisession-retention-");
		const requestPath = path.join(tempDir.path(), "retention", "session-0", "evidence", "requests.jsonl");
		let firstTurnRequestText: Promise<string> | undefined;
		const run = await runOne("retention", event => {
			if (!firstTurnRequestText && event.type === "turn" && event.turn === 1) {
				firstTurnRequestText = Bun.file(requestPath).text();
			}
		});
		if (!firstTurnRequestText) throw new Error("The first turn did not expose request evidence.");
		const firstTurnRequests = parseJsonLines(await firstTurnRequestText);
		const requests = parseJsonLines(await Bun.file(path.join(run.evidenceDir, "requests.jsonl")).text());

		expect(firstTurnRequests.length).toBeGreaterThan(0);
		expect(requests.length).toBeGreaterThan(2);
		expect(requests.every(request => typeof request.context === "object" && request.context !== null)).toBe(true);
		expect(
			requests.every(
				request => typeof request.callsArrayLengthAfterTrim === "number" && request.callsArrayLengthAfterTrim <= 2,
			),
		).toBe(true);
	});
	test("provider does not retain serialized request lines", async () => {
		tempDir = TempDir.createSync("@bench-multisession-provider-stream-");
		const agentDir = path.join(tempDir.path(), "agent");
		const requestPath = path.join(tempDir.path(), "requests.jsonl");
		await Bun.write(requestPath, "");
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), Settings.isolated(), {
			agentDir,
			automaticRefresh: false,
		});
		const provider = createBenchMockProvider(modelRegistry, 0, requestPath);
		try {
			const context: Context = {
				systemPrompt: ["test"],
				messages: [{ role: "user", content: "capture this request", timestamp: 0 }],
			};
			await provider.root.stream(provider.root, context).result();
			// Persisted at capture time, before the provider is disposed.
			expect(parseJsonLines(await Bun.file(requestPath).text())).toHaveLength(1);
		} finally {
			provider.dispose();
			authStorage.close();
		}
	});
});
