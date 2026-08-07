import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

interface ProbePaths {
	home: string;
	xdgState: string;
	customAgent: string;
	otherAgent: string;
}

interface ProbeOptions {
	home: string;
	env?: Record<string, string>;
	agentDir?: string;
}

const tempRoots: string[] = [];
const ISOLATED_ENV_KEYS = [
	"GJC_CONFIG_DIR",
	"PI_CONFIG_DIR",
	"GJC_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;

async function createProbePaths(): Promise<ProbePaths> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-root-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	return {
		home,
		xdgState: path.join(root, "xdg-state"),
		customAgent: path.join(root, "custom-agent"),
		otherAgent: path.join(root, "other-agent"),
	};
}

async function enableXdgState(paths: ProbePaths): Promise<void> {
	await fs.mkdir(path.join(paths.xdgState, "gjc"), { recursive: true });
}

async function runProbe(options: ProbeOptions): Promise<string> {
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) childEnv[key] = value;
	}
	childEnv.HOME = options.home;
	childEnv.USERPROFILE = options.home;
	for (const key of ISOLATED_ENV_KEYS) delete childEnv[key];
	if (options.env) Object.assign(childEnv, options.env);

	const modulePath = path.resolve(import.meta.dir, "../src/dirs.ts");
	const moduleUrl = url.pathToFileURL(modulePath).href;
	const argument = options.agentDir === undefined ? "" : JSON.stringify(options.agentDir);
	const source = `import { getMemoryRootDir } from ${JSON.stringify(moduleUrl)};
const root = getMemoryRootDir(${argument});
console.log(JSON.stringify(root));
`;

	const proc = Bun.spawn([process.execPath, "-e", source], {
		cwd: options.home,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`memory-root probe failed (${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return JSON.parse(stdout.trim()) as string;
}

function slashPath(value: string): string {
	return value.replaceAll("\\", "/");
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("memory root directory", () => {
	it("uses the default config root for the default profile", async () => {
		const paths = await createProbePaths();
		expect(await runProbe({ home: paths.home })).toBe(path.join(paths.home, ".gjc", "memory"));
	});

	it("uses the default config root when an explicit argument matches the default agent dir", async () => {
		const paths = await createProbePaths();
		const defaultAgent = path.join(paths.home, ".gjc", "agent");
		expect(await runProbe({ home: paths.home, agentDir: defaultAgent })).toBe(
			path.join(paths.home, ".gjc", "memory"),
		);
	});

	it("honors a custom config directory for the default profile", async () => {
		const paths = await createProbePaths();
		expect(await runProbe({ home: paths.home, env: { GJC_CONFIG_DIR: ".gjc-memory-test" } })).toBe(
			path.join(paths.home, ".gjc-memory-test", "memory"),
		);
	});

	it("uses the process-global custom agent dir for a zero-argument lookup", async () => {
		const paths = await createProbePaths();
		expect(await runProbe({ home: paths.home, env: { GJC_CODING_AGENT_DIR: paths.customAgent } })).toBe(
			path.join(paths.customAgent, "memory"),
		);
	});

	it("keeps a matching explicit argument on the process-global custom profile", async () => {
		const paths = await createProbePaths();
		expect(
			await runProbe({
				home: paths.home,
				env: { GJC_CODING_AGENT_DIR: paths.customAgent },
				agentDir: paths.customAgent,
			}),
		).toBe(path.join(paths.customAgent, "memory"));
	});

	it("uses a differing explicit dir instead of the process-global custom profile", async () => {
		const paths = await createProbePaths();
		expect(
			await runProbe({
				home: paths.home,
				env: { GJC_CODING_AGENT_DIR: paths.customAgent },
				agentDir: paths.otherAgent,
			}),
		).toBe(path.join(paths.otherAgent, "memory"));
	});

	it("uses XDG state for the default profile when the XDG target exists", async () => {
		const paths = await createProbePaths();
		await enableXdgState(paths);
		const expected =
			process.platform === "win32"
				? path.join(paths.home, ".gjc", "memory")
				: path.join(paths.xdgState, "gjc", "memory");
		expect(await runProbe({ home: paths.home, env: { XDG_STATE_HOME: paths.xdgState } })).toBe(expected);
	});

	it("keeps a custom resolver profile out of XDG state", async () => {
		const paths = await createProbePaths();
		await enableXdgState(paths);
		expect(
			await runProbe({
				home: paths.home,
				env: {
					GJC_CODING_AGENT_DIR: paths.customAgent,
					XDG_STATE_HOME: paths.xdgState,
				},
			}),
		).toBe(path.join(paths.customAgent, "memory"));
	});

	it("keeps an explicit custom profile out of XDG state", async () => {
		const paths = await createProbePaths();
		await enableXdgState(paths);
		expect(
			await runProbe({
				home: paths.home,
				env: { XDG_STATE_HOME: paths.xdgState },
				agentDir: paths.customAgent,
			}),
		).toBe(path.join(paths.customAgent, "memory"));
	});

	it("does not redirect the default profile to XDG state on Windows", async () => {
		if (process.platform !== "win32") return;
		const paths = await createProbePaths();
		await enableXdgState(paths);
		const root = await runProbe({
			home: paths.home,
			env: { XDG_STATE_HOME: paths.xdgState },
		});
		expect(slashPath(root)).toBe(slashPath(path.join(paths.home, ".gjc", "memory")));
	});
});
