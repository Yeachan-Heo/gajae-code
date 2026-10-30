import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { Agent } from "@gajae-code/agent-core";
import { type Context, getBundledModel, type ImageContent, type SimpleStreamOptions } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { logger, TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRunner, loadExtensions } from "../src/extensibility/extensions";
import { getPromptImageProcessBudgetSnapshot, PromptImageUploadStore } from "../src/sdk/host/prompt-image-upload";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";
import { createSessionImageInput } from "../src/sdk/image-input";
import { AgentSession, type QueuedInputSubmission } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const MiB = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const STATIC_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
let temp: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
const sessions: AgentSession[] = [];
const releases: Array<() => void> = [];
let providerCalls = 0;

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
	const name = Buffer.from(type, "ascii");
	let crc = 0xffffffff;
	for (const byte of Buffer.concat([name, data])) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, name, data, checksum]);
}

function png(width = 1, height = 1, byteLength?: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const source = Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.alloc(height * (width * 3 + 1)))),
		chunk("IEND"),
	]);
	return byteLength === undefined
		? source
		: Buffer.concat([
				source.subarray(0, -12),
				chunk("ruSt", Buffer.alloc(byteLength - source.length - 12)),
				source.subarray(-12),
			]);
}

function image(bytes = png(), mimeType = "image/png"): ImageContent {
	return { type: "image", data: bytes.toString("base64"), mimeType };
}

function deferred() {
	const hold = Promise.withResolvers<void>();
	releases.push(() => hold.resolve());
	return hold;
}

function buildSession(
	responses: MockHandler[] = [() => ({ content: ["done"] })],
	autoResize = false,
	sessionManager = SessionManager.inMemory(temp.path()),
	extensionRunner?: ExtensionRunner,
): AgentSession {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const mock = createMockModel({
		responses: responses.map(response => async (request: Context, options?: SimpleStreamOptions) => {
			providerCalls++;
			return typeof response === "function" ? await response(request, options) : response;
		}),
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "images.autoResize": autoResize });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: registry, extensionRunner });
	sessions.push(session);
	return session;
}

function holdEvaluation(session: AgentSession) {
	const hold = deferred();
	const done = session.trackEvalExecution(hold.promise, new AbortController());
	return { release: () => hold.resolve(), done };
}

async function tick(): Promise<void> {
	await Bun.sleep(0);
}

async function cancel(submission: QueuedInputSubmission): Promise<void> {
	expect(submission.cancel()).toBe(true);
	expect(await submission.terminal).toMatchObject({ disposition: "removed", reason: "cancelled" });
	await tick();
}

async function wireAccept(store: PromptImageUploadStore, bytes: Buffer) {
	const { id } = store.begin("wire", {
		mimeType: "image/png",
		byteLength: bytes.length,
		sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
	});
	for (let offset = 0, sequence = 0; offset < bytes.length; offset += 96 * 1024, sequence++)
		store.append("wire", { id, sequence, data: bytes.subarray(offset, offset + 96 * 1024).toString("base64") });
	await store.finish("wire", { id });
	return store.redeem("wire", [{ id }]);
}

beforeEach(async () => {
	temp = TempDir.createSync("@sdk-image-input-");
	auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	registry = new ModelRegistry(auth);
	providerCalls = 0;
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const session of sessions.splice(0)) await session.dispose();
	auth.close();
	await temp.remove();
	vi.restoreAllMocks();
});

test.each(["prompt", "submit"] as const)("%s waits for the caller's durable preflight fence", async operation => {
	const session = buildSession();
	const evaluation = operation === "submit" ? holdEvaluation(session) : undefined;
	const controller = createSessionImageInput(session);
	const entered = deferred();
	const commit = deferred();
	let calls = 0;
	const options = {
		onPreflightAcceptCommit: async () => {
			calls++;
			entered.resolve();
			await commit.promise;
		},
	};
	const pending =
		operation === "prompt"
			? controller.prompt("durable", [image()], options)
			: controller.submitUserMessage("durable", [image()], { ...options, deliverAs: "followUp" });
	await entered.promise;
	expect(providerCalls).toBe(0);
	expect(session.getQueuedMessages().followUp).toEqual([]);
	commit.resolve();
	const result = await pending;
	expect(calls).toBe(1);
	if (result) {
		expect(await result.admitted).toMatchObject({ submissionId: result.submissionId });
		await cancel(result);
	} else {
		expect(providerCalls).toBe(1);
	}
	evaluation?.release();
	await evaluation?.done;
});

