import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { resetAgentDirFromEnvironment } from "@gajae-code/utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const PROBE_NAME = "ooo-probe";
const HANDLED_TEXT = "ooo bridge intercepted";

/**
 * A filesystem extension module whose `input` handler claims the `ooo` prefix
 * exactly like the documented Ouroboros bridge (`docs/ooo-bridge-extension-contract.md`).
 * If session startup loads it, `ooo status` never reaches the model.
 */
const PROBE_MODULE = `
export default function activate(gjc) {
	gjc.on("input", async event => {
		if (event.text !== "ooo status") return {};
		return { handled: true, text: ${JSON.stringify(HANDLED_TEXT)} };
	});
}
`;

describe("issue #5497: session startup loads filesystem extension modules", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let projectGlobalAgentDir = "";
	let sessionAgentDir = "";
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalPiAgentDir: string | undefined;

	const installProbe = (extensionsRoot: string = sessionAgentDir): string => {
		const probeDir = path.join(extensionsRoot, "extensions", PROBE_NAME);
		fs.mkdirSync(probeDir, { recursive: true });
		const entry = path.join(probeDir, "index.ts");
		fs.writeFileSync(entry, PROBE_MODULE);
		return entry;
	};

	beforeEach(() => {
		// Fixtures stay under an explicit /tmp root (not TMPDIR) so a TMPDIR inside the
		// developer HOME can never place project fixtures under a discovered ancestor.
		tempDir = fs.mkdtempSync(path.join(path.sep, "tmp", "gjc-5497-"));
		tempHomeDir = fs.mkdtempSync(path.join(path.sep, "tmp", "gjc-5497-home-"));
		originalHome = process.env.HOME;
		originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
		originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		// Process-global user scope stays on the default profile; the session under
		// test selects a DIFFERENT agent directory below.
		projectGlobalAgentDir = path.join(tempHomeDir, ".gjc", "agent");
		fs.mkdirSync(projectGlobalAgentDir, { recursive: true });
		process.env.GJC_CODING_AGENT_DIR = projectGlobalAgentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		resetAgentDirFromEnvironment();
		sessionAgentDir = path.join(tempHomeDir, ".gjc", "profile-agent");
		fs.mkdirSync(sessionAgentDir, { recursive: true });
		clearCache();
	});

	afterEach(() => {
		cleanupTempHome(() => ({
			tempDir,
			tempHomeDir,
			originalHome,
			originalAgentDir,
			originalPiAgentDir,
		}))();
		clearCache();
		vi.restoreAllMocks();
	});

	const createSession = async (options: {
		disableExtensionDiscovery?: boolean;
		additionalExtensionPaths?: string[];
		settingsOverrides?: Parameters<typeof Settings.isolated>[0];
	}) =>
		await createAgentSession({
			cwd: tempDir,
			agentDir: sessionAgentDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(options.settingsOverrides ?? {}),
			disableExtensionDiscovery: options.disableExtensionDiscovery,
			additionalExtensionPaths: options.additionalExtensionPaths,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

	it("registers the module's input handler and lets it claim intercepted input", async () => {
		const entry = installProbe();
		const { session, extensionsResult } = await createSession({});

		try {
			expect(extensionsResult.extensions.map(extension => extension.resolvedPath)).toContain(entry);

			const runner = session.extensionRunner;
			expect(runner).toBeDefined();
			expect(runner?.hasHandlers("input")).toBe(true);

			await expect(runner?.emitInput("ooo status", undefined, "interactive")).resolves.toEqual({
				handled: true,
				text: HANDLED_TEXT,
			});
			const passthrough = await runner?.emitInput("hello there", undefined, "interactive");
			expect(passthrough?.handled).not.toBe(true);
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("honors disableExtensionDiscovery while still loading explicit paths", async () => {
		const entry = installProbe();
		const { session: disabledSession, extensionsResult: disabledResult } = await createSession({
			disableExtensionDiscovery: true,
		});
		try {
			expect(disabledResult.extensions.map(extension => extension.resolvedPath)).not.toContain(entry);
			expect(disabledSession.extensionRunner?.hasHandlers("input")).not.toBe(true);
		} finally {
			await disabledSession.dispose();
		}

		const { session: explicitSession, extensionsResult: explicitResult } = await createSession({
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [entry],
		});
		try {
			expect(explicitResult.extensions.map(extension => extension.resolvedPath)).toContain(entry);
			await expect(
				explicitSession.extensionRunner?.emitInput("ooo status", undefined, "interactive"),
			).resolves.toEqual({ handled: true, text: HANDLED_TEXT });
		} finally {
			await explicitSession.dispose();
		}
	}, 30_000);

	it("applies the extensions and disabledExtensions settings", async () => {
		// A path outside every discovery directory: only the `extensions` setting can load it.
		const configuredDir = path.join(tempDir, "configured", PROBE_NAME);
		fs.mkdirSync(configuredDir, { recursive: true });
		const configuredEntry = path.join(configuredDir, "index.ts");
		fs.writeFileSync(configuredEntry, PROBE_MODULE);

		const { session: configuredSession, extensionsResult: configuredResult } = await createSession({
			settingsOverrides: { extensions: [configuredEntry] },
		});
		try {
			expect(configuredResult.extensions.map(extension => extension.resolvedPath)).toContain(configuredEntry);
			await expect(
				configuredSession.extensionRunner?.emitInput("ooo status", undefined, "interactive"),
			).resolves.toEqual({ handled: true, text: HANDLED_TEXT });
		} finally {
			await configuredSession.dispose();
		}

		const entry = installProbe();
		const { session: disabledSession, extensionsResult: disabledResult } = await createSession({
			settingsOverrides: { disabledExtensions: [`extension-module:${PROBE_NAME}`] },
		});
		try {
			expect(disabledResult.extensions.map(extension => extension.resolvedPath)).not.toContain(entry);
			expect(disabledSession.extensionRunner?.hasHandlers("input")).not.toBe(true);
		} finally {
			await disabledSession.dispose();
		}

		// The same disabled id must also drop a file-form entry passed through the
		// `extensions` setting, not only a discovered directory entry.
		const { session: disabledFileSession, extensionsResult: disabledFileResult } = await createSession({
			settingsOverrides: {
				extensions: [configuredEntry],
				disabledExtensions: [`extension-module:${PROBE_NAME}`],
			},
		});
		try {
			expect(disabledFileResult.extensions.map(extension => extension.resolvedPath)).not.toContain(configuredEntry);
			expect(disabledFileSession.extensionRunner?.hasHandlers("input")).not.toBe(true);
		} finally {
			await disabledFileSession.dispose();
		}
	}, 30_000);

	it("loads a project-scope module from <cwd>/.gjc/extensions", async () => {
		const entry = installProbe(path.join(tempDir, ".gjc"));
		const { session, extensionsResult } = await createSession({});

		try {
			expect(extensionsResult.extensions.map(extension => extension.resolvedPath)).toContain(entry);
			await expect(session.extensionRunner?.emitInput("ooo status", undefined, "interactive")).resolves.toEqual({
				handled: true,
				text: HANDLED_TEXT,
			});
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("keeps the session usable when a discovered module fails to import", async () => {
		const brokenDir = path.join(sessionAgentDir, "extensions", "aaa-broken");
		fs.mkdirSync(brokenDir, { recursive: true });
		fs.writeFileSync(path.join(brokenDir, "index.ts"), 'throw new Error("boom at import");\n');
		const entry = installProbe();

		const { session, extensionsResult } = await createSession({});
		try {
			expect(extensionsResult.extensions.map(extension => extension.resolvedPath)).toContain(entry);
			expect(extensionsResult.errors.some(error => error.error.includes("boom at import"))).toBe(true);
			await expect(session.extensionRunner?.emitInput("ooo status", undefined, "interactive")).resolves.toEqual({
				handled: true,
				text: HANDLED_TEXT,
			});
		} finally {
			await session.dispose();
		}
	}, 30_000);

	it("loads a module once when discovery and explicit paths both name it", async () => {
		const entry = installProbe();
		const { session, extensionsResult } = await createSession({ additionalExtensionPaths: [entry] });

		try {
			const loaded = extensionsResult.extensions.filter(extension => extension.resolvedPath === entry);
			expect(loaded).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	}, 30_000);
});
