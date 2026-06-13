import { afterEach, describe, expect, it, spyOn } from "bun:test";
import SessionCommand from "../src/commands/session";

type SpawnSyncMock = {
	mockImplementation: (implementation: (cmd: string[]) => unknown) => void;
	mockRestore?: () => void;
};

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function spawnResult(exitCode: number, stdout = "", stderr = "") {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		signalCode: null,
	};
}

function mockSpawnSync(implementation: (cmd: string[]) => unknown): SpawnSyncMock {
	const spy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncMock;
	spy.mockImplementation(implementation);
	return spy;
}

function sessionLine(name = "gajae_code_test", branch = ""): string {
	return `${name}\t1\t0\t1770000000\t1\troot\t2\t${branch}\tfeature-demo\n`;
}

async function runSessionCommand(argv: string[]): Promise<string> {
	let output = "";
	const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new SessionCommand(argv, { bin: "gjc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		writeSpy.mockRestore();
	}
}

afterEach(() => {
	process.stdout.write = ORIGINAL_STDOUT_WRITE;
	(Bun.spawnSync as unknown as SpawnSyncMock).mockRestore?.();
});

describe("gjc session command", () => {
	it("emits exact list JSON DTOs with flags before action", async () => {
		mockSpawnSync(() =>
			spawnResult(0, `${sessionLine("gajae_code_test", "feature/demo")}untagged\t1\t0\t1770000001\t\troot\t1\t\t\n`),
		);

		const output = await runSessionCommand(["--json", "list"]);
		const payload = JSON.parse(output);

		expect(payload).toEqual({
			ok: true,
			sessions: [
				{
					name: "gajae_code_test",
					attached: false,
					windows: 1,
					panes: 2,
					bindings: "root",
					createdAt: "2026-02-02T02:40:00.000Z",
				},
			],
		});
	});

	it("emits JSON failure wrappers", async () => {
		mockSpawnSync(() => spawnResult(0, ""));

		const output = await runSessionCommand(["status", "missing", "--json"]);
		const payload = JSON.parse(output);

		expect(payload).toEqual({ ok: false, reason: "gjc_tmux_session_not_found" });
	});

	it("creates and reports a detached managed session as exact JSON DTO", async () => {
		const calls: string[][] = [];
		const previousSession = process.env.GJC_TMUX_SESSION;
		process.env.GJC_TMUX_SESSION = "custom_session";
		mockSpawnSync((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) return spawnResult(0, sessionLine("custom_session"));
			return spawnResult(0, "");
		});

		const output = await runSessionCommand(["create", "--json"]);
		if (previousSession === undefined) delete process.env.GJC_TMUX_SESSION;
		else process.env.GJC_TMUX_SESSION = previousSession;
		const payload = JSON.parse(output);

		expect(calls.some(call => call.includes("new-session"))).toBe(true);
		expect(calls.some(call => call.includes("@gjc-profile"))).toBe(true);
		expect(payload).toEqual({
			ok: true,
			session: {
				name: "custom_session",
				attached: false,
				windows: 1,
				panes: 2,
				bindings: "root",
				createdAt: "2026-02-02T02:40:00.000Z",
			},
		});
	});

	it("surfaces an untagged-session diagnostic with a detail hint in JSON failures", async () => {
		mockSpawnSync((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "winsess\n");
				return spawnResult(0, "winsess\t1\t0\t1770000000\t\troot\t0\t\t\t\n");
			}
			return spawnResult(0, "");
		});

		const output = await runSessionCommand(["status", "winsess", "--json"]);
		const payload = JSON.parse(output);

		expect(payload.ok).toBe(false);
		expect(payload.reason).toBe("gjc_tmux_session_untagged");
		expect(typeof payload.detail).toBe("string");
		expect(payload.detail).toContain("not fully supported");
		expect(payload.detail).not.toContain(" — ");
	});
});
