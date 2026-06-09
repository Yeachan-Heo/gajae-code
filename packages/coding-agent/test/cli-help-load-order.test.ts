import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

let cleanupRoot: string | undefined;

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

afterEach(async () => {
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("CLI help load order", () => {
	it("loads the root help command without tripping config/model-registry cycles", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-help-load-order-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			["modelRoles:", "  default: openai/codex-mini-latest", "modelProfile:", "  default: codex-standard", ""].join(
				"\n",
			),
		);

		const proc = Bun.spawn([process.execPath, cliEntry, "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				XDG_DATA_HOME: xdg,
				PI_CODING_AGENT_DIR: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				OPENAI_API_KEY: "sk-unavailable-model-sentinel",
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			},
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("Useful Commands:");
		expect(stdout).toContain("gjc --help");
		expect(stderr).not.toContain("codex-mini-latest");
		expect(stderr).not.toContain("raw-http-request");
	}, 15_000);
});