test.each([
	"prompt",
	"submit",
] as const)("%s releases its reservation when durable persistence fails", async operation => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = operation === "submit" ? holdEvaluation(session) : undefined;
	const controller = createSessionImageInput(session);
	const failure = new Error("durable write refused");
	const options = {
		onPreflightAcceptCommit: async () => {
			throw failure;
		},
	};
	const pending =
		operation === "prompt"
			? controller.prompt("not admitted", [image()], options)
			: controller.submitUserMessage("not admitted", [image()], { ...options, deliverAs: "followUp" });
	await expect(pending).rejects.toBe(failure);
	expect(providerCalls).toBe(0);
	expect(session.getQueuedMessages().followUp).toEqual([]);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	evaluation?.release();
	await evaluation?.done;
});

test.each([
	"prompt",
	"submit",
] as const)("%s rechecks cancellation after an awaited persistence fence", async operation => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = operation === "submit" ? holdEvaluation(session) : undefined;
	const controller = createSessionImageInput(session);
	const entered = deferred();
	const commit = deferred();
	const signal = new AbortController();
	const options = {
		preflightSignal: signal.signal,
		onPreflightAcceptCommit: async () => {
			entered.resolve();
			await commit.promise;
		},
	};
	const pending =
		operation === "prompt"
			? controller.prompt("cancel during commit", [image()], options)
			: controller.submitUserMessage("cancel during commit", [image()], { ...options, deliverAs: "followUp" });
	const rejected = pending.then(
		() => undefined,
		error => error,
	);
	await entered.promise;
	signal.abort();
	commit.resolve();
	expect(await rejected).toBeDefined();
	expect(providerCalls).toBe(0);
	expect(session.getQueuedMessages().followUp).toEqual([]);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	evaluation?.release();
	await evaluation?.done;
});

