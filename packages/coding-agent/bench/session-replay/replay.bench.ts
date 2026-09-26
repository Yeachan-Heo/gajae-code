#!/usr/bin/env bun


import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { Agent, type AgentTool, type StreamFn } from "@gajae-code/agent-core";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@gajae-code/ai";

import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { registerCustomApi, unregisterCustomApis, type CustomStreamSimpleFn } from "@gajae-code/ai/api-registry";



import { ModelRegistry } from "../../src/config/model-registry";

import type { PerfCorpusReport } from "../perf-corpus-schema";

import { startCpuProfile } from "../../src/debug/profiler";
const compactionSummaryText = "Compacted summary of the recorded sanitized session.";

const streamCompactionSummary: CustomStreamSimpleFn = model => {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 9,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		const content = message.content[0];
		if (!content || content.type !== "text") throw new Error("Stub summarizer text block is missing");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		content.text = compactionSummaryText;
		stream.push({ type: "text_delta", contentIndex: 0, delta: compactionSummaryText, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: compactionSummaryText, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
};


import { Settings } from "../../src/config/settings";



import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";

import { AuthStorage } from "../../src/session/auth-storage";

import { SessionManager } from "../../src/session/session-manager";


import { AstGrepTool } from "../../src/tools/ast-grep";

import { BashTool } from "../../src/tools/bash";

import { FindTool } from "../../src/tools/find";

import { ReadTool } from "../../src/tools/read";

import { SearchTool } from "../../src/tools/search";

import type { ToolSession } from "../../src/tools";

import { EditTool, type EditMode } from "../../src/edit";
import { Editor } from "@gajae-code/tui/components/editor";
import { Text, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal";
import { defaultEditorTheme } from "../../../../packages/tui/test/test-themes";
import * as z from "zod/v4";
import {
	assertCorpusProvenance,
	buildSessionReplayProfileReport,
	compareTopFunctions,
	ensureProfileOutputDirectory,

	renderProfileReportMarkdown,
	type CpuProfile,
	type CpuProfileNode,
	type FixtureMeasurement,
	type HarnessMark,
	type ReplayFidelity,
	type SessionReplayProfileReport,
} from "./profile-report";
import { loadCorpusManifest, sha256Hex, toolCallSequence, type CorpusEntry, type CorpusManifest } from "./corpus";

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const cliEntry = path.join(repositoryRoot, "packages", "coding-agent", "src", "cli.ts");
const traceLoader = path.join(repositoryRoot, "scripts", "trace-loader.ts");

const intervalMicros = 100;
const scenarioNames = ["startup", "session-load", "session-save", "replay", "tools", "keystroke", "compaction"] as const;
type ScenarioName = (typeof scenarioNames)[number];
/**
 * Short scenarios are repeated inside one profiler window until they reach a
 * minimum sampled wall time, so the top-10 self-time ranking is not decided by
 * a few dozen samples (AC1a.3 stability). Longer windows are required for I/O-bound scenarios whose CPU samples are sparse.
 */
const MIN_SCENARIO_WALL_MS: Partial<Record<ScenarioName, number>> = {
	"session-load": 5_000,
	"session-save": 5_000,
	replay: 10_000,
	tools: 15_000,
	keystroke: 8_000,
	compaction: 5_000,
};
const MAX_SCENARIO_REPEATS = 200;
const STARTUP_REPEATS = 5;
type SessionJsonlEntry = Parameters<typeof toolCallSequence>[0][number];

type SessionMessage = Message;
type CorpusDirectories = Record<string, string>;

type FullProfileNode = CpuProfileNode & { children?: number[]; hitCount?: number; parent?: number };
type FullCpuProfile = CpuProfile & { nodes: FullProfileNode[]; startTime?: number; endTime?: number };

interface CliOptions {
	scenarios: ScenarioName[];
	corpus?: string;
	out?: string;
	compare?: string;
}

interface ScenarioRunResult {
	profile: FullCpuProfile;
	marks: HarnessMark[];
	measurements: Record<string, FixtureMeasurement>;
	replayFidelity: Record<string, ReplayFidelity>;
	notes: string[];
}

function usage(): string {
	return [
		"Usage: bun run bench:profile -- --scenario <all|startup|session-load|session-save|replay|tools|keystroke|compaction>[,...] [--corpus <extraDir>] [--out <dir>] [--compare <otherReport.json>]",
	].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { scenarios: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--scenario" || flag === "--corpus" || flag === "--out" || flag === "--compare") {
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			if (flag === "--scenario") {
				const requested = value.split(",").filter(Boolean);
				if (requested.includes("all")) {
					if (requested.length !== 1) throw new Error("all cannot be combined with another scenario");
					options.scenarios = [...scenarioNames];
				} else {
					for (const name of requested) {
						if (!(scenarioNames as readonly string[]).includes(name)) throw new Error(`Unknown scenario: ${name}`);
						options.scenarios.push(name as ScenarioName);
					}
				}
			} else if (flag === "--corpus") options.corpus = value;
			else if (flag === "--out") options.out = value;
			else options.compare = value;
			index += 1;
			continue;
		}
		if (flag === "--help" || flag === "-h") throw new Error(usage());
		throw new Error(`Unknown option: ${String(flag)}\n${usage()}`);
	}
	if (options.scenarios.length === 0) throw new Error(`--scenario is required\n${usage()}`);
	options.scenarios = [...new Set(options.scenarios)];
	return options;
}



function profileDurationMs(profile: CpuProfile): number {
	return (profile.timeDeltas ?? []).reduce((sum, delta) => sum + Math.max(0, delta), 0) / 1_000;
}

function mergeProfiles(profiles: FullCpuProfile[]): FullCpuProfile {
	if (profiles.length === 0) throw new Error("Bun produced no startup CPU profiles");
	const nodes: FullProfileNode[] = [];
	const samples: number[] = [];
	const timeDeltas: number[] = [];
	let nextId = 1;
	for (const profile of profiles) {
		const idMap = new Map<number, number>();
		for (const node of profile.nodes) {
			idMap.set(node.id, nextId);
			nextId += 1;
		}
		for (const node of profile.nodes) {
			nodes.push({
				...node,
				id: idMap.get(node.id) ?? node.id,
				...(node.children === undefined ? {} : { children: node.children.map(child => idMap.get(child) ?? child) }),
				...(node.parent === undefined ? {} : { parent: idMap.get(node.parent) ?? node.parent }),
			});
		}
		for (const sample of profile.samples ?? []) samples.push(idMap.get(sample) ?? sample);
		timeDeltas.push(...(profile.timeDeltas ?? []));
	}
	return {
		nodes,
		samples,
		timeDeltas,
		samplingInterval: intervalMicros,
		startTime: profiles[0]?.startTime,
		endTime: (profiles[0]?.startTime ?? 0) + timeDeltas.reduce((sum, delta) => sum + delta, 0),
	};
}

async function readProfileFiles(directory: string): Promise<FullCpuProfile[]> {
	const files = (await fs.readdir(directory)).filter(name => name.endsWith(".cpuprofile")).sort();
	const profiles: FullCpuProfile[] = [];
	for (const file of files) profiles.push(JSON.parse(await Bun.file(path.join(directory, file)).text()) as FullCpuProfile);
	return profiles;
}

function isolatedStartupEnvironment(tempRoot: string, scenario: "help" | "version" | "idle"): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (!key.startsWith("GJC_") && value !== undefined) env[key] = value;
	}
	const home = path.join(tempRoot, "home");
	const agentDir = path.join(tempRoot, "agent");
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
		GJC_CODING_AGENT_DIR: agentDir,
		GJC_AGENT_DIR: agentDir,
		GJC_TRACE_OUT: path.join(tempRoot, `${scenario}.trace.json`),

		GJC_TRACE_SCENARIO: scenario,
		GJC_TRACE_HARNESS: "1",
		...(scenario === "idle" ? { GJC_DEBUG_REDRAW: "1" } : {}),
		BUN: process.execPath,
	};
}

