import { describe, expect, test, vi } from "bun:test";
import {
	type SdkComposerObservation,
	SdkComposerObservationError,
	type SdkSessionInfo,
	type SdkSessionInfoUsage,
} from "@gajae-code/coding-agent/sdk";
import {
	DESKTOP_SESSION_INFO_LIMITS,
	type DesktopSessionInfoOptions,
	projectDesktopSessionInfo,
	readDesktopSessionInfo,
} from "../src/session-info";
import type { DesktopSessionInfo } from "../src/session-info-protocol";
import { projectGoal, projectTodos } from "../src/session-state";

const secret = "private-sdk-metadata";
const catalogSessionId = "desktop-catalog-session";
const sdkSessionId = "sdk-owner-identity";
const options: DesktopSessionInfoOptions = {
	catalogSessionId,
	redact: value => value.replaceAll(secret, "[redacted]").replaceAll("/private/project", "[project]"),
};

function usage(source: SdkSessionInfoUsage["source"], input: number): SdkSessionInfoUsage {
	return {
		available: true,
		source,
		note: `SDK provenance for ${source}`,
		tokens: { input, output: 7, cacheRead: 3, cacheWrite: 2, total: input + 12 },
		premiumRequests: null,
		cost: {
			amount: 0.25,
			source: source === "stream_partial" ? "live_partial_cost" : "sdk_recorded_cost",
			reason: "SDK recorded cost is not actual billed cost.",
		},
	};
}

/** Public observation DTO, not a reimplementation of session internals or usage calculations. */
function snapshot(): SdkSessionInfo {
	return {
		sessionId: sdkSessionId,
		sessionGeneration: 7,
		name: `Conversation ${secret} ${sdkSessionId}`,
		cwd: "/private/project",
		model: { provider: "fixture-provider", id: "fixture-model", name: `Model ${secret}`, contextWindow: 32_768 },
		modelProfile: "not-in-desktop-protocol",
		thinkingLevel: "high",
		streaming: true,
		bashRunning: true,
		pythonRunning: false,
		queuedMessages: 2,
		metadata: { createdAt: "2026-11-01T00:00:00.000Z", persisted: true },
		hud: { branch: "not-in-desktop-protocol", jobs: 3, tokensPerSecond: 8, version: "sdk-version" },
		run: {
			state: "compacting",
			streaming: true,
			bashRunning: true,
			pythonRunning: false,
			compacting: true,
			retrying: false,
			postPromptWork: true,
			queuedMessages: 2,
		},
		tools: { available: 4, pending: 1, calls: 9, results: 8 },
		recordedTotals: usage("transcript_aggregate", 100),
		activeTotals: usage("active_messages", 30),
		liveProgress: usage("stream_partial", 5),
		accountQuota: { available: false, reason: "No account endpoint was queried." },
		actualBilledCost: { available: false, reason: "No invoice evidence is available." },
		context: {
			tokens: 500,
			contextWindow: 32_768,
			percent: 1.52587890625,
			source: "provider_anchor",
			note: "SDK provider anchor plus heuristic trailing changes, not cumulative usage.",
		},
		stats: {
			userMessages: 1,
			assistantMessages: 2,
			toolCalls: 9,
			toolResults: 8,
			totalMessages: 20,
			tokens: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 },
			premiumRequests: 999,
			cost: 999,
		},
	};
}

function available(result: DesktopSessionInfo) {
	if (!result.available) throw new Error(`Expected available information, got ${result.code}`);
	return result;
}

function read(info: SdkSessionInfo, override: Partial<DesktopSessionInfoOptions> = {}) {
	return available(projectDesktopSessionInfo(info, { ...options, ...override }));
}

