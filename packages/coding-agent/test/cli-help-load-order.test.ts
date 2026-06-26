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
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			},
		});

		const [, , exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
	}, 15_000);

	it("renders --help offline without touching the provider/model path (issue #438)", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-help-offline-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

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
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
				// Strip provider credentials so any accidental provider call would fail
				// loudly, and point network at a black hole so help can never reach out.
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_OAUTH_TOKEN: "",
				OPENAI_API_KEY: "",
				GEMINI_API_KEY: "",
				GITHUB_TOKEN: "",
				HTTP_PROXY: "http://127.0.0.1:1",
				HTTPS_PROXY: "http://127.0.0.1:1",
			},
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		const combined = `${stdout}\n${stderr}`;
		// Help text must render.
		expect(combined).toContain("USAGE");
		// And must not leak provider/model failures or raw request-log hints.
		expect(combined).not.toMatch(/does not exist/i);
		expect(combined).not.toContain("raw-http-request");
		expect(combined).not.toContain("http-400-requests");
	}, 15_000);

	it("fast-paths root --tmux --help before runtime globals", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-help-fast-path-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		const proc = Bun.spawn([process.execPath, cliEntry, "--tmux", "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				XDG_DATA_HOME: xdg,
				PI_CODING_AGENT_DIR: agentDir,
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
		expect(stdout).toContain("USAGE");
		expect(stderr).toBe("");
	}, 15_000);

	it("fast-paths root --tmux --version before runtime globals", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-version-fast-path-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		const proc = Bun.spawn([process.execPath, cliEntry, "--tmux", "--version"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				XDG_DATA_HOME: xdg,
				PI_CODING_AGENT_DIR: agentDir,
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
		expect(stdout).toMatch(/^gjc\/\d+\.\d+\.\d+\n$/);
		expect(stderr).toBe("");
	}, 15_000);
});
