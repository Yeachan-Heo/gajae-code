import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@gajae-code/coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { resetAgentDirFromEnvironment } from "@gajae-code/utils";
import fc from "fast-check";
import { safeRmSync } from "../../../scripts/safe-cleanup";
import { cleanupTempHome, type TempHomeState } from "./helpers/temp-home-cleanup";

const PROBE = "operator-disabled-probe";
const OTHER = "operator-enabled-probe";
const PROBE_ID = `extension-module:${PROBE}`;
const OTHER_ID = `extension-module:${OTHER}`;

const PROBE_MODULE = `
export default function activate(gjc) {
	gjc.on("input", async event => {
		if (event.text !== "probe ping") return {};
		return { handled: true, text: "probe-hit" };
	});
}
`;

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	clearCache();
	for (const root of roots.splice(0)) {
		safeRmSync(root, { recursive: true, force: true });
	}
});

function listYaml(key: string, values: string[]): string {
	if (values.length === 0) return `${key}: []\n`;
	return `${key}:\n${values.map(value => `  - ${JSON.stringify(value)}`).join("\n")}\n`;
}

function installProbe(agentDir: string, name: string): string {
	const dir = path.join(agentDir, "extensions", name);
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, "index.ts");
	fs.writeFileSync(entry, PROBE_MODULE);
	return entry;
}

async function loadLayers(options: {
	globalList?: string[];
	projectYaml?: string;
	projectJson?: string;
}): Promise<Settings> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dext-"));
	roots.push(root);
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	if (options.globalList) {
		fs.writeFileSync(path.join(agent, "config.yml"), listYaml("disabledExtensions", options.globalList));
	}
	if (options.projectYaml !== undefined) {
		fs.writeFileSync(path.join(project, ".gjc", "config.yml"), options.projectYaml);
	}
	if (options.projectJson !== undefined) {
		fs.writeFileSync(path.join(project, ".gjc", "settings.json"), options.projectJson);
	}
	return await Settings.loadReadonly({ cwd: project, agentDir: agent });
}

describe("repository disabledExtensions layer", () => {
	it("does not let a repository config clear the operator disable list", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID, "mcp:untrusted"],
			projectYaml: "disabledExtensions: []\n",
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([PROBE_ID, "mcp:untrusted"]);
		} finally {
			await settings.close();
		}
	});

	it("does not let a repository settings file clear the operator disable list", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID],
			projectJson: JSON.stringify({ disabledExtensions: [] }),
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([PROBE_ID]);
		} finally {
			await settings.close();
		}
	});

	it("does not let a repository disable list replace the operator list", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID],
			projectYaml: listYaml("disabledExtensions", ["skill:repo-only"]),
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([PROBE_ID]);
		} finally {
			await settings.close();
		}
	});

	it("still allows a Settings.init override when a repository config clears the list", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dext-init-"));
		roots.push(root);
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		fs.mkdirSync(path.join(project, ".gjc"), { recursive: true });
		fs.mkdirSync(agent, { recursive: true });
		fs.writeFileSync(
			path.join(project, ".gjc", "config.yml"),
			"skills:\n  ignoredSkills:\n    - kept-skill\ndisabledExtensions: []\n",
		);
		const settings = await Settings.init({
			inMemory: true,
			cwd: project,
			agentDir: agent,
			overrides: { disabledExtensions: [PROBE_ID] },
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([PROBE_ID]);
			expect(settings.get("skills.ignoredSkills")).toEqual(["kept-skill"]);
		} finally {
			await settings.close();
			await resetSettingsForTest();
		}
	});

	it("still allows a runtime override to replace the operator disable list", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID],
			projectYaml: "disabledExtensions: []\n",
		});
		try {
			settings.override("disabledExtensions", ["skill:session-only"]);
			expect(settings.get("disabledExtensions")).toEqual(["skill:session-only"]);
		} finally {
			await settings.close();
		}
	});

	it("still allows the operator disable list when the repository omits it", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID],
			projectYaml: "skills:\n  ignoredSkills:\n    - kept-skill\n",
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([PROBE_ID]);
			expect(settings.get("skills.ignoredSkills")).toEqual(["kept-skill"]);
		} finally {
			await settings.close();
		}
	});

	it("still allows a repository skill ignore list next to a disable list", async () => {
		const settings = await loadLayers({
			globalList: [PROBE_ID],
			projectYaml: `skills:\n  ignoredSkills:\n    - kept-skill\n${listYaml("disabledExtensions", [])}`,
		});
		try {
			expect(settings.get("skills.ignoredSkills")).toEqual(["kept-skill"]);
		} finally {
			await settings.close();
		}
	});

	it("still allows an operator disable id with surrounding spaces", async () => {
		const settings = await loadLayers({
			globalList: [`  ${PROBE_ID}  `],
			projectYaml: "skills:\n  ignoredSkills:\n    - kept-skill\n",
		});
		try {
			expect(settings.get("disabledExtensions")).toEqual([`  ${PROBE_ID}  `]);
		} finally {
			await settings.close();
		}
	});

	it("property: operator disable ids stay independent of a repository list, seed 606, 64 inputs", async () => {
		const idBody = fc.string({
			unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
			minLength: 1,
			maxLength: 8,
		});
		const idList = fc
			.uniqueArray(idBody, { minLength: 0, maxLength: 4 })
			.map(ids => ids.map(id => `extension-module:${id}`));
		await fc.assert(
			fc.asyncProperty(
				idList,
				fc.option(idList, { nil: undefined }),
				fc.option(idList, { nil: undefined }),
				fc.boolean(),
				async (globalList, projectList, overrideList, useSettingsJson) => {
					const projectBody =
						projectList === undefined
							? "skills:\n  ignoredSkills:\n    - kept-skill\n"
							: `skills:\n  ignoredSkills:\n    - kept-skill\n${listYaml("disabledExtensions", projectList)}`;
					const settings = await loadLayers({
						globalList,
						projectYaml: useSettingsJson ? undefined : projectBody,
						projectJson: useSettingsJson
							? JSON.stringify({
									skills: { ignoredSkills: ["kept-skill"] },
									...(projectList === undefined ? {} : { disabledExtensions: projectList }),
								})
							: undefined,
					});
					try {
						if (overrideList !== undefined) settings.override("disabledExtensions", overrideList);
						expect(settings.get("disabledExtensions")).toEqual(overrideList ?? globalList);
						expect(settings.get("skills.ignoredSkills")).toEqual(["kept-skill"]);
					} finally {
						await settings.close();
					}
				},
			),
			{ seed: 606, numRuns: 64 },
		);
	});
});

