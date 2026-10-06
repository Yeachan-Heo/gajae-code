import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthBrokerServerHandle, AuthStorage, SqliteAuthCredentialStore, startAuthBroker } from "../src";
import { hostHeaderMatchesBind, parseBind } from "../src/utils/parse-bind";

describe("hostHeaderMatchesBind", () => {
	test("accepts only the bound hostname and port", () => {
		const bind = parseBind("127.0.0.1:4000");
		expect(hostHeaderMatchesBind("127.0.0.1:4000", bind)).toBe(true);
		expect(hostHeaderMatchesBind("attacker.example:4000", bind)).toBe(false);
		expect(hostHeaderMatchesBind("127.0.0.1:4001", bind)).toBe(false);
		expect(hostHeaderMatchesBind("127.0.0.1", bind)).toBe(false);
		expect(hostHeaderMatchesBind("127.0.0.1.attacker.example:4000", bind)).toBe(false);
		expect(hostHeaderMatchesBind(null, bind)).toBe(false);
	});

	test("accepts a bracketed IPv6 loopback bind", () => {
		const bind = parseBind("[::1]:4000");
		expect(hostHeaderMatchesBind("[::1]:4000", bind)).toBe(true);
		expect(hostHeaderMatchesBind("127.0.0.1:4000", bind)).toBe(false);
	});
});

type BrokerFixture = {
	root: string;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	handle: AuthBrokerServerHandle;
};

const fixtures: BrokerFixture[] = [];

async function startFixture(bearerTokens: string[]): Promise<BrokerFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-host-"));
	const store = await SqliteAuthCredentialStore.open(path.join(root, "agent.db"));
	store.saveOAuth("anthropic", {
		access: "access-secret",
		refresh: "refresh-secret",
		expires: Date.now() + 60_000,
	});
	const storage = new AuthStorage(store);
	await storage.reload();
	const handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens,
		disableRefresher: true,
	});
	const fixture = { root, store, storage, handle };
	fixtures.push(fixture);
	return fixture;
}

function httpGet(
	port: number,
	hostHeader: string,
	requestPath: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; raw: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port }, () => {
			const extra = Object.entries(headers)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join("");
			socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}Connection: close\r\n\r\n`);
		});
		const chunks: Uint8Array[] = [];
		socket.on("data", chunk => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		socket.on("error", reject);
		socket.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const status = Number(raw.split(" ")[1]);
			resolve({ status, raw });
		});
	});
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.handle.close();
		fixture.storage.close();
		fixture.store.close();
		await fs.rm(fixture.root, { recursive: true, force: true });
	}
});

describe("auth-broker tokenless host pin", () => {
	test("serves metadata to the bound host and rejects a rebound name", async () => {
		const fixture = await startFixture([]);
		const port = fixture.handle.port;
		const bound = await httpGet(port, `127.0.0.1:${port}`, "/v1/credentials/metadata");
		expect(bound.status).toBe(200);

		const rebound = await httpGet(port, `attacker.example:${port}`, "/v1/credentials/metadata");
		expect(rebound.status).toBe(403);
		expect(rebound.raw).toContain("no-auth rejects a host that is not the loopback bind");
		expect(rebound.raw).not.toContain("access-secret");
		expect(rebound.raw).not.toContain("refresh-secret");
	});

	test("still serves healthz to a non-bind host", async () => {
		const fixture = await startFixture([]);
		const response = await httpGet(fixture.handle.port, "attacker.example:80", "/v1/healthz");
		expect(response.status).toBe(200);
		expect(response.raw).toContain('"ok":true');
	});

	test("does not pin Host when a bearer token is configured", async () => {
		const fixture = await startFixture(["secret-token"]);
		const response = await httpGet(fixture.handle.port, "broker.example:9", "/v1/credentials/metadata", {
			Authorization: "Bearer secret-token",
		});
		expect(response.status).toBe(200);
	});
});
