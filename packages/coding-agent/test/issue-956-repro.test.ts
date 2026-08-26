import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getProjectDir, setAgentDir, setProjectDir } from "@gajae-code/utils";
import { MCPCommandController } from "../src/modes/controllers/runtime-mcp-command-controller";
import { initTheme } from "../src/modes/theme/theme";
import * as mcpClient from "../src/runtime-mcp/client";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("issue #956: interactive /mcp test", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-956-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-issue-956-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);

		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify(
				{
					mcpServers: {
						github: {
							type: "stdio",
							command: "github-mcp-server",
							args: ["serve"],
						},
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fs.rm(projectDir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("tests a connected server discovered from standalone .mcp.json", async () => {
		const transport = {
			connected: true,
			request: vi.fn(),
			notify: vi.fn(),
			close: vi.fn(async () => {}),
		};
		const connection = {
			name: "github",
			config: { type: "stdio" as const, command: "github-mcp-server", args: ["serve"] },
			transport,
			serverInfo: { name: "GitHub MCP", version: "1.0.0" },
			capabilities: {},
		};
		const showError = vi.fn();
		const showStatus = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();
		const refreshMCPTools = vi.fn();
		const listTools = vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "search_issues" }] as never);
		const controller = new MCPCommandController({
			chatContainer: { addChild },
			ui: { requestRender },
			editor: {},
			sessionManager: { getCwd: () => projectDir },
			showError,
			showStatus,
			session: { refreshMCPTools },
			mcpManager: {
				withPreparedLease: vi.fn(
					async (_name, _config, run) => await run({ connectionForLease: () => connection }),
				),
				getConnectionStatus: vi.fn(() => "connected"),
			},
		} as never);

		await controller.handle("/mcp test github");

		expect(showError).not.toHaveBeenCalled();
		expect(listTools).toHaveBeenCalledWith(connection, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(requestRender).toHaveBeenCalled();
	});
});
