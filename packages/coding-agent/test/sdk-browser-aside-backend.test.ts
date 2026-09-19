import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

describe("createAgentSession browser.backend", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function sessionOptions(backend?: "native" | "aside") {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-browser-backend-"));
		tempDirs.push(tempDir);
		const browserSettings = backend === undefined ? {} : { "browser.backend": backend };
		return {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({
				"browser.enabled": true,
				...browserSettings,
				"computer.alwaysOn": false,
				"tools.discoveryMode": "all",
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	it("keeps the built-in browser tool and omits Aside guidance when the backend is unset", async () => {
		const { session } = await createAgentSession(sessionOptions());
		try {
			const discoverable = session.getDiscoverableTools({ source: "builtin" });
			expect(discoverable).toEqual(expect.arrayContaining([expect.objectContaining({ name: "browser" })]));
			expect(session.systemPrompt.join("\n\n")).not.toContain("<browser-backend>");
			// The activity declaration requirement belongs to the Aside routing
			// contract only; the default backend never asks Bash to declare one.
			const nativePrompt = session.systemPrompt.join("\n\n");
			expect(nativePrompt).not.toContain('"kind":"browser"');
			expect(nativePrompt).not.toContain('mode":"repl');
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("hides the built-in browser tool and injects Aside guidance for the aside backend", async () => {
		const { session } = await createAgentSession(sessionOptions("aside"));
		try {
			expect(session.getActiveToolNames()).not.toContain("browser");
			const discoverable = session.getDiscoverableTools({ source: "builtin" });
			expect(discoverable.map(tool => tool.name)).not.toContain("browser");
			const prompt = session.systemPrompt.join("\n\n");
			expect(prompt).toContain("<browser-backend>");
			expect(prompt).toContain("aside repl");
			expect(prompt).not.toContain("MCP `repl`");
			// The routing contract requires a structured declaration on every
			// Aside Bash call, for repl, for exec, and for exec --session follow-ups.
			expect(prompt).toContain("`activity` argument");
			expect(prompt).toContain('{"kind":"browser","provider":"aside","mode":"repl"}');
			expect(prompt).toContain('{"kind":"browser","provider":"aside","mode":"exec"}');
			expect(prompt).toContain("`--session <id>` follow-ups");
			expect(prompt).toContain("omit it on Bash calls that do not invoke Aside");
		} finally {
			await session.dispose();
		}
	}, 60_000);
});
