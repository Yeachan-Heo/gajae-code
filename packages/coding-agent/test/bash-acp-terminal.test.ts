import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ClientBridge, ClientBridgeTerminalHandle } from "../src/session/client-bridge";
import { truncateHeadBytes, truncateTailBytes } from "../src/session/streaming-output";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { stubBashExecutorSettings } from "./helpers/tool-session-settings";

interface SessionOptions {
	tailKiB?: number;
	headKiB?: number;
	saveArtifact?: (content: string, type: string) => Promise<string>;
}

function makeSession(bridge: ClientBridge, options: SessionOptions = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "search.enabled") return false;
				if (key === "find.enabled") return false;
				if (key === "tools.artifactTailBytes") return options.tailKiB;
				if (key === "tools.artifactHeadBytes") return options.headKiB;
				return undefined;
			},
			has(key: string) {
				if (key === "tools.artifactTailBytes") return options.tailKiB !== undefined;
				if (key === "tools.artifactHeadBytes") return options.headKiB !== undefined;
				return false;
			},
			getBashInterceptorRules() {
				return [];
			},
			...stubBashExecutorSettings,
		},
		getClientBridge: () => bridge,
		getArtifactManager: options.saveArtifact ? () => ({ save: options.saveArtifact }) : undefined,
	} as unknown as ToolSession;
}

afterEach(() => {
	mock.restore();
});

