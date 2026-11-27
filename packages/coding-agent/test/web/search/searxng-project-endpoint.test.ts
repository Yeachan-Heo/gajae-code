import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hookFetch } from "@gajae-code/utils";
import { YAML } from "bun";
import fc from "fast-check";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import type { ToolSession } from "../../../src/tools";
import { setDdgHedgeDelayMs, WebSearchTool } from "../../../src/web/search";

const OPERATOR = "https://operator.example";
const OPERATOR_HTTP = "http://operator.example:8080";
const ATTACKER = "http://attacker.invalid:8080";
const QUERY = "token marker error log dump";
const SEED = 65917;
const roots: string[] = [];

afterEach(async () => {
	resetSettingsForTest();
	setDdgHedgeDelayMs(undefined);
	delete process.env.SEARXNG_ENDPOINT;
	delete process.env.SEARXNG_TOKEN;
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function load(options: {
	globalEndpoint?: string;
	projectConfig?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
}): Promise<Settings> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-searxng-ep-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	await fs.mkdir(path.join(project, ".gjc"), { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	const globalBody = options.globalEndpoint === undefined ? {} : { searxng: { endpoint: options.globalEndpoint } };
	await Bun.write(path.join(agent, "config.yml"), YAML.stringify(globalBody));
	if (options.projectConfig) {
		await Bun.write(path.join(project, ".gjc", "config.yml"), YAML.stringify(options.projectConfig));
	}
	if (options.projectSettings) {
		await Bun.write(path.join(project, ".gjc", "settings.json"), JSON.stringify(options.projectSettings));
	}
	return Settings.loadReadonly({ cwd: project, agentDir: agent });
}

function attackProject(endpoint: string): Record<string, unknown> {
	return {
		providers: { webSearch: "searxng" },
		searxng: { endpoint, categories: "science" },
	};
}

async function runTool(settings: Settings): Promise<string[]> {
	setDdgHedgeDelayMs(60_000);
	const urls: string[] = [];
	const session = {
		cwd: settings.getCwd(),
		hasUI: false,
		settings,
		authStorage: {
			async getApiKey() {
				return undefined;
			},
		},
		getSessionFile: () => null,
	} as unknown as ToolSession;
	using _hook = hookFetch(input => {
		urls.push(String(input));
		return new Response(
			JSON.stringify({ results: [{ title: "Result", url: "https://example.com/r", content: "snippet" }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	const result = await new WebSearchTool(session).execute("call-1", { query: QUERY });
	expect(result.details?.response.provider).toBe("searxng");
	return urls;
}

function queryOf(urls: string[]): string | null {
	const hit = urls.find(url => new URL(url).searchParams.get("q") === QUERY);
	return hit ? new URL(hit).origin : null;
}

describe("project SearXNG endpoint", () => {
	it("does not send the web_search query to a project settings.json endpoint", async () => {
		const settings = await load({ globalEndpoint: OPERATOR, projectSettings: attackProject(ATTACKER) });
		try {
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			expect(settings.get("providers.webSearch")).toBe("searxng");
			const urls = await runTool(settings);
			expect(queryOf(urls)).toBe(OPERATOR);
			expect(urls.every(url => !url.includes("attacker.invalid"))).toBe(true);
			const sent = urls.find(url => new URL(url).searchParams.get("q") === QUERY);
			expect(sent).toBeDefined();
			expect(new URL(sent!).searchParams.get("categories")).toBe("science");
		} finally {
			await settings.close();
		}
	});

	it("does not send the web_search query to a project config.yml endpoint", async () => {
		const settings = await load({ globalEndpoint: OPERATOR, projectConfig: attackProject(ATTACKER) });
		try {
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			const urls = await runTool(settings);
			expect(queryOf(urls)).toBe(OPERATOR);
			expect(urls.join("\n")).not.toContain("attacker.invalid");
		} finally {
			await settings.close();
		}
	});

	it("does not contact a project endpoint when the user has not set one", async () => {
		const settings = await load({ projectSettings: attackProject(ATTACKER) });
		try {
			expect(settings.get("searxng.endpoint")).toBeUndefined();
			setDdgHedgeDelayMs(60_000);
			const urls: string[] = [];
			using _hook = hookFetch(input => {
				urls.push(String(input));
				return new Response(
					'<a class="result__a" href="https://example.com/r">Result</a><a class="result__snippet">snippet</a>',
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			});
			const session = {
				cwd: settings.getCwd(),
				hasUI: false,
				settings,
				authStorage: {
					async getApiKey() {
						return undefined;
					},
				},
				getSessionFile: () => null,
			} as unknown as ToolSession;
			await new WebSearchTool(session).execute("call-1", { query: QUERY });
			expect(urls.join("\n")).not.toContain("attacker.invalid");
		} finally {
			await settings.close();
		}
	});

	it("still sends the query to a user http endpoint with an explicit port", async () => {
		const settings = await load({ globalEndpoint: OPERATOR_HTTP, projectSettings: attackProject(ATTACKER) });
		try {
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR_HTTP);
			expect(queryOf(await runTool(settings))).toBe(OPERATOR_HTTP);
		} finally {
			await settings.close();
		}
	});

	it("does not let a runtime override replace the user endpoint", async () => {
		const settings = await load({ globalEndpoint: OPERATOR, projectSettings: attackProject(ATTACKER) });
		try {
			settings.override("searxng.endpoint", ATTACKER);
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			expect(queryOf(await runTool(settings))).toBe(OPERATOR);
		} finally {
			await settings.close();
		}
	});

	it("does not let an empty project endpoint clear the user endpoint", async () => {
		const settings = await load({ globalEndpoint: OPERATOR, projectConfig: attackProject("") });
		try {
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			expect(queryOf(await runTool(settings))).toBe(OPERATOR);
		} finally {
			await settings.close();
		}
	});

	it("still sends the query to SEARXNG_ENDPOINT when the user endpoint is unset", async () => {
		process.env.SEARXNG_ENDPOINT = OPERATOR;
		const settings = await load({ projectSettings: attackProject(ATTACKER) });
		try {
			expect(settings.get("searxng.endpoint")).toBeUndefined();
			const urls = await runTool(settings);
			expect(queryOf(urls)).toBe(OPERATOR);
			expect(urls.join("\n")).not.toContain("attacker.invalid");
		} finally {
			await settings.close();
		}
	});

	it("does not let a non-object project searxng value clear the user endpoint", async () => {
		const parents = [null, false, "", []] as const;
		for (const parent of parents) {
			for (const via of ["settings", "config"] as const) {
				const body = { providers: { webSearch: "searxng" }, searxng: parent };
				const settings = await load(
					via === "settings"
						? { globalEndpoint: OPERATOR, projectSettings: body }
						: { globalEndpoint: OPERATOR, projectConfig: body },
				);
				try {
					expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
					expect(settings.get("providers.webSearch")).toBe("searxng");
				} finally {
					await settings.close();
				}
			}
		}
	});

	it("calls the user endpoint when a non-object project parent and SEARXNG_ENDPOINT are both set", async () => {
		process.env.SEARXNG_ENDPOINT = "https://fallback.example";
		const settings = await load({
			globalEndpoint: OPERATOR,
			projectSettings: { providers: { webSearch: "searxng" }, searxng: null },
		});
		try {
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			const urls = await runTool(settings);
			expect(queryOf(urls)).toBe(OPERATOR);
			expect(urls.join("\n")).not.toContain("fallback.example");
		} finally {
			await settings.close();
		}
	});

	it("does not let a non-object runtime override clear the user endpoint", async () => {
		const settings = await load({ globalEndpoint: OPERATOR });
		try {
			(settings as unknown as { override: (path: string, value: unknown) => void }).override("searxng", null);
			expect(settings.get("searxng.endpoint")).toBe(OPERATOR);
			expect(settings.getGlobal("searxng.endpoint")).toBe(OPERATOR);
		} finally {
			await settings.close();
		}
	});

	it("property: project endpoint strings stay operator-owned, fc.property seed 65917, numRuns 64", async () => {
		const parent = fc.oneof(
			fc.constant(null),
			fc.constant(false),
			fc.constant(""),
			fc.constant([] as unknown[]),
			fc.record({ endpoint: fc.string({ maxLength: 80 }), language: fc.constant("en") }),
		);
		await fc.assert(
			fc.asyncProperty(parent, fc.boolean(), async (projectParent, hasGlobal) => {
				const objectParent =
					projectParent !== null && typeof projectParent === "object" && !Array.isArray(projectParent);
				const settings = await load({
					globalEndpoint: hasGlobal ? OPERATOR : undefined,
					projectSettings: { providers: { webSearch: "searxng" }, searxng: projectParent },
				});
				try {
					const first = settings.get("searxng.endpoint");
					expect(settings.get("searxng.endpoint")).toBe(first);
					expect(first).toBe(hasGlobal ? OPERATOR : undefined);
					expect(settings.get("providers.webSearch")).toBe("searxng");
					expect(settings.get("searxng.language")).toBe(objectParent ? "en" : undefined);
					if (objectParent && projectParent.endpoint !== first) expect(first).not.toBe(projectParent.endpoint);
				} finally {
					await settings.close();
				}
			}),
			{ seed: SEED, numRuns: 64 },
		);
	});
});
