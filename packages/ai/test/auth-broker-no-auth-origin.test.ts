import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { type AuthBrokerServerHandle, AuthStorage, SqliteAuthCredentialStore, startAuthBroker } from "../src";

type BrokerFixture = {
	root: string;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	handle: AuthBrokerServerHandle;
	credentialId: number;
};

const fixtures: BrokerFixture[] = [];

async function startFixture(bearerTokens: string[]): Promise<BrokerFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-no-auth-origin-"));
	const store = await SqliteAuthCredentialStore.open(path.join(root, "agent.db"));
	store.saveOAuth("anthropic", {
		access: "access-secret",
		refresh: "refresh-secret",
		expires: Date.now() + 60_000,
	});
	const storage = new AuthStorage(store);
	await storage.reload();
	const credentialId = storage.exportSnapshot().credentials[0]?.id;
	if (credentialId === undefined) throw new Error("fixture credential missing");
	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens,
		disableRefresher: true,
	});
	const fixture = { root, store, storage, handle, credentialId };
	fixtures.push(fixture);
	return fixture;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.handle.close();
		fixture.storage.close();
		fixture.store.close();
		await fs.rm(fixture.root, { recursive: true, force: true });
	}
});

describe("auth-broker no-auth browser origin guard", () => {
	test("preserves tokenless access for non-browser loopback clients", async () => {
		const fixture = await startFixture([]);

		const response = await fetch(`${fixture.handle.url}/v1/credentials/metadata`);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { credentials?: Array<{ id: number }> };
		expect(body.credentials?.[0]?.id).toBe(fixture.credentialId);
	});

	test("preserves public health for browser-origin probes", async () => {
		const fixture = await startFixture([]);

		const response = await fetch(`${fixture.handle.url}/v1/healthz`, {
			headers: { Origin: "https://monitor.example" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	test("rejects tokenless Origin before snapshot disclosure", async () => {
		const fixture = await startFixture([]);

		const response = await fetch(`${fixture.handle.url}/v1/snapshot`, {
			headers: { Origin: "https://attacker.example" },
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.json()).toEqual({ error: "no-auth rejects requests carrying Origin" });
	});

	test("does not log a request-supplied credential-shaped Origin", async () => {
		const fixture = await startFixture([]);
		const info = vi.spyOn(logger, "info");
		const requestSuppliedSecret = "refresh-secret";

		const response = await fetch(`${fixture.handle.url}/v1/snapshot`, {
			headers: { Origin: requestSuppliedSecret },
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "no-auth rejects requests carrying Origin" });
		expect(JSON.stringify(info.mock.calls)).not.toContain(requestSuppliedSecret);
		expect(info).toHaveBeenCalledWith(
			"auth-broker no-auth browser-origin request rejected",
			expect.objectContaining({ originPresent: true }),
		);
	});

	test.each([
		"https://attacker.example",
		"null",
		"not an origin",
		"",
	])("rejects tokenless Origin %p before credential mutation", async origin => {
		const fixture = await startFixture([]);

		const response = await fetch(`${fixture.handle.url}/v1/credential/${fixture.credentialId}/disable`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "text/plain" },
			body: "{}",
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.json()).toEqual({ error: "no-auth rejects requests carrying Origin" });
		expect(fixture.storage.listCredentialInventory()[0]?.disabledCause).toBeNull();
	});

	test("rejects tokenless browser preflight before route handling", async () => {
		const fixture = await startFixture([]);

		const response = await fetch(`${fixture.handle.url}/v1/credential/${fixture.credentialId}/disable`, {
			method: "OPTIONS",
			headers: {
				Origin: "https://attacker.example",
				"Access-Control-Request-Method": "POST",
			},
		});

		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(fixture.storage.listCredentialInventory()[0]?.disabledCause).toBeNull();
	});

	test("rejects wrong bearer values before protected route handling", async () => {
		const fixture = await startFixture(["secret-token"]);
		const requests = [
			{
				method: "GET",
				route: "/v1/credentials/metadata",
				headers: { Authorization: "Bearer wrong-token" },
			},
			{
				method: "GET",
				route: "/v1/snapshot",
				headers: { Authorization: "Bearer wrong-token", Origin: "https://attacker.example" },
			},
			{
				method: "POST",
				route: `/v1/credential/${fixture.credentialId}/disable`,
				headers: {
					Authorization: "Bearer wrong-token",
					Origin: "https://attacker.example",
					"Content-Type": "application/json",
				},
				body: "{}",
			},
		] as const;
		const before = JSON.stringify(fixture.storage.listCredentialInventory());

		for (const request of requests) {
			const { route, ...init } = request;
			const response = await fetch(`${fixture.handle.url}${route}`, init);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
			expect(JSON.stringify(fixture.storage.listCredentialInventory())).toBe(before);
		}
	});

	test("preserves authenticated browser-origin clients", async () => {
		const fixture = await startFixture(["secret-token"]);

		const response = await fetch(`${fixture.handle.url}/v1/credential/${fixture.credentialId}/disable`, {
			method: "POST",
			headers: {
				Authorization: "Bearer secret-token",
				Origin: "https://client.example",
				"Content-Type": "application/json",
			},
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fixture.storage.listCredentialInventory()[0]?.disabledCause).toBe("disabled via auth-broker");
	});
});
