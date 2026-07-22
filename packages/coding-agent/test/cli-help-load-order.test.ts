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

	it("renders contribute-pr --help without loading native-dependent commands", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-contribute-pr-help-native-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		const proc = Bun.spawn([process.execPath, cliEntry, "contribute-pr", "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				XDG_DATA_HOME: xdg,
				GJC_CODING_AGENT_DIR: agentDir,
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
		const combined = `${stdout}\n${stderr}`;

		expect(exitCode, combined).toBe(0);
		expect(stdout).toContain("USAGE");
		expect(stdout).toContain("$ gjc contribute-pr");
		expect(stdout).toContain("--no-spawn");
		expect(combined).not.toContain("Failed to load pi_natives native addon");
	}, 15_000);

	it("lists representative commands in root --help", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-help-commands-"));
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
				GJC_CODING_AGENT_DIR: agentDir,
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
		const combined = `${stdout}\n${stderr}`;

		expect(exitCode, combined).toBe(0);
		expect(stdout).toContain("Commands:");
		expect(stdout).toContain("gjc setup");
		expect(stdout).toContain("gjc session");
		expect(stdout).toContain("gjc state");
		expect(stdout).toContain("gjc harness");
		expect(stdout).toContain("gjc config");
		expect(stdout).toContain("gjc ralplan");
		expect(stdout).toContain("gjc ultragoal");
		expect(stdout).toContain("gjc team");
		expect(stdout).toContain("gjc mcp");
		expect(stdout).toContain("gjc mcp-serve");
		expect(stdout).toContain("gjc contribute-pr");
		expect(stdout).toContain("gjc web-search");
		expect(stdout).toContain("gjc codex-native-hook");
		expect(stdout).toContain("gjc gc");
		expect(stdout).toContain("gjc <command> --help");
		expect(stdout).toContain("Available Tools");
		expect(stdout).toContain("Useful Commands");
		expect(stderr).toBe("");
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

		for (const versionFlag of ["--version", "-v"]) {
			const proc = Bun.spawn([process.execPath, cliEntry, "--tmux", versionFlag], {
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
		}
	}, 15_000);
	it("package bin wrapper executes CLI help when imported by a Bun global shim", async () => {
		if (Bun.semver.order(Bun.version, "1.3.14") < 0) {
			return;
		}
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bin-wrapper-help-"));
		cleanupRoot = root;
		const home = path.join(root, "home");
		const xdg = path.join(root, "xdg");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(xdg, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });

		const wrapperPath = path.join(repoRoot, "packages", "coding-agent", "bin", "gjc.js");
		const proc = Bun.spawn([process.execPath, wrapperPath, "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: xdg,
				XDG_DATA_HOME: xdg,
				GJC_CODING_AGENT_DIR: agentDir,
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
		const combined = `${stdout}
${stderr}`;

		expect(exitCode, combined).toBe(0);
		expect(stdout).toContain("gjc v");
		expect(stdout).toContain("USAGE");
		expect(combined).not.toContain("Bun is a fast JavaScript runtime");
	}, 15_000);
});
