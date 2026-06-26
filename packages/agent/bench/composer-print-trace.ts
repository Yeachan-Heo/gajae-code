import * as fs from "node:fs/promises";
import { traceExpectationForScenario, type ScenarioId, type TraceExpectation } from "./composer-scenarios";
import type { TraceRecord } from "./composer-stability-v3";

type JsonObject = Record<string, unknown>;

export { traceExpectationForScenario, type TraceExpectation } from "./composer-scenarios";

export async function readSessionJsonl(sessionFile: string): Promise<JsonObject[]> {
	const raw = await fs.readFile(sessionFile, "utf8");
	return raw
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as JsonObject);
}

/** Convert persisted GJC session JSONL into classifier events (tool_call / tool_execution_end / scenario_result). */
export function sessionLinesToTraceEvents(lines: JsonObject[], exitCode: number): JsonObject[] {
	const events: JsonObject[] = [];
	for (const line of lines) {
		if (line.type !== "message") continue;
		const message = line.message;
		if (!message || typeof message !== "object") continue;
		const role = (message as JsonObject).role;
		if (role === "assistant") {
			const content = (message as JsonObject).content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as JsonObject;
				if (p.type === "toolCall") {
					events.push({
						type: "tool_call",
						toolName: p.name,
						status: "called",
						arguments: p.arguments,
					});
				}
			}
		}
		if (role === "toolResult") {
			const m = message as JsonObject;
			const isError = m.isError === true;
			events.push({
				type: "tool_execution_end",
				toolName: m.toolName,
				status: isError ? "error" : "success",
				arguments: extractToolArgsFromDetails(m.details),
				message: flattenToolResultContent(m.content),
			});
		}
	}
	events.push({
		type: "scenario_result",
		status: exitCode === 0 ? "passed" : "failed",
	});
	return events;
}

function extractToolArgsFromDetails(details: unknown): unknown {
	if (!details || typeof details !== "object") return undefined;
	return (details as JsonObject).arguments;
}

function flattenToolResultContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && (item as JsonObject).type === "text") {
			const text = (item as JsonObject).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

export function buildTraceRecord(input: {
	scenarioId: ScenarioId;
	modelRole: "candidate" | "baseline";
	model: string;
	trial: number;
	events: JsonObject[];
	tracePath?: string;
	expected?: TraceExpectation;
}): TraceRecord {
	return {
		scenarioId: input.scenarioId,
		modelRole: input.modelRole,
		model: input.model,
		trial: input.trial,
		events: input.events,
		expected: input.expected ?? traceExpectationForScenario(input.scenarioId),
		tracePath: input.tracePath,
	};
}

export async function findLatestSessionFile(sessionDir: string): Promise<string | undefined> {
	let entries: string[];
	try {
		entries = await fs.readdir(sessionDir);
	} catch {
		return undefined;
	}
	const jsonl = entries.filter(name => name.endsWith(".jsonl")).sort();
	if (jsonl.length === 0) return undefined;
	return `${sessionDir}/${jsonl[jsonl.length - 1]}`;
}