async function runIdleStartupInPty(tempRoot: string, profileDirectory: string, env: Record<string, string>): Promise<void> {
	const debugPaths = [path.join(env.GJC_AGENT_DIR ?? "", "gjc-debug.log"), path.join(env.GJC_AGENT_DIR ?? "", "state", "gjc-debug.log")];
	const driverPath = path.join(tempRoot, "idle-driver.py");
	const pythonSource = `
import os, pty, select, subprocess, sys, time


command = [os.environ.get("BUN", "bun"), "--cpu-prof", "--cpu-prof-dir", ${JSON.stringify(profileDirectory)}, "--no-env-file", "--preload", ${JSON.stringify(traceLoader)}, ${JSON.stringify(cliEntry)}, "--no-session", "--no-tools"]

debug_paths = ${JSON.stringify(debugPaths)}
master, slave = pty.openpty()
child = subprocess.Popen(command, cwd=${JSON.stringify(repositoryRoot)}, env=os.environ.copy(), stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
barrier = False
deadline = time.time() + 45.0
try:
    while time.time() < deadline:
        try:
            readable, _, _ = select.select([master], [], [], 0.02)
            if readable:
                try:
                    os.read(master, 65536)
                except OSError:
                    pass
        except (OSError, EOFError):
            pass
        for debug_path in debug_paths:
            try:
                if "fullRender: first render" in open(debug_path, encoding="utf-8").read():
                    barrier = True
                    break
            except OSError:
                pass
        if barrier:
            break
    if not barrier:
        raise RuntimeError("interactive:first-render-complete barrier was not observed")
    try:
        os.write(master, b"\\x03")
    except OSError:
        pass
    try:
        child.wait(timeout=3.0)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3.0)


finally:
    try:
        os.close(master)
    except OSError:
        pass
`;
	await Bun.write(driverPath, pythonSource);
	const processHandle = Bun.spawn(["python3", driverPath], { cwd: repositoryRoot, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (exitCode !== 0) throw new Error(`startup idle scenario failed: ${stderr.trim()} ${stdout.trim()}`);
}

async function runStartupScenario(outputDirectory: string): Promise<{ profile: FullCpuProfile; marks: HarnessMark[]; notes: string[] }> {
	const tempRoot = await fs.mkdtemp(path.join(outputDirectory, ".startup-"));
	const childProfiles: FullCpuProfile[] = [];
	const marks: HarnessMark[] = [];
	const notes: string[] = [];
	let profileElapsedMs = 0;
	try {
		for (const scenario of ["help", "version", "idle"] as const) {
			const profileDirectory = path.join(tempRoot, scenario);
			await fs.mkdir(profileDirectory, { recursive: true });
			const env = isolatedStartupEnvironment(path.join(tempRoot, scenario), scenario);
			const argv = scenario === "help" ? ["--help"] : scenario === "version" ? ["--version"] : ["--no-session", "--no-tools"];
			const wallStartMs = performance.now();
			if (scenario === "idle") {
				await runIdleStartupInPty(tempRoot, profileDirectory, env);
			} else {
				// Each run writes its own .cpuprofile into profileDirectory; they are merged below.
				for (let repeat = 0; repeat < STARTUP_REPEATS; repeat += 1) {
					const child = Bun.spawn([process.execPath, "--cpu-prof", "--cpu-prof-dir", profileDirectory, "--no-env-file", "--preload", traceLoader, cliEntry, ...argv], {
						cwd: repositoryRoot,
						env,
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					if (exitCode !== 0) throw new Error(`startup ${scenario} failed: ${stderr.trim()} ${stdout.trim()}`);
				}
			}
			const files = await readProfileFiles(profileDirectory);
			if (files.length === 0) {
				if (scenario !== "idle") throw new Error(`Bun CPU profiler emitted no ${scenario} profile`);
				notes.push("The idle CLI reaches the real first-render barrier under a PTY, but its interactive shutdown path does not finish the Bun --cpu-prof child; startup.cpuprofile therefore contains the help/version child profiles only.");
				marks.push({ scenario: "startup", name: "idle", kind: "startup", startMs: profileElapsedMs, endMs: profileElapsedMs, wallStartMs, wallEndMs: performance.now() });
				continue;
			}
			const profile = mergeProfiles(files);

			const duration = profileDurationMs(profile);
			marks.push({
				scenario: "startup",
				name: scenario,
				kind: "startup",
				startMs: profileElapsedMs,
				endMs: profileElapsedMs + duration,
				wallStartMs,
				wallEndMs: performance.now(),
			});
			profileElapsedMs += duration;
			childProfiles.push(profile);
		}
		return { profile: mergeProfiles(childProfiles), marks, notes };

	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messagesFromEntries(entries: SessionJsonlEntry[]): SessionMessage[] {
	const messages: SessionMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
		if (typeof message.content !== "string" && !Array.isArray(message.content)) continue;
		if (message.role === "assistant" && !Array.isArray(message.content)) continue;
		if (message.role === "toolResult" && (typeof message.toolCallId !== "string" || typeof message.toolName !== "string")) continue;
		messages.push(message as unknown as SessionMessage);
	}
	return messages;
}


function copyPathWithinTemp(sourceDirectory: string, entry: CorpusEntry, targetRoot: string): Promise<string> {
	const sourcePath = path.resolve(sourceDirectory, entry.file);
	const relative = path.relative(sourceDirectory, sourcePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Corpus entry escapes corpus directory: ${entry.id}`);
	const destination = path.join(targetRoot, relative);
	return fs.mkdir(path.dirname(destination), { recursive: true }).then(async () => {
		await fs.copyFile(sourcePath, destination);
		return destination;
	});
}


async function runSessionIoScenario(
	scenario: "session-load" | "session-save",
	manifest: CorpusManifest,
	corpusDirectories: CorpusDirectories,
	originMs: number,
): Promise<HarnessMark[]> {
	const marks: HarnessMark[] = [];
	for (const entry of manifest.entries) {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-replay-"));
		let manager: SessionManager | undefined;
		try {
			const source = await copyPathWithinTemp(corpusDirectories[entry.id]!, entry, tempRoot);
			const startMs = performance.now();
			manager = await SessionManager.open(source);
			manager.getEntries();
			if (scenario === "session-save") {
				manager.appendMessage({ role: "user", content: "session replay save benchmark", timestamp: Date.now() });
				await manager.flush();
			}
			const endMs = performance.now();
			marks.push({ scenario, name: `${scenario}:${entry.id}`, kind: scenario, sessionId: entry.id, startMs: startMs - originMs, endMs: endMs - originMs });
		} finally {
			await manager?.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}
	return marks;
}

function textOfMessage(message: SessionMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text").map(part => part.text).join("");
}

function chunkText(text: string): string[] {
	const codePoints = Array.from(text);
	const chunks: string[] = [];
	for (let index = 0; index < codePoints.length; index += 4) chunks.push(codePoints.slice(index, index + 4).join(""));
	return chunks;
}

function assistantMessageFrom(recorded: AssistantMessage, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		...recorded,
		content,
		stopReason: recorded.content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
		usage: {
			input: recorded.usage.input,
			output: recorded.usage.output,
			cacheRead: recorded.usage.cacheRead,
			cacheWrite: recorded.usage.cacheWrite,
			totalTokens: recorded.usage.totalTokens,
			cost: { ...recorded.usage.cost },
		},
	};
}

function streamRecordedAssistant(recorded: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = assistantMessageFrom(recorded);
		stream.push({ type: "start", partial });
		for (const block of recorded.content) {
			const contentIndex = partial.content.length;
			if (block.type === "text") {
				const partialText = { type: "text" as const, text: "" };
				partial.content.push(partialText);
				stream.push({ type: "text_start", contentIndex, partial });
				for (const delta of chunkText(block.text)) {
					partialText.text += delta;
					stream.push({ type: "text_delta", contentIndex, delta, partial });
				}
				stream.push({ type: "text_end", contentIndex, content: partialText.text, partial });
			} else if (block.type === "toolCall") {
				const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
				partial.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex, partial });
				const json = JSON.stringify(block.arguments);
				let argumentText = "";
				for (const delta of chunkText(json)) {
					argumentText += delta;
					try {
						toolCall.arguments = JSON.parse(argumentText) as Record<string, unknown>;
					} catch {
						// Partial JSON is expected until the complete recorded argument is streamed.
					}
					stream.push({ type: "toolcall_delta", contentIndex, delta, partial });
				}
				toolCall.arguments = block.arguments;
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
			} else {
				partial.content.push(structuredClone(block));
			}
		}
		const reason = partial.content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
		partial.stopReason = reason;
		stream.push({ type: "done", reason, message: partial });
	});
	return stream;
}

function createRecordedTools(messages: SessionMessage[]): AgentTool[] {
	const calls = messages.flatMap(message => {
		if (message.role !== "assistant") return [];
		return message.content.filter((part): part is ToolCall => part.type === "toolCall");
	});
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);

	const names = [...new Set(calls.map(call => call.name))];
	const parameters = z.object({}).passthrough();
	return names.map(name => {
		const tool: AgentTool<typeof parameters, unknown, unknown> = {
			name,
			label: name,
			description: "Returns the recorded sanitized tool result; no tool implementation is executed.",
			parameters,
			async execute(toolCallId) {
				const result = results.get(toolCallId);
				if (!result || result.toolName !== name) throw new Error(`Recorded result missing for ${name}:${toolCallId}`);
				return {
					content: structuredClone(result.content),
					...(result.details === undefined ? {} : { details: structuredClone(result.details) }),
					...(result.isError ? { isError: true } : {}),
				};
			},
		};
		return tool;
	});
}

function messageHasToolCalls(message: Message): message is AssistantMessage {
	return message.role === "assistant";
}

async function replayEntry(
	entry: CorpusEntry,
	entries: SessionJsonlEntry[],
	originMs: number,
): Promise<{ marks: HarnessMark[]; fidelity: ReplayFidelity; measurement: FixtureMeasurement }> {
	const messages = messagesFromEntries(entries);
	const assistantMessages = messages.filter(messageHasToolCalls);
	const recordedSequenceHash = sha256Hex(JSON.stringify(toolCallSequence(entries)));
	if (recordedSequenceHash !== entry.toolCallSeqSha256) throw new Error(`Recorded tool-call sequence checksum mismatch for ${entry.id}`);
	const mock = createMockModel();

	const model: Model = mock.model;
	const tools = createRecordedTools(messages);
	let assistantIndex = 0;
	const streamFn: StreamFn = () => {
		const recorded = assistantMessages[assistantIndex];
		if (!recorded) throw new Error(`Replay exhausted assistant turns for ${entry.id}`);
		assistantIndex += 1;
		return streamRecordedAssistant(recorded);
	};
	const agent = new Agent({ initialState: { model, systemPrompt: ["Replay only the recorded sanitized assistant/tool exchange."], tools, messages: [] }, streamFn });
	const replayUsers = messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user");

	const startTime = performance.now();
	const cpuStart = process.cpuUsage();
	const memoryStart = process.memoryUsage().rss;
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-replay-agent-"));
	const authStorage = await AuthStorage.create(path.join(tmpRoot, "auth.db"));
	authStorage.setRuntimeApiKey(model.provider, "session-replay-benchmark-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const sessionManager = SessionManager.inMemory(tmpRoot);
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.reminders": false, "retry.enabled": false });
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	const terminal = new VirtualTerminal(96, 32);
	const tui = new TUI(terminal);
	const frame = new Text("", 0, 0);
	tui.addChild(frame);
	tui.start();
	let renderedText = "";
	const replayedToolNames: string[] = [];


	const toolStarts = new Map<string, { at: number; name: string }>();
	const marks: HarnessMark[] = [];
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_update" && (event.assistantMessageEvent.type === "text_delta" || event.assistantMessageEvent.type === "toolcall_delta")) {
			const start = performance.now();
			if (event.assistantMessageEvent.type === "text_delta") {
				renderedText += event.assistantMessageEvent.delta;
				frame.setText(renderedText);
				tui.requestRender();
			}
			marks.push({ scenario: "replay", name: `token-delta:${entry.id}:${marks.length}`, kind: "token-delta", sessionId: entry.id, startMs: start - originMs, endMs: performance.now() - originMs });
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			for (const part of event.message.content) if (part.type === "toolCall") replayedToolNames.push(part.name);
		}

		if (event.type === "message_end" && event.message.role === "toolResult") {
			const output = event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			renderedText += `\n${event.message.toolName}: ${output}`;
			frame.setText(renderedText);
			tui.requestRender();
		}
		if (event.type === "tool_execution_start") toolStarts.set(event.toolCallId, { at: performance.now(), name: event.toolName });
		if (event.type === "tool_execution_end") {
			const started = toolStarts.get(event.toolCallId);
			if (started) {
				marks.push({ scenario: "replay", name: `tool-call:${entry.id}:${event.toolCallId}`, kind: "tool-call", sessionId: entry.id, toolName: started.name, startMs: started.at - originMs, endMs: performance.now() - originMs });
				toolStarts.delete(event.toolCallId);
			}
		}
	});
	const scenarioStart = performance.now();
	const wallStartMs = scenarioStart;
	try {
		if (replayUsers.length === 0) {
			await session.prompt("replay recorded session", { skipCompactionCheck: true });
		} else {
			let userIndex = 0;
			while (assistantIndex < assistantMessages.length) {
				const before = assistantIndex;
				const userMessage = replayUsers[Math.min(userIndex, replayUsers.length - 1)]!;
				await session.prompt(textOfMessage(userMessage), { skipCompactionCheck: true });
				await session.waitForIdle();
				if (assistantIndex === before) throw new Error(`Replay did not consume an assistant message for ${entry.id}`);
				userIndex += 1;
			}
		}
		if (assistantIndex !== assistantMessages.length) {
			throw new Error(`Replay consumed ${assistantIndex}/${assistantMessages.length} assistant messages for ${entry.id}`);
		}
		await terminal.waitForRender();
		const endTime = performance.now();
		const cpuDelta = process.cpuUsage(cpuStart);
		const endRss = process.memoryUsage().rss;
		const viewport = terminal.getViewport();
		const finalFrameNonEmpty = viewport.some(line => line.trim().length > 0);
		const actualSequenceHash = sha256Hex(JSON.stringify(replayedToolNames));
		const fidelity: ReplayFidelity = {
			recordedAssistantTurns: entry.assistantTurns,
			replayedAssistantTurns: assistantIndex,
			recordedToolCallSeqSha256: recordedSequenceHash,
			replayedToolCallSeqSha256: actualSequenceHash,
			finalFrameNonEmpty,
		};

		marks.push({ scenario: "replay", name: `session-replay:${entry.id}`, kind: "scenario", sessionId: entry.id, startMs: scenarioStart - originMs, endMs: endTime - originMs, wallStartMs, wallEndMs: endTime });
		return {
			marks,
			fidelity,
			measurement: {
				elapsedMs: endTime - scenarioStart,
				userMicros: cpuDelta.user,
				systemMicros: cpuDelta.system,
				rssBeforeBytes: memoryStart,
				rssAfterBytes: endRss,
			},
		};
	} finally {
		unsubscribe();
		tui.stop();
		await session.dispose();
		await sessionManager.close();
		authStorage.close();
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}
}

async function runReplayScenario(
	manifest: CorpusManifest,
	corpusDirectories: CorpusDirectories,
	originMs: number,
): Promise<{ marks: HarnessMark[]; replayFidelity: Record<string, ReplayFidelity>; measurements: Record<string, FixtureMeasurement> }> {
	const marks: HarnessMark[] = [];
	const replayFidelity: Record<string, ReplayFidelity> = {};
	const measurements: Record<string, FixtureMeasurement> = {};
	for (const entry of manifest.entries) {
		const rawText = await Bun.file(path.resolve(corpusDirectories[entry.id]!, entry.file)).text();
		const parsed = Bun.JSONL.parse(rawText) as unknown as SessionJsonlEntry[];
		const replay = await replayEntry(entry, parsed, originMs);
		marks.push(...replay.marks);
		replayFidelity[entry.id] = replay.fidelity;
		measurements[entry.id] = replay.measurement;
	}
	return { marks, replayFidelity, measurements };
}

function createToolSession(cwd: string, settings: Settings, artifactsDir: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => artifactsDir,
		settings,
		skipPythonPreflight: true,
	} as unknown as ToolSession;
}

async function unpackToolFixtures(tempRoot: string): Promise<string> {
	const archivePath = path.join(repositoryRoot, "packages", "typescript-edit-benchmark", "fixtures.tar.gz");
	const extractedRoot = path.join(tempRoot, "fixtures");
	await fs.mkdir(extractedRoot, { recursive: true });
	const child = Bun.spawn(["tar", "-xzf", archivePath, "-C", extractedRoot], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Could not extract typescript-edit-benchmark fixtures: ${stderr.trim()} ${stdout.trim()}`);
	return path.join(extractedRoot, "fixtures");
}

async function runToolScenario(originMs: number): Promise<HarnessMark[]> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-replay-tools-"));
	const marks: HarnessMark[] = [];
	try {
		const fixtureRoot = await unpackToolFixtures(tempRoot);
		const settings = Settings.isolated({ "edit.mode": "replace", "compaction.enabled": false, "astGrep.enabled": true });
		const toolSession = createToolSession(fixtureRoot, settings, path.join(tempRoot, "artifacts"));
		const sample = path.join(fixtureRoot, "operator-swap-comparison-001", "input", "pending-action.ts");
		const mark = async (name: string, toolName: string, run: () => Promise<unknown>): Promise<void> => {
			const start = performance.now();
			await run();
			marks.push({ scenario: "tools", name, kind: "tool-call", toolName, startMs: start - originMs, endMs: performance.now() - originMs });
		};
		await mark("tools:read", "read", async () => new ReadTool(toolSession).execute("bench-read", { path: sample }));
		await mark("tools:search", "search", async () => new SearchTool(toolSession).execute("bench-search", { pattern: "return", paths: [fixtureRoot] }));
		await mark("tools:glob", "find", async () => new FindTool(toolSession).execute("bench-glob", { paths: [path.join(fixtureRoot, "**", "*.ts")] }));
		await mark("tools:bash", "bash", async () => new BashTool(toolSession).execute("bench-bash", { command: "grep -R -n 'return' operator-swap-comparison-001/input", timeout: 10 }));

		await mark("tools:ast_grep", "ast_grep", async () => new AstGrepTool(toolSession).execute("bench-ast-grep", { pat: "return $VALUE", paths: [fixtureRoot] }));

		const modes: EditMode[] = ["replace", "patch", "hashline", "vim", "apply_patch"];
		const editDirectory = path.join(fixtureRoot, "bench-edits");
		await fs.mkdir(editDirectory, { recursive: true });
		for (const mode of modes) {
			const filePath = path.join(editDirectory, `${mode}.ts`);
			await Bun.write(filePath, "export const benchValue = 1;\n");
			const edit = new EditTool(toolSession, mode);
			await mark(`tools:edit:${mode}`, "edit", async () => {
				if (mode === "replace") {
					return edit.execute(`bench-edit-${mode}`, { path: filePath, edits: [{ old_text: "benchValue", new_text: "benchValueUpdated" }] });
				}
				if (mode === "patch") {
					return edit.execute(`bench-edit-${mode}`, { path: filePath, edits: [{ diff: "@@ -1 +1 @@\n-export const benchValue = 1;\n+export const benchValueUpdated = 1;" }] });
				}
				if (mode === "hashline") {
					return edit.execute(`bench-edit-${mode}`, { path: filePath, input: `§${filePath}\n»BOF\n// hashline benchmark\n` });
				}
				if (mode === "vim") {
					return edit.execute(`bench-edit-${mode}`, { file: filePath, steps: [{ kbd: ["G", "o"], insert: "// vim benchmark" }] });
				}
				return edit.execute(`bench-edit-${mode}`, {
					input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-export const benchValue = 1;\n+export const benchValueUpdated = 1;\n*** End Patch`,
				});
			});
		}
		return marks;
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

async function runKeystrokeScenario(originMs: number): Promise<HarnessMark[]> {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	const editor = new Editor(defaultEditorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	const marks: HarnessMark[] = [];
	try {
		await terminal.flush();
		const keys = ["r", "e", "p", "l", "a", "y", " ", "한", "글", "", "!", "\x1b[D", "x", "\x1b[C", "\n", "f", "i", "n", "i", "s", "h", "\x7f", "?", "\x1b[H", "z", "\x1b[F"];
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index]!;
			const start = performance.now();
			terminal.sendInput(key);
			tui.requestRender(true, "session-replay-keystroke");
			await terminal.flush();
			marks.push({ scenario: "keystroke", name: `keystroke:${index}`, kind: "keystroke", startMs: start - originMs, endMs: performance.now() - originMs });
		}
		await terminal.waitForRender();
		if (editor.getText().length === 0) throw new Error("Keystroke scenario did not leave rendered editor content");
		return marks;
	} finally {
		tui.stop();
	}
}

async function copyCorpusEntry(entry: CorpusEntry, corpusDirectory: string): Promise<{ root: string; path: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-replay-compaction-"));
	const copied = await copyPathWithinTemp(corpusDirectory, entry, root);
	return { root, path: copied };
}

async function runCompactionScenario(
	manifest: CorpusManifest,
	corpusDirectories: CorpusDirectories,

	originMs: number,
): Promise<HarnessMark> {
	const compactionEntry = [...manifest.entries].sort((left, right) => right.assistantTurns - left.assistantTurns)[0];
	if (!compactionEntry) throw new Error("No corpus session is available for compaction");
	const unregisterSummarizer = "session-replay-bench";
	registerCustomApi("session-replay-summary", streamCompactionSummary, unregisterSummarizer);
	const copied = await copyCorpusEntry(compactionEntry, corpusDirectories[compactionEntry.id]!);
	let manager: SessionManager | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const mock = createMockModel();
	const model: Model = { ...mock.model, api: "session-replay-summary", provider: "session-replay", contextWindow: Math.min(mock.model.contextWindow, 8_192) };
	try {
		manager = await SessionManager.open(copied.path);
		const context = manager.buildSessionContext();
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Summarize the supplied session for a compaction benchmark."], tools: [], messages: context.messages },
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(path.join(copied.root, "auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "session-replay-compaction-benchmark-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const settings = Settings.isolated({ "compaction.enabled": true, "compaction.strategy": "context-full", "todo.reminders": false });
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		const start = performance.now();
		await session.compact("Summarize the existing recorded conversation.");
		return {
			scenario: "compaction",
			name: `compaction:${compactionEntry.id}`,
			kind: "compaction",
			sessionId: compactionEntry.id,
			startMs: start - originMs,
			endMs: performance.now() - originMs,
		};
	} finally {
		await session?.dispose();
		await manager?.close();
		authStorage?.close();
		unregisterCustomApis(unregisterSummarizer);
		await fs.rm(copied.root, { recursive: true, force: true });
	}
}

async function runInspectedScenario(
	name: Exclude<ScenarioName, "startup">,
	manifest: CorpusManifest,
	corpusDirectories: CorpusDirectories,

): Promise<ScenarioRunResult> {
	const profiler = await startCpuProfile();
	const originMs = performance.now();

	const marks: HarnessMark[] = [];
	const measurements: Record<string, FixtureMeasurement> = {};
	const replayFidelity: Record<string, ReplayFidelity> = {};
	const scenarioStart = performance.now();
	const minimumWallMs = MIN_SCENARIO_WALL_MS[name] ?? 0;
	try {
		for (let iteration = 0; iteration < MAX_SCENARIO_REPEATS; iteration += 1) {
			if (name === "session-load" || name === "session-save") {
				marks.push(...(await runSessionIoScenario(name, manifest, corpusDirectories, originMs)));
			} else if (name === "replay") {
				const replay = await runReplayScenario(manifest, corpusDirectories, originMs);
				marks.push(...replay.marks);
				Object.assign(replayFidelity, replay.replayFidelity);
				Object.assign(measurements, replay.measurements);
			} else if (name === "tools") {
				marks.push(...(await runToolScenario(originMs)));
			} else if (name === "keystroke") {
				marks.push(...(await runKeystrokeScenario(originMs)));
			} else {
				marks.push(await runCompactionScenario(manifest, corpusDirectories, originMs));
			}
			if (performance.now() - scenarioStart >= minimumWallMs) break;
		}
		const scenarioEnd = performance.now();
		marks.push({ scenario: name, name: `${name}:all`, kind: "scenario", startMs: scenarioStart - originMs, endMs: scenarioEnd - originMs });
		const captured = await profiler.stop();
		const profile = JSON.parse(captured.data) as FullCpuProfile;
		return { profile, marks, measurements, replayFidelity, notes: [] };
	} catch (error) {
		try {
			await profiler.stop();
		} catch {
			// The profile may already have been stopped after a capture error.
		}
		throw error;
	}
}

async function loadCombinedManifest(options: CliOptions): Promise<{ manifest: CorpusManifest; corpusDirectories: CorpusDirectories; manifestSha256: string }> {
	const baseDirectory = path.resolve(repositoryRoot, "packages", "coding-agent", "bench", "session-replay", "corpus");
	const baseManifestPath = path.join(baseDirectory, "manifest.json");
	const baseManifest = await loadCorpusManifest(baseDirectory);
	const rawManifests: unknown[] = [JSON.parse(await Bun.file(baseManifestPath).text()) as unknown];
	const corpusDirectories: CorpusDirectories = Object.fromEntries(baseManifest.entries.map(entry => [entry.id, baseDirectory]));
	const entries = [...baseManifest.entries];
	if (options.corpus) {
		const additionalDirectory = path.resolve(repositoryRoot, options.corpus);
		const additionalManifest = await loadCorpusManifest(additionalDirectory);
		if (additionalManifest.sanitizerVersion !== baseManifest.sanitizerVersion) {
			throw new Error("--corpus sanitizerVersion must match the committed corpus sanitizerVersion");
		}
		const existingIds = new Set(entries.map(entry => entry.id));
		for (const entry of additionalManifest.entries) {
			if (existingIds.has(entry.id)) throw new Error(`Duplicate corpus entry id: ${entry.id}`);
			entries.push(entry);
			corpusDirectories[entry.id] = additionalDirectory;
		}
		rawManifests.push(JSON.parse(await Bun.file(path.join(additionalDirectory, "manifest.json")).text()) as unknown);
	}
	const manifest: CorpusManifest = { ...baseManifest, entries };
	return { manifest, corpusDirectories, manifestSha256: sha256Hex(JSON.stringify(rawManifests)) };
}
async function capturePerfCorpusReport(): Promise<PerfCorpusReport> {
	const benchmarkPath = path.join(repositoryRoot, "packages", "coding-agent", "bench", "perf-corpus.bench.ts");
	const child = Bun.spawn([process.execPath, benchmarkPath], {
		cwd: repositoryRoot,
		env: { ...Bun.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Perf-corpus compatibility workload failed: ${stderr.trim()}`);
	return JSON.parse(stdout) as PerfCorpusReport;
}





function reportSummary(report: SessionReplayProfileReport): string {
	const lines: string[] = [];
	for (const [scenario, summary] of Object.entries(report.scenarios)) {
		const top = summary.topFunctions.slice(0, 5).map(item => `${item.functionName} ${item.selfTimeMs.toFixed(1)}ms (${(item.share * 100).toFixed(1)}%)`).join("; ");
		lines.push(`${scenario}: ${top || "no samples"}`);
	}
	lines.push("replay fidelity:");
	for (const [id, fidelity] of Object.entries(report.replayFidelity)) {
		const match = fidelity.recordedAssistantTurns === fidelity.replayedAssistantTurns && fidelity.recordedToolCallSeqSha256 === fidelity.replayedToolCallSeqSha256 && fidelity.finalFrameNonEmpty;
		lines.push(`  ${id}: turns ${fidelity.recordedAssistantTurns}/${fidelity.replayedAssistantTurns}, tool sequence ${fidelity.recordedToolCallSeqSha256 === fidelity.replayedToolCallSeqSha256 ? "match" : "mismatch"}, frame ${fidelity.finalFrameNonEmpty ? "non-empty" : "empty"}${match ? "" : " (failed)"}`);
	}
	return lines.join("\n");
}

async function readReport(pathname: string): Promise<SessionReplayProfileReport> {
	return JSON.parse(await Bun.file(pathname).text()) as SessionReplayProfileReport;
}


async function run(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
	const gitSha = new TextDecoder().decode(revision.stdout).trim();
	if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error("Could not resolve full git HEAD SHA");
	const outputDirectory = await ensureProfileOutputDirectory(repositoryRoot, options.out, gitSha);
	const compareBeforeRun = options.compare ? await readReport(path.resolve(repositoryRoot, options.compare)) : undefined;
	const { manifest, corpusDirectories, manifestSha256 } = await loadCombinedManifest(options);
	const manifestSnapshot = `${JSON.stringify(manifest, null, 2)}\n`;
	await Bun.write(path.join(outputDirectory, "corpus-manifest.json"), manifestSnapshot);
	await Bun.write(path.join(outputDirectory, "corpus-manifest.sha256"), `${manifestSha256}\n`);


	const profiles: Record<string, CpuProfile> = {};
	const marks: HarnessMark[] = [];
	const replayFidelity: Record<string, ReplayFidelity> = {};
	const measurements: Record<string, FixtureMeasurement> = {};
	const notes: string[] = ["Recorded assistant text is streamed in UTF-safe four-code-point chunks; this approximates token-sized deltas without adding a tokenizer dependency."];
	for (const scenario of options.scenarios) {
		if (scenario === "startup") {
			const startup = await runStartupScenario(outputDirectory);
			profiles.startup = startup.profile;
			marks.push(...startup.marks);
			notes.push(...startup.notes);
			marks.push({ scenario: "startup", name: "startup:all", kind: "scenario", startMs: 0, endMs: profileDurationMs(startup.profile) });
			await Bun.write(path.join(outputDirectory, "startup.cpuprofile"), `${JSON.stringify(startup.profile, null, 2)}\n`);
			continue;
		}
		const result = await runInspectedScenario(scenario, manifest, corpusDirectories);

		profiles[scenario] = result.profile;
		marks.push(...result.marks);
		Object.assign(replayFidelity, result.replayFidelity);
		Object.assign(measurements, result.measurements);
		notes.push(...result.notes);
		await Bun.write(path.join(outputDirectory, `${scenario}.cpuprofile`), `${JSON.stringify(result.profile, null, 2)}\n`);
	}
	const perfCorpusReport = await capturePerfCorpusReport();
	await Bun.write(path.join(outputDirectory, "perf-corpus-report.json"), `${JSON.stringify(perfCorpusReport, null, 2)}\n`);
	notes.push("Perf-corpus validation reuses the repository runner's measured fixture and memory-surface evidence, then adds one source-class-matched replay fixture per session.");

	if (profiles.replay) assertCorpusProvenance(manifest, replayFidelity);
	await Bun.write(path.join(outputDirectory, "marks.json"), `${JSON.stringify(marks, null, 2)}\n`);
	await Bun.write(path.join(outputDirectory, "replay-fidelity.json"), `${JSON.stringify(replayFidelity, null, 2)}\n`);
	await Bun.write(path.join(outputDirectory, "fixture-measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
	const report = await buildSessionReplayProfileReport({
		repositoryRoot,
		outputDirectory,
		manifest,
		manifestSha256,
		profiles,
		marks,
		replayFidelity,
		measurements,
		perfCorpusReport,
		notes,
		command: `bun run bench:profile -- --scenario ${options.scenarios.join(",")}${options.corpus ? ` --corpus ${options.corpus}` : ""}`,
	});
	await Bun.write(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await Bun.write(path.join(outputDirectory, "report.md"), renderProfileReportMarkdown(report));
	process.stdout.write(`Profile output: ${path.relative(repositoryRoot, outputDirectory)}\n${reportSummary(report)}\n`);
	if (compareBeforeRun) {
		const overlaps = compareTopFunctions(report, compareBeforeRun);
		let fails = false;
		for (const [scenario, overlap] of Object.entries(overlaps)) {
			process.stdout.write(`${scenario} top-function overlap: ${overlap}/10\n`);
			if (overlap < 8) fails = true;
		}
		if (fails) process.exitCode = 1;
	}
}

if (import.meta.main) {
	run().catch(error => {
		const name = error instanceof Error ? error.name : "Error";
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${name}: ${message}\n`);
		process.exitCode = 1;
	});
}
