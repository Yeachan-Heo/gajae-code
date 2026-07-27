import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "../../../config/model-registry";
import { Settings } from "../../../config/settings";
import { Broker } from "../../../sdk/broker/broker";
import { createLifecycleAgentSession } from "../../../sdk/lifecycle-session";
import { AuthStorage } from "../../../session/auth-storage";
import { appendAppServerProjection, readAppServerProjections } from "../../../session/app-server-projection";
import { SessionManager } from "../../../session/session-manager";
import { api, models, providerName, streamSimple } from "../fixtures/stub-model-provider";

const stubModel = models[0];

async function createInProcessLifecycleSession(root: string, name: string) {
	const cwd = path.join(root, name);
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	const created = await createLifecycleAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});
	if ("failure" in created) {
		await authStorage.close();
		throw new Error(`In-process lifecycle session creation failed: ${created.failure.message}`);
	}
	const { session } = created;
	session.modelRegistry.registerProvider(providerName, {
		api,
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "stub",
		streamSimple,
		models: [{ ...stubModel, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const model = session.modelRegistry.find(providerName, stubModel.id);
	if (!model) throw new Error("Expected in-process stub model registration.");
	await session.setDefaultModelSelection(model, "off");
	return { session, authStorage };
}

async function disposeInProcessSession(session: { dispose: () => Promise<void> }, authStorage: AuthStorage): Promise<void> {
	await session.dispose();
	await authStorage.close();
}

test.skip(
	"R2 real broker child-spawn is sandbox-blocked: spawn_failed No ready SDK endpoint remains available; GJC_SDK_SESSION_COMMAND then terminal_uncertain Lifecycle terminal evidence could not be verified after persistence (suspected pre-existing lifecycle persistence verification under bun test); approved in-process fallback below",
	() => {},
);

test("R2 in-process lifecycle sessions stream isolated stub turns with usage and no network", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-r2-in-process-"));
	let first: Awaited<ReturnType<typeof createInProcessLifecycleSession>> | undefined;
	let second: Awaited<ReturnType<typeof createInProcessLifecycleSession>> | undefined;
	try {
		first = await createInProcessLifecycleSession(root, "first");
		second = await createInProcessLifecycleSession(root, "second");
		await Promise.all([first.session.prompt("first session only"), second.session.prompt("second session only")]);

		const firstAssistant = first.session.messages.at(-1);
		const secondAssistant = second.session.messages.at(-1);
		expect(first.session.sessionId).not.toBe(second.session.sessionId);
		expect(firstAssistant).toMatchObject({ role: "assistant", usage: { totalTokens: 6 } });
		expect(secondAssistant).toMatchObject({ role: "assistant", usage: { totalTokens: 6 } });
		expect(JSON.stringify(first.session.messages)).toContain("first session only");
		expect(JSON.stringify(first.session.messages)).not.toContain("second session only");
		expect(JSON.stringify(second.session.messages)).toContain("second session only");
		expect(JSON.stringify(second.session.messages)).not.toContain("first session only");
		expect(JSON.stringify(firstAssistant)).toContain("Stub response.");
		expect(JSON.stringify(secondAssistant)).toContain("Stub response.");
	} finally {
		if (first) await disposeInProcessSession(first.session, first.authStorage);
		if (second) await disposeInProcessSession(second.session, second.authStorage);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("R2 broker validates a captured authority tuple and refuses stale get-endpoint and close requests", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-r2-authority-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "r2-authority-session";
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId, pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: agentDir, stateRoot },
			endpointGeneration: 7,
			pid: process.pid,
			endpointMtimeMs,
		});
		const endpointIncarnation = createHash("sha256")
			.update(JSON.stringify({ endpointGeneration: 7, endpointMtimeMs, pid: process.pid, sessionId }))
			.digest("hex");
		const captured = await broker.handleRequest("session.get_endpoint", {
			sessionId,
			endpointGeneration: 7,
			endpointIncarnation,
		});
		// P1-C: get_endpoint returns the broker-attested authority tuple alongside the endpoint,
		// so an owned close can be fenced against a recycled endpoint.
		expect(captured).toEqual({
			ok: true,
			result: {
				sessionId,
				pid: process.pid,
				token: "session-secret",
				endpointGeneration: 7,
				endpointIncarnation,
				endpointMtimeMs,
			},
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId,
				endpointGeneration: 8,
				endpointIncarnation,
			}),
		).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId,
				endpointGeneration: 7,
				endpointIncarnation: "0".repeat(64),
			}),
		).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
		expect(
			await broker.handleRequest(
				"session.close",
				{ sessionId, endpointGeneration: 7, endpointIncarnation: "0".repeat(64) },
				"r2-stale-close",
			),
		).toMatchObject({ ok: false, error: { code: "endpoint_stale" } });
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("R2 projection records use ordinal cursors and preserve source-key idempotency", async () => {
	const store = SessionManager.inMemory();
	const first = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "projection-first",
		payload: { ordinal: 1 },
	});
	const second = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "projection-second",
		payload: { ordinal: 2 },
	});
	const third = await appendAppServerProjection(store, {
		schemaVersion: 1,
		recordKind: "turn",
		sourceKey: "projection-third",
		payload: { ordinal: 3 },
	});

	expect(readAppServerProjections(store, second.revision)).toEqual({
		records: [
			{
				entryId: third.entryId,
				envelope: {
					schemaVersion: 1,
					recordKind: "turn",
					sourceKey: "projection-third",
					payload: { ordinal: 3 },
				},
			},
		],
		revision: third.revision,
	});
	expect(
		await appendAppServerProjection(store, {
			schemaVersion: 1,
			recordKind: "turn",
			sourceKey: "projection-first",
			payload: { ordinal: 1 },
		}),
	).toEqual({ entryId: first.entryId, revision: first.revision, reused: true });
	await expect(
		appendAppServerProjection(store, {
			schemaVersion: 1,
			recordKind: "turn",
			sourceKey: "projection-first",
			payload: { ordinal: "conflict" },
		}),
	).rejects.toMatchObject({ code: "idempotency_conflict" });
});
