import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import type { Settings } from "@gajae-code/coding-agent/config/settings";
import type { CustomToolContext } from "@gajae-code/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import { imageGenTool } from "../../src/tools/image-gen";

const originalFetch = global.fetch;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dirs: string[] = [];
const links: string[] = [];
const files: string[] = [];

function canSymlink(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-image-link-probe-"));
	try {
		const target = path.join(dir, "t");
		const link = path.join(dir, "l");
		fs.writeFileSync(target, "x");
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	global.fetch = originalFetch;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const file of files.splice(0)) {
		const parent = path.dirname(file);
		if (path.basename(parent).startsWith("gjc-image-")) fs.rmSync(parent, { recursive: true, force: true });
		else fs.rmSync(file, { force: true });
	}
	for (const link of links.splice(0)) fs.rmSync(link, { force: true });
});

function ctx(): CustomToolContext {
	const model = {
		api: "openai-responses",
		provider: "openai",
		id: "gpt-5.5",
		name: "GPT 5.5",
		baseUrl: "https://api.openai.com/v1",
		output: ["text", "image"],
	} as Model;
	return {
		sessionManager: {
			getCwd: () => os.tmpdir(),
			getSessionId: () => "s",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => undefined,
		} as unknown as ModelRegistry,
		model,
		settings: {
			getModelRole: (role: string) => (role === "image" ? "openai/gpt-5.5" : undefined),
			get: (() => undefined) as unknown as Settings["get"],
		} as unknown as Settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function stubFetch(): void {
	const body = JSON.stringify({
		output: [{ type: "image_generation_call", result: png.toString("base64"), status: "completed" }],
	});
	const fetchMock = (async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
	fetchMock.preconnect = originalFetch.preconnect;
	global.fetch = fetchMock;
}

async function generate(): Promise<string> {
	stubFetch();
	const result = await imageGenTool.execute("call-1", { subject: "a cat" }, undefined, ctx());
	const imagePath = result.details?.imagePaths?.[0];
	if (!imagePath) throw new Error("no image path");
	files.push(imagePath);
	return imagePath;
}

describe("image temp file", () => {
	it("still allows saving a generated image when no temp symlink is planted", async () => {
		const imagePath = await generate();
		const stat = fs.lstatSync(imagePath);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.isFile()).toBe(true);
		expect(fs.readFileSync(imagePath).equals(png)).toBe(true);
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		it("does not follow a preexisting symlink at the predictable temp name", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-image-victim-"));
			dirs.push(dir);
			const victim = path.join(dir, "victim");
			fs.writeFileSync(victim, "SAFE");
			const now = Date.now;
			const fixed = 1_700_000_000_000;
			Date.now = () => fixed;
			try {
				const observed = Snowflake.next();
				const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
				const id = Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
				const linkPath = path.join(os.tmpdir(), `gjc-image-${id}.png`);
				links.push(linkPath);
				fs.rmSync(linkPath, { force: true });
				fs.symlinkSync(victim, linkPath);
				const imagePath = await generate();
				expect(fs.readFileSync(victim, "utf8")).toBe("SAFE");
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
				expect(imagePath).not.toBe(linkPath);
				expect(fs.readFileSync(imagePath).equals(png)).toBe(true);
				if (process.platform !== "win32") expect(fs.statSync(imagePath).mode & 0o777).toBe(0o600);
			} finally {
				Date.now = now;
			}
		});
});
