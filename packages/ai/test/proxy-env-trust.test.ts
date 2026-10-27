import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Bun autoloads cwd/.env into process.env before getProxyForUrl runs. A project
 * declaration of a proxy selector must not become the tunnel URL. A value
 * inherited from the launching shell, including one that differs from the
 * project declaration, stays in use.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "proxy-env-trust-probe.ts");
const STARTUP_PRELOAD = path.join(import.meta.dir, "fixtures", "proxy-env-trust-startup-preload.ts");
const PROXY_KEYS = [
	"PI_PROXY",
	"PI_PROXY_ANTHROPIC",
	"PI_PROXY_CURSOR",
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

const PROJECT = "http://project.proxy:8080";
const SHELL = "http://shell.proxy:8080";
const tempDirs: string[] = [];

interface ProxySelectionCase {
	provider: string;
	envName: string;
	runtime: string;
}

interface ProbeOptions {
	inherited?: Record<string, string>;
	worktreeCwd?: string;
}

function tempDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-proxy-env-trust-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function selectedProxy(
	cwd: string,
	options: ProbeOptions & { provider?: string; target?: string } = {},
): Promise<string | null> {
	const stdout = await runProbe(
		cwd,
		[options.provider ?? "anthropic", options.target ?? "https://api.example.com/v1"],
		options,
	);
	return (JSON.parse(stdout) as { proxy: string | null }).proxy;
}

async function selectedProxies(
	cwd: string,
	cases: ProxySelectionCase[],
	options: ProbeOptions = {},
): Promise<(string | null)[]> {
	const stdout = await runProbe(cwd, ["--cases", JSON.stringify(cases)], options);
	return (JSON.parse(stdout) as { proxies: (string | null)[] }).proxies;
}

async function runProbe(cwd: string, args: string[], options: ProbeOptions): Promise<string> {
	const command = [process.execPath];
	if (options.worktreeCwd) command.push("--preload", STARTUP_PRELOAD);
	command.push(PROBE, ...args);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("PI_PROXY")) env[key] = value;
	}
	for (const key of PROXY_KEYS) delete env[key];
	if (options.inherited) Object.assign(env, options.inherited);
	if (options.worktreeCwd) env.GJC_PROXY_TRUST_TEST_WORKTREE_CWD = options.worktreeCwd;
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return stdout.trim();
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function generatedToken(random: () => number): string {
	return Math.floor(random() * 0x1_0000_0000)
		.toString(36)
		.padStart(7, "0");
}