describe("BashTool ACP terminal routing", () => {
	it("routes through bridge, emits terminalId update, and releases the handle", async () => {
		const stubText = "hello from terminal\n";

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-xyz",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};

		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		const updates: Array<{ details?: { terminalId?: string } }> = [];

		const tool = new BashTool(makeSession(bridge));
		const result = await tool.execute("call-1", { command: "echo hi" }, undefined, update => {
			updates.push(update as { details?: { terminalId?: string } });
		});

		// createTerminal must be called with the expanded command
		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("echo hi");
		expect(params.outputByteLimit).toBe(1024);

		// The first onUpdate must carry the terminalId so the editor can embed it
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0]!.details?.terminalId).toBe("term-xyz");

		// The final result text must contain the stub output
		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("hello from terminal");

		// The result details must carry terminalId for the ACP event mapper
		expect(result.details?.terminalId).toBe("term-xyz");

		// The handle must always be released
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("bounds client-terminal output to the default 1 KiB tail", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(400)}TAIL\n`;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-tail",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const result = await new BashTool(makeSession(bridge)).execute("call-tail", { command: "wide-output" });
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).not.toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(result.details?.meta?.truncation?.direction).toBe("tail");
		expect(result.details?.meta?.truncation?.outputBytes).toBeGreaterThan(1000);
		expect(result.details?.meta?.truncation?.outputBytes).toBeLessThanOrEqual(1024);
	});

	it("honors an explicit ACP tail budget", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(800)}TAIL\n`;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-explicit-tail",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const result = await new BashTool(makeSession(bridge, { tailKiB: 2 })).execute("call-explicit-tail", {
			command: "wide-output",
		});

		expect(createSpy.mock.calls[0]?.[0].outputByteLimit).toBe(2048);
		expect(result.details?.meta?.truncation?.direction).toBe("tail");
		expect(result.details?.meta?.truncation?.outputBytes).toBeGreaterThan(2000);
		expect(result.details?.meta?.truncation?.outputBytes).toBeLessThanOrEqual(2048);
	});

	it("honors explicit ACP head retention and artifacts the full returned output", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(800)}TAIL\n`;
		const saveArtifact = mock(async () => "acp-full-output");
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-head-tail",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const result = await new BashTool(makeSession(bridge, { tailKiB: 1, headKiB: 1, saveArtifact })).execute(
			"call-head-tail",
			{ command: "wide-output" },
		);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(createSpy.mock.calls[0]?.[0].outputByteLimit).toBeUndefined();
		expect(text).toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(text).toContain("elided");
		expect(result.details?.meta?.truncation?.direction).toBe("middle");
		expect(result.details?.meta?.truncation?.artifactId).toBe("acp-full-output");
		expect(saveArtifact).toHaveBeenCalledWith(stubText, "bash-original");
		expect(text).toContain("[raw output: artifact://acp-full-output]");
		expect(result.details?.meta?.truncation?.artifactTruncatedBytes).toBeUndefined();
	});

	it("does not duplicate an artifact reference on failed truncated output", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(800)}TAIL\n`;
		const saveArtifact = mock(async () => "acp-failed-output");
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-failed-truncated",
			waitForExit: async () => ({ exitCode: 7, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		let caught: unknown;
		try {
			await new BashTool(makeSession(bridge, { tailKiB: 1, saveArtifact })).execute("call-failed-truncated", {
				command: "wide-output && exit 7",
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("Command exited with code 7");
		expect(message).toContain("[raw output: artifact://acp-failed-output]");
		expect(message.match(/artifact:\/\/acp-failed-output/gu)).toHaveLength(1);
		expect(saveArtifact).toHaveBeenCalledWith(stubText, "bash-original");
	});

	it("uses UTF-8-safe byte windows for explicit ACP head and tail on one line", async () => {
		const stubText = "界".repeat(2_000);
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-multibyte-head-tail",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const result = await new BashTool(makeSession(bridge, { tailKiB: 1, headKiB: 1 })).execute("call-multibyte", {
			command: "wide-output",
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain(truncateHeadBytes(stubText, 1024).text);
		expect(text).toContain(truncateTailBytes(stubText, 1024).text);
		expect(text).not.toContain("�");
		expect(result.details?.meta?.truncation?.direction).toBe("middle");
	});

	it("surfaces bounded artifact-save diagnostics without inventing a URI", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(800)}TAIL\n`;
		const saveArtifact = mock(async (_content: string, _type: string): Promise<string> => {
			throw new Error("disk full while publishing bash output");
		});
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-save-failure",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const result = await new BashTool(makeSession(bridge, { saveArtifact })).execute("call-save-failure", {
			command: "wide-output",
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain("Bash output artifact save failed");
		expect(text).toContain("disk full while publishing bash output");
		expect(text).not.toContain("artifact://");
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});
	it("discloses unavailable original-output recovery without inventing a URI", async () => {
		const stubText = `HEAD\n${"middle\n".repeat(800)}TAIL\n`;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-save-unavailable",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const result = await new BashTool(makeSession(bridge, { tailKiB: 1 })).execute("call-save-unavailable", {
			command: "wide-output",
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(text).toContain("Bash output artifact unavailable");
		expect(text).toContain("artifact storage is unavailable");
		expect(text).not.toContain("artifact://");
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("does not label already-truncated client output as a full artifact", async () => {
		const stubText = `REMOTE-PARTIAL\n${"middle\n".repeat(400)}TAIL\n`;
		const saveArtifact = mock(async () => "must-not-save");
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-remote-truncated",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: true }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const result = await new BashTool(makeSession(bridge, { saveArtifact })).execute("call-remote-truncated", {
			command: "wide-output",
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(saveArtifact).not.toHaveBeenCalled();
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
		expect(text).toContain("(output truncated)");
	});

	it("discloses client-reported partial output on ACP poll updates", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let reads = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-poll-truncated",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				reads++;
				if (reads === 1) queueMicrotask(() => pendingExit.resolve({ exitCode: 0, signal: null }));
				return { output: "REMOTE-PARTIAL\n", truncated: true };
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const updates: Array<{ content?: Array<{ text?: string }> }> = [];

		await new BashTool(makeSession(bridge)).execute(
			"call-poll-truncated",
			{ command: "stream" },
			undefined,
			update => {
				updates.push(update as { content?: Array<{ text?: string }> });
			},
		);

		expect(updates.some(update => update.content?.some(block => block.text?.includes("(output truncated)")))).toBe(
			true,
		);
	});

	it("discloses locally truncated output on ACP poll updates", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const stubText = `HEAD\n${"middle\n".repeat(400)}TAIL\n`;
		let reads = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-poll-local-truncated",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				reads++;
				if (reads === 2) queueMicrotask(() => pendingExit.resolve({ exitCode: 0, signal: null }));
				return { output: stubText, truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const updates: Array<{ content?: Array<{ text?: string }> }> = [];

		await new BashTool(makeSession(bridge)).execute(
			"call-poll-local-truncated",
			{ command: "stream" },
			undefined,
			update => {
				updates.push(update as { content?: Array<{ text?: string }> });
			},
		);

		expect(updates.some(update => update.content?.some(block => block.text?.includes("(output truncated)")))).toBe(
			true,
		);
	});

	it("releases the client terminal when final output retrieval fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-output-failure",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => {
				throw new Error("client output unavailable");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		const result = await tool.execute("call-output-failure", { command: "echo hi" });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("client output unavailable");
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("releases the client terminal when waiting for exit fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-exit-failure",
			waitForExit: async () => {
				throw new Error("client wait unavailable");
			},
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-exit-failure", { command: "echo hi" })).rejects.toThrow(
			/client wait unavailable/,
		);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the command times out", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		spyOn(Bun, "sleep").mockImplementation(async () => {});

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-timeout", { command: "sleep 60", timeout: 1 })).rejects.toThrow(
			/Command timed out after 1 seconds/,
		);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		pendingExit.resolve({ exitCode: null, signal: "TERM" });
	});

	it("discloses client-reported partial output on ACP timeout", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout-truncated",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({ output: "REMOTE-PARTIAL\n", truncated: true }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		spyOn(Bun, "sleep").mockImplementation(async () => {});
		const tool = new BashTool(makeSession(bridge));
		await expect(tool.execute("call-timeout-truncated", { command: "sleep 60", timeout: 1 })).rejects.toThrow(
			/output truncated/,
		);
		pendingExit.resolve({ exitCode: null, signal: "TERM" });
	});

	it("artifacts oversized client output before surfacing a timeout", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const stubText = `HEAD\n${"middle\n".repeat(400)}TAIL\n`;
		const saveArtifact = mock(async () => "timeout-full-output");
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout-output",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		spyOn(Bun, "sleep").mockImplementation(async () => {});

		const tool = new BashTool(makeSession(bridge, { saveArtifact }));
		let caught: unknown;
		try {
			await tool.execute("call-timeout-output", { command: "sleep 60", timeout: 1 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("Command timed out after 1 seconds");
		expect(message).toContain("artifact://timeout-full-output");

		expect(saveArtifact).toHaveBeenCalledWith(stubText, "bash-original");
		pendingExit.resolve({ exitCode: null, signal: "TERM" });
	});

	it("recovers and artifacts oversized ACP output when aborted", async () => {
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const killGate = Promise.withResolvers<void>();
		let killSettled = false;
		const stubText = `HEAD\n${"middle\n".repeat(400)}TAIL\n`;
		const saveArtifact = mock(async () => "abort-full-output");
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-abort-output",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				expect(killSettled).toBe(true);
				return { output: stubText, truncated: false };
			},
			kill: async () => {
				await killGate.promise;
				killSettled = true;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge, { saveArtifact }));

		let caught: unknown;
		try {
			await tool.execute("call-abort-output", { command: "sleep 60" }, controller.signal, update => {
				if (update.details?.terminalId === handle.terminalId) {
					controller.abort();
					setTimeout(() => killGate.resolve(), 25);
				}
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("Command aborted");
		expect(message).toContain("TAIL");
		expect(message).toContain("artifact://abort-full-output");
		expect(saveArtifact).toHaveBeenCalledWith(stubText, "bash-original");
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		pendingExit.resolve({ exitCode: null, signal: "TERM" });
	});

	it("injects the session's requested agent directory into child command environments", async () => {
		// The global Settings singleton belongs to an EARLIER session (default
		// profile); the session's REQUESTED directory is the tenant profile and
		// must win in the spawned command environment.
		const session = {
			cwd: process.cwd(),
			settings: {
				get: () => undefined,
				has: () => false,
				getAgentDir: () => "default-profile",
				...stubBashExecutorSettings,
			},
			getSessionId: () => "test-session",
			getSessionAgentDir: () => "tenant-profile",
		} as unknown as ToolSession;

		const result = await new BashTool(session).execute("call", { command: 'echo "$GJC_CODING_AGENT_DIR"' });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("tenant-profile");
		expect(text).not.toContain("default-profile");
	});

	it("lets an explicit legacy agent-directory override beat the session injection", async () => {
		const session = {
			cwd: process.cwd(),
			settings: {
				get: () => undefined,
				has: () => false,
				getAgentDir: () => "default-profile",
				...stubBashExecutorSettings,
			},
			getSessionId: () => "test-session",
			getSessionAgentDir: () => "tenant-profile",
		} as unknown as ToolSession;

		// The tool call explicitly supplies ONLY the legacy alias: the injected
		// canonical variable must be suppressed, or the child's getAgentDir()
		// would prefer it over the caller's explicit override.
		const result = await new BashTool(session).execute("call", {
			command: 'echo "gjc=$GJC_CODING_AGENT_DIR pi=$PI_CODING_AGENT_DIR"',
			env: { PI_CODING_AGENT_DIR: "legacy-profile" },
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("pi=legacy-profile");
		expect(text).not.toContain("tenant-profile");
	});
});
