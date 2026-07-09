import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createCommandHookHandler,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	type GjcPluginRegistry,
	installGjcPluginBundle,
	loadConstrainedPluginHooks,
	parseManifest,
} from "../src/extensibility/gjc-plugins";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmdhooks-"));
	tempDirs.push(cwd);
	return cwd;
}

/** Verdict script: blocks `rm -rf /`, echoes session id for other bash input, silent otherwise. */
const GATE_SCRIPT = `const chunks = [];
process.stdin.on("data", c => chunks.push(c));
process.stdin.on("end", () => {
	let payload = {};
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {}
	const input = payload?.data?.input;
	if (input?.command === "rm -rf /") {
		process.stdout.write(JSON.stringify({ block: true, reason: "denied by policy" }));
	} else if (input?.command === "echo session") {
		process.stdout.write(JSON.stringify({ block: true, reason: "sid=" + payload.session.id }));
	} else if (input?.command === "echo env") {
		process.stdout.write(JSON.stringify({ block: true, reason: "secret=" + (process.env.GJC_TEST_SECRET ?? "unset") }));
	}
	process.exit(0);
});
`;

async function bundleWithCommandHook(over?: { hook?: Record<string, unknown>; script?: string }): Promise<string> {
	const src = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmdhooksrc-"));
	tempDirs.push(src);
	await fs.mkdir(path.join(src, "hooks"), { recursive: true });
	await fs.writeFile(path.join(src, "hooks", "gate.js"), over?.script ?? GATE_SCRIPT);
	await fs.writeFile(
		path.join(src, "gajae-plugin.json"),
		JSON.stringify({
			kind: "gajae-code-plugin",
			name: "command-hook-bundle",
			version: "1.0.0",
			hooks: [over?.hook ?? { name: "gate", event: "tool_call", command: "bun", args: ["hooks/gate.js"] }],
		}),
	);
	return src;
}

function expectLoadError(fn: () => unknown, code: GjcPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

async function expectAsyncLoadError(fn: () => Promise<unknown>, code: GjcPluginLoadErrorCode): Promise<void> {
	try {
		await fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

function manifestWithHook(hook: Record<string, unknown>): Record<string, unknown> {
	return { kind: "gajae-code-plugin", name: "m", version: "1.0.0", hooks: [hook] };
}

describe("GJC plugin command hooks: manifest schema", () => {
	test("requires exactly one of path / command, and args only with command", () => {
		const invalid: Record<string, unknown>[] = [
			{ name: "h", event: "tool_call", path: "hooks/h.ts", command: "bun" },
			{ name: "h", event: "tool_call" },
			{ name: "h", event: "tool_call", path: "hooks/h.ts", args: ["x"] },
		];
		for (const hook of invalid) {
			expectLoadError(() => parseManifest(manifestWithHook(hook), "/p/gajae-plugin.json"), "invalid_manifest");
		}
	});

	test("rejects command hooks on non-tool_call events (v1 contract)", () => {
		expectLoadError(
			() =>
				parseManifest(
					manifestWithHook({ name: "h", event: "session_start", command: "bun", args: ["h.js"] }),
					"/p/gajae-plugin.json",
				),
			"invalid_manifest",
		);
	});

	test("rejects timeoutMs out of bounds", () => {
		for (const timeoutMs of [0, 99, 60_001, 1.5]) {
			expectLoadError(
				() =>
					parseManifest(
						manifestWithHook({ name: "h", event: "tool_call", command: "bun", args: ["h.js"], timeoutMs }),
						"/p/gajae-plugin.json",
					),
				"invalid_manifest",
			);
		}
	});

	test("accepts a target-less command hook (governance hooks observe every tool call)", () => {
		const manifest = parseManifest(
			manifestWithHook({ name: "h", event: "tool_call", command: "bun", args: ["h.js"], timeoutMs: 5000 }),
			"/p/gajae-plugin.json",
		);
		expect(manifest.hooks[0]?.command).toBe("bun");
		expect(manifest.hooks[0]?.target).toBeUndefined();
	});
});

describe("GJC plugin command hooks: confinement policy at install", () => {
	test("denies out-of-root commands, escaping args, env expansion, and eval flags", async () => {
		const cwd = await mkCwd();
		const denied: { command: string; args: string[] }[] = [
			{ command: "/bin/sh", args: ["hooks/gate.js"] },
			{ command: "bun", args: ["../../etc/gate.js"] },
			{ command: "bun", args: [`$${"{HOME}"}/gate.js`] },
			{ command: "bun", args: ["-e", "hooks/gate.js"] },
		];
		for (const { command, args } of denied) {
			const src = await bundleWithCommandHook({ hook: { name: "gate", event: "tool_call", command, args } });
			await expectAsyncLoadError(
				() => installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true }),
				"security_policy",
			);
		}
	});
});

describe("GJC plugin command hooks: install-time approval", () => {
	test("install without --allow-command-hooks fails loudly", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithCommandHook();
		try {
			await installGjcPluginBundle(src, { scope: "project", cwd });
			throw new Error("expected security_policy");
		} catch (error) {
			expect(error).toBeInstanceOf(GjcPluginLoadError);
			expect((error as GjcPluginLoadError).code).toBe("security_policy");
			expect((error as GjcPluginLoadError).message).toContain("--allow-command-hooks");
		}
	});

	test("install with approval records commandHooksApproved and pins the script", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithCommandHook();
		const res = await installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true });
		expect(res.status).toBe("installed");
		expect(res.entry.commandHooksApproved).toBe(true);
		expect(res.entry.copiedFiles.some(f => f.relativePath === "hooks/gate.js")).toBe(true);
		const surface = res.entry.surfaces.hooks[0];
		expect(surface?.command).toBe("bun");
		expect(surface?.relativePath).toBeUndefined();
	});

	test("module-hook-only bundles never record approval", async () => {
		const cwd = await mkCwd();
		const src = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmdhooksrc-"));
		tempDirs.push(src);
		await fs.mkdir(path.join(src, "hooks"), { recursive: true });
		await fs.writeFile(
			path.join(src, "hooks", "h.ts"),
			"export default function(api){ api.on('tool_call', ()=>({})); }\n",
		);
		await fs.writeFile(
			path.join(src, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "module-hook-bundle",
				version: "1.0.0",
				hooks: [{ name: "h", event: "tool_call", target: "read", phase: "before", path: "hooks/h.ts" }],
			}),
		);
		const res = await installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true });
		expect(res.entry.commandHooksApproved).toBeUndefined();
	});
});

