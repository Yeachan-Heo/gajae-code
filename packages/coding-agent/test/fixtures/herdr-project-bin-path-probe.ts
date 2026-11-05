/**
 * Public-entry probe. Started with cwd set to a fixture that has a project
 * dotenv, so Bun and the env snapshot load that file before this script runs.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import type { Args } from "../../src/cli/args";
import { Settings } from "../../src/config/settings";
import { runRootCommand } from "../../src/main";
import { AuthStorage } from "../../src/session/auth-storage";

const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!bundledModel) {
	process.stderr.write("missing bundled model\n");
	process.exit(2);
}

const mode = process.argv[2];
if (mode !== "attack" && mode !== "allow") {
	process.stderr.write("usage: herdr-project-bin-path-probe.ts attack|allow\n");
	process.exit(2);
}

function rootArgs(): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
		mode: "text",
	};
}

function markerReady(file: string): boolean {
	const started = Date.now();
	while (Date.now() - started < 1500) {
		if (fs.existsSync(file)) return true;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	return fs.existsSync(file);
}

const cwd = process.cwd();
const payloadMarker = path.join(cwd, "payload-ran");
const allowMarker = path.join(cwd, "allow-ran");
const agentDir = fs.mkdtempSync(path.join(cwd, "agent-"));
const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));

try {
	await runRootCommand(rootArgs(), [], {
		createAgentSession: async () => {
			let activeModel = bundledModel;
			return {
				session: {
					sessionId: "herdr-bin-path-probe",
					get model() {
						return activeModel;
					},
					extensionRunner: undefined,
					getConfiguredModelChain: () => undefined,
					hasRecoveredDefaultFallbackChain: () => false,
					setConfiguredModelChain: () => {},
					seedDefaultFallbackResolution: () => {},
					setModelTemporary: async (model: typeof bundledModel) => {
						activeModel = model;
					},
					setUnavailableModelProfile: () => {},
					getUnavailableModelProfile: () => undefined,
					subscribe: () => () => {},
					dispose: async () => {},
				},
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		},
		discoverAuthStorage: async () => authStorage,
		settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": true }),
		suppressProcessExit: true,
		startupUpdate: { check: async () => undefined },
		initTheme: async () => {},
		readPipedInput: async () => undefined,
		runStartupCredentialAutoImportIfNeeded: async () => undefined,
		runPrintMode: async () => {},
		quit: async () => {},
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
} finally {
	try {
		authStorage.close();
	} catch {
		// runRootCommand already closes this storage on the print path.
	}
}

const payload = markerReady(payloadMarker);
const allowed = mode === "allow" ? markerReady(allowMarker) : fs.existsSync(allowMarker);
const child = spawnSync("/bin/sh", ["-c", 'printf %s "$HERDR_BIN_PATH"'], {
	env: process.env,
	encoding: "utf8",
});
if (child.status !== 0) {
	process.stderr.write(child.stderr ?? "child env probe failed\n");
	process.exit(1);
}
process.stdout.write(
	`RESULT payload=${payload ? 1 : 0} allowed=${allowed ? 1 : 0} child=${JSON.stringify(child.stdout ?? "")}\n`,
);
