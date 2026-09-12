import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { toolWireSchema } from "@gajae-code/ai/utils/schema/wire";
import { validateToolArguments } from "@gajae-code/ai/utils/validation";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { disposeAllShellSessions } from "@gajae-code/coding-agent/exec/bash-executor";
import { ArtifactManager } from "@gajae-code/coding-agent/session/artifacts";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool, type BashToolDetails, type BashToolInput } from "../../src/tools/bash";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

/**
 * The browser-backend routing contract (`browser.backend: aside`) marks its
 * Bash calls with a structured `activity` declaration. These tests pin the
 * contract's three properties: generic Bash is unchanged, only the exact
 * declaration is accepted (never coerced), and the accepted value rides the
 * existing result/progress details. No Aside CLI, network, or browser is
 * involved — the declaration is metadata on ordinary commands.
 */

const replDeclaration = { kind: "browser", provider: "aside", mode: "repl" } as const;
const execDeclaration = { kind: "browser", provider: "aside", mode: "exec" } as const;

function createStubBashTool(asyncEnabled = false): BashTool {
	const session = {
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "async.enabled") return asyncEnabled;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;

	return new BashTool(session);
}

function validatedArguments(tool: BashTool, arguments_: Record<string, unknown>): Record<string, unknown> {
	return validateToolArguments(tool, {
		type: "toolCall",
		id: "activity-tool-call",
		name: tool.name,
		arguments: arguments_,
	});
}

describe("bash activity declaration: input validation", () => {
	it("keeps generic bash input valid and unchanged without a declaration", () => {
		for (const command of ["npm test", "git status", "python script.py"]) {
			const tool = createStubBashTool();
			const args = validatedArguments(tool, { command });
			expect(args.command).toBe(command);
			expect(args.activity).toBeUndefined();
		}
	});

	it("accepts the repl declaration verbatim", () => {
		const tool = createStubBashTool();
		const args = validatedArguments(tool, {
			command: "aside repl 'snapshot(page, { interactive: true })'",
			activity: replDeclaration,
		});
		expect(args.command).toBe("aside repl 'snapshot(page, { interactive: true })'");
		expect(args.activity).toEqual(replDeclaration);
	});

	it("accepts the exec declaration verbatim", () => {
		const tool = createStubBashTool();
		const args = validatedArguments(tool, {
			command: "aside exec --session aside-1 'continue the research'",
			activity: execDeclaration,
		});
		expect(args.command).toBe("aside exec --session aside-1 'continue the research'");
		expect(args.activity).toEqual(execDeclaration);
	});

	it("drops malformed declarations without failing the command or inventing values", () => {
		const tool = createStubBashTool();
		const malformed = [
			{ kind: "browser", provider: "aside", mode: "EXEC" },
			{ kind: "browser", provider: "aside", mode: "foo" },
			{ kind: "browser", provider: "aside" },
			{ kind: "browser", provider: "builtin", mode: "repl" },
			{ kind: "search", provider: "aside", mode: "repl" },
			{ kind: "browser", provider: "aside", mode: "repl", url: "https://example.com" },
			{ kind: "browser", provider: "aside", mode: ["repl"] },
			"browser",
			null,
			true,
		];
		for (const activity of malformed) {
			const args = validatedArguments(tool, { command: "npm test", activity });
			// The command itself stays valid and untouched; only the metadata is gone.
			expect(args.command).toBe("npm test");
			expect(args.activity).toBeUndefined();
		}
	});

	it("never coerces an unsupported mode into repl or exec", () => {
		const tool = createStubBashTool();
		for (const mode of ["EXEC", "Repl", "run", ""]) {
			const args = validatedArguments(tool, {
				command: "npm test",
				activity: { kind: "browser", provider: "aside", mode },
			});
			expect(args.command).toBe("npm test");
			expect(args.activity).toBeUndefined();
		}
	});

	it("exposes the declaration on the model-facing wire schema as optional", () => {
		const schema = toolWireSchema(createStubBashTool());
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		expect(properties.activity).toMatchObject({
			type: "object",
			properties: {
				kind: { const: "browser" },
				provider: { const: "aside" },
				mode: { enum: ["repl", "exec"] },
			},
			required: ["kind", "provider", "mode"],
		});
		expect(schema.required ?? []).not.toContain("activity");
	});
});

