import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthBrokerServerHandle, AuthStorage, SqliteAuthCredentialStore, startAuthBroker } from "../src";

type BrokerFixture = {
	root: string;
	store: SqliteAuthCredentialStore;
	storage: AuthStorage;
	handle: AuthBrokerServerHandle;
};

const fixtures: BrokerFixture[] = [];

async function startBroker(options: {
	bearerTokens: string[];
	readBearerTokens?: () => readonly string[] | Promise<readonly string[]>;
}): Promise<BrokerFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-live-bearer-"));
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
		bearerTokens: options.bearerTokens,
		readBearerTokens: options.readBearerTokens,
		disableRefresher: true,
	});
	const fixture = { root, store, storage, handle };
	fixtures.push(fixture);
	return fixture;
}

async function metadataStatus(url: string, bearer: string): Promise<number> {
	const response = await fetch(`${url}/v1/credentials/metadata`, {
		headers: { authorization: `Bearer ${bearer}` },
	});
	await response.arrayBuffer();
	return response.status;
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.handle.close();
		fixture.storage.close();
		fixture.store.close();
		await fs.rm(fixture.root, { recursive: true, force: true });
	}
});

describe("auth-broker live bearer allow-list", () => {
	test("refuses the previous bearer after the reader returns a replacement", async () => {
		let current = "boot-bearer";
		const fixture = await startBroker({
			bearerTokens: [current],
			readBearerTokens: () => [current],
		});

		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(200);
		current = "rotated-bearer";
		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(401);
		expect(await metadataStatus(fixture.handle.url, "rotated-bearer")).toBe(200);
	});

	test("still allows the boot bearer when the reader returns it", async () => {
		const fixture = await startBroker({
			bearerTokens: ["boot-bearer"],
			readBearerTokens: () => ["boot-bearer"],
		});

		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(200);
		expect(await metadataStatus(fixture.handle.url, "other-bearer")).toBe(401);
	});

	test("still allows the boot bearer when no reader is installed", async () => {
		const fixture = await startBroker({ bearerTokens: ["boot-bearer"] });

		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(200);
		expect(await metadataStatus(fixture.handle.url, "other-bearer")).toBe(401);
	});

	test("still allows the boot bearer when the reader returns nothing", async () => {
		const fixture = await startBroker({
			bearerTokens: ["boot-bearer"],
			readBearerTokens: () => [],
		});

		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(200);
		expect(await metadataStatus(fixture.handle.url, "other-bearer")).toBe(401);
	});

	test("refuses a stale bearer read that finishes after a replacement", async () => {
		let releaseStale: (value: readonly string[]) => void = () => {
			throw new Error("stale read was not armed");
		};
		const stale = new Promise<readonly string[]>(resolve => {
			releaseStale = resolve;
		});
		let holdFirst = true;
		let markStarted: () => void = () => {};
		const started = new Promise<void>(resolve => {
			markStarted = resolve;
		});
		let mode: "replacement" | "empty" | "throw" = "replacement";
		const fixture = await startBroker({
			bearerTokens: ["boot-bearer"],
			readBearerTokens: () => {
				if (holdFirst) {
					holdFirst = false;
					markStarted();
					return stale;
				}
				if (mode === "replacement") return ["rotated-bearer"];
				if (mode === "empty") return [];
				throw new Error("token file unreadable");
			},
		});

		const late = metadataStatus(fixture.handle.url, "boot-bearer");
		const which = await Promise.race([started.then(() => "started" as const), late.then(() => "settled" as const)]);
		expect(await metadataStatus(fixture.handle.url, "rotated-bearer")).toBe(200);
		if (which === "started") {
			releaseStale(["boot-bearer"]);
			expect(await late).toBe(401);
			expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(401);
			expect(await metadataStatus(fixture.handle.url, "rotated-bearer")).toBe(200);

			mode = "empty";
			expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(401);
			expect(await metadataStatus(fixture.handle.url, "rotated-bearer")).toBe(200);

			mode = "throw";
			expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(401);
			expect(await metadataStatus(fixture.handle.url, "rotated-bearer")).toBe(200);
		}
	});

	test("still allows the boot bearer when the reader cannot load a replacement", async () => {
		const fixture = await startBroker({
			bearerTokens: ["boot-bearer"],
			readBearerTokens: () => {
				throw new Error("token file unreadable");
			},
		});

		expect(await metadataStatus(fixture.handle.url, "boot-bearer")).toBe(200);
		expect(await metadataStatus(fixture.handle.url, "other-bearer")).toBe(401);
	});
});
