import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { transformSdkStateForRollback } from "../../../scripts/transform-sdk-state-for-rollback";
import { readBrokerDiscovery, writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const pretrainManifest = path.join(import.meta.dir, "manifests", "sdk-pretrain-binary.json");
class PinnedOldReaderCommitUnavailableError extends Error {
	constructor(baseRef: string, reason: string) {
		super(
			`Pinned old-reader git object ${baseRef} cannot establish its exact commit identity; ${reason}. The rollback acceptance proof requires this commit.`,
		);
		this.name = "PinnedOldReaderCommitUnavailableError";
	}
}

type PinnedCommitRecovery = {
	remote: string;
	ref: string;
	depth: number;
};

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-rollback-"));

async function command(
	argv: string[],
	cwd = repoRoot,
	env?: Record<string, string>,
	timeoutMs = 300_000,
): Promise<{ exitCode: number; output: string }> {
	const label = argv.slice(0, 4).join(" ");
	const started = Date.now();
	const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	// Actionable phase evidence: each rollback build stage logs its duration so a slow or
	// hanging stage (baseRef fetch vs offline install vs native build vs bun compile vs run)
	// is attributable in CI instead of the whole proof opaquely hitting the outer timeout.
	console.error(
		`[rollback-stage] ${label} exit=${exitCode} ms=${Date.now() - started}${timedOut ? ` TIMED_OUT>${timeoutMs}ms` : ""}`,
	);
	const phase = timedOut ? `\n[rollback-stage] '${label}' exceeded ${timeoutMs}ms and was killed` : "";
	return { exitCode, output: `${stdout}${stderr}${phase}` };
}

async function resolvePinnedOldReaderCommit(baseRef: string, recovery: PinnedCommitRecovery): Promise<string> {
	if (recovery.ref !== baseRef) {
		throw new PinnedOldReaderCommitUnavailableError(
			baseRef,
			`recovery ref ${recovery.ref} does not match the pinned commit`,
		);
	}

	const current = await command(["git", "rev-parse", "--verify", `${baseRef}^{commit}`]);
	if (current.exitCode === 0 && current.output.trim() === baseRef) return baseRef;

	const fetched = await command([
		"git",
		"fetch",
		"--no-tags",
		`--depth=${recovery.depth}`,
		recovery.remote,
		recovery.ref,
	]);
	const recovered = await command(["git", "rev-parse", "--verify", `${baseRef}^{commit}`]);
	if (fetched.exitCode !== 0 || recovered.exitCode !== 0 || recovered.output.trim() !== baseRef) {
		throw new PinnedOldReaderCommitUnavailableError(
			baseRef,
			`bounded fetch from ${recovery.remote} ref ${recovery.ref} at depth ${recovery.depth} exited ${fetched.exitCode}`,
		);
	}
	return recovered.output.trim();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, description: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

function expandProductCommand(
	command: readonly string[],
	values: Readonly<Record<"executable" | "ownerId" | "agentDir" | "transportShim", string>>,
): string[] {
	return command.map(arg =>
		arg.replace(
			/\{(executable|ownerId|agentDir|transportShim)\}/g,
			(_match, name: keyof typeof values) => values[name],
		),
	);
}

async function jsonFile(pathname: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await fs.readFile(pathname, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function startOldFormatFakeEndpoint(token: string): {
	url: string;
	port: number;
	frames: Record<string, unknown>[];
	stop: () => void;
} {
	const frames: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname !== "/" || url.searchParams.get("token") !== token)
				return new Response("unauthorized", { status: 401 });
			if (server.upgrade(request)) return;
			return new Response("upgrade failed", { status: 500 });
		},
		websocket: {
			message(socket, message) {
				const frame = JSON.parse(String(message)) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "hello") {
					socket.send(
						JSON.stringify({
							type: "action_needed",
							sessionId: "rollback-session",
							id: "rollback-action",
							kind: "ask",
							question: "Approve transformed rollback state?",
							options: ["approve"],
						}),
					);
				}
			},
		},
	});
	return { url: `ws://127.0.0.1:${server.port!}`, port: server.port!, frames, stop: () => server.stop(true) };
}

