import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Issue #5374: `GJC_SESSION_ID` must mean "this session's own id" on the
 * bash tool-env path, and master ownership must travel under its own distinct
 * variable (`GJC_MASTER_OWNER_SESSION_ID`).
 *
 * The direct `gjc sdk spawn` dispatch env previously read
 * `GJC_SESSION_ID: resolvedEnv?.GJC_MASTER_OWNER_SESSION_ID ?? own id`, which
 * overloaded one name with two meanings (master identity vs. own identity).
 */
function createSession(sessionId: string, ownerSessionId?: string): ToolSession {
	return {
		cwd: process.cwd(),
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getMasterBashCapability: () => "master-capability-fixture",
		...(ownerSessionId === undefined
			? { getMasterOwnerSessionId: () => undefined }
			: { getMasterOwnerSessionId: () => ownerSessionId }),
		settings: {
			has: () => false,
			get: () => undefined,
			getBashInterceptorRules: () => [],
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
}

function echoSessionEnv(): string {
	return 'printf "own=%s owner=%s" "$GJC_SESSION_ID" "$GJC_MASTER_OWNER_SESSION_ID"';
}

function textOf(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
	return content.find(block => block.type === "text")?.text ?? "";
}

const coordinatorOnlyEnvNames = [
	"GJC_COORDINATOR_SESSION_STATE_FILE",
	"GJC_COORDINATOR_SESSION_ID",
	"GJC_COORDINATOR_SESSION_LAUNCH_ID",
	"GJC_COORDINATOR_SESSION_READINESS_FILE",
	"GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED",
	"GJC_COORDINATOR_SIDECAR_KEY_ID",
];

describe("issue #5374: session identity on the bash tool-env path", () => {
	it("a master-owned child exposes its own id in GJC_SESSION_ID", async () => {
		const result = await new BashTool(createSession("child-session", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("own=child-session");
	});

	it("master ownership travels under GJC_MASTER_OWNER_SESSION_ID", async () => {
		const result = await new BashTool(createSession("child-session", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("owner=master-owner");
	});

	it("a master session exposes its own id", async () => {
		const result = await new BashTool(createSession("master-owner", "master-owner")).execute("call", {
			command: echoSessionEnv(),
		});
		expect(textOf(result)).toContain("own=master-owner");
	});
});

describe("issue #5802: coordinator env isolation at the bash boundary", () => {
	it("scrubs inherited coordinator env while preserving explicit overrides and derived session identity", async () => {
		const namesToRestore = [...coordinatorOnlyEnvNames, "GJC_SESSION_ID"];
		const previousEnv = new Map(namesToRestore.map(name => [name, process.env[name]]));
		for (const name of coordinatorOnlyEnvNames) process.env[name] = `ambient-${name}`;
		process.env.GJC_SESSION_ID = "parent-session";

		try {
			const command = [
				`for name in ${coordinatorOnlyEnvNames.join(" ")}; do`,
				`  value=$(printenv "$name" 2>/dev/null || printf '<unset>')`,
				`  printf '%s=%s\\n' "$name" "$value"`,
				"done",
				`printf 'GJC_SESSION_ID=%s\\n' "$GJC_SESSION_ID"`,
				`printf 'BASH_TOOL_EXPLICIT=%s\\n' "$BASH_TOOL_EXPLICIT"`,
			].join("\n");
			const result = await new BashTool(createSession("child-session")).execute("call", {
				command,
				env: {
					GJC_COORDINATOR_SESSION_ID: "explicit-coordinator-id",
					BASH_TOOL_EXPLICIT: "explicit-tool-value",
				},
			});
			const output = textOf(result);
			for (const name of coordinatorOnlyEnvNames) {
				expect(output).toContain(
					`${name}=${name === "GJC_COORDINATOR_SESSION_ID" ? "explicit-coordinator-id" : "<unset>"}`,
				);
			}
			expect(output).toContain("GJC_SESSION_ID=child-session");
			expect(output).toContain("BASH_TOOL_EXPLICIT=explicit-tool-value");
		} finally {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
