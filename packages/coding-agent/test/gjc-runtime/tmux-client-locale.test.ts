import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createManagedGjcTmuxSession,
	statusGjcTmuxSession,
	verifyManagedGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

const tmux = process.platform === "win32" ? null : Bun.which("tmux");
const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const roots: string[] = [];

/**
 * A detached SDK Broker inherits its launcher's environment. Started from a
 * launchd job, cron, or a service manager it has no LANG/LC_* and no TMUX, so
 * every tmux client it runs is a non-UTF-8 client. The socket directory is
 * fresh, so the managed launch also starts the tmux server, as it does on a
 * machine with no default server running.
 */
function serviceLauncherEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		HOME: root,
		PATH: process.env.PATH ?? "",
		SHELL: process.env.SHELL ?? "/bin/sh",
		TMPDIR: root,
		USER: process.env.USER ?? "",
		XPC_SERVICE_NAME: "0",
		TMUX_TMPDIR: root,
	};
}

function rawTmux(env: NodeJS.ProcessEnv, args: string[]): string {
	const result = Bun.spawnSync([tmux!, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode !== 0) throw new Error(`tmux ${args[0]} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

async function launchFromServiceEnvironment(workspaceName: string) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-locale-")));
	roots.push(root);
	const cwd = path.join(root, workspaceName);
	await fs.mkdir(cwd);
	const env = serviceLauncherEnvironment(root);
	const childSessionId = crypto.randomUUID();
	// The pane runs the managed-owner supervisor from `process.argv[1]`, which is
	// this test file under `bun test`. Point it at the source CLI for the duration
	// of the synchronous launch, exactly as a source-run Broker would.
	const testEntry = process.argv[1];
	process.argv[1] = cliEntry;
	try {
		const proof = createManagedGjcTmuxSession({ childSessionId, cwd, argv: ["/bin/sleep", "30"] }, env, {
			platform: process.platform,
		});
		return { env, childSessionId, proof };
	} finally {
		process.argv[1] = testEntry!;
	}
}

// Linux managed launches first classify the caller's cgroup and may need a
// systemd user scope; the macOS owner path has no such precondition.
describe.skipIf(!tmux || process.platform !== "darwin")("managed tmux launch from a non-UTF-8 launcher", () => {
	afterEach(async () => {
		for (const root of roots.splice(0)) {
			// Each fixture owns its socket directory; only that isolated server is removed.
			Bun.spawnSync([tmux!, "kill-server"], { stdout: "pipe", stderr: "pipe", env: { TMUX_TMPDIR: root } });
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("registers and re-proves the session it just created", async () => {
		const { env, childSessionId, proof } = await launchFromServiceEnvironment("workspace");

		// The fixture really is a non-UTF-8 client: a plain tmux client in this
		// environment reports the tab separator as `_`.
		expect(rawTmux(env, ["display-message", "-p", "-t", proof.nativeSessionId, "#{session_id}\t#"])).toBe(
			`${proof.nativeSessionId}_#\n`,
		);
		expect(proof.nativeSessionId).toMatch(/^\$\d+$/);
		expect(proof.sessionId).toBe(childSessionId);
		const status = statusGjcTmuxSession(proof.name, env);
		expect(status).toMatchObject({
			name: proof.name,
			nativeSessionId: proof.nativeSessionId,
			sessionId: childSessionId,
			sessionStateFile: proof.sessionStateFile,
			ownerGeneration: proof.ownerGeneration,
			panePids: [proof.pid],
		});
		expect(verifyManagedGjcTmuxSession(proof, env)).toBe("verified");
	});

	it("round-trips a non-ASCII workspace path through the session state-file tag", async () => {
		const { env, proof } = await launchFromServiceEnvironment("작업공간");

		expect(proof.sessionStateFile).toContain(`${path.sep}작업공간${path.sep}`);
		expect(statusGjcTmuxSession(proof.name, env).sessionStateFile).toBe(proof.sessionStateFile);
		expect(verifyManagedGjcTmuxSession(proof, env)).toBe("verified");
	});
});