test("preflight persistence without core acceptance releases image capacity", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const failure = new Error("core refused before run acceptance");
	vi.spyOn(session.agent, "prompt").mockRejectedValueOnce(failure);
	let commits = 0;
	await expect(
		createSessionImageInput(session).prompt("no run", [image()], {
			onPreflightAcceptCommit: () => {
				commits++;
			},
		}),
	).rejects.toBe(failure);
	expect(commits).toBe(1);
	expect(providerCalls).toBe(0);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("a command registered during image preparation cannot bypass the fence or discard images", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	let effects = 0;
	let commits = 0;
	const pending = createSessionImageInput(session).prompt("/mutate", [image()], {
		onPreflightAcceptCommit: () => {
			commits++;
		},
	});
	session.setMCPPromptCommands([
		{
			path: "owned-image-command",
			resolvedPath: "owned-image-command",
			source: "project",
			command: {
				name: "mutate",
				description: "Test side effect",
				async execute() {
					effects++;
				},
			},
		},
	]);
	await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
	expect(effects).toBe(0);
	expect(commits).toBe(0);
	expect(providerCalls).toBe(0);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("a throwing public acceptance observer cannot strand an accepted run", async () => {
	const session = buildSession();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	let accepts = 0;
	await session.prompt("observer failure", {
		onRunAccepted: () => {
			accepts++;
			throw new Error("observer failed");
		},
	});
	expect(accepts).toBe(1);
	expect(providerCalls).toBe(1);
	expect(session.isStreaming).toBe(false);
	expect(warning).toHaveBeenCalledWith("Prompt run acceptance observer failed");
});

test("a competing run cannot become the image invocation's resource owner", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const resource = deferred();
	let imageHandle: string | undefined;
	let competingHandle: string | undefined;
	let session: AgentSession;
	session = buildSession([
		async () => {
			competingHandle = session.agent.activeResourceRunId;
			return { content: ["competitor finished"] };
		},
		async () => {
			imageHandle = session.agent.activeResourceRunId;
			if (!imageHandle) throw new Error("Image run did not acquire a resource identity");
			session.agent.resourceLedger.track(imageHandle, "post_prompt", "owned image consumer", resource.promise);
			return { content: ["image finished"] };
		},
	]);
	const prompt = session.agent.prompt.bind(session.agent);
	vi.spyOn(session.agent, "prompt").mockImplementationOnce(async (messages, options) => {
		// Deterministic real competing start after SDK preflight, before THIS
		// invocation's core acceptance. It must never capture this image lease.
		await prompt("competing prompt");
		if (typeof messages === "string" || Array.isArray(options))
			throw new Error("Expected session-owned canonical message invocation");
		return prompt(messages, options);
	});
	await createSessionImageInput(session).prompt("owned image", [image()]);
	expect(competingHandle).toBeDefined();
	expect(imageHandle).toBeDefined();
	expect(imageHandle).not.toBe(competingHandle);
	expect(
		session.agent.resourceLedger.pending(imageHandle!).some(entry => entry.label === "owned image consumer"),
	).toBe(true);
	expect(getPromptImageProcessBudgetSnapshot().sourceBytes).toBeGreaterThan(baseline.sourceBytes);
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("registered extension commands reject image input before handler side effects", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const marker = path.join(temp.path(), "extension-side-effect");
	const extension = path.join(temp.path(), "image-command.ts");
	await Bun.write(
		extension,
		`export default function(api) { api.registerCommand("image-effect", { description: "owned fixture", handler: async () => { await Bun.write(${JSON.stringify(marker)}, "executed"); } }); }`,
	);
	const loaded = await loadExtensions([extension], temp.path());
	expect(loaded.errors).toEqual([]);
	const manager = SessionManager.inMemory(temp.path());
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, temp.path(), manager, registry);
	const session = buildSession(undefined, false, manager, runner);
	let commits = 0;
	await expect(
		createSessionImageInput(session).prompt("/image-effect", [image()], {
			onPreflightAcceptCommit: () => {
				commits++;
			},
		}),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(await Bun.file(marker).exists()).toBe(false);
	expect(commits).toBe(0);
	expect(providerCalls).toBe(0);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("image acceptance observers run after quota ownership and cannot strand the run", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	let calls = 0;
	let observedScope: unknown;
	let observedResource: string | undefined;
	await createSessionImageInput(session).prompt("owned observer", [image()], {
		onRunAccepted: run => {
			calls++;
			observedScope = run.scope;
			observedResource = session.agent.activeResourceRunId;
			throw new Error("image observer failure");
		},
	});
	expect(observedScope).toBeDefined();
	expect(observedResource).toBeDefined();
	expect(calls).toBe(1);
	expect(providerCalls).toBe(1);
	expect(session.isStreaming).toBe(false);
	expect(warning).toHaveBeenCalledWith("Prompt run acceptance observer failed");
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("asynchronous image run observers cannot create unhandled rejections or gate execution", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const observer = deferred();
	await createSessionImageInput(session).prompt("async observer", [image()], {
		onRunAccepted: () => observer.promise,
	});
	expect(providerCalls).toBe(1);
	expect(session.isStreaming).toBe(false);
	observer.reject(new Error("late observer failure"));
	await tick();
	expect(warning).toHaveBeenCalledWith("Prompt run acceptance observer failed");
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("factory cannot reset a live quota or revive a manually disposed controller", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const first = createSessionImageInput(session);
	expect(createSessionImageInput(session)).toBe(first);
	const submission = await first.submitUserMessage("image", [image()], { deliverAs: "followUp" });
	const retained = getPromptImageProcessBudgetSnapshot();
	first.dispose();
	expect(createSessionImageInput(session)).toBe(first);
	await expect(first.prompt("stale", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	await cancel(submission);
	expect(submission.cancel()).toBe(false);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test("queued admission returns the real receipt and cancel releases only its own lease", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const controller = createSessionImageInput(session);
	const source = png();
	const encoded = image(source);
	const cost = source.length + encoded.data.length;
	const first = await controller.submitUserMessage("one", [encoded], { deliverAs: "steer" });
	const second = await controller.submitUserMessage("two", [encoded], {
		deliverAs: "followUp",
		queuePolicy: "sequential",
	});
	expect(await first.admitted).toMatchObject({ submissionId: first.submissionId, delivery: "steer" });
	expect(await second.admitted).toMatchObject({
		submissionId: second.submissionId,
		delivery: "followUp",
		queuePolicy: "sequential",
	});
	expect(getPromptImageProcessBudgetSnapshot().sourceBytes - baseline.sourceBytes).toBe(cost * 2);
	await cancel(first);
	expect(getPromptImageProcessBudgetSnapshot().sourceBytes - baseline.sourceBytes).toBe(cost);
	await cancel(second);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test.each([
	"prompt",
	"submit",
] as const)("%s cancellation before admission discards only owned staged bytes", async operation => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const controller = createSessionImageInput(session);
	const signal = new AbortController();
	const pending =
		operation === "prompt"
			? controller.prompt("cancelled", [image()], { preflightSignal: signal.signal })
			: controller.submitUserMessage("cancelled", [image()], {
					deliverAs: "followUp",
					preflightSignal: signal.signal,
				});
	expect(getPromptImageProcessBudgetSnapshot().concurrentFinishes).toBe(baseline.concurrentFinishes + 1);
	signal.abort();
	await expect(pending).rejects.toBeDefined();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});

test("signal cancellation after admission removes the exact tracked image submission", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const signal = new AbortController();
	const submission = await createSessionImageInput(session).submitUserMessage("cancel", [image()], {
		deliverAs: "followUp",
		preflightSignal: signal.signal,
	});
	await submission.admitted;
	signal.abort();
	expect(await submission.terminal).toMatchObject({ disposition: "removed", reason: "cancelled" });
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test("concurrent preparation shares one decoder slot without deleting the winning request", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const controller = createSessionImageInput(session);
	const first = controller.submitUserMessage("winner", [image()], { deliverAs: "followUp" });
	const second = controller.submitUserMessage("loser", [image()], { deliverAs: "followUp" });
	await expect(second).rejects.toMatchObject({ code: "busy" });
	const submission = await first;
	expect(session.getQueuedMessages().followUp).toContain("winner");
	expect(session.getQueuedMessages().followUp).not.toContain("loser");
	await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	evaluation.release();
	await evaluation.done;
});

test.each([
	"block",
	"unsupported",
	"model-change",
	"resize-change",
] as const)("%s prevents final dispatch without a provider turn", async reason => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	if (reason === "block") session.settings.set("images.blockImages", true);
	if (reason === "unsupported") session.agent.setModel({ ...session.model!, input: ["text"] });
	const pending = createSessionImageInput(session).prompt("image", [image()]);
	if (reason === "model-change") session.agent.setModel({ ...session.model! });
	if (reason === "resize-change") session.settings.set("images.autoResize", true);
	await expect(pending).rejects.toMatchObject({
		code: reason === "block" ? "operation_prohibited" : reason === "unsupported" ? "invalid_input" : "busy",
	});
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});

test.each([
	["whitespace", () => ({ ...image(), data: `${image().data}\n` })],
	["padding bits", () => ({ type: "image", data: "AB==", mimeType: "image/png" }) as ImageContent],
	["unpadded", () => ({ ...image(), data: "AA" })],
	["MIME mismatch", () => image(png(), "image/jpeg")],
	["MIME alias", () => image(png(), "image/jpg")],
	["corrupt decoder input", () => image(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(40)]))],
	["renderer identity", () => ({ ...image(), ownerId: "other" })],
	["path", () => ({ ...image(), path: "/tmp/payload.png" })],
] as const)("rejects %s with exact cleanup", async (_name, source) => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	await expect(createSessionImageInput(buildSession()).prompt("invalid", [source()])).rejects.toMatchObject({
		code: "invalid_input",
	});
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});

test("rejects animated images, image count and decoded-pixel limits before admission", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const controller = createSessionImageInput(buildSession());
	const marker = STATIC_GIF.indexOf(0x2c);
	const frame = STATIC_GIF.subarray(marker, -1);
	const animated = Buffer.concat([STATIC_GIF.subarray(0, -1), frame, Buffer.from([0x3b])]);
	await expect(controller.prompt("animated", [image(animated, "image/gif")])).rejects.toMatchObject({
		code: "invalid_input",
	});
	await expect(
		controller.prompt(
			"count",
			Array.from({ length: 17 }, () => image()),
		),
	).rejects.toMatchObject({ code: "invalid_input" });
	const invalid = png();
	const header = Buffer.from(invalid.subarray(16, 29));
	header.writeUInt32BE(20_001, 0);
	const dimension = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), invalid.subarray(33)]);
	await expect(controller.prompt("dimensions", [image(dimension)])).rejects.toMatchObject({ code: "invalid_input" });
	header.writeUInt32BE(10_000, 0);
	header.writeUInt32BE(4_001, 4);
	const pixels = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), invalid.subarray(33)]);
	await expect(controller.prompt("pixels", [image(pixels)])).rejects.toMatchObject({ code: "invalid_input" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});