describe("getProxyForUrl project dotenv", () => {
	it("ignores PI_PROXY when only the project dotenv sets it", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY=${PROJECT}\n`))).toBeNull();
	});

	it("ignores PI_PROXY_ANTHROPIC when only the project dotenv sets it", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY_ANTHROPIC=${PROJECT}\n`))).toBeNull();
	});

	it("ignores HTTPS_PROXY when only the project dotenv sets it", async () => {
		expect(await selectedProxy(tempDir(`HTTPS_PROXY=${PROJECT}\n`))).toBeNull();
	});

	it("ignores https_proxy when only the project dotenv sets it", async () => {
		expect(await selectedProxy(tempDir(`https_proxy=${PROJECT}\n`))).toBeNull();
	});

	it("ignores ALL_PROXY when only the project dotenv sets it", async () => {
		expect(await selectedProxy(tempDir(`ALL_PROXY=${PROJECT}\n`))).toBeNull();
	});

	it("ignores HTTP_PROXY when only the project dotenv sets it", async () => {
		expect(
			await selectedProxy(tempDir(`HTTP_PROXY=${PROJECT}\n`), {
				target: "http://api.example.com/v1",
			}),
		).toBeNull();
	});

	it("ignores a dynamic project dotenv PI_PROXY", async () => {
		expect(await selectedProxy(tempDir(`TARGET=${PROJECT}\nPI_PROXY=$TARGET\n`))).toBeNull();
	});

	it("ignores PI_PROXY when the shell value equals the project declaration", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY=${PROJECT}\n`), { inherited: { PI_PROXY: PROJECT } })).toBeNull();
	});

	it("keeps a PI_PROXY inherited from the launching shell", async () => {
		expect(await selectedProxy(tempDir(), { inherited: { PI_PROXY: SHELL } })).toBe(SHELL);
	});

	it("keeps an HTTPS_PROXY inherited from the launching shell", async () => {
		expect(await selectedProxy(tempDir(), { inherited: { HTTPS_PROXY: SHELL } })).toBe(SHELL);
	});

	it("keeps a shell PI_PROXY when the project dotenv declares a different comparable value", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY=${PROJECT}\n`), { inherited: { PI_PROXY: SHELL } })).toBe(SHELL);
	});

	it("ignores a different shell PI_PROXY when the project declaration is dynamic", async () => {
		expect(
			await selectedProxy(tempDir(`TARGET=${PROJECT}\nPI_PROXY=$TARGET\n`), { inherited: { PI_PROXY: SHELL } }),
		).toBeNull();
	});

	it("ignores a different shell PI_PROXY when the project declaration has quoted inner whitespace", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY=" ${PROJECT} "\n`), { inherited: { PI_PROXY: SHELL } })).toBeNull();
	});

	it("selects the shell HTTPS_PROXY when the project dotenv sets PI_PROXY", async () => {
		expect(await selectedProxy(tempDir(`PI_PROXY=${PROJECT}\n`), { inherited: { HTTPS_PROXY: SHELL } })).toBe(SHELL);
	});

	it("uses startup dotenv provenance when first selecting a proxy after a worktree cwd change", async () => {
		const project = tempDir(`PI_PROXY=${PROJECT}\n`);
		const worktree = tempDir();
		expect(
			await selectedProxy(project, {
				inherited: { HTTPS_PROXY: SHELL },
				worktreeCwd: worktree,
			}),
		).toBe(SHELL);
	});

	it("preserves proxy provenance invariants for seeded generated declarations", async () => {
		const random = seededRandom(0x6833);
		const declarations: string[] = [];
		const cases: ProxySelectionCase[] = [];
		const expected: string[] = [];
		const fallback = "http://fallback.proxy:8080";

		for (let index = 0; index < 16; index++) {
			const dynamicProvider = `property_dynamic_${index}`;
			const dynamicKey = `PI_PROXY_${dynamicProvider.toUpperCase()}`;
			declarations.push(`${dynamicKey}=$GJC_PROXY_DYNAMIC_TARGET_${index}`);
			cases.push({
				provider: dynamicProvider,
				envName: dynamicKey,
				runtime: `http://shell-dynamic-${index}-${generatedToken(random)}.proxy:8080`,
			});
			expected.push(fallback);

			const exactProvider = `property_exact_${index}`;
			const exactKey = `PI_PROXY_${exactProvider.toUpperCase()}`;
			const exactDeclaration = `http://project-exact-${index}-${generatedToken(random)}.proxy:8080`;
			declarations.push(`${exactKey}=${exactDeclaration}`);
			cases.push({ provider: exactProvider, envName: exactKey, runtime: exactDeclaration });
			expected.push(fallback);

			const paddedProvider = `property_padded_${index}`;
			const paddedKey = `PI_PROXY_${paddedProvider.toUpperCase()}`;
			const paddedDeclaration = `http://project-padded-${index}-${generatedToken(random)}.proxy:8080`;
			declarations.push(`${paddedKey}=${paddedDeclaration}`);
			cases.push({ provider: paddedProvider, envName: paddedKey, runtime: ` \t${paddedDeclaration} \t` });
			expected.push(fallback);

			const distinctProvider = `property_distinct_${index}`;
			const distinctKey = `PI_PROXY_${distinctProvider.toUpperCase()}`;
			const distinctDeclaration = `http://project-distinct-${index}-${generatedToken(random)}.proxy:8080`;
			const shellValue = `http://shell-distinct-${index}-${generatedToken(random)}.proxy:8080`;
			declarations.push(`${distinctKey}=${distinctDeclaration}`);
			cases.push({ provider: distinctProvider, envName: distinctKey, runtime: shellValue });
			expected.push(shellValue);
		}

		expect(
			await selectedProxies(tempDir(`${declarations.join("\n")}\n`), cases, {
				inherited: { HTTPS_PROXY: fallback },
			}),
		).toEqual(expected);
	});
});
