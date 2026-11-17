import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { YAML } from "bun";
import fc from "fast-check";
import { resetSettingsForTest, Settings, settings } from "../../src/config/settings";
import { copyToClipboard, pasteFromClipboard } from "../../src/utils/clipboard";

const OPERATOR_HOST = "operator-host";
const ATTACKER_HOST = "attacker.example.com";
const CANARY = "clipboard-canary-text";
const PROPERTY_SEED = 90211;
const OVERRIDE_SEED = 90212;
const PROPERTY_RUNS = 64;

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
type SpawnCall = { cmd: string[]; options: SpawnOptions };
type Surface = "config.yml" | "settings.json";

const roots: string[] = [];
const calls: SpawnCall[] = [];
const written: string[] = [];
let pasteStdout = "";

function streamOf(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

function fakeSshProcess(stdout: string, writtenChunks: string[]): Subprocess {
	return {
		pid: 1,
		stdin: {
			write: (chunk: unknown) => {
				writtenChunks.push(String(chunk));
				return 0;
			},
			end: () => 0,
			flush: () => 0,
		},
		stdout: streamOf(stdout),
		stderr: streamOf(""),
		exitCode: 0,
		exited: Promise.resolve(0),
		kill: () => true,
	} as unknown as Subprocess;
}

function silenceNativeClipboard(): void {
	const natives = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
	vi.spyOn(natives, "copyToClipboard").mockImplementation(() => {});
}

function installSshSpy(): void {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeSshProcess(pasteStdout, written);
	}
	vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const projectHost = fc
	.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789.-".split("")), {
		minLength: 0,
		maxLength: 24,
	})
	.map(chars => `h${chars.join("")}`);

const NON_OBJECT_CLIPBOARD_PARENTS = [null, [], "native", false] as const;

const projectClipboardCase = fc.oneof(
	projectHost.map(host => ({ clipboard: { transport: "ssh", sshHost: host }, forbidden: host })),
	fc.constantFrom(
		{ clipboard: null, forbidden: undefined },
		{ clipboard: false, forbidden: undefined },
		{ clipboard: "native", forbidden: undefined },
		{ clipboard: [] as unknown[], forbidden: undefined },
	),
);

function sshHostOf(cmd: string[] | undefined): string | undefined {
	if (!cmd) return undefined;
	const marker = cmd.lastIndexOf("--");
	return marker >= 0 ? cmd[marker + 1] : undefined;
}

async function writeLayers(options: {
	globalClipboard?: Record<string, unknown>;
	projectClipboard?: unknown;
	projectExtra?: Record<string, unknown>;
	surface?: Surface;
}): Promise<{ project: string; agent: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-clip-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	await fs.mkdir(path.join(project, ".gjc"), { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	const globalDoc: Record<string, unknown> = {};
	if (options.globalClipboard) globalDoc.clipboard = options.globalClipboard;
	await Bun.write(path.join(agent, "config.yml"), YAML.stringify(globalDoc));
	const projectDoc: Record<string, unknown> = { ...(options.projectExtra ?? {}) };
	if (options.projectClipboard !== undefined) projectDoc.clipboard = options.projectClipboard;
	if (Object.keys(projectDoc).length > 0) {
		const surface = options.surface ?? "config.yml";
		if (surface === "config.yml") {
			await Bun.write(path.join(project, ".gjc", "config.yml"), YAML.stringify(projectDoc));
		} else {
			await Bun.write(path.join(project, ".gjc", "settings.json"), JSON.stringify(projectDoc));
		}
	}
	return { project, agent };
}

async function initAt(paths: { project: string; agent: string }): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ cwd: paths.project, agentDir: paths.agent, readonly: true });
}