test("supported static MIME types round-trip canonical bytes when auto-resize is disabled", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const bytes = png();
	const sources = [
		image(bytes),
		image(Buffer.from(await new Bun.Image(bytes).jpeg().bytes()), "image/jpeg"),
		image(Buffer.from(await new Bun.Image(bytes).webp().bytes()), "image/webp"),
		image(STATIC_GIF, "image/gif"),
	];
	const submission = await createSessionImageInput(session).submitUserMessage("all formats", sources, {
		deliverAs: "followUp",
	});
	const queued = session.agent.snapshotFollowUp()[0];
	if (queued?.role !== "user" || !Array.isArray(queued.content)) throw new Error("Expected queued user content");
	expect(queued.content.filter(part => part.type === "image")).toEqual(sources);
	await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test("normalization uses canonical dimensions under live shared transient reservations", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession(undefined, true);
	const evaluation = holdEvaluation(session);
	const pending = createSessionImageInput(session).submitUserMessage("resize", [image(png(2000, 1))], {
		deliverAs: "followUp",
	});
	const inFlight = getPromptImageProcessBudgetSnapshot();
	expect(inFlight.transientBytes).toBeGreaterThan(baseline.transientBytes);
	expect(inFlight.concurrentFinishes).toBe(baseline.concurrentFinishes + 1);
	const submission = await pending;
	const queued = session.agent.snapshotFollowUp()[0];
	if (queued?.role !== "user" || !Array.isArray(queued.content)) throw new Error("Expected queued user image");
	const normalized = queued.content.find(part => part.type === "image");
	if (normalized?.type !== "image") throw new Error("Expected normalized image");
	const metadata = await new Bun.Image(Buffer.from(normalized.data, "base64")).metadata();
	expect(metadata.width).toBe(1568);
	expect(metadata.height).toBe(1);
	await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	evaluation.release();
	await evaluation.done;
});

