import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	type DesktopSetting,
	parseRequest,
} from "../src/protocol";

let environment: NodeJS.ProcessEnv;
let agentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	environment = { ...process.env };
	agentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
});
afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(agentDir);
	}
});

async function launch() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-scope-"));
	const dataDir = path.join(directory, "app");
	await setModelPresetRegistryDisabled({ agentDir: path.join(dataDir, "agent"), disabled: true });
	const frames: DesktopFrame[] = [];
	const captures: CreateAgentSessionOptions[] = [];
	const host = new DesktopHost({
		dataDir,
		emit: frame => frames.push(frame),
		createSession: async options => {
			captures.push(options);
			return createAgentSession(options);
		},
	});
	cleanups.push(async () => {
		await host.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const response = frames.find(frame => frame.type === "response" && frame.id === id);
		if (!response || response.type !== "response") throw new Error("Missing response");
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const open = async (name: string, enabled: boolean) => {
		const projectPath = path.join(directory, name);
		await Bun.write(path.join(projectPath, ".gjc", "config.yml"), `retry:\n  enabled: ${enabled}\n`);
		const project = await call<DesktopProject>("project.open", { path: projectPath });
		return call<DesktopSession>("session.create", { projectId: project.id });
	};
	return { call, open, captures };
}

test("resolves selected-project settings rather than the desktop catalog directory", async () => {
	const { call, open, captures } = await launch();
	const first = await open("first-project", false);
	const second = await open("second-project", true);
	const firstSettings = await call<DesktopSetting[]>("settings.get", { sessionId: first.id });
	const secondSettings = await call<DesktopSetting[]>("settings.get", { sessionId: second.id });
	expect(firstSettings.find(setting => setting.path === "retry.enabled")?.value).toBe(false);
	expect(secondSettings.find(setting => setting.path === "retry.enabled")?.value).toBe(true);
	expect(captures[0]?.settings?.get("retry.enabled")).toBe(false);
	expect(captures[1]?.settings?.get("retry.enabled")).toBe(true);
	expect(captures[0]?.modelRegistry).not.toBe(captures[1]?.modelRegistry);
});

test("keeps each conversation and its children in an independent SDK agent registry", async () => {
	const { open, captures } = await launch();
	await open("first-project", true);
	await open("second-project", true);
	const first = captures[0]?.agentRegistry;
	const second = captures[1]?.agentRegistry;
	expect(first).toBeDefined();
	expect(second).toBeDefined();
	expect(first).not.toBe(second);
	expect(first?.get("0-Main")?.session).not.toBe(second?.get("0-Main")?.session);
	expect(first?.listVisibleTo("0-Main")).toEqual([]);
	expect(second?.listVisibleTo("0-Main")).toEqual([]);
});
