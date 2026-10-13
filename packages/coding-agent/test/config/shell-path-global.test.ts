import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";
import { YAML } from "bun";
import { Settings } from "../../src/config/settings";

/**
 * `Settings.getShellConfig()` is the shell bash and the Python executor spawn.
 * Project `.gjc/settings.json` merges over the user config for `get()`, so a
 * repository `shellPath` must not be the path that resolution returns.
 */

const tempDirs: string[] = [];

afterEach(async () => {
	resetShellConfigCache();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function layout(): Promise<{
	projectDir: string;
	agentDir: string;
	planted: string;
	marker: string;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-shell-path-"));
	tempDirs.push(root);
	const projectDir = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const planted = path.join(projectDir, "planted-shell");
	const marker = path.join(root, "planted-ran");
	await Bun.write(planted, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\n`);
	await fs.chmod(planted, 0o755);
	return { projectDir, agentDir, planted, marker };
}

async function writeProjectShell(projectDir: string, shellPath: string): Promise<void> {
	await Bun.write(path.join(projectDir, ".gjc", "settings.json"), JSON.stringify({ shellPath }));
}

async function writeUserShell(agentDir: string): Promise<string> {
	const trusted = path.join(agentDir, "trusted-shell");
	await Bun.write(trusted, "");
	await Bun.write(path.join(agentDir, "config.yml"), `${YAML.stringify({ shellPath: trusted })}\n`);
	return trusted;
}

describe("Settings.getShellConfig shellPath trust", () => {
	it("does not select a shellPath planted in the project settings file", async () => {
		const { projectDir, agentDir, planted, marker } = await layout();
		await writeProjectShell(projectDir, planted);
		const settings = await Settings.loadReadonly({ cwd: projectDir, agentDir });

		resetShellConfigCache();
		let resolved: string;
		try {
			resolved = settings.getShellConfig().shell;
		} finally {
			resetShellConfigCache();
		}

		expect(settings.get("shellPath")).toBe(planted);
		expect(resolved).not.toBe(planted);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("still selects a shellPath from the user settings file", async () => {
		const { projectDir, agentDir, planted, marker } = await layout();
		const trusted = await writeUserShell(agentDir);
		await writeProjectShell(projectDir, planted);
		const settings = await Settings.loadReadonly({ cwd: projectDir, agentDir });

		resetShellConfigCache();
		let resolved: string;
		try {
			resolved = settings.getShellConfig().shell;
		} finally {
			resetShellConfigCache();
		}

		expect(settings.get("shellPath")).toBe(planted);
		expect(settings.getGlobal("shellPath")).toBe(trusted);
		expect(resolved).toBe(trusted);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("selects a user shellPath when the project sets none", async () => {
		const { projectDir, agentDir, marker } = await layout();
		const trusted = await writeUserShell(agentDir);
		const settings = await Settings.loadReadonly({ cwd: projectDir, agentDir });

		resetShellConfigCache();
		let resolved: string;
		try {
			resolved = settings.getShellConfig().shell;
		} finally {
			resetShellConfigCache();
		}

		expect(resolved).toBe(trusted);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("does not select a runtime shellPath override", async () => {
		const { projectDir, agentDir, planted, marker } = await layout();
		const trusted = await writeUserShell(agentDir);
		const settings = await Settings.loadReadonly({ cwd: projectDir, agentDir });
		settings.override("shellPath", planted);

		resetShellConfigCache();
		let resolved: string;
		try {
			resolved = settings.getShellConfig().shell;
		} finally {
			resetShellConfigCache();
		}

		expect(settings.get("shellPath")).toBe(planted);
		expect(resolved).toBe(trusted);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});
