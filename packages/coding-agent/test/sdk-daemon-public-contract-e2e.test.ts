import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	PublicCommandFailure,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";

const root = resolve(import.meta.dir, "../../..");
const entry = join(root, "packages/coding-agent/src/cli/public-command-entry.ts");
const errors = join(root, "packages/coding-agent/src/cli/public-command-errors.ts");
const evidence = join(root, "packages/coding-agent/src/cli/public-command-evidence.ts");
const cli = join(root, "packages/coding-agent/src/cli.ts");

async function actualCli(argv: string[], scope: string) {
	const proc = Bun.spawn([process.execPath, cli, ...argv], {
		cwd: scope,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Exclude Bun's source transpiler cache from product-write assertions, as in plugin-uninstall-dry-run.test.ts.
		env: {
			...process.env,
			GJC_MALLOC_ENV_REEXEC: "1",
			GJC_CODING_AGENT_DIR: scope,
			PI_CODING_AGENT_DIR: scope,
			HOME: scope,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(8192);
	expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(8192);
	expect(stdout + stderr).not.toContain("\u001b");
	return { stdout, stderr, code };
}

describe("actual CLI public discovery and evidence traversal", () => {
	it("runs safe help, usage and missing-source recipes through bootstrap", async () => {
		const scope = await mkdtemp(join(await realpath(tmpdir()), "gjc-public-recipes-"));
		try {
			await writeFile(join(scope, "settings.json"), "{ invalid runtime-settings-canary }");
			const id = "a".repeat(32),
				digest = "b".repeat(64);
			const missing = join(scope, "must-not-exist");
			await expect(stat(missing)).rejects.toThrow();
			const recipes: { argv: string[]; code: number; json: boolean; help?: boolean }[] = [
				{ argv: ["sdk", "session", "raw", "query", "--help", "--json"], code: 0, json: true, help: true },
				{
					argv: ["daemon", "reload", "--help", "--help-section=options", "--json"],
					code: 0,
					json: true,
					help: true,
				},
				{ argv: ["sdk", "session", "send", "-h"], code: 0, json: false, help: true },
				...[
					["sdk", "session", "private-secret-canary", "--help", "--json"],
					["sdk", "spawn", "--unknown-private-secret", "--json", "--help"],
					["sdk", "spawn", "--prompt", "--json", "--help"],
					["sdk", "--help", "--help-page=1", "--help-page=1", "--json"],
					["sdk", "--help", "--help-page=9007199254740992", "--json"],
					["sdk", "--help=json", "--json"],
					["sdk", "--error-ref", id, "--json"],
					["daemon", `--error-ref=${id}`, `--error-sha256=${digest}`, "--error-page=0", "--json"],
					["sdk", "session", "inspect", `--error-ref=${id}`, `--error-sha256=${digest}`, "--json"],
				].map(argv => ({ argv, code: 2, json: true })),
				{
					argv: ["sdk", "session", "send", "s", "--text=--json", "--unknown-private-secret"],
					code: 2,
					json: false,
				},
				{ argv: ["sdk", "--", "--help", "--json"], code: 2, json: false },
				{
					argv: ["sdk", `--error-ref=${id}`, `--error-sha256=${digest}`, "--error-agent-dir", missing, "--json"],
					code: 1,
					json: true,
				},
				{
					argv: ["daemon", `--error-ref=${id}`, `--error-sha256=${digest}`, "--error-agent-dir", missing],
					code: 1,
					json: false,
				},
			];
			for (const recipe of recipes) {
				const result = await actualCli(recipe.argv, scope);
				expect(result.code).toBe(recipe.code);
				expect(recipe.json || recipe.help ? result.stderr : result.stdout).toBe("");
				expect(result.stdout + result.stderr).not.toMatch(/private-secret|runtime-settings-canary/);
				if (recipe.json) {
					const envelope = JSON.parse(result.stdout);
					expect(result.stdout.endsWith("\n")).toBe(true);
					expect(envelope.schema).toBe(recipe.help ? "gjc.command-help" : "gjc.command-error");
					if (recipe.code === 2)
						expect(envelope.error).toMatchObject({
							category: "usage",
							outcomeCertainty: "not-applied",
							retryability: "no",
						});
					if (recipe.code === 1)
						expect(envelope).toMatchObject({
							complete: false,
							continuation: null,
							evidence: { status: "unavailable" },
						});
					if (recipe.help) expect(envelope.command).toEqual(recipe.argv.slice(0, recipe.argv.indexOf("--help")));
					if (recipe.help && recipe.argv[0] === "daemon") {
						expect(envelope.canonicalCommand).toEqual(["daemon", "restart"]);
						let helpPage = envelope;
						const entries = [...helpPage.entries];
						let traversed = 0;
						while (helpPage.next?.section === "options") {
							expect(++traversed).toBeLessThan(100);
							const following = await actualCli(helpPage.next.argv, scope);
							expect(following.code).toBe(0);
							expect(following.stderr).toBe("");
							helpPage = JSON.parse(following.stdout);
							entries.push(...helpPage.entries);
						}
						expect(JSON.stringify(entries)).not.toMatch(/--smoke|--owner-id|--agent-dir/);
					}
				}
			}
			await expect(stat(missing)).rejects.toThrow();
			expect(await readdir(scope)).toEqual(["settings.json"]);
		} finally {
			await rm(scope, { recursive: true, force: true });
		}
	}, 120_000);

	it("reconstructs all retained bytes using real CLI continuations after an oversized failure publisher exits", async () => {
		const scope = await mkdtemp(join(await realpath(tmpdir()), "gjc-public-traversal-"));
		try {
			const references = [
				{ kind: "sessionId", value: "safe-session" },
				{ kind: "operationRef", value: '漢字\\"'.repeat(2500) },
			];
			const published =
				await child(`import {PublicCommandFailure,renderPublicCommandFailure} from ${JSON.stringify(errors)};
const result=await renderPublicCommandFailure(new PublicCommandFailure({kind:"wait_timeout",proof:"accepted",references:${JSON.stringify(references)}}),{command:["sdk","session","send"],json:true,agentDir:${JSON.stringify(scope)},scopeAgentDir:${JSON.stringify(scope)}});process.stdout.write(result.stdout);process.exitCode=result.exitCode;`);
			expect(published.code).toBe(1);
			expect(published.stderr).toBe("");
			expect(Buffer.byteLength(published.stdout)).toBeLessThanOrEqual(8192);
			const original = JSON.parse(published.stdout);
			expect(original.error).toMatchObject({ outcomeCertainty: "applied", retryability: "no" });
			expect(original.evidence.status).toBe("retained");
			const store = join(scope, "cli-error-evidence-v1");
			const names = await readdir(store);
			const recordName = names.find(name => /^\d+\.json$/.test(name))!;
			const exactBytes = await readFile(join(store, recordName));
			await writeFile(join(scope, "settings.json"), "{ invalid runtime-settings-canary }");
			const chunks: Buffer[] = [];
			let next = original.continuation;
			let offset = 0,
				pages = 0;
			while (next !== null) {
				expect(++pages).toBeLessThanOrEqual(1024);
				expect(next).toMatchObject({
					id: original.evidence.id,
					sha256: original.evidence.sha256,
					page: pages,
					executable: "gjc",
				});
				expect(next.argv.slice(0, 2)).toEqual(["sdk", "--error-ref"]);
				expect(next.argv).toContain(`--error-agent-dir=${scope}`);
				const result = await actualCli(next.argv, scope);
				expect(result.code).toBe(0);
				expect(result.stderr).toBe("");
				const page = JSON.parse(result.stdout);
				expect(page).toMatchObject({
					schema: "gjc.command-error-evidence",
					id: original.evidence.id,
					sha256: original.evidence.sha256,
					page: pages,
				});
				for (const fragment of page.fragments) {
					expect(fragment.encoding).toBe("base64");
					expect(fragment.offsetBytes).toBe(offset);
					expect(fragment.totalBytes).toBe(exactBytes.length);
					const chunk = Buffer.from(fragment.data, "base64");
					chunks.push(chunk);
					offset += chunk.length;
				}
				expect(page.complete).toBe(page.next === null);
				next = page.next;
			}
			expect(pages).toBeGreaterThan(1);
			const reconstructed = Buffer.concat(chunks);
			expect(reconstructed).toEqual(exactBytes);
			expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(original.evidence.sha256);
			expect(JSON.parse(reconstructed.toString()).references).toEqual(references);
			expect(await readFile(join(store, recordName))).toEqual(exactBytes);
			expect(await readdir(store)).toEqual(names);
			expect((await readdir(scope)).sort()).toEqual(["cli-error-evidence-v1", "settings.json"]);
		} finally {
			await rm(scope, { recursive: true, force: true });
		}
	}, 180_000);
});

async function child(source: string) {
	const proc = Bun.spawn([process.execPath, "--eval", source], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GJC_MALLOC_ENV_REEXEC: "1" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}
function dispatchSource(family: "sdk" | "daemon", argv: string[], hooks: string) {
	return `import { dispatchPublicCommand } from ${JSON.stringify(entry)};
import { Command } from "@gajae-code/utils/cli";
import { PublicCommandFailure } from ${JSON.stringify(errors)};
await dispatchPublicCommand(${JSON.stringify(argv)}, {bin:"gjc",version:"test",command:${JSON.stringify(family)},${hooks}});`;
}

describe("public family boundary subprocess contracts", () => {
	it("preserves exact SDK worker argv through registered bootstrap hooks without starting workers", async () => {
		for (const argv of [["session-host-internal"], ["broker-internal", "--agent-dir", "/safe-fixture"]]) {
			const result = await child(`import {commands,runCli} from ${JSON.stringify(cli)};
import {Command} from "@gajae-code/utils/cli";
commands.find(entry=>entry.name==="sdk").load=async()=>class extends Command {async run(){process.stdout.write(JSON.stringify({workerArgv:this.argv}))}};
await runCli(${JSON.stringify(["sdk", ...argv])});`);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ workerArgv: argv });
		}
	});

	it("does not grant runtime bypass to malformed or decorated private worker tokens", async () => {
		for (const argv of [
			["broker-internal"],
			["broker-internal", "--agent-dir"],
			["broker-internal", "--agent-dir", ""],
			["broker-internal", "--agent-dir", "--help"],
			["broker-internal", "--agent-dir", "\u001b[31m/tmp/agent"],
			["broker-internal", "--agent-dir=/safe-fixture"],
			["broker-internal", "--agent-dir", "/safe-fixture", "--help"],
			["session-host-internal", "--help"],
			["private-secret-worker"],
		]) {
			const result = await child(
				dispatchSource(
					"sdk",
					argv,
					`setup:async()=>{throw new Error("runtime must remain inert")},load:async()=>{throw new Error("worker must not load")}`,
				),
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain('"category":"usage"');
			expect(result.stderr).not.toContain("private-secret-worker");
		}
	});
	it("keeps valid help and usage failures out of setup and command loading", async () => {
		for (const argv of [
			["session", "inspect", "--help", "--json"],
			["spawn", "--prompt", "--json"],
		]) {
			const result = await child(
				dispatchSource(
					"sdk",
					argv,
					`setup:async()=>{throw new Error("setup-secret")},load:async()=>{throw new Error("load-secret")}`,
				),
			);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(argv[0] === "spawn" ? 2 : 0);
			expect(JSON.parse(result.stdout).schema).toBe(argv[0] === "spawn" ? "gjc.command-error" : "gjc.command-help");
			expect(result.stdout).not.toContain("secret");
		}
	});

	it("catches setup, loader, and typed runtime failures once without secret echo", async () => {
		for (const hooks of [
			`setup:async()=>{throw new Error("setup-secret")},load:async()=>{throw new Error("unreachable")}`,
			`load:async()=>{throw new Error("loader-secret")}`,
			`load:async()=>class extends Command {async run(){throw new PublicCommandFailure({kind:"timeout",proof:"sent"})}}`,
		]) {
			const result = await child(dispatchSource("sdk", ["search", "--json"], hooks));
			expect(result.code).toBe(1);
			expect(result.stderr).toBe("");
			expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
			expect(JSON.parse(result.stdout).schema).toBe("gjc.command-error");
			expect(result.stdout).not.toContain("secret");
		}
	});

	it("preserves setup warnings and existing output on success", async () => {
		const setup = `setup:async report=>report({code:"macos_nofile_limit_low",successStderr:"original warning\\n"})`;
		const success = await child(
			dispatchSource(
				"sdk",
				["search", "--json"],
				`${setup},load:async()=>class extends Command {async run(){process.stdout.write("success")}}`,
			),
		);
		expect(success).toEqual({ code: 0, stdout: "success", stderr: "original warning\n" });
	});

	it("reports only static setup diagnostics on setup, load and runtime failures in both modes", async () => {
		const report = `report({code:"macos_nofile_limit_low",successStderr:"raw-warning-secret\\n"});`;
		for (const json of [false, true]) {
			for (const hooks of [
				`setup:async report=>{${report}throw new Error("setup-secret")},load:async()=>{throw new Error("unreachable")}`,
				`setup:async report=>{${report}},load:async()=>{throw new Error("loader-secret")}`,
				`setup:async report=>{${report}},load:async()=>class extends Command {async run(){throw new PublicCommandFailure({kind:"timeout",proof:"sent"})}}`,
			]) {
				const result = await child(dispatchSource("sdk", ["search", ...(json ? ["--json"] : [])], hooks));
				const output = json ? result.stdout : result.stderr;
				expect(result.code).toBe(1);
				expect(json ? result.stderr : result.stdout).toBe("");
				expect(output).not.toContain("secret");
				expect(output).toContain(PUBLIC_COMMAND_DIAGNOSTICS.macos_nofile_limit_low);
				expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
				if (json)
					expect(JSON.parse(output).diagnostics).toEqual([
						{ code: "macos_nofile_limit_low", message: PUBLIC_COMMAND_DIAGNOSTICS.macos_nofile_limit_low },
					]);
			}
		}
	});

	it("accounts for optional diagnostics at the output boundary without changing certainty or exit", async () => {
		for (const json of [false, true]) {
			let omitted = false;
			for (let length = 7000; length <= 8100; length += 20) {
				const result = await renderPublicCommandFailure(
					new PublicCommandFailure({
						kind: "timeout",
						proof: "sent",
						references: [{ kind: "operationRef", value: "r".repeat(length) }],
					}),
					{
						command: ["sdk", "session", "send"],
						json,
						diagnostics: ["macos_nofile_limit_low", "macos_nofile_limit_low"],
					},
				);
				expect(Buffer.byteLength(result.stdout || result.stderr)).toBeLessThanOrEqual(8192);
				expect(result.exitCode).toBe(1);
				expect(result.envelope.error.outcomeCertainty).toBe("unknown");
				if (!result.envelope.diagnostics) {
					expect(result.envelope.omittedOptional).toContainEqual({ path: "diagnostics", reason: "output_budget" });
					omitted = true;
				} else expect(result.envelope.diagnostics).toHaveLength(1);
			}
			expect(omitted).toBe(true);
		}
	});

	it("preserves successful output bytes and forwards JSON only to supporting operations", async () => {
		for (const [family, argv, expected] of [
			["sdk", ["search", "--json"], ["search", "--json"]],
			[
				"sdk",
				["spawn", "--cwd", ".", "--prompt", "task", "--json"],
				["spawn", "--cwd", ".", "--prompt", "task", "--json"],
			],
			["sdk", ["session", "inspect", "s", "--json"], ["session", "inspect", "s"]],
			["sdk", ["guides", "trust", "--json"], ["guides", "trust"]],
			["sdk", ["serve", "--stdio", "--json"], ["serve", "--stdio"]],
			["daemon", ["status", "--json", "--", "telegram"], ["status", "--json", "--", "telegram"]],
		] as const) {
			const result = await child(
				dispatchSource(
					family,
					[...argv],
					`load:async()=>class extends Command {async run(){if(JSON.stringify(this.argv)!==${JSON.stringify(JSON.stringify(expected))})throw new Error("argv mismatch");process.stdout.write("existing-success-bytes")}}`,
				),
			);
			expect(result).toEqual({ code: 0, stdout: "existing-success-bytes", stderr: "" });
		}
	});

	it("uses text stderr for failures and JSON stdout for invalid help traversal", async () => {
		const text = await child(dispatchSource("sdk", ["bad-secret"], `load:async()=>{throw new Error("unreachable")}`));
		expect(text.code).toBe(2);
		expect(text.stdout).toBe("");
		expect(text.stderr).not.toContain("bad-secret");
		expect(Buffer.byteLength(text.stderr)).toBeLessThanOrEqual(8192);
		const json = await child(
			dispatchSource(
				"sdk",
				["--help", "--help-page", "9999", "--json"],
				`load:async()=>{throw new Error("unreachable")}`,
			),
		);
		expect(json.code).toBe(2);
		expect(json.stderr).toBe("");
		expect(JSON.parse(json.stdout).error.category).toBe("usage");
	});

	it("retrieves retained evidence after publisher exit without operation loading and reports missing evidence explicitly", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "gjc-entry-evidence-"));
		try {
			const published = await child(`import {publishCommandEvidence} from ${JSON.stringify(evidence)};
const result=await publishCommandEvidence({agentDir:${JSON.stringify(agentDir)},command:["sdk","session","send"],error:{code:"uncertain_after_send",category:"uncertain",retryability:"unknown",outcomeCertainty:"unknown"},references:[{kind:"operationRef",value:"operation-safe"}]},{family:"sdk",scopeAgentDir:${JSON.stringify(agentDir)},json:true});console.log(JSON.stringify(result));`);
			const retained = JSON.parse(published.stdout);
			expect(retained.status).toBe("retained");
			const hooks = `setup:async()=>{throw new Error("setup forbidden")},load:async()=>{throw new Error("load forbidden")}`;
			const argv = retained.continuation.argv.slice(1) as string[];
			const found = await child(dispatchSource("sdk", argv, hooks));
			expect(found.code).toBe(0);
			expect(found.stderr).toBe("");
			expect(Buffer.byteLength(found.stdout)).toBeLessThanOrEqual(8192);
			expect(JSON.parse(found.stdout).schema).toBe("gjc.command-error-evidence");
			const text = await child(
				dispatchSource(
					"sdk",
					argv.filter(token => token !== "--json"),
					hooks,
				),
			);
			expect(text.code).toBe(0);
			expect(text.stderr).toBe("");
			expect(text.stdout).toContain("Fragment:");
			expect(Buffer.byteLength(text.stdout)).toBeLessThanOrEqual(8192);
			const missing = await child(dispatchSource("daemon", argv, hooks));
			expect(missing.code).toBe(1);
			expect(missing.stderr).toBe("");
			const failure = JSON.parse(missing.stdout);
			expect(failure.evidence.status).toBe("unavailable");
			expect(failure.complete).toBe(false);
			expect(failure.continuation).toBeNull();
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
