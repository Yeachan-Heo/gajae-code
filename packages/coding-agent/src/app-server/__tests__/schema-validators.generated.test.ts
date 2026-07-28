import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateAppServerValidators } from "../../../scripts/generate-app-server-validators";
import { experimentalValidators, isJson, stableValidators } from "../protocol-source/schema-validators.generated";

const thread = {
	cliVersion: "1",
	createdAt: 0,
	cwd: "/workspace",
	ephemeral: false,
	id: "thread-1",
	modelProvider: "openai",
	preview: "preview",
	sessionId: "session-1",
	source: "cli",
	status: { type: "idle" },
	turns: [],
	updatedAt: 0,
};
const stableThreadStart = {
	approvalPolicy: "untrusted",
	approvalsReviewer: "user",
	cwd: "/workspace",
	instructionSources: [],
	model: "gpt",
	modelProvider: "openai",
	reasoningEffort: null,
	sandbox: { type: "dangerFullAccess" },
	serviceTier: null,
	thread,
};
const experimentalThreadStart = {
	...stableThreadStart,
	activePermissionProfile: null,
	multiAgentMode: "proactive",
	runtimeWorkspaceRoots: [],
};

test("generated maps validate nested values, enums, required fields, and array elements", () => {
	const client = stableValidators.clientRequestParams["thread/list"];
	expect(client({})).toBe(true);
	expect(client(null)).toBe(false);

	const serverRequest = stableValidators.serverRequestParams.applyPatchApproval;
	expect(
		serverRequest({
			callId: "call",
			conversationId: "thread",
			fileChanges: { "a.ts": { type: "add", content: "text" } },
		}),
	).toBe(true);
	expect(
		serverRequest({ callId: "call", conversationId: "thread", fileChanges: { "a.ts": { type: "add", content: 1 } } }),
	).toBe(false);
	expect(
		serverRequest({
			callId: "call",
			conversationId: "thread",
			fileChanges: { "a.ts": { type: "Add", content: "text" } },
		}),
	).toBe(false);

	const serverResult = stableValidators.serverRequestResults.applyPatchApproval;
	expect(serverResult({ decision: "approved" })).toBe(true);
	expect(serverResult({ decision: "Approved" })).toBe(false);

	expect(stableValidators.clientNotificationParams.initialized(undefined)).toBe(true);
	expect(stableValidators.clientNotificationParams.initialized(null)).toBe(false);

	const notification = stableValidators.serverNotificationParams["process/exited"];
	expect(
		notification({
			exitCode: 0,
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		}),
	).toBe(true);
	expect(
		notification({
			exitCode: "0",
			processHandle: "p",
			stderr: "",
			stderrCapReached: false,
			stdout: "",
			stdoutCapReached: false,
		}),
	).toBe(false);
});

test("ThreadStartResponse profile validators preserve the vendored profile distinction", () => {
	const stable = stableValidators.clientRequestResults["thread/start"];
	const experimental = experimentalValidators.clientRequestResults["thread/start"];
	expect(stable(stableThreadStart)).toBe(true);
	expect(experimental(experimentalThreadStart)).toBe(true);
	const stableWithExperimentalField = { ...stableThreadStart, activePermissionProfile: null };
	const stableAcceptsExperimentalField = stable(stableWithExperimentalField);
	expect(stableAcceptsExperimentalField).toBe(true);
	expect(experimental({ ...experimentalThreadStart, thread: null })).toBe(false);
});

