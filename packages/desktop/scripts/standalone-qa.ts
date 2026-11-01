// Manual packaged-runtime proof: no globally installed gjc/Bun or live provider.
// Usage: bun packages/desktop/scripts/standalone-qa.ts /absolute/path/Gajae\ Code.app
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DesktopOperatorOperation } from "../../desktop-host/src/operator-protocol";
import type { DesktopFrame, DesktopProject, DesktopRequest, DesktopSession } from "../../desktop-host/src/protocol";
import { childDiagnostics } from "./child-diagnostics";

const app = path.resolve(
	process.argv[2] ?? path.join(import.meta.dir, "../src-tauri/target/release/bundle/macos/Gajae Code.app"),
);
const directory = path.join(app, "Contents/MacOS");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-standalone-"));
const dataDir = path.join(root, "data");
const agentDir = path.join(dataDir, "agent");
const project = path.join(root, "project");
const environment = {
	PATH: "/usr/bin:/bin",
	HOME: path.join(root, "home"),
	TMPDIR: root,
	LANG: "en_US.UTF-8",
	GJC_DESKTOP_ISOLATED: "1",
	GJC_DESKTOP_DATA_DIR: dataDir,
};
interface DiagnosticDrain {
	wait(timeoutMs: number): Promise<string>;
}
const children = new Set<Bun.Subprocess>();
const drains = new Set<DiagnosticDrain>();
const pending = new Map<string, PromiseWithResolvers<unknown>>();
let nextId = 0;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let readFrames: Promise<void> | undefined;
let readerFailure: Error | undefined;
let shutdownExpected = false;
let diagnostics: DiagnosticDrain | undefined;

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const deadline = Promise.withResolvers<T>();
	const timer = setTimeout(() => deadline.reject(new Error(`${label} timed out`)), timeoutMs);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}