describe("repository disabledExtensions at session startup", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let homeState: TempHomeState = { tempDir: "", tempHomeDir: "", originalHome: undefined };
	let originalUserProfile: string | undefined;

	afterEach(() => {
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		cleanupTempHome(() => homeState)();
		clearCache();
		vi.restoreAllMocks();
	});

	function isolateHome(): { projectDir: string; agentDir: string } {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dext-sess-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dext-home-"));
		originalUserProfile = process.env.USERPROFILE;
		homeState = {
			tempDir,
			tempHomeDir,
			originalHome: process.env.HOME,
			originalAgentDir: process.env.GJC_CODING_AGENT_DIR,
			originalPiAgentDir: process.env.PI_CODING_AGENT_DIR,
		};
		process.env.HOME = tempHomeDir;
		process.env.USERPROFILE = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		const projectGlobalAgentDir = path.join(tempHomeDir, ".gjc", "agent");
		fs.mkdirSync(projectGlobalAgentDir, { recursive: true });
		process.env.GJC_CODING_AGENT_DIR = projectGlobalAgentDir;
		delete process.env.PI_CODING_AGENT_DIR;
		resetAgentDirFromEnvironment();
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempHomeDir, ".gjc", "profile-agent");
		fs.mkdirSync(path.join(projectDir, ".gjc"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		clearCache();
		return { projectDir, agentDir };
	}

	async function startSession(projectDir: string, agentDir: string, projectYaml: string) {
		fs.writeFileSync(path.join(agentDir, "config.yml"), listYaml("disabledExtensions", [PROBE_ID]));
		fs.writeFileSync(path.join(projectDir, ".gjc", "config.yml"), projectYaml);
		const disabledEntry = installProbe(agentDir, PROBE);
		const enabledEntry = installProbe(agentDir, OTHER);
		const settings = await Settings.loadForScope({ cwd: projectDir, agentDir });
		const started = await createAgentSession({
			cwd: projectDir,
			agentDir,
			sessionManager: SessionManager.inMemory(),
			settings,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return { ...started, settings, disabledEntry, enabledEntry };
	}

	it("does not import an operator-disabled module when a repository config clears the list", async () => {
		const { projectDir, agentDir } = isolateHome();
		const started = await startSession(projectDir, agentDir, "disabledExtensions: []\n");
		try {
			expect(started.settings.get("disabledExtensions")).toEqual([PROBE_ID]);
			const loaded = started.extensionsResult.extensions.map(extension => extension.resolvedPath);
			expect(loaded).not.toContain(started.disabledEntry);
			expect(loaded).toContain(started.enabledEntry);
		} finally {
			await started.session.dispose();
			await started.settings.close();
		}
	}, 30_000);

	it("still allows the operator disable list when the repository config omits it", async () => {
		const { projectDir, agentDir } = isolateHome();
		const started = await startSession(projectDir, agentDir, "skills:\n  ignoredSkills:\n    - kept-skill\n");
		try {
			expect(started.settings.get("disabledExtensions")).toEqual([PROBE_ID]);
			expect(started.settings.get("skills.ignoredSkills")).toEqual(["kept-skill"]);
			const loaded = started.extensionsResult.extensions.map(extension => extension.resolvedPath);
			expect(loaded).not.toContain(started.disabledEntry);
			expect(loaded).toContain(started.enabledEntry);
		} finally {
			await started.session.dispose();
			await started.settings.close();
		}
	}, 30_000);

	it("does not let a repository list unload an extension the operator left enabled", async () => {
		const { projectDir, agentDir } = isolateHome();
		const started = await startSession(projectDir, agentDir, listYaml("disabledExtensions", [OTHER_ID]));
		try {
			const loaded = started.extensionsResult.extensions.map(extension => extension.resolvedPath);
			expect(loaded).toContain(started.enabledEntry);
			expect(loaded).not.toContain(started.disabledEntry);
		} finally {
			await started.session.dispose();
			await started.settings.close();
		}
	}, 30_000);
});