describe("desktop public SDK session information mapping", () => {
	test("maps public metadata, run state, tool counts and usage provenance without recalculating SDK observations", () => {
		const info = snapshot();
		const result = read(info);
		expect(result.metadata).toEqual({
			catalogSessionId,
			name: "Conversation [redacted] [session]",
			sessionFileDisplay: null,
			cwd: "[project]",
			createdAt: info.metadata.createdAt,
			persisted: true,
		});
		expect(result.model).toEqual({ provider: "fixture-provider", id: "fixture-model", name: "Model [redacted]" });
		expect(result.thinkingLevel).toBe("high");
		for (const key of [
			"run",
			"tools",
			"recordedTotals",
			"activeTotals",
			"liveProgress",
			"context",
			"accountQuota",
			"actualBilledCost",
		] as const)
			expect(result[key]).toEqual(info[key]);
		const serialized = JSON.stringify(result);
		for (const hidden of [
			secret,
			sdkSessionId,
			"/private/project",
			"stats",
			"sessionGeneration",
			"hud",
			"modelProfile",
		])
			expect(serialized).not.toContain(hidden);
	});

	test("preserves unavailable and partially known metrics instead of coercing missing evidence to zero", () => {
		const info = snapshot();
		info.recordedTotals = { available: false, reason: "No usable positive SDK usage." };
		info.activeTotals = usage("active_messages", 20);
		info.activeTotals.tokens.cacheRead = null;
		info.activeTotals.tokens.total = null;
		info.activeTotals.cost.amount = null;
		info.activeTotals.cost.reason = "Zero has unknown pricing provenance.";
		info.liveProgress = { available: false, reason: "No assistant stream is observable." };
		info.context = {
			tokens: null,
			contextWindow: 32_768,
			percent: null,
			source: "unknown",
			note: "Compaction invalidated the usage anchor.",
		};
		const result = read(info);
		expect(result.recordedTotals).toEqual(info.recordedTotals);
		expect(result.activeTotals).toEqual(info.activeTotals);
		expect(result.liveProgress).toEqual(info.liveProgress);
		expect(result.context).toEqual(info.context);
	});

	test("returns independent DTOs without mutating the public snapshot", () => {
		const info = snapshot();
		const original = structuredClone(info);
		const result = read(info);
		result.metadata.cwd = "tampered";
		result.model!.id = "tampered";
		result.run.queuedMessages = 999;
		result.tools.pending = 999;
		result.context.tokens = 999;
		if (result.activeTotals.available) result.activeTotals.tokens.input = 999;
		result.accountQuota.reason = "tampered";
		expect(info).toEqual(original);
	});

	test("redacts complete observed fields before desktop truncation and sanitizes controls and Unicode", () => {
		const info = snapshot();
		const long = `${"😀".repeat(DESKTOP_SESSION_INFO_LIMITS.fieldChars - 1)}${secret}`;
		info.model!.name = long;
		const seen: string[] = [];
		const result = read(info, {
			redact: value => {
				seen.push(value);
				return options.redact(value);
			},
		});
		expect(seen).toContain(long);
		expect(result.model!.name.isWellFormed()).toBe(true);
		expect([...result.model!.name].length).toBe(DESKTOP_SESSION_INFO_LIMITS.fieldChars + 1);
		expect(result.model!.name).toEndWith("…");
		expect(JSON.stringify(result)).not.toContain(secret);
		info.model!.name = "safe\u001b\u0000\u202e\ud800😀";
		expect(read(info).model!.name).toBe("safe   �😀");
	});

	test("withholds oversized input and expanded redactor output rather than truncating secret-bearing metadata", () => {
		const info = snapshot();
		const oversized = "x".repeat(DESKTOP_SESSION_INFO_LIMITS.inputChars + 1);
		info.model!.name = oversized;
		const redact = vi.fn(options.redact);
		expect(read(info, { redact }).model!.name).toBe("[withheld: display limit]");
		expect(redact.mock.calls.some(([value]) => value === oversized)).toBe(false);
		expect(read(info, { redact: () => oversized }).metadata.cwd).toBe("[withheld: display limit]");
	});

	test("masks observed SDK identity before and after the host redactor without hiding provider/model identities", () => {
		const info = snapshot();
		const seen: string[] = [];
		const result = read(info, {
			redact: value => {
				seen.push(value);
				return `${value} ${sdkSessionId}`;
			},
		});
		expect(seen.every(value => !value.includes(sdkSessionId))).toBe(true);
		expect(result.model!.provider).toBe("fixture-provider [session]");
		expect(JSON.stringify(result)).not.toContain(sdkSessionId);
	});

	test("fails closed on throwing or invalid host redactors without exposing exception text", () => {
		const info = snapshot();
		const result = projectDesktopSessionInfo(info, {
			...options,
			redact: () => {
				throw new Error(secret);
			},
		});
		expect(result).toMatchObject({ available: false, code: "redaction_failed" });
		expect(JSON.stringify(result)).not.toContain(secret);
		const invalid: DesktopSessionInfo = Reflect.apply(projectDesktopSessionInfo, undefined, [
			info,
			{ ...options, redact: () => null },
		]);
		expect(invalid).toMatchObject({ available: false, code: "redaction_failed" });
	});

	test("rejects invalid catalog identity and SDK identities masquerading as app identities", () => {
		const info = snapshot();
		for (const id of ["", "../sdk", "app\n", "a".repeat(129), sdkSessionId, `app-${sdkSessionId}`])
			expect(projectDesktopSessionInfo(info, { ...options, catalogSessionId: id })).toMatchObject({
				available: false,
				code: "invalid_catalog_session",
			});
	});

	test("omits absent model/name/thinking without inventing metadata", () => {
		const info = snapshot();
		delete info.model;
		delete info.name;
		info.thinkingLevel = null;
		info.metadata.createdAt = null;
		const result = read(info);
		expect(result.model).toBeNull();
		expect(result.thinkingLevel).toBeNull();
		expect(result.metadata).toMatchObject({ name: null, createdAt: null, sessionFileDisplay: null });
	});
});

