/**
 * Issue #4291 acceptance 8 + dashboard integration: keyboard navigation,
 * back/cancel behavior, narrow-terminal rendering, scope-bound lists, and the
 * import wizard's explicit-confirmation flow. The dashboard renders
 * Skills/Hooks/MCPs without any dependency on the ExtensionDashboard provider
 * inventory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomizationDashboard } from "@gajae-code/coding-agent/modes/components/customization/customization-dashboard";
import { ImportWizard } from "@gajae-code/coding-agent/modes/components/customization/import-wizard";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";

let tmpRoot: string;
let projectDir: string;
let homeDir: string;
let savedAgentDir: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-4291-ui-"));
	projectDir = path.join(tmpRoot, "project");
	homeDir = path.join(tmpRoot, "home");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(homeDir, { recursive: true });
	savedAgentDir = getAgentDir();
	const themeInstance = await getThemeByName("red-claw");
	if (!themeInstance) throw new Error("Failed to load theme for tests");
	setThemeInstance(themeInstance);
	setAgentDir(path.join(homeDir, ".gjc", "agent"));
});

afterEach(async () => {
	setAgentDir(savedAgentDir);
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

const SKILL_MD = `---
description: Fixture skill for tests.
---

# Fixture

Do the thing.
`;

async function seedProjectSkill(): Promise<void> {
	await fs.mkdir(path.join(projectDir, ".gjc", "skills", "fixture"), { recursive: true });
	await fs.writeFile(path.join(projectDir, ".gjc", "skills", "fixture", "SKILL.md"), SKILL_MD);
}

describe("CustomizationDashboard", () => {
	test("opens with one project skill and zero extension modules", async () => {
		await seedProjectSkill();
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		expect(dashboard.section).toBe("skills");
		expect(dashboard.scope).toBe("project");
		expect(dashboard.inventory.rows.some(r => r.name === "fixture" && r.status === "enabled")).toBe(true);
		const lines = dashboard.render(80).join("\n");
		expect(lines).toContain("/extensions");
		expect(lines).toContain("Configure skills, hooks, and MCPs.");
		expect(lines).toContain("fixture");
	});

	test("keyboard: section cycling and scope switching", async () => {
		await seedProjectSkill();
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		dashboard.handleInput("\x1b[C"); // right arrow
		expect(dashboard.section).toBe("hooks");
		dashboard.handleInput("\x1b[C");
		expect(dashboard.section).toBe("mcps");
		dashboard.handleInput("\x1b[D"); // left arrow
		expect(dashboard.section).toBe("hooks");
		dashboard.handleInput("s");
		expect(dashboard.scope).toBe("global");
		dashboard.handleInput("s");
		expect(dashboard.scope).toBe("project");
	});

	test("scope switching filters the visible rows to the active scope", async () => {
		await seedProjectSkill();
		await fs.mkdir(path.join(getAgentDir(), "skills", "global-only"), { recursive: true });
		await fs.writeFile(path.join(getAgentDir(), "skills", "global-only", "SKILL.md"), SKILL_MD);
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		// Project scope shows the project row, not the global one.
		let lines = dashboard.render(80).join("\n");
		expect(lines).toContain("fixture");
		expect(lines).not.toContain("global-only");
		dashboard.handleInput("s");
		expect(dashboard.scope).toBe("global");
		lines = dashboard.render(80).join("\n");
		expect(lines).toContain("global-only");
		expect(lines).not.toContain("fixture");
	});

	test("skills master switch marks native skills disabled", async () => {
		await seedProjectSkill();
		const settings = {
			get(key: string): unknown {
				return key === "skills.enabled" ? false : undefined;
			},
		};
		const dashboard = await CustomizationDashboard.create(projectDir, settings, homeDir);
		const row = dashboard.inventory.rows.find(r => r.surface === "skills" && r.name === "fixture");
		expect(row?.status).toBe("disabled");
		expect(row?.diagnostics?.join(" ")).toContain("disabled globally");
	});

	test("rendered rows strip terminal control sequences from hostile names", async () => {
		await fs.mkdir(path.join(projectDir, ".gjc", "hooks", "pre"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".gjc", "hooks", "pre", "evil\x1b[31m.ts"), "export {}\n");
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		dashboard.handleInput("\x1b[C"); // hooks section
		const lines = dashboard.render(80);
		expect(lines.join("\n")).not.toContain("evil\x1b[31m");
		expect(Bun.stripANSI(lines.join("\n"))).toContain("evil");
	});

	test("esc/q closes via onClose", async () => {
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		let closed = 0;
		dashboard.onClose = () => {
			closed += 1;
		};
		dashboard.handleInput("q");
		expect(closed).toBe(1);
	});

	test("narrow-terminal rendering stays within the viewport", async () => {
		await seedProjectSkill();
		const dashboard = await CustomizationDashboard.create(projectDir, undefined, homeDir);
		const narrow = dashboard.render(20);
		expect(Bun.stripANSI(narrow.join(" "))).toContain("/extensions:");
		for (const line of narrow) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
		}
		for (const line of dashboard.render(60)) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});
});

describe("ImportWizard", () => {
	test("selection lists are attached and visible at every choice step", async () => {
		const wizard = new ImportWizard(projectDir, "project", homeDir);
		expect(wizard.hasVisibleSelector).toBe(true);
		wizard.handleInput("\r"); // product
		expect(wizard.step).toBe("sourceScope");
		expect(wizard.hasVisibleSelector).toBe(true);
		wizard.handleInput("\r"); // source scope
		expect(wizard.step).toBe("surfaces");
		expect(wizard.hasVisibleSelector).toBe(true);
	});

	test("esc cancels at any selection step without writing anything", async () => {
		await seedProjectSkill();
		const wizard = new ImportWizard(projectDir, "project", homeDir);
		expect(wizard.step).toBe("product");
		const closed: boolean[] = [];
		wizard.onClose = applied => {
			closed.push(applied);
		};
		wizard.handleInput("\x1b");
		expect(closed).toEqual([false]);
		await expect(fs.stat(path.join(projectDir, ".gjc", "mcp.json"))).rejects.toThrow();
	});

	test("drives product → scope → surfaces → policy → preview, enter applies", async () => {
		await fs.mkdir(path.join(projectDir, ".claude", "skills", "wiz-skill"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "skills", "wiz-skill", "SKILL.md"), SKILL_MD);
		const wizard = new ImportWizard(projectDir, "project", homeDir);
		const previewReady = Promise.withResolvers<void>();
		const applyFinished = Promise.withResolvers<void>();
		wizard.onRequestRender = () => {
			if (wizard.step === "preview") previewReady.resolve();
			if (wizard.step === "result") applyFinished.resolve();
		};
		wizard.handleInput("\r"); // product: claude-code (first)
		expect(wizard.step).toBe("sourceScope");
		wizard.handleInput("\r"); // source scope: project (first)
		expect(wizard.step).toBe("surfaces");
		wizard.handleInput("\r"); // surfaces: all
		expect(wizard.step).toBe("collision");
		wizard.handleInput("\r"); // policy: skip (first) → builds preview async
		await previewReady.promise;
		expect(wizard.step).toBe("preview");
		expect(wizard.hasVisibleSelector).toBe(false);
		expect(wizard.preview?.entries.some(e => e.surface === "skills" && e.destinationName === "wiz-skill")).toBe(true);
		wizard.handleInput("\r"); // confirm apply
		await applyFinished.promise;
		expect(wizard.step).toBe("result");
		expect(wizard.result?.ok).toBe(true);
		await fs.stat(path.join(projectDir, ".gjc", "skills", "wiz-skill", "SKILL.md"));
	});

	test("a failed apply closes with applied=false, never a false success", async () => {
		// Replace the destination's directory parent after preview to force an apply failure.
		await fs.mkdir(path.join(projectDir, ".claude", "skills", "wiz-skill"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "skills", "wiz-skill", "SKILL.md"), SKILL_MD);
		const wizard = new ImportWizard(projectDir, "project", homeDir);
		const previewReady = Promise.withResolvers<void>();
		const applyFinished = Promise.withResolvers<void>();
		wizard.onRequestRender = () => {
			if (wizard.step === "preview") previewReady.resolve();
			if (wizard.step === "result") applyFinished.resolve();
		};
		const closed: boolean[] = [];
		wizard.onClose = applied => {
			closed.push(applied);
		};
		for (let i = 0; i < 4; i++) wizard.handleInput("\r");
		await previewReady.promise;
		expect(wizard.step).toBe("preview");
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".gjc", "skills"), "not-a-directory");
		wizard.handleInput("\r"); // apply
		await applyFinished.promise;
		expect(wizard.step).toBe("result");
		expect(wizard.result?.ok).toBe(false);
		wizard.handleInput("\r"); // close
		expect(closed).toEqual([false]);
	});

	test("preview paging reaches every entry before confirmation", async () => {
		// Seed more skills than one preview page holds.
		for (let i = 0; i < 12; i++) {
			await fs.mkdir(path.join(projectDir, ".claude", "skills", `skill-${i}`), { recursive: true });
			await fs.writeFile(path.join(projectDir, ".claude", "skills", `skill-${i}`, "SKILL.md"), SKILL_MD);
		}
		const wizard = new ImportWizard(projectDir, "project", homeDir);
		const previewReady = Promise.withResolvers<void>();
		wizard.onRequestRender = () => {
			if (wizard.step === "preview") previewReady.resolve();
		};
		for (let i = 0; i < 4; i++) wizard.handleInput("\r");
		await previewReady.promise;
		expect(wizard.step).toBe("preview");
		const pageOne = wizard.render(80).join("\n");
		expect(pageOne).toContain("page 1/");
		expect(pageOne).not.toContain("skill-9");
		wizard.handleInput("\x1b[C"); // next page
		const pageTwo = wizard.render(80).join("\n");
		expect(pageTwo).toContain("skill-9");
	});
});