test("normalizer refuses insufficient scratch capacity before its encoder runs", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession(undefined, true);
	await expect(
		createSessionImageInput(session).prompt("large raster", [image(png(4000, 4000))]),
	).rejects.toMatchObject({ code: "busy" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
}, 30_000);

test("exact image-byte and count boundaries admit valid sources and reject the next byte", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const controller = createSessionImageInput(session);
	const exact = await controller.submitUserMessage("20 MiB", [image(png(1, 1, 20 * MiB))], { deliverAs: "followUp" });
	await cancel(exact);
	await expect(
		controller.submitUserMessage("over 20 MiB", [image(png(1, 1, 20 * MiB + 1))], { deliverAs: "followUp" }),
	).rejects.toMatchObject({ code: "invalid_input" });
	const sixteen = await controller.submitUserMessage(
		"sixteen",
		Array.from({ length: 16 }, () => image()),
		{ deliverAs: "followUp" },
	);
	await cancel(sixteen);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
}, 60_000);

test("repeated facade creation cannot evade 64 MiB accepted-session quota", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const source = image(png(1, 1, 17 * MiB));
	const submissions: QueuedInputSubmission[] = [];
	for (let index = 0; index < 3; index++)
		submissions.push(
			await createSessionImageInput(session).submitUserMessage(`image ${index}`, [source], {
				deliverAs: "followUp",
			}),
		);
	await expect(
		createSessionImageInput(session).submitUserMessage("overflow", [source], { deliverAs: "followUp" }),
	).rejects.toMatchObject({ code: "busy" });
	await cancel(submissions.shift()!);
	const replacement = await createSessionImageInput(session).submitUserMessage("replacement", [source], {
		deliverAs: "followUp",
	});
	for (const submission of [...submissions, replacement]) await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
}, 60_000);

test("a public preparation holds the same decoder slot as its private SDK-host peer", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const wire = new PromptImageUploadStore(() => true, session);
	const bytes = png();
	const { id } = wire.begin("wire", {
		mimeType: "image/png",
		byteLength: bytes.length,
		sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
	});
	wire.append("wire", { id, sequence: 0, data: bytes.toString("base64") });
	try {
		const pending = createSessionImageInput(session).submitUserMessage("public", [image()], {
			deliverAs: "followUp",
		});
		await expect(wire.finish("wire", { id })).rejects.toMatchObject({ code: "busy" });
		const submission = await pending;
		await wire.finish("wire", { id });
		const lease = wire.redeem("wire", [{ id }]);
		try {
			await cancel(submission);
			expect(getPromptImageProcessBudgetSnapshot().sourceBytes).toBeGreaterThan(baseline.sourceBytes);
		} finally {
			lease.release();
		}
	} finally {
		wire.close();
	}
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test("wire host and facade share accepted-session budget, staging bytes and decoder slots", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const evaluation = holdEvaluation(session);
	const wire = new PromptImageUploadStore(() => true, session);
	const bytes = png(1, 1, 17 * MiB);
	const leases = [];
	try {
		for (let index = 0; index < 3; index++) leases.push(await wireAccept(wire, bytes));
		await expect(
			createSessionImageInput(session).submitUserMessage("overflow", [image(bytes)], { deliverAs: "followUp" }),
		).rejects.toMatchObject({ code: "busy" });
		leases[0]!.release();
		const submission = await createSessionImageInput(session).submitUserMessage("recovered", [image(bytes)], {
			deliverAs: "followUp",
		});
		await cancel(submission);
		// Public failures cannot consume or discard another authenticated owner's leases.
		for (const lease of leases.slice(1)) expect(lease.images[0]!.data).toBe(bytes.toString("base64"));
	} finally {
		for (const lease of leases) lease.release();
		wire.close();
	}
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	evaluation.release();
	await evaluation.done;
}, 60_000);

