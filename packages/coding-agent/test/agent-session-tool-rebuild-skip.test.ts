import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import * as z from "zod/v4";
import { Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

// Cache-stability invariant: when MCP servers reconnect with byte-identical tool
// definitions, `refreshMCPTools` must not rebuild the system prompt. A rebuild
// invalidates the Anthropic prompt-cache breakpoint placed on the system block
// and forces a full prefix re-encode on the next request.

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: z.object({ value: z.string() }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string, description: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: z.object({ q: z.string() }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("AgentSession refreshMCPTools rebuild skipping", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	interface NewSessionOptions {
		mcpDiscoveryEnabled?: boolean;
		getMcpServerInstructions?: () => Map<string, string> | undefined;
	}

	function newSession(
		rebuildSystemPrompt: (toolNames: string[]) => Promise<string>,
		options: NewSessionOptions = {},
	): {
		session: AgentSession;
	} {
		const readTool = createBasicTool("read", "Read");
		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[initialMcp.name, initialMcp as unknown as AgentTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, initialMcp as unknown as AgentTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			toolRegistry,
			rebuildSystemPrompt: async (toolNames, _tools) => ({
				systemPrompt: [await rebuildSystemPrompt(toolNames)],
			}),
			mcpDiscoveryEnabled: options.mcpDiscoveryEnabled,
			getMcpServerInstructions: options.getMcpServerInstructions,
		});
		sessions.push(session);
		return { session };
	}

	it("skips rebuild when an MCP refresh produces an identical tool set", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});
		// The session constructor does not run rebuildSystemPrompt; baseline=0.
		expect(rebuildCount).toBe(0);

		const initialMcp = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search nucleus");

		// First refresh: no signature recorded yet, must rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Second refresh with byte-identical metadata: must NOT rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);

		// Third refresh, again identical: still no rebuild.
		await session.refreshMCPTools([initialMcp]);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's description changes", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v1");
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(1);

		const v2 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search v2");
		await session.refreshMCPTools([v2]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when the active tool list changes via setActiveToolsByName", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const b = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain");

		// Bring both into the registry; only `mcp__nucleus_search` becomes active per
		// the agent's initial tool set.
		await session.refreshMCPTools([a, b]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Activate the previously-inactive tool: the active list grew, signature must
		// change, rebuild must fire.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same list again: skip.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search", "mcp__nucleus_explain"]);
		expect(rebuildCount).toBe(baseline + 1);

		// Drop one: rebuild fires again.
		await session.setActiveToolsByName(["read", "mcp__nucleus_search"]);
		expect(rebuildCount).toBe(baseline + 2);
	});

	it("does not skip when refreshBaseSystemPrompt is called explicitly", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Explicit refresh must always rebuild (callers use it to pick up env-side changes
		// such as edit mode toggles, which are invisible to our tool signature).
		await session.refreshBaseSystemPrompt();
		expect(rebuildCount).toBe(2);

		// Subsequent identical MCP refresh should still skip after the explicit refresh
		// freshens the cached signature.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});

	it("retries an identical MCP refresh after a superseding explicit rebuild fails", async () => {
		// Given
		const firstRebuildEntered = Promise.withResolvers<void>();
		const releaseFirstRebuild = Promise.withResolvers<void>();
		const explicitRefreshError = new Error("explicit rebuild failed");
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			const rebuild = ++rebuildCount;
			if (rebuild === 1) {
				firstRebuildEntered.resolve();
				await releaseFirstRebuild.promise;
			}
			if (rebuild === 2) throw explicitRefreshError;
			return `tools:${toolNames.join(",")}`;
		});
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		// When
		const firstRefresh = session.refreshMCPTools([tool]);
		await firstRebuildEntered.promise;
		let explicitFailure: unknown;
		try {
			await session.refreshBaseSystemPrompt();
		} catch (error) {
			explicitFailure = error;
		}
		expect(explicitFailure).toBe(explicitRefreshError);
		releaseFirstRebuild.resolve();
		await firstRefresh;
		await session.refreshMCPTools([tool]);

		// Then
		expect(rebuildCount).toBe(3);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__nucleus_search"]);
	});

	it("ignores incidental insertion order in the refresh argument", async () => {
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const a = createMcpCustomTool("mcp__nucleus_a", "nucleus", "a", "A");
		const b = createMcpCustomTool("mcp__nucleus_b", "nucleus", "b", "B");

		// `refreshMCPTools` re-derives the active tool set from the registry using the
		// session's existing ordering, so passing the same content in a different order
		// must not mutate the signature.
		await session.refreshMCPTools([a, b]);
		expect(rebuildCount).toBe(1);

		await session.refreshMCPTools([b, a]);
		expect(rebuildCount).toBe(1);
	});

	it("rebuilds when an MCP tool's label changes", async () => {
		// Tool labels are rendered into the prompt body (`{{label}}: \`{{name}}\``),
		// so a label change — even with name and description constant — must force
		// a rebuild. Otherwise we'd serve a stale label after an MCP server upgrade.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		// Override the auto-derived label so the test mutates only the label.
		const v1WithLabel = { ...v1, label: "old label" } as typeof v1;
		await session.refreshMCPTools([v1WithLabel]);
		expect(rebuildCount).toBe(1);

		const v2WithLabel = { ...v1, label: "new label" } as typeof v1;
		await session.refreshMCPTools([v2WithLabel]);
		expect(rebuildCount).toBe(2);
	});

	it("rebuilds when MCP server instructions text changes", async () => {
		// `rebuildSystemPrompt` embeds per-server `instructions` text into the appended
		// prompt. The signature must include this so a server upgrade that changes
		// instructions while keeping tools constant still triggers a rebuild.
		let rebuildCount = 0;
		const instructions = new Map<string, string>([["nucleus", "v1 instructions"]]);
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ getMcpServerInstructions: () => instructions },
		);

		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Same tools, same instructions: skip.
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate the live instructions map (callers return the live reference).
		instructions.set("nucleus", "v2 instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);

		// Adding a new server's instructions also triggers rebuild.
		instructions.set("glean", "glean instructions");
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a discoverable (inactive) registry tool's metadata changes", async () => {
		// With MCP discovery on, the rebuilt prompt summarizes ALL discoverable MCP
		// tools — including ones not in the active set. The signature must capture the
		// full registry; otherwise a description change to a discoverable-but-inactive
		// tool would silently leave a stale summary in the cached prompt.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{ mcpDiscoveryEnabled: true },
		);

		const active = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const discoverable = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v1");

		await session.refreshMCPTools([active, discoverable]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same registry: skip.
		await session.refreshMCPTools([active, discoverable]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the discoverable (NOT active) tool's description: signature must
		// differ via the registrySegment branch and force a rebuild.
		const discoverableV2 = createMcpCustomTool("mcp__nucleus_explain", "nucleus", "explain", "Explain v2");
		await session.refreshMCPTools([active, discoverableV2]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("rebuilds when an MCP tool's customWireName changes", async () => {
		// `customWireName` overrides the model-facing tool name (e.g. `edit` exposes
		// itself as `apply_patch` to GPT-5). The wire name is rendered into the prompt
		// body via `toolPromptNames`, so a wire-name flip with the rest of the metadata
		// constant would otherwise leave a stale system prompt that advertises the wrong
		// callable name to the model. The signature must catch this.
		let rebuildCount = 0;
		const { session } = newSession(async toolNames => {
			rebuildCount++;
			return `tools:${toolNames.join(",")}`;
		});

		// Attach a custom wire name to the MCP tool. `applyToolProxy` forwards arbitrary
		// properties from the underlying CustomTool to the wrapper, so the AgentTool the
		// signature inspects exposes `customWireName` as if it were declared on the type.
		const v1 = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");
		const v1WithWire = { ...v1, customWireName: "wire_v1" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Same wire name: skip.
		await session.refreshMCPTools([v1WithWire]);
		expect(rebuildCount).toBe(1);

		// Wire name changes while name/label/description stay constant: must rebuild.
		const v2WithWire = { ...v1, customWireName: "wire_v2" } as typeof v1 & { customWireName: string };
		await session.refreshMCPTools([v2WithWire]);
		expect(rebuildCount).toBe(2);

		// Drop wire name entirely: must rebuild (signature must differ from `wire_v2`).
		await session.refreshMCPTools([v1]);
		expect(rebuildCount).toBe(3);
	});

	it("rebuilds when a tool's getter-based description reflects new settings state", async () => {
		// Built-in tools whose prompt-rendered metadata depends on settings expose
		// `description` via getters that re-evaluate on every access (TaskTool reads
		// task.disabledAgents/maxConcurrency/isolation.mode/simple/async.enabled,
		// SearchToolBm25Tool reads the discoverable MCP tool count, EditTool resolves
		// through the current edit-mode definition). The signature reads `tool.description`
		// live each call, so a settings flip that mutates the rendered string MUST differ
		// the signature on the next `#applyActiveToolsByName`. Defending this contract
		// against a future refactor that caches per-tool description strings.
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			// Discovery-on so the dynamic tool participates in the registry segment too,
			// matching the production pattern where `TaskTool` and friends are always
			// reachable via the registry.
			{ mcpDiscoveryEnabled: true },
		);

		// Reuse the initially-active MCP name so the tool stays in the active list
		// across refreshes - we want to defend the path where `tool.description` is read
		// for the active descriptionSegment, not just the registrySegment.
		const settingState = { disabled: "none" };
		const dynamicTool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "placeholder");
		Object.defineProperty(dynamicTool, "description", {
			get: () => `dynamic disabled=${settingState.disabled}`,
			enumerable: true,
			configurable: true,
		});

		await session.refreshMCPTools([dynamicTool]);
		const baseline = rebuildCount;
		expect(baseline).toBeGreaterThanOrEqual(1);

		// Same underlying state, same tool object identity: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline);

		// Mutate the settings-backed state. The tool object identity does not change,
		// but its `description` getter now returns a new string. The signature must
		// pick this up live (no per-tool caching) and force a rebuild.
		settingState.disabled = "plan,explore";
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);

		// Same state again: skip.
		await session.refreshMCPTools([dynamicTool]);
		expect(rebuildCount).toBe(baseline + 1);
	});
	it("does not rebuild when only the calendar date rolls over between tool-stable MCP refreshes", async () => {
		// Date/cwd/workspace-tree are volatile per-turn context, not stable system
		// prompt inputs. A midnight rollover must not perturb the MCP tool signature.
		setSystemTime(new Date("2025-01-01T23:59:58Z"));
		try {
			let rebuildCount = 0;
			const { session } = newSession(async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			});
			const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

			// First refresh: no signature yet, must rebuild.
			await session.refreshMCPTools([tool]);
			expect(rebuildCount).toBe(1);

			// Same tools, same day: signature matches, skip.
			await session.refreshMCPTools([tool]);
			expect(rebuildCount).toBe(1);

			// Advance past midnight.
			setSystemTime(new Date("2025-01-02T00:00:01Z"));

			// Same tools, new calendar day: skip because volatile date/cwd/tree
			// context is intentionally excluded from the stable tool signature.
			await session.refreshMCPTools([tool]);
			expect(rebuildCount).toBe(1);

			// Same tools, same new day: skip again.
			await session.refreshMCPTools([tool]);
			expect(rebuildCount).toBe(1);
		} finally {
			setSystemTime(); // restore real time
		}
	});
	it("does not rebuild when MCP server instructions change only beyond the 4000-char truncation boundary", async () => {
		// `rebuildSystemPrompt` (sdk/session.ts) truncates each server instruction to 4000 chars
		// before embedding it. The `getMcpServerInstructions` callback must therefore
		// return pre-truncated strings so the signature hashes exactly what the prompt
		// builder uses. Changes beyond char 4000 cannot affect rendered prompt bytes
		// and must NOT trigger a rebuild.
		const prefix = "A".repeat(4000);
		const instructions = new Map<string, string>([["nucleus", `${prefix}_tail_v1`]]);
		let rebuildCount = 0;
		const { session } = newSession(
			async toolNames => {
				rebuildCount++;
				return `tools:${toolNames.join(",")}`;
			},
			{
				getMcpServerInstructions: () => {
					// Mirror what sdk/session.ts does: truncate to 4000 chars before returning.
					const out = new Map<string, string>();
					for (const [name, text] of instructions) {
						out.set(name, text.length > 4000 ? text.slice(0, 4000) : text);
					}
					return out;
				},
			},
		);
		const tool = createMcpCustomTool("mcp__nucleus_search", "nucleus", "search", "Search");

		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate only the text beyond char 4000: truncated string is identical → skip.
		instructions.set("nucleus", `${prefix}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(1);

		// Mutate within the first 4000 chars: truncated string differs → rebuild.
		instructions.set("nucleus", `${"B".repeat(4000)}_tail_v2`);
		await session.refreshMCPTools([tool]);
		expect(rebuildCount).toBe(2);
	});
});
