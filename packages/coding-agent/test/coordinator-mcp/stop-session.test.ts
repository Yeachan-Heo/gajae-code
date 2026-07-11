import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coord-stop-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function makeServer(root: string) {
	let n = 0;
	return createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
			GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".state"),
			GJC_COORDINATOR_MCP_PROFILE: "stop-controller",
			GJC_COORDINATOR_MCP_REPO: "repo-stop",
		},
		services: {
			startSession: (input: { cwd: string }) => {
				n += 1;
				return {
					name: `stop-session-${n}`,
					cwd: input.cwd,
					createdAt: new Date().toISOString(),
				};
			},
		},
	});
}

describe("gjc_coordinator_stop_session", () => {
	it("refuses a non-ephemeral (start_session) session unless force, then reaps and purges it", async () => {
		await withTempRoot(async root => {
			const server = await makeServer(root);
			const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			expect(started.ok).toBe(true);
			const sessionId = String((started.session as { session_id: string }).session_id);

			const refused = await server.callTool("gjc_coordinator_stop_session", {
				session_id: sessionId,
				allow_mutation: true,
			});
			expect(refused.ok).toBe(false);
			expect(refused.reason).toBe("not_ephemeral");

			const forced = await server.callTool("gjc_coordinator_stop_session", {
				session_id: sessionId,
				force: true,
				allow_mutation: true,
			});
			expect(forced.ok).toBe(true);

			// The session record is purged.
			const status = await server.callTool("gjc_coordinator_read_status", { session_id: sessionId });
			expect(status.session ?? null).toBeNull();
		});
	});

	it("reaps a delegate-created ephemeral session without force", async () => {
		await withTempRoot(async root => {
			const server = await makeServer(root);
			const delegated = await server.callTool("gjc_delegate_execute", {
				task: "ephemeral work",
				cwd: root,
				allow_mutation: true,
			});
			expect(delegated.ok).toBe(true);
			const sessionId = String((delegated as { session_id: string }).session_id);

			const reaped = await server.callTool("gjc_coordinator_stop_session", {
				session_id: sessionId,
				allow_mutation: true,
			});
			expect(reaped.ok).toBe(true); // ephemeral → allowed without force

			const status = await server.callTool("gjc_coordinator_read_status", { session_id: sessionId });
			expect(status.session ?? null).toBeNull();
		});
	});

	it("returns unknown_session for a missing id", async () => {
		await withTempRoot(async root => {
			const server = await makeServer(root);
			const missing = await server.callTool("gjc_coordinator_stop_session", {
				session_id: "does-not-exist",
				allow_mutation: true,
			});
			expect(missing.ok).toBe(false);
			expect(missing.reason).toBe("unknown_session");
		});
	});
});