test("separate real sessions still share process source, encoded and transient capacity", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const source = image(png(1, 1, 19 * MiB));
	const submissions: QueuedInputSubmission[] = [];
	const evaluations = [];
	// The fifth preparation must account for both borrowed source base64 and
	// its new accepted copy; four retained requests leave insufficient peak capacity.
	for (let index = 0; index < 4; index++) {
		const session = buildSession();
		evaluations.push(holdEvaluation(session));
		submissions.push(
			await createSessionImageInput(session).submitUserMessage("retain", [source], { deliverAs: "followUp" }),
		);
	}
	const last = buildSession();
	const held = holdEvaluation(last);
	await expect(
		createSessionImageInput(last).submitUserMessage("process overflow", [source], { deliverAs: "followUp" }),
	).rejects.toMatchObject({ code: "busy" });
	await cancel(submissions.shift()!);
	const recovered = await createSessionImageInput(last).submitUserMessage("recovered", [source], {
		deliverAs: "followUp",
	});
	for (const submission of [...submissions, recovered]) await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	for (const evaluation of [...evaluations, held]) evaluation.release();
	await Promise.all([...evaluations, held].map(evaluation => evaluation.done));
}, 60_000);

test("initial prompt retains through genuine terminal until a late actual resource settles", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const started = deferred();
	const finish = deferred();
	const resource = deferred();
	let handle: string | undefined;
	let session: AgentSession;
	session = buildSession([
		async () => {
			handle = session.activePromptHandle;
			if (!handle) throw new Error("Expected actual prompt resource handle");
			session.agent.resourceLedger.track(handle, "post_prompt", "late image consumer", resource.promise);
			started.resolve();
			await finish.promise;
			return { content: ["done"] };
		},
	]);
	const controller = createSessionImageInput(session);
	const pending = controller.prompt("image", [image()]);
	await started.promise;
	const retained = getPromptImageProcessBudgetSnapshot();
	finish.resolve();
	await pending;
	if (!handle) throw new Error("Expected captured real resource identity");
	expect(session.agent.resourceLedger.pending(handle).some(entry => entry.label === "late image consumer")).toBe(true);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	controller.dispose();
	await session.dispose();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(1);
});

