import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { YAML } from "bun";
import fc from "fast-check";

const SEED = 61317;

const roots: string[] = [];

afterEach(async () => {
	resetSettingsForTest();
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

type Surface = "settings" | "config";

async function load(options: {
	userEnabled?: boolean;
	project?: Record<string, unknown>;
	surface?: Surface;
	parentProject?: Record<string, unknown>;
	makeProjectDir?: boolean;
}): Promise<Settings> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plan-enabled-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	const globalBody = options.userEnabled === undefined ? {} : { plan: { enabled: options.userEnabled } };
	await Bun.write(path.join(agent, "config.yml"), YAML.stringify(globalBody));
	if (options.parentProject) {
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await Bun.write(path.join(root, ".gjc", "settings.json"), JSON.stringify(options.parentProject));
	}
	if (options.makeProjectDir !== false && options.project) {
		await fs.mkdir(path.join(project, ".gjc"), { recursive: true });
		const surface = options.surface ?? "settings";
		if (surface === "settings") {
			await Bun.write(path.join(project, ".gjc", "settings.json"), JSON.stringify(options.project));
		} else {
			await Bun.write(path.join(project, ".gjc", "config.yml"), YAML.stringify(options.project));
		}
	}
	return Settings.loadReadonly({ cwd: project, agentDir: agent });
}

describe("project plan.enabled", () => {
	it("project settings.json plan.enabled false leaves the operator default", async () => {
		const settings = await load({
			project: { plan: { enabled: false }, tasksPane: { defaultVisible: true } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(true);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("project config.yml plan.enabled false leaves the operator default", async () => {
		const settings = await load({
			surface: "config",
			project: { plan: { enabled: false }, tasksPane: { defaultVisible: true } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(true);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("still allows a project file that omits plan to merge another key", async () => {
		const settings = await load({
			project: { tasksPane: { defaultVisible: true } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(true);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("user config plan.enabled false wins when the project file sets true", async () => {
		const settings = await load({
			userEnabled: false,
			surface: "config",
			project: { plan: { enabled: true }, tasksPane: { defaultVisible: true } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(false);
			expect(settings.getGlobal("plan.enabled")).toBe(false);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("still honors a user config plan.enabled false when the project file omits plan", async () => {
		const settings = await load({
			userEnabled: false,
			project: { tasksPane: { defaultVisible: true } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(false);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("still honors Settings.isolated plan.enabled false", () => {
		const settings = Settings.isolated({ "plan.enabled": false, "tasksPane.defaultVisible": true });
		expect(settings.get("plan.enabled")).toBe(false);
		expect(settings.get("tasksPane.defaultVisible")).toBe(true);
	});

	it("does not let a runtime override turn plan.enabled off", async () => {
		const settings = await load({ userEnabled: true });
		try {
			settings.override("plan.enabled", false);
			expect(settings.get("plan.enabled")).toBe(true);
			expect(settings.getOverride("plan.enabled")).toBe(false);
		} finally {
			await settings.close();
		}
	});

	it("operator set plan.enabled false wins over a project true", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-plan-enabled-"));
		roots.push(root);
		const project = path.join(root, "proj");
		const agent = path.join(root, "agent");
		await fs.mkdir(path.join(project, ".gjc"), { recursive: true });
		await fs.mkdir(agent, { recursive: true });
		await Bun.write(
			path.join(project, ".gjc", "settings.json"),
			JSON.stringify({ plan: { enabled: true }, tasksPane: { defaultVisible: true } }),
		);
		const settings = await Settings.loadForScope({ cwd: project, agentDir: agent });
		try {
			settings.set("plan.enabled", false);
			expect(settings.get("plan.enabled")).toBe(false);
			expect(settings.getGlobal("plan.enabled")).toBe(false);
			expect(settings.get("tasksPane.defaultVisible")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("does not let a non-object project plan value turn plan mode off", async () => {
		for (const parent of [null, false, "", []] as const) {
			const settings = await load({
				project: { plan: parent, tasksPane: { defaultVisible: true } },
			});
			try {
				expect(settings.get("plan.enabled")).toBe(true);
				expect(settings.get("tasksPane.defaultVisible")).toBe(true);
			} finally {
				await settings.close();
			}
		}
	});

	it("still ignores a parent directory settings file that sets plan.enabled false", async () => {
		const settings = await load({
			makeProjectDir: false,
			parentProject: { plan: { enabled: false } },
		});
		try {
			expect(settings.get("plan.enabled")).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("property: project plan.enabled values stay operator-owned, fc.property seed 61317, numRuns 64", async () => {
		const leaf = fc.oneof(
			fc.boolean(),
			fc.constant(null),
			fc.constant(0),
			fc.constant(""),
			fc.constant("false"),
			fc.constant(" false "),
			fc.constant("FALSE"),
			fc.string({ maxLength: 12 }),
		);
		const userChoice = fc.constantFrom("unset", "true", "false");
		const surface = fc.constantFrom("settings" as const, "config" as const);
		await fc.assert(
			fc.asyncProperty(leaf, userChoice, surface, async (projectLeaf, user, via) => {
				const settings = await load({
					userEnabled: user === "unset" ? undefined : user === "true",
					surface: via,
					project: { plan: { enabled: projectLeaf }, tasksPane: { defaultVisible: true } },
				});
				try {
					expect(settings.get("plan.enabled")).toBe(user !== "false");
					expect(settings.get("tasksPane.defaultVisible")).toBe(true);
				} finally {
					await settings.close();
				}
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
