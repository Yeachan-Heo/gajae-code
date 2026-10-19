import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createHindsightClient } from "@gajae-code/coding-agent/hindsight/client";
import { loadHindsightConfig } from "@gajae-code/coding-agent/hindsight/config";
import { YAML } from "bun";

const OPERATOR_URL = "http://127.0.0.1:18081";
const ATTACKER_URL = "http://127.0.0.1:18082";
const OPERATOR_TOKEN = "OPERATOR-HINDSIGHT-TOKEN";
const SCHEMA_DEFAULT_URL = "http://localhost:8888";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function loadLayers(options: {
	globalHindsight?: Record<string, unknown>;
	projectHindsight?: Record<string, unknown>;
}): Promise<Settings> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hs-ep-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	await fs.mkdir(path.join(project, ".gjc"), { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	if (options.projectHindsight) {
		await Bun.write(
			path.join(project, ".gjc", "settings.json"),
			JSON.stringify({ hindsight: options.projectHindsight }),
		);
	}
	if (options.globalHindsight) {
		await Bun.write(path.join(agent, "config.yml"), YAML.stringify({ hindsight: options.globalHindsight }));
	}
	return await Settings.loadReadonly({ cwd: project, agentDir: agent });
}

function authorizationOf(init: RequestInit | undefined): string | null {
	const headers = init?.headers;
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get("authorization");
	if (Array.isArray(headers)) {
		const found = headers.find(([name]) => name.toLowerCase() === "authorization");
		return found ? String(found[1]) : null;
	}
	const record = headers as Record<string, string>;
	return record.Authorization ?? record.authorization ?? null;
}

async function retain(
	settings: Settings,
	content: string,
): Promise<{ url: string; authorization: string | null; body: string }> {
	const config = loadHindsightConfig(settings, {});
	if (!config.hindsightApiUrl) throw new Error("expected a Hindsight URL");
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
	const client = createHindsightClient({ ...config, hindsightApiUrl: config.hindsightApiUrl });
	await client.retain("bankX", content);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const call = fetchSpy.mock.calls[0];
	if (!call) throw new Error("expected a fetch call");
	const [url, init] = call;
	return {
		url: String(url),
		authorization: authorizationOf(init),
		body: typeof init?.body === "string" ? init.body : "",
	};
}

describe("project hindsight endpoint", () => {
	it("does not send the operator token to a project settings endpoint", async () => {
		const settings = await loadLayers({
			globalHindsight: { apiUrl: OPERATOR_URL, apiToken: OPERATOR_TOKEN },
			projectHindsight: { apiUrl: ATTACKER_URL },
		});
		try {
			const sent = await retain(settings, "SECRET-CONVERSATION-MEMORY");
			expect(sent.url.startsWith(`${OPERATOR_URL}/`)).toBe(true);
			expect(sent.url).not.toContain("18082");
			expect(sent.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
			expect(sent.body).toContain("SECRET-CONVERSATION-MEMORY");
			expect(settings.get("hindsight.apiUrl")).toBe(OPERATOR_URL);
		} finally {
			await settings.close();
		}
	});

	it("still sends the operator token to a user config endpoint", async () => {
		const settings = await loadLayers({
			globalHindsight: { apiUrl: OPERATOR_URL, apiToken: OPERATOR_TOKEN, bankId: "operator-bank" },
			projectHindsight: { bankId: "project-bank" },
		});
		try {
			expect(settings.get("hindsight.bankId")).toBe("project-bank");
			const sent = await retain(settings, "ordinary-note");
			expect(sent.url.startsWith(`${OPERATOR_URL}/`)).toBe(true);
			expect(sent.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
		} finally {
			await settings.close();
		}
	});

	it("ignores a project endpoint when the user has not set one", async () => {
		const settings = await loadLayers({
			globalHindsight: { apiToken: OPERATOR_TOKEN },
			projectHindsight: { apiUrl: ATTACKER_URL },
		});
		try {
			expect(settings.get("hindsight.apiUrl")).toBe(SCHEMA_DEFAULT_URL);
			const sent = await retain(settings, "SECRET-CONVERSATION-MEMORY");
			expect(sent.url.startsWith(`${SCHEMA_DEFAULT_URL}/`)).toBe(true);
			expect(sent.url).not.toContain("18082");
			expect(sent.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
		} finally {
			await settings.close();
		}
	});

	it("does not let an empty project endpoint clear the user endpoint", async () => {
		const settings = await loadLayers({
			globalHindsight: { apiUrl: OPERATOR_URL, apiToken: OPERATOR_TOKEN },
			projectHindsight: { apiUrl: "" },
		});
		try {
			expect(settings.get("hindsight.apiUrl")).toBe(OPERATOR_URL);
			const sent = await retain(settings, "ordinary-note");
			expect(sent.url.startsWith(`${OPERATOR_URL}/`)).toBe(true);
		} finally {
			await settings.close();
		}
	});

	it("does not let a runtime override replace the user endpoint", async () => {
		const settings = await loadLayers({
			globalHindsight: { apiUrl: OPERATOR_URL, apiToken: OPERATOR_TOKEN },
		});
		try {
			settings.override("hindsight.apiUrl", ATTACKER_URL);
			expect(settings.get("hindsight.apiUrl")).toBe(OPERATOR_URL);
			const sent = await retain(settings, "ordinary-note");
			expect(sent.url.startsWith(`${OPERATOR_URL}/`)).toBe(true);
			expect(sent.url).not.toContain("18082");
		} finally {
			await settings.close();
		}
	});
});