test("busy steer returns its real joined-run receipt without sampling a later current handle", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const started = deferred();
	const finish = deferred();
	const resource = deferred();
	let session: AgentSession;
	session = buildSession([
		async () => {
			const handle = session.activePromptHandle;
			if (!handle) throw new Error("Expected live resource handle");
			session.agent.resourceLedger.track(handle, "post_prompt", "busy image consumer", resource.promise);
			started.resolve();
			await finish.promise;
			return { content: ["first"] };
		},
		() => ({ content: ["steered"] }),
	]);
	const seed = session.prompt("seed");
	await started.promise;
	const controller = createSessionImageInput(session);
	const submission = await controller.submitUserMessage("busy image", [image()], { deliverAs: "steer" });
	expect(await submission.admitted).toMatchObject({ delivery: "steer" });
	const retained = getPromptImageProcessBudgetSnapshot();
	await expect(controller.prompt("busy prompt", [image()])).rejects.toMatchObject({ code: "busy" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	finish.resolve();
	expect(await submission.execution).toMatchObject({ disposition: "joined-current-run" });
	expect(submission.cancel()).toBe(false);
	expect(await submission.terminal).toMatchObject({ disposition: "completed" });
	await seed;
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("abort is not resource-settlement proof for an accepted initial prompt", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const started = deferred();
	const finish = deferred();
	const resource = deferred();
	let session: AgentSession;
	session = buildSession([
		async () => {
			const handle = session.activePromptHandle;
			if (!handle) throw new Error("Expected live prompt handle");
			session.agent.resourceLedger.track(handle, "post_prompt", "abort late consumer", resource.promise);
			started.resolve();
			await finish.promise;
			return { content: ["cancelled"] };
		},
	]);
	const pending = createSessionImageInput(session).prompt("image", [image()]);
	await started.promise;
	const retained = getPromptImageProcessBudgetSnapshot();
	const aborting = session.abort({ cause: "internal" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	finish.resolve();
	await Promise.all([pending, aborting]);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("a real queued no-model refusal settles the image receipt and releases quota", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const entered = deferred();
	const finish = deferred();
	const session = buildSession([
		async () => {
			entered.resolve();
			await finish.promise;
			return { content: ["predecessor"] };
		},
	]);
	const predecessor = session.prompt("predecessor");
	await entered.promise;
	const submit = session.submitUserMessage.bind(session);
	const submitSpy = vi
		.spyOn(session, "submitUserMessage")
		.mockImplementation((content, options) =>
			submit(content, { ...options, sdkRunCapability: createSdkRunCapability("refused-image-owner") }),
		);
	let submission: QueuedInputSubmission;
	try {
		submission = await createSessionImageInput(session).submitUserMessage("queued image", [image()], {
			deliverAs: "followUp",
		});
	} finally {
		submitSpy.mockRestore();
	}
	expect(getPromptImageProcessBudgetSnapshot().sourceBytes).toBeGreaterThan(baseline.sourceBytes);
	session.agent.setModel(undefined);
	finish.resolve();
	expect(await submission.execution).toMatchObject({ disposition: "removed", reason: "refused" });
	expect(await submission.terminal).toMatchObject({ disposition: "removed", reason: "refused" });
	await predecessor;
	await session.waitForIdle();
	await tick();
	expect(submission.cancel()).toBe(false);
	expect(providerCalls).toBe(1);
	expect(session.agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("executed queued receipt binds exact terminal attempt and survives controller disposal", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const started = deferred();
	const finish = deferred();
	const resource = deferred();
	let session: AgentSession;
	session = buildSession([
		() => ({ content: ["seed complete"] }),
		async () => {
			const handle = session.activePromptHandle;
			if (!handle) throw new Error("Expected real resource handle");
			session.agent.resourceLedger.track(handle, "post_prompt", "queued late consumer", resource.promise);
			started.resolve();
			await finish.promise;
			return { content: ["done"] };
		},
	]);
	// Idle follow-ups continue an established conversation; they deliberately
	// do not start the first turn of a brand-new empty session.
	await session.prompt("seed conversation");
	expect(providerCalls).toBe(1);
	const controller = createSessionImageInput(session);
	const submission = await controller.submitUserMessage("queued image", [image()], { deliverAs: "followUp" });
	await started.promise;
	expect(providerCalls).toBe(2);
	expect(await submission.execution).toMatchObject({ disposition: "promoted-to-run" });
	expect(submission.cancel()).toBe(false);
	const retained = getPromptImageProcessBudgetSnapshot();
	controller.dispose();
	finish.resolve();
	expect(await submission.terminal).toMatchObject({ disposition: "completed" });
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
});

test("notifications cannot rebind a facade before a committed transition has completed", async () => {
	const session = buildSession();
	const entered = deferred();
	const commitTail = deferred();
	session.registerToolSessionTransitionCleanup(() => {
		entered.resolve();
		return commitTail.promise;
	});
	const predecessor = createSessionImageInput(session);
	const generation = session.sessionLifecycle.generation;
	await session.notifySessionIdentityChanged();
	expect(session.sessionLifecycle.generation).toBe(generation);
	expect(createSessionImageInput(session)).toBe(predecessor);
	const transition = session.newSession();
	await entered.promise;
	expect(session.sessionLifecycle.generation).toBeGreaterThan(generation);
	expect(session.sessionLifecycle.transitioning).toBe(true);
	await session.notifySessionIdentityChanged();
	expect(createSessionImageInput(session)).toBe(predecessor);
	await expect(predecessor.prompt("in transition", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	commitTail.resolve();
	expect(await transition).toBe(true);
	expect(session.sessionLifecycle.transitioning).toBe(false);
	expect(createSessionImageInput(session)).not.toBe(predecessor);
	expect(providerCalls).toBe(0);
});

test("committed replacement permits a fresh facade but never revives its predecessor", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const predecessor = createSessionImageInput(session);
	const originalId = session.sessionId;
	expect(await session.newSession()).toBe(true);
	expect(session.sessionId).not.toBe(originalId);
	const successor = createSessionImageInput(session);
	expect(successor).not.toBe(predecessor);
	await expect(predecessor.prompt("stale", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	const evaluation = holdEvaluation(session);
	const submission = await successor.submitUserMessage("new identity", [image()], { deliverAs: "followUp" });
	await cancel(submission);
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
	evaluation.release();
	await evaluation.done;
});

test.each([
	"quarantined",
	"observation-failed",
] as const)("%s retains accepted capacity even after the late consumer finishes", async reason => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const started = deferred();
	const finish = deferred();
	const resource = deferred();
	let handle: string | undefined;
	let session: AgentSession;
	session = buildSession([
		async () => {
			handle = session.activePromptHandle;
			if (!handle) throw new Error("Expected actual resource identity");
			session.agent.resourceLedger.track(handle, "post_prompt", "unfenced consumer", resource.promise);
			started.resolve();
			await finish.promise;
			return { content: ["done"] };
		},
	]);
	const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
	const controller = createSessionImageInput(session);
	const pending = controller.prompt("retain without proof", [image()]);
	await started.promise;
	if (!handle) throw new Error("Expected captured resource handle");
	const retained = getPromptImageProcessBudgetSnapshot();
	const observation = vi.spyOn(session.agent.resourceLedger, "waitForSettlement");
	if (reason === "quarantined")
		observation.mockResolvedValue({ status: "unfenced", reason: "quarantined", pending: [] });
	else observation.mockRejectedValue(new Error("observation unavailable"));
	finish.resolve();
	await pending;
	await tick();
	controller.dispose();
	resource.resolve();
	await tick();
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(retained);
	expect(retained.sourceBytes).toBeGreaterThan(baseline.sourceBytes);
	expect(warning.mock.calls.some(call => String(call[0]).includes("capacity retained"))).toBe(true);
	// Intentionally no test-only release capability: unfenced capacity is retained
	// process-wide just as in production (one tiny image per adversarial case).
});

test("owner replacement followed by ABA cannot revive the old facade", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const controller = createSessionImageInput(session);
	const original = session.sessionManager;
	session.sessionManager = SessionManager.inMemory(temp.path());
	await expect(controller.prompt("replacement", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	session.sessionManager = original;
	expect(createSessionImageInput(session)).toBe(controller);
	await expect(controller.prompt("ABA", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});

test("real A→B→A session switches never revive predecessor controllers", async () => {
	const manager = SessionManager.create(
		temp.path(),
		SessionManager.explicitDestination(path.join(temp.path(), "sessions")),
	);
	const session = buildSession(undefined, false, manager);
	const originalId = session.sessionId;
	manager.appendMessage({ role: "user", content: "persisted seed", timestamp: Date.now() });
	// User-only sessions deliberately remain memory-only until explicitly
	// persisted. Switching a nonexistent path otherwise creates a new identity.
	await manager.ensureOnDisk();
	await manager.flush();
	const originalFile = manager.getSessionFile();
	if (!originalFile) throw new Error("Expected persisted session file");
	const predecessor = createSessionImageInput(session);
	expect(await session.newSession()).toBe(true);
	const intermediate = createSessionImageInput(session);
	expect(intermediate).not.toBe(predecessor);
	expect(await session.switchSession(originalFile)).toBe(true);
	expect(session.sessionId).toBe(originalId);
	const successor = createSessionImageInput(session);
	expect(successor).not.toBe(predecessor);
	expect(successor).not.toBe(intermediate);
	await expect(predecessor.prompt("old A", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	await expect(intermediate.prompt("old B", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	expect(providerCalls).toBe(0);
});

test("session disposal during prepare cannot resurrect a decoder lease", async () => {
	const baseline = getPromptImageProcessBudgetSnapshot();
	const session = buildSession();
	const controller = createSessionImageInput(session);
	const pending = controller.prompt("revoked", [image()]);
	const disposing = session.dispose();
	await expect(pending).rejects.toBeDefined();
	await disposing;
	expect(createSessionImageInput(session)).toBe(controller);
	await expect(controller.prompt("stale", [image()])).rejects.toMatchObject({ code: "resource_gone" });
	expect(getPromptImageProcessBudgetSnapshot()).toEqual(baseline);
	expect(providerCalls).toBe(0);
});