async function stop(process: Bun.Subprocess): Promise<void> {
	if (process.exitCode !== null) return;
	process.kill("SIGTERM");
	try {
		await bounded(process.exited, 6500, "SIGTERM shutdown");
	} catch {
		if (process.exitCode === null) process.kill("SIGKILL");
		await bounded(process.exited, 2000, "SIGKILL reap");
	}
}
function diagnostic(stream: ReadableStream<Uint8Array>): DiagnosticDrain {
	const drain = childDiagnostics(stream);
	drains.add(drain);
	return drain;
}
async function cli(args: string[], binary = "gjc"): Promise<string> {
	const process = Bun.spawn([path.join(directory, binary), ...args], {
		cwd: project,
		env: environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.add(process);
	const output = diagnostic(process.stdout);
	const errors = diagnostic(process.stderr);
	const code = await bounded(process.exited, 90_000, `Bundled ${binary} ${args.join(" ")}`);
	const [text, errorText] = await Promise.all([output.wait(1000), errors.wait(1000)]);
	if (code !== 0) throw new Error(`Bundled ${binary} ${args.join(" ")} failed (${code}): ${errorText}`);
	return text.trim();
}
async function request<T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> {
	if (readerFailure) throw readerFailure;
	if (!child || child.exitCode !== null) throw new Error("Host is not running");
	const id = `standalone-${++nextId}`;
	const result = Promise.withResolvers<unknown>();
	pending.set(id, result);
	const deadline = setTimeout(() => result.reject(new Error(`${method} timed out`)), 30_000);
	try {
		child.stdin.write(`${JSON.stringify({ id, method, params } satisfies DesktopRequest)}\n`);
		const [, response] = await Promise.all([
			bounded(Promise.resolve(child.stdin.flush()), 5000, "Host request flush"),
			result.promise,
		]);
		return response as T;
	} finally {
		clearTimeout(deadline);
		pending.delete(id);
	}
}
try {
	for (const location of [project, agentDir, environment.HOME]) await fs.mkdir(location, { recursive: true });
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				"standalone-fixture": {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "fixture-not-a-real-secret",
					models: [
						{
							id: "offline",
							name: "Offline runtime fixture",
							reasoning: false,
							input: ["text"],
							contextWindow: 32768,
							maxTokens: 1024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			modelRoles: { default: "standalone-fixture/offline" },
			compaction: { enabled: false },
			retry: { enabled: false },
			shellPath: "/bin/bash",
		}),
	);
	const version = await cli(["--version"]);
	const smoke = await cli(["--smoke-test"]);
	const sdkDispatch = await cli(["sdk", "--help"], "gjc-desktop-host");
	if (!sdkDispatch.includes('"id":"sdk/overview/summary"')) throw new Error("SDK child mode did not reach the CLI");
	// Mirrors native bundled_command: app-local CLI first, system tools retained.
	child = Bun.spawn([path.join(directory, "gjc-desktop-host")], {
		cwd: project,
		env: { ...environment, PATH: `${directory}:${environment.PATH}` },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.add(child);
	diagnostics = diagnostic(child.stderr);
	reader = child.stdout.getReader();
	readFrames = (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { value, done } = await reader!.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > 8 * 1024 * 1024) throw new Error("Host frame exceeded QA budget");
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const frame = JSON.parse(buffer.slice(0, newline)) as DesktopFrame;
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (frame.type === "fatal") throw new Error(frame.error);
					if (frame.type !== "response") continue;
					const result = pending.get(frame.id);
					if (frame.ok) result?.resolve(frame.result);
					else result?.reject(new Error(frame.error));
				}
			}
			buffer += decoder.decode();
			if (buffer.trim()) throw new Error("Host ended with an incomplete frame");
			if (!shutdownExpected) throw new Error("Host frame stream closed before shutdown");
		} catch (error) {
			readerFailure = error instanceof Error ? error : new Error(String(error));
			for (const result of pending.values()) result.reject(readerFailure);
		} finally {
			reader!.releaseLock();
		}
	})();
	await request("bootstrap");
	const workspace = await request<DesktopProject>("project.open", { path: project });
	const session = await request<DesktopSession>("session.create", { projectId: workspace.id });
	let operation = await request<DesktopOperatorOperation>("operator.execute", {
		sessionId: session.id,
		text: "! command -v gjc && gjc --version && gjc state ultragoal --help",
	});
	const deadline = Date.now() + 30_000;
	while (operation.status === "running" && Date.now() < deadline) {
		await Bun.sleep(100);
		operation = await request<DesktopOperatorOperation>("operator.get", {
			sessionId: session.id,
			operationId: operation.operationId,
		});
	}
	if (
		operation.status !== "completed" ||
		operation.exitCode !== 0 ||
		!operation.output.includes(path.join(directory, "gjc"))
	)
		throw new Error(`Bundled workflow command failed: ${JSON.stringify(operation)}`);
	shutdownExpected = true;
	await request("shutdown");
	const code = await bounded(child.exited, 10_000, "Host shutdown exit");
	await bounded(readFrames, 5000, "Host final frame drain");
	if (readerFailure) throw readerFailure;
	if (code !== 0) throw new Error(`Host shutdown failed: ${await diagnostics.wait(1000)}`);
	process.stdout.write(
		`${JSON.stringify({ app, globalPath: environment.PATH, version, smoke, sdkDispatch, shellStatus: operation.status, shellExitCode: operation.exitCode, shellOutput: operation.output, hostExitCode: code }, null, 2)}\n`,
	);
} finally {
	await Promise.all([...children].map(stop));
	if (reader && readFrames) {
		await bounded(
			reader.cancel().catch(() => {}),
			500,
			"Host reader cancellation",
		).catch(() => {});
		await bounded(readFrames, 1000, "Host reader cleanup").catch(() => {});
	}
	await Promise.all([...drains].map(drain => drain.wait(1000)));
	await fs.rm(root, { recursive: true, force: true });
}
