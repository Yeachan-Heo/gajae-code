import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import { Broker, lifecycleTargetForTest, normalizeBrokerInput } from "../src/sdk/broker/broker";
import { deriveLegacyTargetIdentity } from "../src/sdk/broker/identity";

import { lifecyclePublicFailure, runSdkSessionCli } from "../src/sdk/cli/session-cli";
import { SessionLifecycleService } from "../src/sdk/lifecycle";
import { SessionManager } from "../src/session/session-manager";

const brokers: Broker[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const broker of brokers.splice(0)) await broker.stop();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter(key => record[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function generatedUnknownBrokerCodes(seed: number, count: number): string[] {
	let state = seed >>> 0;
	const next = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state;
	};
	return Array.from({ length: count }, () => `generated_${next().toString(36)}_${next().toString(36)}`);
}

function lifecycleService(broker: Broker): SessionLifecycleService {
	return new SessionLifecycleService({
		global: async (operation, input, options) => broker.handleRequest(operation, input, options.idempotencyKey),
	});
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-legacy-admission-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	const saved = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	await saved.ensureOnDisk();
	const sessionId = saved.getSessionId();
	const sessionPath = saved.getSessionFile();
	if (!sessionPath) throw new Error("Missing fixture transcript");
	await saved.close();
	const broker = new Broker({ agentDir });
	brokers.push(broker);
	await broker.start();
	const target = { cwd, stateRoot: path.join(cwd, ".gjc", "state"), sessionId, sessionPath };
	const ledgerPath = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
	const service = lifecycleService(broker);
	return { broker, service, agentDir, target, ledgerPath };
}

test("unresolved legacy states refuse empty-session deletion before admission, including after restart", async () => {
	for (const state of ["accepted", "effect_started", "awaiting_ready", "terminal_uncertain"] as const) {
		const fixtureState = await fixture();
		const { target, ledgerPath, agentDir } = fixtureState;
		let broker = fixtureState.broker;
		const before = await Bun.file(target.sessionPath).text();
		expect(before).not.toContain('"type":"message"');
		await broker.ledger.begin("opaque-legacy-identity", "opaque-request-hash", {
			intendedSessionId: "other-session",
		});
		if (state !== "accepted") await broker.ledger.transition("opaque-legacy-identity", state);
		for (const restart of [false, true]) {
			if (restart) {
				await broker.stop();
				broker = new Broker({ agentDir });
				brokers.push(broker);
				await broker.start();
			}
			const ledgerBefore = await Bun.file(ledgerPath).text();
			const result = await lifecycleService(broker).delete({
				actor: { id: "test", namespace: "test" },
				capability: "session.delete",
				requestKey: `fresh-${state}-${restart}`,
				target,
			});
			expect(result).toMatchObject({
				ok: false,
				certainty: "uncertain",
				error: { code: "legacy_lifecycle_ambiguous" },
			});
			if (result.ok) throw new Error("Unexpected admission");
			const rendered = await renderPublicCommandFailure(lifecyclePublicFailure(result), {
				command: ["sdk", "session", "raw"],
				json: true,
			});
			expect(rendered.envelope.diagnostics?.map(item => item.code)).toEqual(["lifecycle_legacy_history_ambiguous"]);
			expect(rendered.envelope.error.outcomeCertainty).toBe("unknown");
			expect(rendered.envelope.error.retryability).toBe("unknown");
			expect(await Bun.file(target.sessionPath).text()).toBe(before);
			expect(await Bun.file(ledgerPath).text()).toBe(ledgerBefore);
		}
		expect(broker.ledger.get("opaque-legacy-identity")?.state).toBe(
			state === "accepted" ? "accepted" : "terminal_uncertain",
		);
	}
}, 30_000);

test("only proven final unrelated legacy rows pass an actual managed empty-session delete", async () => {
	for (const state of ["terminal_ok", "terminal_error"] as const) {
		const { broker, target } = await fixture();
		await broker.ledger.begin("final-other", "old-hash", { intendedSessionId: "other-session" });
		await broker.ledger.transition("final-other", state, {
			response:
				state === "terminal_ok"
					? { ok: true, result: { sessionId: "other-session" } }
					: { ok: false, error: { code: "fixture_error", message: "final" } },
		});
		const response = await broker.handleRequest("session.delete", target, `fresh-${state}`);
		expect(response).toMatchObject({ ok: true, result: { sessionId: target.sessionId } });
		expect(await Bun.file(target.sessionPath).exists()).toBe(false);
	}
}, 20_000);

test("generated broker codes keep legacy ambiguity uncertain and preserve unrelated certainty", async () => {
	let responseCode = "legacy_lifecycle_ambiguous";
	const service = new SessionLifecycleService({
		global: async () => ({
			ok: false,
			error: { code: responseCode, message: "fixture broker failure" },
		}),
	});
	const cases = [
		{ code: "legacy_lifecycle_ambiguous", certainty: "uncertain" },
		{ code: "terminal_uncertain", certainty: "uncertain" },
		{ code: "cleanup_pending", certainty: "cleanup_pending" },
		{ code: "unavailable", certainty: "retryable" },
		{ code: "broker_restarting", certainty: "retryable" },
		{ code: "readiness_timeout", certainty: "retryable" },
		{ code: "startup_admission_timeout", certainty: "retryable" },
		...generatedUnknownBrokerCodes(0x6832, 96).map(code => ({ code, certainty: "terminal" })),
	];

	for (const [index, item] of cases.entries()) {
		responseCode = item.code;
		const result = await service.delete({
			actor: { id: "generated-code-property", namespace: "test" },
			capability: "session.delete",
			requestKey: `generated-code-${index}`,
			target: { sessionId: "property-session" },
		});
		expect(result).toMatchObject({
			ok: false,
			certainty: item.certainty,
			error: { code: item.code },
		});
		if (item.code !== "legacy_lifecycle_ambiguous") continue;
		if (result.ok) throw new Error("Unexpected successful lifecycle result");
		const rendered = await renderPublicCommandFailure(lifecyclePublicFailure(result), {
			command: ["sdk", "session", "delete", "property-session"],
			json: true,
		});
		expect(rendered.envelope.error.outcomeCertainty).toBe("unknown");
		expect(rendered.envelope.error.retryability).toBe("unknown");
		expect(rendered.envelope.error.nextSteps.map(step => step.description)).toContain(
			"The operation outcome is unknown. Reconcile available evidence and do not blindly retry.",
		);
		expect(rendered.envelope.diagnostics?.map(item => item.code)).toEqual(["lifecycle_legacy_history_ambiguous"]);
	}
});

test("final legacy rows with matching or missing target evidence remain fenced", async () => {
	for (const matching of [true, false]) {
		const { broker, target } = await fixture();
		await broker.ledger.begin("final-opaque", "old-hash", matching ? { intendedSessionId: target.sessionId } : {});
		await broker.ledger.transition("final-opaque", "terminal_error", {
			response: { ok: false, error: { code: "fixture_error", message: "final" } },
		});
		expect(await broker.handleRequest("session.delete", target, "fresh")).toMatchObject({
			ok: false,
			error: { code: "legacy_lifecycle_ambiguous" },
		});
		expect(await Bun.file(target.sessionPath).exists()).toBe(true);
	}
}, 20_000);

test("exact legacy identity is not authority to repeat an uncertain effect or change its input", async () => {
	const { broker, target, agentDir } = await fixture();
	const key = "original-delete-key";
	const normalized = normalizeBrokerInput("session.delete", target);
	if (!("input" in normalized)) throw new Error("Invalid fixture target");
	const identity = await deriveLegacyTargetIdentity(
		agentDir,
		"session.delete",
		key,
		digest(lifecycleTargetForTest("session.delete", normalized.input)),
	);
	await broker.ledger.begin(identity, digest({ operation: "session.delete", input: normalized.input }), {
		intendedSessionId: target.sessionId,
	});
	await broker.ledger.transition(identity, "effect_started");
	await broker.ledger.transition(identity, "terminal_uncertain");
	expect(await broker.handleRequest("session.delete", target, key)).toMatchObject({
		ok: false,
		error: { code: "terminal_uncertain" },
	});
	expect(
		await broker.handleRequest("session.delete", { ...target, sessionPath: `${target.sessionPath}.different` }, key),
	).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
	expect(await Bun.file(target.sessionPath).exists()).toBe(true);
});

test("the raw CLI reports the actual legacy fence, while hostile messages never enter diagnostics", async () => {
	const { broker, target, agentDir, service } = await fixture();
	await broker.ledger.begin("opaque", "opaque-hash");
	const output: unknown[] = [];
	const failure = await runSdkSessionCli(
		{
			action: "raw",
			rawAction: "global",
			operation: "session.delete",
			idempotencyKey: "fresh-cli-key",
			jsonInput: JSON.stringify(target),
			agentDir,
			json: true,
		},
		value => output.push(value),
		() => {},
		{ lifecycleService: service },
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(PublicCommandFailure);
	expect(output).toEqual([]);
	const cliResult = await renderPublicCommandFailure(failure, { command: ["sdk", "session", "raw"], json: true });
	expect(cliResult.exitCode).toBe(1);
	expect(cliResult.envelope).toMatchObject({
		ok: false,
		error: { code: "operation_failed", outcomeCertainty: "unknown", retryability: "unknown" },
		diagnostics: [{ code: "lifecycle_legacy_history_ambiguous" }],
	});
	const hostile = "token=sk-live-SECRET /Users/operator/ledger.jsonl opaque-identity requestHash=secret";
	for (const json of [true, false]) {
		const rendered = await renderPublicCommandFailure(
			lifecyclePublicFailure({
				ok: false,
				operation: "session.delete",
				certainty: "uncertain",
				error: { code: "legacy_lifecycle_ambiguous", message: hostile },
			}),
			{ command: ["sdk", "session", "raw"], json },
		);
		const text = rendered.stdout + rendered.stderr;
		for (const secret of ["sk-live-SECRET", "/Users/operator", "ledger.jsonl", "opaque-identity", "requestHash="])
			expect(text).not.toContain(secret);
		expect(text).toContain("This request was not dispatched; this refusal does not settle earlier effects.");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
	}
	const unproven = await renderPublicCommandFailure(
		lifecyclePublicFailure({
			ok: false,
			operation: "session.delete",
			certainty: "uncertain",
			error: { code: "terminal_uncertain", message: hostile },
		}),
		{ command: ["sdk", "session", "raw"], json: true },
	);
	expect(unproven.envelope.diagnostics).toBeUndefined();
	expect(await Bun.file(target.sessionPath).exists()).toBe(true);
}, 20_000);
