import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkOpenCodexStatus,
	fetchOpenCodexModels,
	resolveOpenCodexEndpoint,
} from "@gajae-code/ai/providers/openai-opencodex-responses";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let tempHome: string;

beforeEach(async () => {
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-opencodex-"));
	process.env.OPENCODEX_HOME = tempHome;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
	else process.env.OPENCODEX_HOME = originalHome;
	await fs.rm(tempHome, { recursive: true, force: true });
});

describe("OpenCodex discovery", () => {
	test("prefers runtime metadata before the default port and preserves raw model ids", async () => {
		await Bun.write(path.join(tempHome, "runtime-port.json"), JSON.stringify({ hostname: "127.0.0.1", port: 10201 }));
		const calls: string[] = [];
		globalThis.fetch = spyOn(globalThis, "fetch").mockImplementation(async input => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("/healthz"))
				return new Response(JSON.stringify({ ok: true, version: "opencodex" }), { status: 200 });
			return new Response(JSON.stringify([{ id: "provider/model", name: "Provider Model" }]), { status: 200 });
		});

		const models = await fetchOpenCodexModels();
		expect(calls).toEqual(["http://127.0.0.1:10201/healthz", "http://127.0.0.1:10201/api/models"]);
		expect(models?.[0]).toMatchObject({
			id: "opencodex/provider/model",
			wireModelId: "provider/model",
			baseUrl: "http://127.0.0.1:10201/v1",
			provider: "opencodex",
		});
	});

	test("falls back to port 10100 when runtime metadata is absent", async () => {
		globalThis.fetch = spyOn(globalThis, "fetch").mockImplementation(async input => {
			expect(String(input)).toBe("http://127.0.0.1:10100/healthz");
			return new Response(JSON.stringify({ ok: true, pid: 42, port: 10100 }), { status: 200 });
		});
		expect(await resolveOpenCodexEndpoint()).toEqual({ baseUrl: "http://127.0.0.1:10100" });
	});

	test("rejects foreign or malformed health responses", async () => {
		globalThis.fetch = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		expect(await resolveOpenCodexEndpoint()).toBeUndefined();
	});

	test("omits a provider when catalog retrieval fails", async () => {
		globalThis.fetch = spyOn(globalThis, "fetch").mockImplementation(async input => {
			if (String(input).endsWith("/healthz"))
				return new Response(JSON.stringify({ ok: true, version: "opencodex" }));
			return new Response("unavailable", { status: 503 });
		});
		expect(await fetchOpenCodexModels()).toBeNull();
	});

	test("status is read-only and reports absence without throwing", async () => {
		globalThis.fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
		const messages: string[] = [];
		await checkOpenCodexStatus(message => messages.push(message));
		expect(messages[0]).toContain("unavailable");
	});
});