describe("GJC plugin command hooks: session load", () => {
	test("approved command hooks load with a spawn-backed handler", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithCommandHook();
		await installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true });
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.quarantine).toHaveLength(0);
		expect(res.hooks).toHaveLength(1);
		expect(res.hooks[0]?.event).toBe("tool_call");
		expect(typeof res.hooks[0]?.handler).toBe("function");
	});

	test("stripping approval from the registry quarantines the hook (fail-visible)", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithCommandHook();
		await installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true });
		const registryPath = path.join(cwd, ".gjc", "gjc-plugins", "registry.json");
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as GjcPluginRegistry;
		for (const p of registry.plugins) delete (p as { commandHooksApproved?: boolean }).commandHooksApproved;
		await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	});
});

describe("GJC plugin command hooks: runtime verdicts", () => {
	async function loadedGateHandler(cwd: string): Promise<(...args: unknown[]) => unknown> {
		const src = await bundleWithCommandHook();
		await installGjcPluginBundle(src, { scope: "project", cwd, allowCommandHooks: true });
		const res = await loadConstrainedPluginHooks({ cwd });
		const handler = res.hooks[0]?.handler;
		if (!handler) throw new Error("gate handler did not load");
		return handler;
	}

	const ctx = {
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/tmp/sess-1.jsonl" },
	};

	test("honors a block verdict and allows otherwise (end to end through install + load)", async () => {
		const cwd = await mkCwd();
		const handler = await loadedGateHandler(cwd);
		const blocked = (await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "rm -rf /" } },
			ctx,
		)) as { block?: boolean; reason?: string } | undefined;
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toBe("denied by policy");
		const allowed = await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "t2", input: { command: "ls" } },
			ctx,
		);
		expect(allowed).toBeUndefined();
	});

	test("delivers the event envelope (session id) on stdin", async () => {
		const cwd = await mkCwd();
		const handler = await loadedGateHandler(cwd);
		const res = (await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "t3", input: { command: "echo session" } },
			ctx,
		)) as { reason?: string };
		expect(res?.reason).toBe("sid=sess-1");
	});

	test("withholds host env from the hook subprocess", async () => {
		const cwd = await mkCwd();
		process.env.GJC_TEST_SECRET = "leaky";
		try {
			const handler = await loadedGateHandler(cwd);
			const res = (await handler(
				{ type: "tool_call", toolName: "bash", toolCallId: "t4", input: { command: "echo env" } },
				ctx,
			)) as { reason?: string };
			expect(res?.reason).toBe("secret=unset");
		} finally {
			delete process.env.GJC_TEST_SECRET;
		}
	});

	function directHandler(root: string, over?: { timeoutMs?: number }) {
		return createCommandHookHandler({
			plugin: "p",
			name: "gate",
			event: "tool_call",
			command: "bun",
			args: ["gate.js"],
			timeoutMs: over?.timeoutMs,
			pluginRoot: root,
		});
	}

	async function scriptRoot(script: string): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmdhookrt-"));
		tempDirs.push(root);
		await fs.writeFile(path.join(root, "gate.js"), script);
		return root;
	}

	test("fail-closed: non-zero exit blocks tool_call", async () => {
		const root = await scriptRoot("process.exit(3);\n");
		const res = (await directHandler(root)({ type: "tool_call", toolName: "bash" }, ctx)) as {
			block?: boolean;
			reason?: string;
		};
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("fail-closed");
	});

	test("fail-closed: unparseable stdout blocks tool_call", async () => {
		const root = await scriptRoot('process.stdout.write("not json"); process.exit(0);\n');
		const res = (await directHandler(root)({ type: "tool_call", toolName: "bash" }, ctx)) as { block?: boolean };
		expect(res?.block).toBe(true);
	});

	test("fail-closed: timeout blocks tool_call", async () => {
		const root = await scriptRoot("setTimeout(() => process.exit(0), 3_600_000);\n");
		const res = (await directHandler(root, { timeoutMs: 300 })({ type: "tool_call", toolName: "bash" }, ctx)) as {
			block?: boolean;
			reason?: string;
		};
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("timeout");
	});
});