test("generated validators reject values outside the JSON data model", () => {
	const validator = stableValidators.clientRequestParams["thread/start"];
	class NonJsonPayload {}
	const nonEnumerableDate = { cwd: "/workspace" };
	Object.defineProperty(nonEnumerableDate, "secret", { value: new Date(), enumerable: false });
	const symbolMap: Record<PropertyKey, unknown> = { cwd: "/workspace" };
	symbolMap[Symbol("map")] = new Map();
	const symbolPlainValue: Record<PropertyKey, unknown> = { cwd: "/workspace" };
	symbolPlainValue[Symbol("plain")] = "value";
	const nonEnumerableString = { cwd: "/workspace" };
	Object.defineProperty(nonEnumerableString, "secret", { value: "value", enumerable: false });
	const nestedNonEnumerableDate = { cwd: "/workspace", nested: {} };
	Object.defineProperty(nestedNonEnumerableDate.nested, "secret", { value: new Date(), enumerable: false });
	const nestedSymbolMap: { cwd: string; nested: Record<PropertyKey, unknown> } = { cwd: "/workspace", nested: {} };
	nestedSymbolMap.nested[Symbol("map")] = new Map();
	const wirePayload = JSON.parse(JSON.stringify({ cwd: "/workspace", config: { values: [1, 2, 3] } }));

	expect(validator({ cwd: "/workspace" })).toBe(true);
	expect(validator(wirePayload)).toBe(true);
	expect(validator({ cwd: "/workspace", maxTokens: Number.NaN })).toBe(false);
	expect(validator({ cwd: "/workspace", maxTokens: Number.POSITIVE_INFINITY })).toBe(false);
	expect(validator({ cwd: "/workspace", maxTokens: Number.NEGATIVE_INFINITY })).toBe(false);
	expect(validator({ cwd: "/workspace", date: new Date() })).toBe(false);
	expect(validator(nonEnumerableDate)).toBe(false);
	expect(validator(symbolMap)).toBe(false);
	expect(validator(symbolPlainValue)).toBe(false);
	expect(validator(nonEnumerableString)).toBe(false);
	expect(validator(nestedNonEnumerableDate)).toBe(false);
	expect(validator(nestedSymbolMap)).toBe(false);
	expect(validator(new Date())).toBe(false);
	expect(validator(new Map())).toBe(false);
	expect(validator(new NonJsonPayload())).toBe(false);
	expect(validator({ cwd: "/workspace", nested: { value: Number.NaN } })).toBe(false);
});

test("generated validators distinguish required, optional, and absent params", () => {
	const requiredParams = stableValidators.clientRequestParams["thread/start"];
	expect(requiredParams({ cwd: "/workspace" })).toBe(true);
	expect(requiredParams(undefined)).toBe(false);

	const optionalParams = stableValidators.clientRequestParams["account/logout"];
	expect(optionalParams(undefined)).toBe(true);
	expect(optionalParams(null)).toBe(true);
	expect(optionalParams({})).toBe(false);

	const noParams = stableValidators.clientNotificationParams.initialized;
	expect(noParams(undefined)).toBe(true);
	expect(noParams(null)).toBe(false);
});

test("generated JSON guard rejects sparse arrays without rejecting dense arrays", () => {
	const validator = stableValidators.clientRequestParams["thread/start"];
	const sparseNested = [1, , 3];
	const sparseTopLevel = [1, , 3];

	expect(validator({ cwd: "/workspace", config: { values: sparseNested } })).toBe(false);
	expect(isJson(sparseTopLevel)).toBe(false);
	expect(isJson([1, 2, 3])).toBe(true);
	expect(validator({ cwd: "/workspace", config: { values: [1, 2, 3] } })).toBe(true);
});

test("every generated stable validator rejects a non-JSON probe", () => {
	for (const [direction, validators] of Object.entries(stableValidators)) {
		for (const [method, validator] of Object.entries(validators)) {
			expect(validator(new Date()), `stable.${direction}.${method} accepted its non-JSON probe`).toBe(false);
		}
	}
});

test("generator output is byte-identical to the committed validators", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-app-server-validators-"));
	try {
		const generatedPath = path.join(directory, "schema-validators.generated.ts");
		expect(await generateAppServerValidators(generatedPath)).toEqual({
			stable: {
				clientRequestParams: 90,
				clientRequestResults: 90,
				clientNotificationParams: 1,
				serverRequestParams: 10,
				serverRequestResults: 10,
				serverNotificationParams: 70,
			},
			experimental: {
				clientRequestParams: 127,
				clientRequestResults: 127,
				clientNotificationParams: 1,
				serverRequestParams: 11,
				serverRequestResults: 11,
				serverNotificationParams: 70,
			},
		});
		expect(await fs.readFile(generatedPath, "utf8")).toBe(
			await fs.readFile(path.join(import.meta.dir, "../protocol-source/schema-validators.generated.ts"), "utf8"),
		);
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});