describe("bash activity declaration: result and progress details", () => {
	let tempDir: string;
	let settings: Settings;
	let manager: AsyncJobManager;

	function makeToolSession(): ToolSession {
		const artifacts = new ArtifactManager(path.join(tempDir, "artifacts"));
		return {
			cwd: tempDir,
			hasUI: false,
			settings,
			getSessionId: () => "bash-activity-test",
			getAgentId: () => "0-Test",
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getArtifactsDir: () => artifacts.dir,
			getArtifactManager: () => artifacts,
			allocateOutputArtifact: (toolType: string) => artifacts.allocatePath(toolType),
		} as unknown as ToolSession;
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-activity-"));
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true, cwd: tempDir });
		manager = new AsyncJobManager({ retentionMs: 20, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		await disposeAllShellSessions();
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 1_000 });
		AsyncJobManager.resetForTests();
		await disposeAllShellSessions();
		resetSettingsForTest();
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("mirrors the declaration into the foreground result details", async () => {
		const tool = new BashTool(makeToolSession());
		const result = await tool.execute("foreground-declared", {
			command: "printf declared",
			timeout: 5,
			activity: replDeclaration,
		} satisfies BashToolInput);
		expect(result.content[0]).toMatchObject({ type: "text", text: "declared" });
		expect(result.details?.activity).toEqual(replDeclaration);
	});

	it("leaves generic foreground results free of activity", async () => {
		const tool = new BashTool(makeToolSession());
		const result = await tool.execute("foreground-plain", {
			command: "printf plain",
			timeout: 5,
		} satisfies BashToolInput);
		expect(result.content[0]).toMatchObject({ type: "text", text: "plain" });
		expect(result.details).not.toHaveProperty("activity");
	});

	it("mirrors the declaration into background start, progress, and terminal details", async () => {
		settings.set("async.enabled", true);
		const tool = new BashTool(makeToolSession());
		const updates: AgentToolResult<BashToolInput>[] = [];
		const onUpdate = ((partial: AgentToolResult<BashToolDetails>) => {
			updates.push(partial as unknown as AgentToolResult<BashToolInput>);
		}) as unknown as AgentToolUpdateCallback<BashToolDetails>;

		const started = await tool.execute(
			"background-declared",
			{ command: "printf background", async: true, timeout: 5, activity: execDeclaration },
			undefined,
			onUpdate,
		);

		const jobId = started.details?.async?.jobId;
		expect(jobId).toBeString();
		expect(started.details?.async).toMatchObject({ state: "running", type: "bash" });
		expect(started.details?.activity).toEqual(execDeclaration);

		await manager.waitForAll();
		expect(manager.getJob(jobId as string)?.status).toBe("completed");

		const detailled = updates.filter(update => update.details && Object.keys(update.details).length > 0);
		expect(detailled.length).toBeGreaterThan(0);
		for (const update of detailled) {
			expect((update.details as unknown as BashToolDetails).activity).toEqual(execDeclaration);
		}
		expect(detailled.at(-1)?.details).toMatchObject({ async: { state: "completed", type: "bash" } });
	});

	it("keeps existing async job behavior for calls without a declaration", async () => {
		settings.set("async.enabled", true);
		const tool = new BashTool(makeToolSession());
		const started = await tool.execute("background-plain", {
			command: "printf plain-background",
			async: true,
			timeout: 5,
		} satisfies BashToolInput);

		const jobId = started.details?.async?.jobId;
		expect(jobId).toBeString();
		expect(started.details).not.toHaveProperty("activity");
		await manager.waitForAll();
		expect(manager.getJob(jobId as string)?.status).toBe("completed");
	});
});