describe("desktop live public SDK observation fencing", () => {
	test("reads the same public observation again after the host callback, without reaching into session internals", () => {
		const info = vi.fn(() => snapshot());
		const result = readDesktopSessionInfo({ info }, options);
		expect(available(result).run.state).toBe("compacting");
		expect(info).toHaveBeenCalledTimes(2);
		expect(info).toHaveBeenCalledWith({});
	});

	test("maps typed SDK lifecycle failures to existing desktop failure codes", () => {
		for (const [sdkCode, code] of [
			["disposed", "disposed"],
			["session_transitioning", "transitioning"],
			["stale_session", "stale_session"],
			["backend_failure", "backend_failure"],
			["invalid_input", "backend_failure"],
		] as const) {
			const info: SdkComposerObservation["info"] = () => {
				throw new SdkComposerObservationError(sdkCode);
			};
			expect(readDesktopSessionInfo({ info }, options)).toMatchObject({ available: false, code });
		}
	});

	test("contains unknown backend errors without returning their text", () => {
		const result = readDesktopSessionInfo(
			{
				info: () => {
					throw new Error(secret);
				},
			},
			options,
		);
		expect(result).toMatchObject({ available: false, code: "backend_failure" });
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("rejects a changed SDK identity, generation, or cwd after reentrant host redaction", () => {
		for (const change of [{ sessionId: "other" }, { sessionGeneration: 8 }, { cwd: "/other" }]) {
			let current = snapshot();
			const result = readDesktopSessionInfo(
				{ info: () => structuredClone(current) },
				{
					...options,
					redact: value => {
						current = { ...current, ...change };
						return options.redact(value);
					},
				},
			);
			expect(result).toMatchObject({ available: false, code: "stale_session" });
		}
	});

	test("reports SDK disposal triggered by reentrant redaction", () => {
		let disposed = false;
		const result = readDesktopSessionInfo(
			{
				info: () => {
					if (disposed) throw new SdkComposerObservationError("disposed");
					return snapshot();
				},
			},
			{
				...options,
				redact: value => {
					disposed = true;
					return options.redact(value);
				},
			},
		);
		expect(result).toMatchObject({ available: false, code: "disposed" });
	});

	test("rejects stale app selection before reading and after the host callback", () => {
		const info = vi.fn(() => snapshot());
		expect(readDesktopSessionInfo({ info }, { ...options, isCurrent: () => false })).toMatchObject({
			available: false,
			code: "stale_session",
		});
		expect(info).not.toHaveBeenCalled();
		let current = true;
		expect(
			readDesktopSessionInfo(
				{ info },
				{
					...options,
					isCurrent: () => current,
					redact: value => {
						current = false;
						return options.redact(value);
					},
				},
			),
		).toMatchObject({ available: false, code: "stale_session" });
	});
});

describe("public session todo/goal projection", () => {
	test("projects bounded todo content without retaining mutable SDK task objects", () => {
		const phases = [{ name: "Phase", tasks: [{ content: "x".repeat(400), status: "in_progress" as const }] }];
		const result = projectTodos({ getTodoPhases: () => phases });
		expect(result.todos).toEqual([{ name: "Phase", tasks: [{ content: "x".repeat(300), status: "in_progress" }] }]);
		result.todos![0]!.tasks[0]!.content = "changed";
		expect(phases[0]!.tasks[0]!.content).toHaveLength(400);
	});

	test("caps todo projection across phases and tasks", () => {
		const phases = Array.from({ length: 30 }, (_, phase) => ({
			name: `Phase ${phase}`,
			tasks: [{ content: "Task", status: "pending" as const }],
		}));
		expect(projectTodos({ getTodoPhases: () => phases }).todos).toHaveLength(24);
		const tasks = Array.from({ length: 130 }, () => ({ content: "Task", status: "pending" as const }));
		expect(projectTodos({ getTodoPhases: () => [{ name: "Phase", tasks }] }).todos![0]!.tasks).toHaveLength(120);
	});

	test("maps retained goal statuses without leaking SDK goal ownership and bookkeeping", () => {
		for (const status of ["active", "paused", "complete", "dropped"] as const) {
			const result = projectGoal({
				getGoalModeState: () => ({
					enabled: status === "active",
					mode: "active",
					goal: {
						id: sdkSessionId,
						objective: "x".repeat(400),
						status,
						tokensUsed: 50,
						timeUsedSeconds: 3,
						createdAt: 1,
						updatedAt: 2,
					},
				}),
			});
			expect(result).toEqual({
				goal: {
					objective: "x".repeat(300),
					status,
					tokensUsed: 50,
					timeUsedSeconds: 3,
				},
			});
		}
	});

	test("omits absent and failing todo/goal observations", () => {
		expect(projectTodos()).toEqual({});
		expect(projectTodos({ getTodoPhases: () => [] })).toEqual({});
		expect(
			projectTodos({
				getTodoPhases: () => {
					throw new Error(secret);
				},
			}),
		).toEqual({});
		expect(projectGoal()).toEqual({});
		expect(projectGoal({ getGoalModeState: () => undefined })).toEqual({});
		expect(
			projectGoal({
				getGoalModeState: () => {
					throw new Error(secret);
				},
			}),
		).toEqual({});
	});
});
