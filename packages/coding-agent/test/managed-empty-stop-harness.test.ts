import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { SessionManager } from "../src/session/session-manager";
import {
	assertExecutedScenarios,
	assertManagedTranscript,
	assertScenarioReport,
	EMPTY_STOP_SCENARIOS,
	handleProviderRequest,
	parseHarnessPort,
	providerSse,
	responseResult,
	type ScenarioReport,
	scenarioNames,
} from "./helpers/managed-empty-stop-harness";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "empty-stop-fixture",
		model: "fallback",
		content: text ? [{ type: "text", text }] : [],
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 1,
			output: 1,
			totalTokens: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function successfulReport(): ScenarioReport {
	const terminal = {
		status: "terminal_ok" as const,
		commandId: "command",
		turnId: "turn",
		content: { version: 1 as const, type: "text" as const, text: "fallback-ok", byteLength: 11, truncated: false },
	};
	return {
		scenario: "fallback-enabled",
		providerModels: ["primary", "fallback"],
		terminal,
		replay: { ...terminal },
		terminalFrames: [
			{ kind: "agent_end", payload: { commandId: "command", turnId: "turn", outcome: { kind: "stopped" } } },
		],
		selectedModel: "empty-stop-fixture/fallback",
		assistantMessages: [assistant("fallback-ok")],
		lifecycle: ["message_start", "message_end", "turn_end", "agent_end"],
		switches: [{ from: "empty-stop-fixture/primary", to: "empty-stop-fixture/fallback", reason: "server" }],
		managedTranscriptExists: true,
	};
}

function request(model: string, route = "/v1/chat/completions"): Request {
	return new Request(`http://127.0.0.1:30200${route}`, { method: "POST", body: JSON.stringify({ model }) });
}

async function chunks(response: Response): Promise<Array<Record<string, unknown>>> {
	return (await response.text())
		.split("\n\n")
		.filter(line => line.startsWith("data: {"))
		.map(line => JSON.parse(line.slice(6)));
}

function withPortBase(value: string | undefined, assertion: () => void): void {
	const previous = process.env.PORT_BASE;
	if (value === undefined) delete process.env.PORT_BASE;
	else process.env.PORT_BASE = value;
	try {
		assertion();
	} finally {
		if (previous === undefined) delete process.env.PORT_BASE;
		else process.env.PORT_BASE = previous;
	}
}

