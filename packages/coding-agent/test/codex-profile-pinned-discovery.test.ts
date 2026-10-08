import { expect, test } from "bun:test";
import * as path from "node:path";
import { AuthStorage, closeModelCache, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { getAgentDir, hookFetch, setAgentDir, TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";

test("Codex discovery follows the pinned account without plan-hiding bundled models", async () => {
	using tempDir = TempDir.createSync("@gjc-codex-pin-catalog-");
	const previousAgentDir = getAgentDir();
	closeModelCache();
	setAgentDir(tempDir.path());
	const store = await SqliteAuthCredentialStore.open(":memory:");
	for (const account of ["free", "paid"]) {
		store.saveOAuth("openai-codex", {
			access: `${account}-token`,
			refresh: `${account}-refresh`,
			expires: Date.now() + 3_600_000,
			accountId: `${account}-account`,
			email: `${account}@example.test`,
		});
	}
	const authStorage = new AuthStorage(store);
	await authStorage.reload();
	for (const account of ["free", "paid"]) {
		authStorage.acquireCredentialScope(`${account}-session`);
		authStorage.setSessionCredentialSelector(`${account}-session`, "openai-codex", {
			kind: "email",
			value: `${account}@example.test`,
		});
	}
	const requests: string[] = [];
	using _fetch = hookFetch((input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "registry.npmjs.org") return Response.json({ version: "0.153.4" });
		expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
		const headers = new Headers(init?.headers);
		const bearer = headers.get("Authorization");
		if (!bearer) throw new Error("Expected a fake Codex bearer token");
		expect(["Bearer free-token", "Bearer paid-token"]).toContain(bearer);
		const account = bearer === "Bearer paid-token" ? "paid" : "free";
		expect(headers.get("chatgpt-account-id")).toBe(`${account}-account`);
		requests.push(account);
		const ids = account === "paid" ? ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"] : ["gpt-5.6-luna"];
		return Response.json({
			models: ids.map(slug => ({ slug, display_name: slug, supported_in_api: true })),
		});
	});
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const availableIds = () =>
		registry
			.getAvailable()
			.filter(model => model.provider === "openai-codex")
			.map(model => model.id);
	try {
		await registry.refreshProvider("openai-codex", "online", "free-session");
		// A free account's plan-scoped catalog omits these ids, but GJC never deletes
		// a bundled entry because the signed-in plan lacks it.
		expect(availableIds()).toContain("gpt-6-astra");
		expect(availableIds()).toContain("gpt-5.6-sol");

		await registry.refreshProvider("openai-codex", "online-if-uncached", "paid-session");
		expect(requests).toEqual(["free", "paid"]);
		expect(availableIds()).toContain("gpt-6-astra");
		expect(availableIds()).toContain("gpt-5.6-sol");
	} finally {
		await registry.dispose();
		authStorage.close();
		closeModelCache();
		setAgentDir(previousAgentDir);
	}
});
