import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type SdkComposerObservation,
	SdkComposerObservationError,
	type SdkSessionInfo,
	type SdkSessionInfoUsage,
} from "@gajae-code/coding-agent/sdk";
import { $ } from "bun";
import {
	DESKTOP_SESSION_INFO_LIMITS,
	type DesktopSessionInfoOptions,
	projectDesktopSessionInfo,
	type RunGh,
	readDesktopPullRequest,
	readDesktopSessionInfo,
} from "../src/session-info";
import type { DesktopSessionInfo } from "../src/session-info-protocol";
import { projectGoal, projectTodos } from "../src/session-state";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
	}
});

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
		hud: { branch: `feature/${secret}/${sdkSessionId}`, jobs: 3, tokensPerSecond: 8, version: "sdk-version" },
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
		for (const hidden of [secret, sdkSessionId, "/private/project", "stats", "sessionGeneration", "modelProfile"])
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
		result.hud.branch = "tampered";
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

describe("desktop session HUD", () => {
	test("projects public SDK branch, owner-scoped jobs, rate and version without rebuilding telemetry", () => {
		const source = snapshot();
		const result = read(source);
		expect(result.hud).toEqual({
			branch: "feature/[redacted]/[session]",
			jobs: 3,
			tokensPerSecond: 8,
			version: "sdk-version",
		});
		result.hud.jobs = 99;
		expect(source.hud.jobs).toBe(3);
		source.hud.branch = "detached";
		expect(read(source).hud.branch).toBe("detached");
	});

	test("preserves missing live HUD evidence and redacts display fields before truncation", () => {
		const source = snapshot();
		source.hud = { branch: null, jobs: null, tokensPerSecond: null, version: `engine ${secret} ${sdkSessionId}` };
		expect(read(source).hud).toEqual({
			branch: null,
			jobs: null,
			tokensPerSecond: null,
			version: "engine [redacted] [session]",
		});
		source.hud.branch = `${"😀".repeat(DESKTOP_SESSION_INFO_LIMITS.fieldChars)}${secret}`;
		const result = read(source);
		expect(result.hud.branch).toBe(`${"😀".repeat(DESKTOP_SESSION_INFO_LIMITS.fieldChars)}…`);
		expect(JSON.stringify(result)).not.toContain(secret);
	});
});