describe("managed empty-stop harness local contracts (no connected scenarios)", () => {
	test("rejects missing accepted messages and leaked provisional attempts on disk", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-empty-stop-transcript-"));
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const accepted = successfulReport().assistantMessages;
		try {
			await expect(assertManagedTranscript(manager, accepted)).rejects.toMatchObject({
				code: "ERR_ASSERTION",
				actual: [],
				expected: accepted,
			});
			manager.appendMessage(accepted[0]!);
			await assertManagedTranscript(manager, accepted);
			const rejected: AssistantMessage = { ...assistant(""), model: "primary", stopReason: "error" };
			manager.appendMessage(rejected);
			await expect(assertManagedTranscript(manager, accepted)).rejects.toMatchObject({
				code: "ERR_ASSERTION",
				actual: [...accepted, rejected],
				expected: accepted,
			});
		} finally {
			await manager.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("selects all scenarios by default and rejects unknown names", () => {
		expect(scenarioNames([])).toEqual([...EMPTY_STOP_SCENARIOS]);
		expect(scenarioNames(["untyped-fallback"])).toEqual(["untyped-fallback"]);
		expect(() => scenarioNames(["fallback-enabled", "unknown"])).toThrow("Unknown scenario");
	});

	test.each([0, -1, 0.5, Number.NaN])("fails zero/invalid executed count: %s", count => {
		expect(() => assertExecutedScenarios(count)).toThrow("Zero scenarios executed");
	});

	test.each(["invalid-scenario", ""])("rejects CLI selection %j with zero executions", async selection => {
		// Invalid selection never constructs a session or binds a server.
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../scripts/verify-managed-empty-stop.ts"), selection],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exit).toBe(1);
		expect(stdout).toContain("executed 0 scenario(s)");
		expect(stderr).toContain("Unknown scenario");
	}, 15_000);

	test.each(["0", "30200", "30219"])("accepts isolated port %s", value => {
		expect(parseHarnessPort(value)).toBe(Number(value));
	});
	test.each(["", " ", "30199", "30220", "8000", "30200.5", "invalid"])("rejects port %s", value => {
		expect(() => parseHarnessPort(value)).toThrow("PORT_BASE");
	});
	test.each(["52440", "52459"])("accepts assigned isolated port %s", value => {
		withPortBase("52440", () => {
			expect(parseHarnessPort(value)).toBe(Number(value));
		});
	});
	test.each(["52439", "52460", "52440.5"])("rejects port outside the assigned isolation range %s", value => {
		withPortBase("52440", () => {
			expect(() => parseHarnessPort(value)).toThrow("PORT_BASE");
		});
	});

	test("uses the assigned range without whitelisting a previous dispatch", () => {
		withPortBase("55440", () => {
			expect(parseHarnessPort()).toBe(55440);
			expect(parseHarnessPort("55459")).toBe(55459);
			for (const value of ["55439", "55460", "55440.5", "52440", "52459"]) {
				expect(() => parseHarnessPort(value)).toThrow("PORT_BASE");
			}
		});
	});

	test("does not retain dispatch ports when no range is assigned", () => {
		withPortBase(undefined, () => {
			expect(parseHarnessPort()).toBe(30200);
			for (const value of ["52440", "52459", "55440"]) {
				expect(() => parseHarnessPort(value)).toThrow("PORT_BASE");
			}
		});
	});

	test("bounds the assigned range by the TCP port limit", () => {
		withPortBase("65520", () => {
			expect(parseHarnessPort()).toBe(65520);
			expect(parseHarnessPort("65535")).toBe(65535);
			for (const value of ["65519", "65536", "65539"]) {
				expect(() => parseHarnessPort(value)).toThrow("PORT_BASE");
			}
		});
	});

	test("emits explicit zero-usage stop and a real SSE terminator", async () => {
		const response = providerSse("primary", "", 0);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const body = await response.text();
		expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
		const events = await chunks(providerSse("primary", "", 0));
		expect(events[1].usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
		expect(events[1].choices).toEqual([{ index: 0, delta: {}, finish_reason: "stop" }]);
	});

	test("provider handler distinguishes typed, untyped, nonzero, and fallback wire evidence", async () => {
		const models: string[] = [];
		const untyped = await chunks(await handleProviderRequest(request("primary"), "untyped-fallback", models));
		expect(untyped.every(chunk => !("usage" in chunk))).toBe(true);
		const nonzero = await chunks(await handleProviderRequest(request("primary"), "nonzero-usage", models));
		expect(nonzero[1].usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
		const fallback = await chunks(await handleProviderRequest(request("fallback"), "fallback-enabled", models));
		expect(fallback[0].choices).toEqual([
			{ index: 0, delta: { role: "assistant", content: "fallback-ok" }, finish_reason: null },
		]);
		expect(models).toEqual(["primary", "primary", "fallback"]);
	});

	test("provider rejects unexpected routing rather than silently emitting a valid fixture", async () => {
		await expect(handleProviderRequest(request("unknown"), "fallback-enabled", [])).rejects.toThrow(
			"Unexpected provider model",
		);
		await expect(handleProviderRequest(request("primary", "/other"), "fallback-enabled", [])).rejects.toThrow(
			"Unexpected provider route",
		);
		await expect(handleProviderRequest(request("fallback"), "fallback-disabled", [])).rejects.toThrow(
			"Unexpected fallback request",
		);
	});

	test("SDK result unwrap fails rejected and malformed acknowledgements", () => {
		expect(responseResult({ ok: true, result: { accepted: true } })).toEqual({ accepted: true });
		expect(() => responseResult({ ok: false, error: { code: "busy" } })).toThrow("SDK request failed");
		expect(() => responseResult({ ok: true, result: null })).toThrow("Expected object");
	});

	test("requires classified fallback admission and an accepted-only lifecycle/transcript", () => {
		const good = successfulReport();
		assertScenarioReport(good);
		expect(() => assertScenarioReport({ ...good, switches: [{ ...good.switches[0], reason: "other" }] })).toThrow(
			"Session fallback classification",
		);
		expect(() => assertScenarioReport({ ...good, switches: [] })).toThrow("fallback admission");
		expect(() => assertScenarioReport({ ...good, lifecycle: [...good.lifecycle, ...good.lifecycle] })).toThrow(
			"Accepted-only lifecycle",
		);
		expect(() =>
			assertScenarioReport({ ...good, assistantMessages: [assistant(""), ...good.assistantMessages] }),
		).toThrow("Failed attempts leaked");
		expect(() => assertScenarioReport({ ...good, providerModels: ["primary", "primary", "fallback"] })).toThrow(
			"Provider model sequence",
		);
		expect(() => assertScenarioReport({ ...good, selectedModel: "empty-stop-fixture/primary" })).toThrow(
			"Selected fallback model",
		);
	});

	test("rejects forged content, uncorrelated/duplicate terminals and missing managed storage", () => {
		const good = successfulReport();
		expect(() => assertScenarioReport({ ...good, terminalFrames: [] })).toThrow("publish exactly once");
		expect(() =>
			assertScenarioReport({ ...good, terminalFrames: [...good.terminalFrames, ...good.terminalFrames] }),
		).toThrow("publish exactly once");
		expect(() =>
			assertScenarioReport({
				...good,
				terminalFrames: [{ payload: { commandId: "foreign", turnId: "turn", outcome: { kind: "stopped" } } }],
			}),
		).toThrow("Terminal command correlation");
		expect(() => assertScenarioReport({ ...good, assistantMessages: [assistant("fabricated")] })).toThrow(
			"Accepted fallback output",
		);
		expect(() => assertScenarioReport({ ...good, replay: { ...good.replay, status: "failed" } })).toThrow(
			"Durable terminal query changed",
		);
		expect(() => assertScenarioReport({ ...good, managedTranscriptExists: false })).toThrow("Managed transcript");
	});

	test("requires actual empty-response code and typed server classification on failed terminal", () => {
		const good = successfulReport();
		const message = {
			...assistant(""),
			model: "primary",
			stopReason: "error" as const,
			errorMessage: "Provider returned an empty response with zero token usage",
			transportFailure: { kind: "transport" as const, providerCode: "empty_response" },
			usage: { ...assistant("").usage, input: 0, output: 0, totalTokens: 0 },
		};
		const terminal = {
			status: "failed" as const,
			commandId: "command",
			turnId: "turn",
			error: { code: "provider_rejected", message: "Prompt submission failed." },
			outcome: { kind: "failed", providerCode: "empty_response" },
		};
		const failed: ScenarioReport = {
			...good,
			scenario: "fallback-disabled",
			providerModels: ["primary"],
			selectedModel: "empty-stop-fixture/primary",
			terminal,
			replay: { ...terminal },
			switches: [],
			assistantMessages: [message],
			terminalFrames: [{ payload: { commandId: "command", turnId: "turn", outcome: { kind: "failed" } } }],
		};
		assertScenarioReport(failed);
		expect(() =>
			assertScenarioReport({ ...failed, assistantMessages: [{ ...message, transportFailure: undefined }] }),
		).toThrow("Replay-safe failure classification");
		const wrongCode = { ...terminal, outcome: { kind: "failed", providerCode: "other" } };
		expect(() => assertScenarioReport({ ...failed, terminal: wrongCode, replay: wrongCode })).toThrow(
			"SDK empty-stop provider code",
		);
		const localTerminal = { ...terminal, error: { ...terminal.error, code: "empty_response" } };
		const local: ScenarioReport = {
			...failed,
			scenario: "untyped-disabled",
			terminal: localTerminal,
			replay: { ...localTerminal },
			assistantMessages: [{ ...message, transportFailure: undefined, errorKind: "local_empty_response" }],
		};
		assertScenarioReport(local);
		expect(() => assertScenarioReport({ ...local, assistantMessages: [message] })).toThrow(
			"Agent-loop empty-stop promotion",
		);
	});

	test("nonzero empty stop remains successful without replay-safe fallback admission", () => {
		const good = successfulReport();
		const terminal = { ...good.terminal, content: undefined };
		const report: ScenarioReport = {
			...good,
			scenario: "nonzero-usage",
			providerModels: ["primary"],
			selectedModel: "empty-stop-fixture/primary",
			terminal,
			replay: { ...terminal },
			assistantMessages: [{ ...assistant(""), model: "primary" }],
			switches: [],
		};
		assertScenarioReport(report);
		expect(() =>
			assertScenarioReport({
				...report,
				assistantMessages: [
					{ ...report.assistantMessages[0], usage: { ...report.assistantMessages[0].usage, totalTokens: 0 } },
				],
			}),
		).toThrow("Nonzero-usage guard");
	});
});
