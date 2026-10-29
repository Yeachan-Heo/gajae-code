// TEST ONLY. Separate process entrypoint; never imported or selected by product code.
// Parent driver supplies a freshly-owned, fully isolated environment before SDK imports.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { createAgentSession, type CreateAgentSessionResult } from "@gajae-code/coding-agent/sdk";
import { approvalGate, executionGate, questionToGate } from "@gajae-code/coding-agent/sdk/workflow-gates";
import { createFrameWriter } from "../../src/frame-writer";
import { DesktopHost } from "../../src/host";
import type { DesktopFrame } from "../../src/protocol";
import { serveProtocol } from "../../src/transport";
import {
	fixtureFetch, type FixtureGateContinuation, type FixtureGateSnapshot, QA_PROVIDER, validateFixtureEnvironment,
} from "../../../desktop/scripts/qa-model-fixture";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function main(): Promise<void> {
	const { layout, baseUrl, providerToken } = await validateFixtureEnvironment(process.env);
	// Install before host initialization, registry refresh, or session construction.
	// All actual SDK serialization and SSE parsing remain production implementations.
	globalThis.fetch = fixtureFetch(baseUrl, providerToken, globalThis.fetch);
	await setModelPresetRegistryDisabled({ agentDir: layout.agentDir, disabled: true });
	process.stdout.write = process.stderr.write.bind(process.stderr);
	const frames = createFrameWriter({
		write: async bytes => { await Bun.write(Bun.stdout, bytes); },
		onError: () => { process.exitCode = 1; process.stdin.destroy(); },
	});
	const emit = (frame: DesktopFrame) => frames.write(frame);
	const captured: CreateAgentSessionResult[] = [];
	const continuations: FixtureGateContinuation[] = [];
	let writes = Promise.resolve();
	let writeFailed = false;
	const gateSnapshot = (sessionId?: string): FixtureGateSnapshot => ({
		version: 1, testOnly: true,
		continuations: structuredClone(continuations.filter(entry => sessionId === undefined || entry.sessionId === sessionId)),
	});
	const persist = () => {
		const json = JSON.stringify(gateSnapshot(), null, 2);
		writes = writes.then(async () => { await Bun.write(layout.gateArtifactPath, json); }).catch(() => { writeFailed = true; });
	};
	const host = new DesktopHost({
		dataDir: layout.dataDir,
		emit,
		createSession: async options => {
			if (!options.authStorage || !options.modelRegistry || !options.sessionManager || !options.settings || options.agentDir !== layout.agentDir || options.cwd !== layout.project)
				throw new Error("Fixture requires the real host-owned session dependencies");
			// Preserve this conversation's host-owned registry/auth/settings unchanged:
			// models.list, model.set and SDK requests must share this exact catalog.
			// No replacement registry, fake session methods or stream overrides.
			const result = await createAgentSession({
				...options,
				disableExtensionDiscovery: true,
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
			});
			captured.push(result);
			return result;
		},
	});
	const ownedSession = async (sessionId: string): Promise<CreateAgentSessionResult> => {
		const snapshot = host.snapshot();
		const metadata = snapshot.sessions.find(session => session.id === sessionId);
		if (!metadata || !snapshot.projects.some(project => project.id === metadata.projectId && project.path === layout.project))
			throw new Error("Unknown fixture session");
		const catalog = record(await Bun.file(path.join(layout.dataDir, "catalog.json")).json());
		const saved = Array.isArray(catalog?.sessions)
			? catalog.sessions.map(record).find(entry => entry?.id === sessionId) : undefined;
		if (typeof saved?.file !== "string") throw new Error("Fixture transcript is not committed");
		const transcript = path.resolve(layout.dataDir, "sessions", saved.file);
		if (!transcript.startsWith(`${layout.dataDir}/sessions/`) || await fs.realpath(transcript) !== transcript)
			throw new Error("Non-owned fixture transcript");
		const result = captured.findLast(entry => entry.session.sessionManager.getSessionFile() === transcript);
		if (!result || result.session.model?.provider !== QA_PROVIDER || result.session.model.baseUrl !== baseUrl)
			throw new Error("Non-owned fixture session or provider");
		return result;
	};
	// Private loopback control transport. It can only emit fixed gates and read
	// promise outcomes; it cannot answer, present, ACK, grant or terminalize gates.
	const controls = Bun.serve<undefined>({
		hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024, idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.origin !== `http://127.0.0.1:${controls.port}` || request.headers.get("host") !== `127.0.0.1:${controls.port}` ||
				request.headers.has("Origin") || request.headers.get("X-Desktop-QA-Fixture") !== providerToken || url.search ||
				request.method !== "POST" || request.headers.get("Content-Type") !== "application/json" ||
				!["/gate", "/gates"].includes(url.pathname))
				return new Response("Forbidden fixture gate control", { status: 403 });
			try {
				const body = record(await request.json());
				if (!body || typeof body.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(body.sessionId) ||
					Object.keys(body).some(key => key !== "sessionId" && !(url.pathname === "/gate" && key === "kind")))
					return new Response("Invalid gate control", { status: 400 });
				const result = await ownedSession(body.sessionId);
				if (url.pathname === "/gate") {
					if (body.kind !== "approval" && body.kind !== "question" && body.kind !== "execution")
						return new Response("Invalid gate kind", { status: 400 });
					if (continuations.length >= 32 || continuations.some(entry => entry.sessionId === body.sessionId && entry.state === "pending"))
						return new Response("Fixture gate limit or pending continuation", { status: 409 });
					const emitter = result.session.getWorkflowGateEmitter();
					if (!emitter?.supportsRemoteGateAnswers()) return new Response("Real SDK remote gates unavailable", { status: 409 });
					const entry: FixtureGateContinuation = {
						id: continuations.length + 1, sessionId: body.sessionId, kind: body.kind,
						state: "pending", advanced: false,
					};
					const input = body.kind === "approval" ? approvalGate({ title: "TEST ONLY fixture plan approval" })
						: body.kind === "execution" ? executionGate({ title: "TEST ONLY fixture execution decision" })
						: questionToGate({ id: `fixture-question-${entry.id}`, question: "TEST ONLY fixture question", options: [{ label: "Fixture A" }, { label: "Fixture B" }] });
					const continuation = emitter.emitGate(input);
					continuations.push(entry);
					void continuation.then(answer => {
						entry.state = "resolved";
						entry.advanced = true;
						entry.answer = answer;
						persist();
					}, () => {
						entry.state = "rejected";
						entry.error = "Genuine SDK gate continuation rejected";
						persist();
					});
					persist();
				}
				await writes;
				if (writeFailed) return new Response("Fixture gate artifact unavailable", { status: 503 });
				return Response.json(gateSnapshot(body.sessionId), { headers: { "Cache-Control": "no-store" } });
			} catch {
				return new Response("Invalid or non-owned fixture gate request", { status: 400 });
			}
		},
	});
	persist();
	await Bun.write(layout.gateControlPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${controls.port}` }));
	const stop = () => { void host.close().finally(() => process.stdin.destroy()); };
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await serveProtocol(process.stdin, host, emit);
	} catch {
		emit({ type: "fatal", error: "QA fixture host transport failed" });
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await controls.stop(true);
		await writes;
		await frames.flush();
	}
}

if (import.meta.main) await main();