describe("desktop session pull request", () => {
	const pullRequest = { number: 42, url: "https://github.com/owner/repo/pull/42" };

	async function checkout(): Promise<string> {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-pr-")));
		cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
		return directory;
	}

	test("asks gh for the checked-out branch's pull request once per branch", async () => {
		const directory = await checkout();
		const calls: string[][] = [];
		const runGh: RunGh = async args => {
			calls.push(args);
			return args[2] === "feature/pr"
				? { exitCode: 0, stdout: JSON.stringify({ ...pullRequest, headRefName: args[2] }), stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "no pull requests found" };
		};
		expect(await readDesktopPullRequest(directory, runGh)).toBeNull();
		expect(calls).toEqual([]);
		await $`git init -q -b feature/pr`.cwd(directory).quiet();
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
		expect(calls).toEqual([["pr", "view", "feature/pr", "--json", "number,url,headRefName"]]);
		await $`git symbolic-ref HEAD refs/heads/main`.cwd(directory).quiet();
		expect(await readDesktopPullRequest(directory, runGh)).toBeNull();
		expect(calls).toEqual([
			["pr", "view", "feature/pr", "--json", "number,url,headRefName"],
			["pr", "view", "main", "--json", "number,url,headRefName"],
		]);
	});

	test("pins gh and its cache to the captured branch when HEAD changes during repository metadata reads", async () => {
		const directory = await checkout();
		await $`git init -q -b feature/captured`.cwd(directory).quiet();
		const successor = { number: 43, url: "https://github.com/owner/repo/pull/43" };
		const git = Bun.which("git")!;
		const spawn = Bun.spawn;
		let switchBranch = true;
		vi.spyOn(Bun, "spawn").mockImplementation(
			new Proxy(spawn, {
				apply(target, thisArg, args) {
					const command: unknown = args[0];
					if (Array.isArray(command) && command[0] === git && command[1] === "rev-parse" && switchBranch) {
						switchBranch = false;
						// The branch read has completed, but repository metadata is still awaiting its command.
						const changed = Bun.spawnSync([git, "symbolic-ref", "HEAD", "refs/heads/feature/successor"], {
							cwd: directory,
						});
						expect(changed.exitCode).toBe(0);
					}
					return Reflect.apply(target, thisArg, args);
				},
			}),
		);
		const runGh = vi.fn<RunGh>(async args => {
			expect((await Bun.file(path.join(directory, ".git", "HEAD")).text()).trim()).toBe(
				"ref: refs/heads/feature/successor",
			);
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					...(args[2] === "feature/captured" ? pullRequest : successor),
					headRefName: args[2],
				}),
				stderr: "",
			};
		});
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
		expect(runGh).toHaveBeenNthCalledWith(1, ["pr", "view", "feature/captured", "--json", "number,url,headRefName"], {
			timeoutMs: 5_000,
		});
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(successor);
		expect(runGh).toHaveBeenNthCalledWith(
			2,
			["pr", "view", "feature/successor", "--json", "number,url,headRefName"],
			{
				timeoutMs: 5_000,
			},
		);
		await $`git symbolic-ref HEAD refs/heads/feature/captured`.cwd(directory).quiet();
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
		expect(runGh).toHaveBeenCalledTimes(2);
	});

	test("withholds numeric selectors with unrelated heads and accepts exact numeric branch matches", async () => {
		const directory = await checkout();
		await $`git init -q -b 42`.cwd(directory).quiet();
		const matching = { number: 43, url: "https://github.com/owner/repo/pull/43" };
		const runGh = vi.fn<RunGh>(async args => ({
			exitCode: 0,
			stdout: JSON.stringify(
				args[2] === "42" ? { ...pullRequest, headRefName: "unrelated/head" } : { ...matching, headRefName: "43" },
			),
			stderr: "",
		}));
		expect(await readDesktopPullRequest(directory, runGh)).toBeNull();
		expect(await readDesktopPullRequest(directory, runGh)).toBeNull();
		expect(runGh).toHaveBeenCalledTimes(1);
		expect(runGh).toHaveBeenNthCalledWith(1, ["pr", "view", "42", "--json", "number,url,headRefName"], {
			timeoutMs: 5_000,
		});
		await $`git symbolic-ref HEAD refs/heads/43`.cwd(directory).quiet();
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(matching);
		expect(runGh).toHaveBeenNthCalledWith(2, ["pr", "view", "43", "--json", "number,url,headRefName"], {
			timeoutMs: 5_000,
		});
	});

	test("coalesces concurrent lookups and returns independently mutable cached DTOs", async () => {
		const directory = await checkout();
		await $`git init -q -b feature/concurrent`.cwd(directory).quiet();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runGh = vi.fn(async () => {
			entered.resolve();
			await release.promise;
			return {
				exitCode: 0,
				stdout: JSON.stringify({ ...pullRequest, headRefName: "feature/concurrent" }),
				stderr: "",
			};
		});
		const first = readDesktopPullRequest(directory, runGh);
		const second = readDesktopPullRequest(directory, runGh);
		await entered.promise;
		release.resolve();
		const results = await Promise.all([first, second]);
		expect(results).toEqual([pullRequest, pullRequest]);
		expect(runGh).toHaveBeenCalledTimes(1);
		results[0]!.number = 999;
		expect(results[1]).toEqual(pullRequest);
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
	});

	test("propagates command failures without caching a fabricated no-PR result", async () => {
		const directory = await checkout();
		await $`git init -q -b feature/failure`.cwd(directory).quiet();
		const runGh = vi
			.fn<RunGh>()
			.mockRejectedValueOnce(new Error("fixture command failed"))
			.mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify({ ...pullRequest, headRefName: "feature/failure" }),
				stderr: "",
			});
		await expect(readDesktopPullRequest(directory, runGh)).rejects.toThrow("fixture command failed");
		expect(await readDesktopPullRequest(directory, runGh)).toEqual(pullRequest);
		expect(runGh).toHaveBeenCalledTimes(2);
	});

	test("rejects malformed or unsafe pull-request metadata rather than inventing a link", async () => {
		const directory = await checkout();
		await $`git init -q -b feature/invalid`.cwd(directory).quiet();
		const invalid = [
			"not json",
			JSON.stringify({ number: 0, url: pullRequest.url, headRefName: "invalid-1" }),
			JSON.stringify({
				number: 42,
				url: "https://user:password@github.com/owner/repo/pull/42",
				headRefName: "invalid-2",
			}),
			JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/43", headRefName: "invalid-3" }),
			JSON.stringify({ number: 42, url: `${pullRequest.url}?token=secret`, headRefName: "invalid-4" }),
			JSON.stringify({ number: 42, url: `${pullRequest.url}\n`, headRefName: "invalid-5" }),
			JSON.stringify(pullRequest),
		];
		for (const [index, stdout] of invalid.entries()) {
			await $`git symbolic-ref HEAD ${`refs/heads/invalid-${index}`}`.cwd(directory).quiet();
			expect(await readDesktopPullRequest(directory, async () => ({ exitCode: 0, stdout, stderr: "" }))).toBeNull();
		}
	});

	test("skips the lookup for a detached HEAD and rejects a non-GitHub pull request URL", async () => {
		const directory = await checkout();
		await $`git init -q -b feature/url`.cwd(directory).quiet();
		const runGh: RunGh = async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ number: 7, url: "javascript:alert(1)", headRefName: "feature/url" }),
			stderr: "",
		});
		expect(await readDesktopPullRequest(directory, runGh)).toBeNull();
		await Bun.write(path.join(directory, ".git", "HEAD"), `${"a".repeat(40)}\n`);
		const unused = vi.fn(runGh);
		expect(await readDesktopPullRequest(directory, unused)).toBeNull();
		expect(unused).not.toHaveBeenCalled();
	});
});