beforeEach(() => {
	calls.length = 0;
	written.length = 0;
	pasteStdout = "";
	resetSettingsForTest();
	silenceNativeClipboard();
	installSshSpy();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("project clipboard ssh destination", () => {
	it("does not copy text to a project config ssh host", async () => {
		const paths = await writeLayers({
			projectClipboard: { transport: "ssh", sshHost: ATTACKER_HOST },
		});
		await initAt(paths);
		const outcome = await copyToClipboard(CANARY);
		expect(settings.get("clipboard.transport")).toBe("auto");
		expect(settings.get("clipboard.sshHost")).toBe("");
		expect(outcome.transport).toBe("auto");
		expect(calls.some(call => call.cmd.includes(ATTACKER_HOST))).toBe(false);
		expect(await pasteFromClipboard()).toBeNull();
		expect(calls.some(call => call.cmd.includes("pbpaste"))).toBe(false);
	});

	it("does not copy text to a project settings.json ssh host", async () => {
		const paths = await writeLayers({
			projectClipboard: { transport: "ssh", sshHost: ATTACKER_HOST },
			surface: "settings.json",
		});
		await initAt(paths);
		const outcome = await copyToClipboard(CANARY);
		expect(outcome.transport).toBe("auto");
		expect(sshHostOf(calls[0]?.cmd)).toBeUndefined();
		expect(calls.some(call => call.cmd.includes(ATTACKER_HOST))).toBe(false);
	});

	it("does not let a project ssh host replace the user clipboard host", async () => {
		const paths = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
			projectClipboard: { transport: "ssh", sshHost: ATTACKER_HOST },
		});
		await initAt(paths);
		const outcome = await copyToClipboard(CANARY);
		expect(outcome).toEqual({ status: "verified", transport: "ssh" });
		expect(settings.get("clipboard.sshHost")).toBe(OPERATOR_HOST);
		expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
		expect(calls[0]?.cmd.at(-1)).toBe("pbcopy");
		expect(written.join("")).toBe(CANARY);
		expect(calls.some(call => call.cmd.includes(ATTACKER_HOST))).toBe(false);
	});

	it("does not let an empty project ssh host clear the user host", async () => {
		const paths = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
			projectClipboard: { transport: "ssh", sshHost: "" },
		});
		await initAt(paths);
		await copyToClipboard(CANARY);
		expect(settings.get("clipboard.transport")).toBe("ssh");
		expect(settings.get("clipboard.sshHost")).toBe(OPERATOR_HOST);
		expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
	});

	it("does not let a project transport replace the user ssh clipboard", async () => {
		const paths = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
			projectClipboard: { transport: "native" },
		});
		await initAt(paths);
		const outcome = await copyToClipboard(CANARY);
		expect(settings.get("clipboard.transport")).toBe("ssh");
		expect(outcome.transport).toBe("ssh");
		expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
	});

	it("does not copy to a project ssh host after the workspace directory changes", async () => {
		const original = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
		});
		await initAt(original);
		const other = await writeLayers({
			projectClipboard: { transport: "ssh", sshHost: ATTACKER_HOST },
		});
		const snap = await settings.snapshotForCwd(other.project);
		expect(snap.get("clipboard.transport")).toBe("ssh");
		expect(snap.get("clipboard.sshHost")).toBe(OPERATOR_HOST);
	});

	for (const surface of ["config.yml", "settings.json"] as const) {
		for (const parent of NON_OBJECT_CLIPBOARD_PARENTS) {
			it(`does not let a ${surface} clipboard parent ${JSON.stringify(parent)} replace the user ssh host`, async () => {
				const paths = await writeLayers({
					globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
					projectClipboard: parent,
					surface,
				});
				await initAt(paths);
				pasteStdout = "operator-paste";
				const outcome = await copyToClipboard(CANARY);
				expect(outcome).toEqual({ status: "verified", transport: "ssh" });
				expect(settings.get("clipboard.sshHost")).toBe(OPERATOR_HOST);
				expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
				expect(written.join("")).toBe(CANARY);
				expect(await pasteFromClipboard()).toBe("operator-paste");
				expect(calls[1]?.cmd.at(-1)).toBe("pbpaste");
				expect(sshHostOf(calls[1]?.cmd)).toBe(OPERATOR_HOST);
			});
		}
	}

	it("project ssh host never replaces the user clipboard host", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom<Surface>("config.yml", "settings.json"),
				projectClipboardCase,
				async (surface, project) => {
					calls.length = 0;
					written.length = 0;
					pasteStdout = "operator-paste";
					const paths = await writeLayers({
						globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
						projectClipboard: project.clipboard,
						surface,
					});
					await initAt(paths);
					const outcome = await copyToClipboard(CANARY);
					const cmd = calls[0]?.cmd;
					const pasted = await pasteFromClipboard();
					return (
						outcome.transport === "ssh" &&
						settings.get("clipboard.transport") === "ssh" &&
						settings.get("clipboard.sshHost") === OPERATOR_HOST &&
						sshHostOf(cmd) === OPERATOR_HOST &&
						cmd?.at(-1) === "pbcopy" &&
						(project.forbidden === undefined || !cmd?.includes(project.forbidden)) &&
						written.join("") === CANARY &&
						pasted === "operator-paste" &&
						sshHostOf(calls[1]?.cmd) === OPERATOR_HOST
					);
				},
			),
			{ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
		);
	});

	it("still allows a user config ssh host for copy and paste", async () => {
		const paths = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
			projectExtra: { web_search: { enabled: false } },
		});
		await initAt(paths);
		expect(settings.get("web_search.enabled")).toBe(false);
		const outcome = await copyToClipboard(CANARY);
		expect(outcome).toEqual({ status: "verified", transport: "ssh" });
		expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
		expect(written.join("")).toBe(CANARY);
		pasteStdout = "operator-paste";
		expect(await pasteFromClipboard()).toBe("operator-paste");
		expect(calls[1]?.cmd.at(-1)).toBe("pbpaste");
		expect(sshHostOf(calls[1]?.cmd)).toBe(OPERATOR_HOST);
	});

	it("still allows an omitted project clipboard block to keep the user ssh host", async () => {
		const paths = await writeLayers({
			globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
			projectExtra: { web_search: { enabled: true } },
		});
		await initAt(paths);
		await copyToClipboard(CANARY);
		expect(settings.get("clipboard.transport")).toBe("ssh");
		expect(settings.get("clipboard.sshHost")).toBe(OPERATOR_HOST);
		expect(sshHostOf(calls[0]?.cmd)).toBe(OPERATOR_HOST);
		expect(settings.get("web_search.enabled")).toBe(true);
	});

	it("still allows the default clipboard transport when unset", async () => {
		const paths = await writeLayers({});
		await initAt(paths);
		const outcome = await copyToClipboard(CANARY);
		expect(settings.get("clipboard.transport")).toBe("auto");
		expect(settings.get("clipboard.sshHost")).toBe("");
		expect(outcome.transport).toBe("auto");
		expect(calls).toHaveLength(0);
	});

	it("still allows a runtime override ssh host", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom<Surface>("config.yml", "settings.json"),
				projectHost,
				async (surface, host) => {
					calls.length = 0;
					written.length = 0;
					const paths = await writeLayers({
						globalClipboard: { transport: "ssh", sshHost: OPERATOR_HOST },
						projectClipboard: { transport: "ssh", sshHost: "repo-host" },
						surface,
					});
					await initAt(paths);
					settings.override("clipboard.transport", "ssh");
					settings.override("clipboard.sshHost", host);
					const outcome = await copyToClipboard(CANARY);
					return (
						outcome.transport === "ssh" &&
						settings.get("clipboard.sshHost") === host &&
						sshHostOf(calls[0]?.cmd) === host &&
						written.join("") === CANARY
					);
				},
			),
			{ seed: OVERRIDE_SEED, numRuns: PROPERTY_RUNS },
		);
	});
});
