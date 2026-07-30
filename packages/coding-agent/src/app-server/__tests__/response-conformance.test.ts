import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageMetadata from "../../../package.json" with { type: "json" };

import { stableValidators } from "../protocol-source/schema-validators.generated";
import { ConnectionState } from "../router/connection-state";
import { processInbound } from "../server";
import {
	experimentalFeatureListHandler,
	fsCreateDirectoryHandler,
	fsGetMetadataHandler,
	fsReadDirectoryHandler,
	fsReadFileHandler,
	fsRemoveHandler,
	fsWriteFileHandler,
	HandlerRegistry,
	type HandlerResult,
} from "../suites/handlers";
import { hooksHandlers } from "../suites/hooks-handlers";
import { configReadHandler, modelListHandler } from "../suites/model-config-handlers";
import { skillsHandlers } from "../suites/skills-handlers";
import { ThreadRuntimeManager } from "../thread-runtime/thread-runtime-manager";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tempDir = mkdtempSync(path.join(os.tmpdir(), "gjc-app-server-response-conformance-"));

function response(frame: Uint8Array | undefined): Record<string, unknown> {
	if (!frame) throw new Error("Expected a response frame");
	return JSON.parse(decoder.decode(frame)) as Record<string, unknown>;
}

function resultOf(value: HandlerResult): unknown {
	if (!value.ok) throw new Error(`Handler returned ${value.errorKey}`);
	return value.result;
}

test("initialize: response validates and sources every required field from runtime", async () => {
	const result = response(
		(
			await processInbound(
				new ConnectionState(),
				new ThreadRuntimeManager(),
				encoder.encode('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
			)
		).response,
	);
	const initializeResult = result.result as Record<string, unknown>;
	const codexHome = process.env.GJC_AGENT_DIR ?? path.join(os.homedir(), ".gjc", "agent");

	expect(stableValidators.clientRequestResults.initialize(initializeResult)).toBe(true);
	expect(initializeResult.userAgent).toBe(`gjc/${packageMetadata.version}`);
	expect(initializeResult.userAgent).toMatch(/^gjc\/[^\s]+$/u);
	expect(initializeResult.codexHome).toBe(codexHome);
	expect(initializeResult.platformFamily).toBe(os.type());
	expect(initializeResult.platformOs).toBe(process.platform);
});

test("implemented handler results validate against stable clientRequestResults", async () => {
	const filePath = path.join(tempDir, "file.txt");
	const directoryPath = path.join(tempDir, "directory");
	writeFileSync(filePath, "contents");

	const cases: Array<{ method: string; result: unknown }> = [
		{ method: "fs/readFile", result: resultOf(await fsReadFileHandler({ path: filePath })) },
		{
			method: "fs/writeFile",
			result: resultOf(await fsWriteFileHandler({ path: path.join(tempDir, "write.txt"), dataBase64: "" })),
		},
		{ method: "fs/getMetadata", result: resultOf(await fsGetMetadataHandler({ path: filePath })) },
		{ method: "fs/readDirectory", result: resultOf(await fsReadDirectoryHandler({ path: tempDir })) },
		{ method: "fs/createDirectory", result: resultOf(await fsCreateDirectoryHandler({ path: directoryPath })) },
		{ method: "fs/remove", result: resultOf(await fsRemoveHandler({ path: directoryPath })) },
		{ method: "config/read", result: resultOf(await configReadHandler({})) },
		{ method: "model/list", result: resultOf(await modelListHandler({})) },
		{ method: "skills/list", result: resultOf(await skillsHandlers["skills/list"]({ cwds: [process.cwd()] })) },
		{ method: "hooks/list", result: resultOf(await hooksHandlers["hooks/list"]({ cwds: [process.cwd()] })) },
		{ method: "experimentalFeature/list", result: resultOf(await experimentalFeatureListHandler({})) },
	];

	for (const { method, result } of cases) {
		const validate = stableValidators.clientRequestResults[method];
		expect(validate, `Missing vendored response definition for ${method}`).toBeDefined();
		expect(validate!(result), `${method} result is schema-valid`).toBe(true);
	}
});

test("outbound response validation fails closed for a malformed handler result", async () => {
	const state = new ConnectionState();
	const registry = new HandlerRegistry();
	registry.register("skills/list", () => ({ ok: true, result: [] }));
	const manager = new ThreadRuntimeManager();

	await processInbound(
		state,
		manager,
		encoder.encode('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
		undefined,
		"websocket",
		registry,
	);
	await processInbound(state, manager, encoder.encode('{"method":"initialized"}'), undefined, "websocket", registry);
	const result = response(
		(
			await processInbound(
				state,
				manager,
				encoder.encode('{"id":2,"method":"skills/list","params":{"cwds":[]}}'),
				undefined,
				"websocket",
				registry,
			)
		).response,
	);

	expect(result).toEqual({ id: 2, error: { code: -32603, message: "Internal error" } });
});

test("cleanup response-conformance temp directory", () => {
	rmSync(tempDir, { recursive: true, force: true });
});