test("v1 SDK state transforms to a rollback directory and is executable by the pinned pre-Phase-B notifications product", async () => {
	const source = await temp();
	const output = path.join(await temp(), "rollback");
	const agentDir = source;
	const endpointDir = path.join(source, "state", "sdk");
	await fs.mkdir(endpointDir, { recursive: true });

	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "rollback-proof",
		ownerId: "proof",
		pid: process.pid,
		host: "127.0.0.1",
		port: 4312,
		url: "ws://127.0.0.1:4312",
		token: "broker-token",
		startedAt: 1,
		heartbeatAt: Date.now(),
	});
	const index = await new SessionIndex(agentDir).open();
	await index.append({
		type: "host_registered",
		sessionId: "rollback-session",
		locator: { repo: source, stateRoot: path.join(source, "state") },
		endpointGeneration: 1,
		pid: process.pid,
	});
	const ledger = await new LifecycleLedger(agentDir).open();
	const begun = await ledger.begin("rollback-proof", "request-hash");
	if (begun.kind !== "new") throw new Error("Expected new lifecycle entry");
	await ledger.transition("rollback-proof", "terminal_ok", { response: { sessionId: "rollback-session" } });

	const manifest = (await Bun.file(pretrainManifest).json()) as {
		baseRef: string;
		strategy: string;
		sourceEntrypoints: string[];
		artifactPath: string;
		artifactPathByPlatform: Record<string, string>;
		artifactSha256Scope: string;
		supportedPlatforms: string[];
		sourceRecovery: PinnedCommitRecovery;
		toolchain: {
			runtime: string;
			version: string;
			dependencyInstall: string[];
			nativeBuild: string[];
			nativeEmbed: string[];
			compile: string[];
			sign: Record<string, string[]>;
		};

		productCommand: string[];
		shutdownCommand: string[];
		runtimeEnvironment: { BUN_OPTIONS: string };
	};
	expect(manifest.strategy).toBe("isolated-worktree-offline-install-compile");
	expect(manifest.baseRef).toMatch(/^[0-9a-f]{40}$/);
	expect(manifest.sourceEntrypoints).toEqual([
		"packages/coding-agent/src/cli.ts",
		"packages/coding-agent/src/notifications/telegram-daemon-cli.ts",
	]);
	expect(manifest.artifactPath).toBe("packages/coding-agent/dist/gjc-rollback");
	expect(manifest.artifactSha256Scope).toContain("executable bytes");
	expect(manifest.supportedPlatforms).toContain(process.platform);
	expect(manifest.artifactPathByPlatform).toEqual({
		darwin: manifest.artifactPath,
		linux: manifest.artifactPath,
		win32: `${manifest.artifactPath}.exe`,
	});
	const artifactPath = manifest.artifactPathByPlatform[process.platform];
	if (artifactPath === undefined) throw new Error(`No rollback executable artifact path for ${process.platform}.`);
	expect(manifest.toolchain.runtime).toBe("bun");
	expect(manifest.toolchain.version).toBe(Bun.version);
	expect(manifest.runtimeEnvironment).toEqual({ BUN_OPTIONS: "--preload {transportShim}" });
	expect(manifest.sourceRecovery).toEqual({ remote: "origin", ref: manifest.baseRef, depth: 1 });
	expect(manifest.productCommand).toEqual([
		"{executable}",
		"notify",
		"daemon-internal",
		"--owner-id",
		"{ownerId}",
		"--agent-dir",
		"{agentDir}",
	]);
	expect(manifest.shutdownCommand).toEqual([
		"{executable}",
		"daemon",
		"stop",
		"telegram",
		"--json",
		"--graceful-timeout-ms",
		"5000",
	]);

	const worktree = await temp();
	let endpointServer:
		| { url: string; port: number; frames: Array<Record<string, unknown>>; stop: () => void }
		| undefined;
	const recoveredCommit = await resolvePinnedOldReaderCommit(manifest.baseRef, manifest.sourceRecovery);
	const added = await command(["git", "worktree", "add", "--detach", worktree, manifest.baseRef]);
	expect(added.exitCode, added.output).toBe(0);
	try {
		const head = await command(["git", "rev-parse", "HEAD"], worktree);
		expect(head.exitCode, head.output).toBe(0);
		const commit = head.output.trim();
		expect(commit).toBe(recoveredCommit);
		expect(commit).toBe(manifest.baseRef);
		const installed = await command(manifest.toolchain.dependencyInstall, worktree);
		expect(installed.exitCode, installed.output).toBe(0);
		const isolatedNodeModules = await fs.lstat(path.join(worktree, "node_modules"));
		expect(isolatedNodeModules.isSymbolicLink()).toBe(false);

		const nativeBuild = await command(
			manifest.toolchain.nativeBuild,
			worktree,
			undefined,
			// Bounded accommodation for documented Windows cold native builds; remains below the outer proof cap.
			process.platform === "win32" ? 900_000 : 300_000,
		);
		expect(nativeBuild.exitCode, nativeBuild.output).toBe(0);
		const nativeEmbed = await command(manifest.toolchain.nativeEmbed, worktree);
		expect(nativeEmbed.exitCode, nativeEmbed.output).toBe(0);
		const productDirectory = path.join(worktree, "packages", "coding-agent");
		const compiled = await command(manifest.toolchain.compile, productDirectory, {
			BUN_NO_CODESIGN_MACHO_BINARY: "1",
		});
		expect(compiled.exitCode, compiled.output).toBe(0);
		const signCommand = manifest.toolchain.sign[process.platform] ?? [];
		if (signCommand.length > 0) {
			const signed = await command(signCommand, productDirectory);
			expect(signed.exitCode, signed.output).toBe(0);
		}
		const executable = path.join(worktree, artifactPath);
		const executableStat = await fs.stat(executable);
		expect(executableStat.isFile()).toBe(true);
		if (process.platform === "win32") {
			expect(path.extname(executable)).toBe(".exe");
		} else {
			expect(executableStat.mode & 0o111).not.toBe(0);
		}
		const artifactSha256 = createHash("sha256")
			.update(await fs.readFile(executable))
			.digest("hex");
		expect(artifactSha256).toMatch(/^[0-9a-f]{64}$/);
		console.log(
			`Pinned pretrain executable commit=${commit} platform=${process.platform} arch=${process.arch} artifact=${artifactPath} sha256=${artifactSha256}`,
		);
		endpointServer = startOldFormatFakeEndpoint("endpoint-token");
		const activeEndpointServer = endpointServer;
		const endpoint = {
			version: 1,
			sessionId: "rollback-session",
			pid: process.pid,
			host: "127.0.0.1",
			port: activeEndpointServer.port,
			url: activeEndpointServer.url,
			token: "endpoint-token",
			startedAt: 1,
			updatedAt: 1,
			stale: false,
		};
		await fs.writeFile(path.join(endpointDir, "rollback-session.json"), JSON.stringify(endpoint));

		const report = await transformSdkStateForRollback({
			from: source,
			out: output,
			to: 1,
			pretrainBinary: {
				baseRef: manifest.baseRef,
				commit,
				artifactPath,
				artifactSha256,
				artifactSha256Scope: manifest.artifactSha256Scope,
			},
		});
		expect(report).toEqual({
			schemaVersion: 1,
			sourceVersion: 1,
			targetVersion: 1,
			omissions: [],
			copied: expect.any(Array),
			pretrainBinary: {
				baseRef: manifest.baseRef,
				commit: manifest.baseRef,
				artifactPath,
				artifactSha256,
				artifactSha256Scope: manifest.artifactSha256Scope,
			},
		});

		expect(report.copied).toContain(path.join("state", "notifications", "rollback-session.json"));
		expect(JSON.parse(await fs.readFile(path.join(output, "report.json"), "utf8"))).toEqual(report);
		// The transformed rollback dir is a static snapshot; assert the broker discovery
		// record is present and structurally valid, not that its captured heartbeat is
		// "live" — a slow CI native rebuild (~272s) otherwise trips the liveness TTL.
		expect(await readBrokerDiscovery(output, Number.POSITIVE_INFINITY)).not.toBeNull();

		const transformedEndpointFile = path.join(output, "state", "notifications", "rollback-session.json");
		const frozenOldEndpoint = JSON.parse(await fs.readFile(transformedEndpointFile, "utf8"));
		expect(frozenOldEndpoint).toMatchObject({
			version: 1,
			url: endpoint.url,
			token: endpoint.token,
			pid: endpoint.pid,
			stale: false,
		});
		await fs.mkdir(path.join(output, "notifications"), { recursive: true });
		await fs.writeFile(
			path.join(output, "notifications", "telegram-daemon.roots.json"),
			JSON.stringify({ version: 1, roots: [path.join(output, "state")] }),
		);

		await fs.writeFile(
			path.join(output, "config.yml"),
			[
				"notifications:",
				"  enabled: true",
				"  telegram:",
				"    botToken: test-token",
				'    chatId: "1"',
				"  daemon:",
				"    idleTimeoutMs: 5000",
				"",
			].join("\n"),
		);
		const transportShim = path.join(output, "rollback-telegram-preload.ts");
		const transportLog = path.join(output, "rollback-telegram-requests.jsonl");
		await fs.writeFile(
			transportShim,
			`import { appendFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
let callbackData;
let deliveredCallback = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.telegram.org") return originalFetch(input, init);
  const method = url.pathname.split("/").at(-1) ?? "";
  const body = typeof init?.body === "string" ? init.body : "";
  appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify({ method, body }) + "\\n");
  if (method === "sendMessage") {
    try {
      const parsed = JSON.parse(body);
      callbackData = parsed?.reply_markup?.inline_keyboard?.flat?.().at?.(-1)?.callback_data;
    } catch {}
  }
  const result = method === "getMe"
    ? { id: 1, is_bot: true, first_name: "Rollback", username: "rollback_bot" }
    : method === "getChat"
      ? { id: 1, type: "private" }
      : method === "getUpdates"
        ? (!deliveredCallback && typeof callbackData === "string"
          ? (deliveredCallback = true, [{ update_id: 1, callback_query: { id: "rollback-callback", from: { id: 1, is_bot: false, first_name: "Rollback" }, message: { message_id: 1, chat: { id: 1, type: "private" } }, data: callbackData } }])
          : [])
        : method === "sendMessage"
          ? { message_id: 1 }
          : true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
		);
		const transportShimSpecifier = transportShim.replaceAll("\\", "/");
		const ownerId = `${process.pid}-rollback-proof`;
		const productCommand = expandProductCommand(manifest.productCommand, {
			executable,
			ownerId,
			agentDir: output,
			transportShim,
		});
		expect(productCommand).toEqual([
			executable,
			"notify",
			"daemon-internal",
			"--owner-id",
			ownerId,
			"--agent-dir",
			output,
		]);

		expect(
			createHash("sha256")
				.update(await fs.readFile(executable))
				.digest("hex"),
		).toBe(artifactSha256);
		const daemonDir = path.join(output, "notifications");
		await fs.writeFile(
			path.join(daemonDir, "telegram-daemon.state.json"),
			JSON.stringify({
				version: 1,
				ownerId,
				pid: 0,
				tokenFingerprint: "4c5dc9b77089",
				chatId: "1",
				startedAt: 1,
				heartbeatAt: 1,
				roots: [path.join(output, "state")],
			}),
		);
		// Windows compiled-startup accommodation.
		const oldProductReadinessTimeoutMs = process.platform === "win32" ? 30_000 : 5_000;
		const oldProduct = Bun.spawn(productCommand, {
			cwd: output,
			env: {
				...process.env,
				GJC_CODING_AGENT_DIR: output,
				BUN_OPTIONS: manifest.runtimeEnvironment.BUN_OPTIONS.replace("{transportShim}", transportShimSpecifier),
			},

			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = new Response(oldProduct.stdout).text();
		const stderr = new Response(oldProduct.stderr).text();
		let readinessError: unknown;
		try {
			const daemonStatePath = path.join(output, "notifications", "telegram-daemon.state.json");
			await waitFor(
				async () => (await jsonFile(daemonStatePath))?.pid === oldProduct.pid,
				oldProductReadinessTimeoutMs,
				"old product daemon readiness and ownership mutation",
			);
			const daemonState = await jsonFile(daemonStatePath);
			expect(daemonState).toMatchObject({ ownerId, pid: oldProduct.pid });
			await waitFor(
				() => activeEndpointServer.frames.some(frame => frame.type === "hello"),
				oldProductReadinessTimeoutMs,
				"old product discovery of transformed notification endpoint",
			);
			await waitFor(
				() =>
					activeEndpointServer.frames.some(
						frame =>
							frame.type === "reply" &&
							frame.id === "rollback-action" &&
							frame.answer === 0 &&
							frame.token === endpoint.token,
					),
				oldProductReadinessTimeoutMs,
				"old product Telegram mutation forwarded to transformed session endpoint",
			);
			const telegramCalls = (await fs.readFile(transportLog, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { method: string });
			expect(telegramCalls.map(call => call.method)).toEqual(
				expect.arrayContaining(["getMe", "getUpdates", "sendMessage"]),
			);
			const shutdownCommand = expandProductCommand(manifest.shutdownCommand, {
				executable,
				ownerId,
				agentDir: output,
				transportShim,
			});
			expect(
				createHash("sha256")
					.update(await fs.readFile(executable))
					.digest("hex"),
			).toBe(artifactSha256);
			const shutdown = await command(shutdownCommand, output, {
				GJC_CODING_AGENT_DIR: output,
				BUN_OPTIONS: manifest.runtimeEnvironment.BUN_OPTIONS.replace("{transportShim}", transportShimSpecifier),
			});
			expect(shutdown.exitCode, shutdown.output).toBe(0);
			const controlPath = path.join(daemonDir, "telegram-daemon.control.json");
			await waitFor(
				async () => (await jsonFile(controlPath)) === undefined,
				oldProductReadinessTimeoutMs,
				"old product control acknowledgement",
			);
			await waitFor(
				async () => {
					try {
						await fs.access(path.join(daemonDir, "telegram-daemon.lock"));
						return false;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
						throw error;
					}
				},
				oldProductReadinessTimeoutMs,
				"old product ownership release",
			);
		} catch (error) {
			readinessError = error;
			oldProduct.kill("SIGKILL");
		}
		const [exitCode, oldStdout, oldStderr] = await Promise.all([oldProduct.exited, stdout, stderr]);
		if (readinessError)
			throw new Error(
				`${readinessError instanceof Error ? readinessError.message : String(readinessError)}\n${oldStdout}${oldStderr}`,
			);
		// Bun reports a signal exit as 128 + signal number on POSIX, while Windows
		// terminates the compiled process with its platform exit status.
		expect(exitCode, `${oldStdout}${oldStderr}`).toBe(process.platform === "win32" ? 1 : 128 + 15);
	} finally {
		await command(["git", "worktree", "remove", "--force", worktree]);
		endpointServer?.stop();
	}
}, 1_500_000);

test("rollback transformer refuses an unknown source version", async () => {
	const source = await temp();
	const output = path.join(await temp(), "rollback");
	await fs.mkdir(path.join(source, "sdk"), { recursive: true });
	await fs.writeFile(path.join(source, "sdk", "broker.json"), JSON.stringify({ version: 99 }));
	await expect(transformSdkStateForRollback({ from: source, out: output, to: 1 })).rejects.toThrow(
		"Unsupported source state version",
	);
	await expect(fs.stat(output)).rejects.toThrow();
});

test("rollback transformer rejects a malformed or misplaced legacy endpoint", async () => {
	const source = await temp();
	const output = path.join(await temp(), "rollback");
	const endpointDir = path.join(source, "state", "sdk");
	await fs.mkdir(endpointDir, { recursive: true });
	await fs.writeFile(
		path.join(endpointDir, "wrong-name.json"),
		JSON.stringify({
			version: 1,
			sessionId: "rollback-session",
			pid: process.pid,
			host: "127.0.0.1",
			port: 4313,
			url: "ws://127.0.0.1:4313",
			token: "endpoint-token",
			startedAt: 1,
			updatedAt: 1,
			stale: false,
		}),
	);
	await expect(transformSdkStateForRollback({ from: source, out: output, to: 1 })).rejects.toThrow(
		"Invalid rollback endpoint path",
	);
});
