import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";

class OracleClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(_params: SessionNotification): Promise<void> {}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "oracle-terminal" };
	}
}

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const cleanupRoots: string[] = [];
let activeProc: AcpProc | undefined;

function subprocessInput(proc: AcpProc): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

async function teardown(proc: AcpProc): Promise<void> {
	try {
		proc.stdin.end();
	} catch {
		// already closed
	}
	const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
	if (exited) return;
	try {
		proc.kill("SIGKILL");
	} catch {
		// already exited
	}
	await Promise.race([proc.exited, Bun.sleep(1500)]);
}

afterEach(async () => {
	if (activeProc) {
		const proc = activeProc;
		activeProc = undefined;
		await teardown(proc);
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

describe("ACP session/delete wire oracle", () => {
	it("deletes a persisted session through SDK 1.2.1 over stdio", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-delete-wire-"));
		cleanupRoots.push(root);
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		const workspace = path.join(root, "workspace");
		await Promise.all([
			fs.promises.mkdir(xdg, { recursive: true }),
			fs.promises.mkdir(agentDir, { recursive: true }),
			fs.promises.mkdir(workspace, { recursive: true }),
		]);

		const proc = Bun.spawn(["bun", cliEntry, "--mode", "acp", "--no-extensions"], {
			cwd: repoRoot,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				XDG_DATA_HOME: xdg,
				XDG_CONFIG_HOME: xdg,
				GJC_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			},
		});
		activeProc = proc;
		void new Response(proc.stderr).text().catch(() => undefined);

		const connection = new ClientSideConnection(
			() => new OracleClient(),
			ndJsonStream(subprocessInput(proc), proc.stdout),
		);
		const initialized = await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		expect(initialized.agentCapabilities?.sessionCapabilities?.delete).toEqual({});

		const created = await connection.newSession({ cwd: workspace, mcpServers: [] });
		const beforeDelete = await connection.listSessions({ cwd: workspace });
		expect(beforeDelete.sessions.map(session => session.sessionId)).toContain(created.sessionId);

		const sessionFiles = await Array.fromAsync(
			new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true, onlyFiles: true }),
		);
		expect(sessionFiles).toHaveLength(1);
		const sessionPath = sessionFiles[0]!;
		const artifactsDir = sessionPath.slice(0, -6);
		await fs.promises.mkdir(artifactsDir, { recursive: true });
		await fs.promises.writeFile(path.join(artifactsDir, "oracle.txt"), "artifact");

		await connection.deleteSession({ sessionId: created.sessionId });

		const afterDelete = await connection.listSessions({ cwd: workspace });
		expect(afterDelete.sessions.map(session => session.sessionId)).not.toContain(created.sessionId);
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	}, 60_000);
});
