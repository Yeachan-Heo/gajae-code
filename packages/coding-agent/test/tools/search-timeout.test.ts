import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { SearchTool } from "@gajae-code/coding-agent/tools/search";
import { ToolAbortError } from "@gajae-code/coding-agent/tools/tool-errors";
import type { GrepOptions, GrepResult, grep as grepFn } from "@gajae-code/natives";

interface BlockingGrepHarness {
	grep: typeof grepFn;
	started: Promise<void>;
	getOptions(): GrepOptions | undefined;
}

function createBlockingGrep(): BlockingGrepHarness {
	const started = Promise.withResolvers<void>();
	let observed: GrepOptions | undefined;
	const grep: typeof grepFn = async options => {
		observed = options;
		started.resolve();
		if (!(options.signal instanceof AbortSignal)) throw new Error("Expected search abort signal");
		const outcome = Promise.withResolvers<GrepResult>();
		options.signal.addEventListener(
			"abort",
			() => {
				const error = new Error("Aborted");
				error.name = "AbortError";
				outcome.reject(error);
			},
			{ once: true },
		);
		return await outcome.promise;
	};
	return { grep, started: started.promise, getOptions: () => observed };
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
	};
}

describe("SearchTool timeout", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-search-timeout-"));
		await Bun.write(path.join(tempDir, "target.txt"), "needle\n");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("enforces the requested call-wide deadline in native grep", async () => {
		const harness = createBlockingGrep();
		const tool = new SearchTool(createSession(tempDir), { grep: harness.grep });

		const execution = tool.execute("timeout", { pattern: "needle", timeout: 0.5 });
		await harness.started;
		await expect(execution).rejects.toThrow("Search timed out after 0.5s; increase timeout or narrow paths/pattern");

		expect(harness.getOptions()?.timeoutMs).toBe(500);
		expect(harness.getOptions()?.signal).toBeInstanceOf(AbortSignal);
	});

	it("reports caller cancellation as a tool abort instead of a timeout", async () => {
		const harness = createBlockingGrep();
		const tool = new SearchTool(createSession(tempDir), { grep: harness.grep });
		const controller = new AbortController();

		const execution = tool.execute("cancel", { pattern: "needle", timeout: 60 }, controller.signal);
		await harness.started;
		controller.abort();

		await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("waits for native cancellation cleanup before returning the timeout", async () => {
		let cleanupSettled = false;
		const grep: typeof grepFn = async options => {
			const signal = options.signal;
			if (!(signal instanceof AbortSignal)) throw new Error("Expected search abort signal");
			return await new Promise<GrepResult>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						setTimeout(() => {
							cleanupSettled = true;
							reject(new DOMException("Aborted", "AbortError"));
						}, 50);
					},
					{ once: true },
				);
			});
		};
		const tool = new SearchTool(createSession(tempDir), { grep });

		await expect(tool.execute("joined-timeout", { pattern: "needle", timeout: 0.5 })).rejects.toThrow(
			"Search timed out after 0.5s; increase timeout or narrow paths/pattern",
		);
		expect(cleanupSettled).toBe(true);
	});

	it("does not surface partial results collected before a later target times out", async () => {
		await Bun.write(path.join(tempDir, "second.txt"), "needle\n");
		let calls = 0;
		const grep: typeof grepFn = async options => {
			calls++;
			if (calls === 1) {
				return {
					matches: [
						{
							path: "",
							lineNumber: 1,
							line: "needle",
						},
					],
					totalMatches: 1,
					filesWithMatches: 1,
					filesSearched: 1,
				};
			}
			const signal = options.signal;
			if (!(signal instanceof AbortSignal)) throw new Error("Expected search abort signal");
			return await new Promise<GrepResult>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		};
		const tool = new SearchTool(createSession(tempDir), { grep });

		await expect(
			tool.execute("partial-timeout", {
				pattern: "needle",
				paths: ["target.txt", "second.txt"],
				timeout: 0.5,
			}),
		).rejects.toThrow("Search timed out after 0.5s; increase timeout or narrow paths/pattern");
		expect(calls).toBe(2);
	});

	it("publishes the default and accepted timeout bounds", () => {
		const tool = new SearchTool(createSession(tempDir));
		expect(tool.parameters.parse({ pattern: "needle" }).timeout).toBe(5);
		expect(tool.parameters.safeParse({ pattern: "needle", timeout: 0.49 }).success).toBe(false);
		expect(tool.parameters.safeParse({ pattern: "needle", timeout: 60.01 }).success).toBe(false);
	});
});
