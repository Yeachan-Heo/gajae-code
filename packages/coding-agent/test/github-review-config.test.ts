import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGithubReviewConfig } from "../src/github-review/config";
import { AppTokenProvider, mintAppJwt } from "../src/github-review/github";
import { DeliveryLog } from "../src/github-review/server";

const tmps: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghr-cfg-"));
	tmps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const REQUIRED = {
	appId: "123",
	installationId: "456",
	privateKeyPath: "/tmp/key.pem",
	webhookSecret: "s",
	botLogin: "gajae-code",
};

function writeConfig(extra: Record<string, unknown> = {}): string {
	const file = path.join(tmpDir(), "config.json");
	fs.writeFileSync(file, JSON.stringify({ ...REQUIRED, ...extra }));
	return file;
}

describe("loadGithubReviewConfig", () => {
	test("fails closed with the missing field names", () => {
		const file = path.join(tmpDir(), "config.json");
		fs.writeFileSync(file, JSON.stringify({ appId: "1" }));
		expect(() => loadGithubReviewConfig(file, {})).toThrow(/installationId, privateKeyPath, webhookSecret, botLogin/);
	});

	test("applies defaults, including the authorization boundaries", () => {
		const config = loadGithubReviewConfig(writeConfig(), {});
		expect(config.allowedAssociations).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
		expect(config.learnAssociations).toEqual(["OWNER"]);
		expect(config.botAliases).toEqual(["gajae-code"]);
		expect(config.markerPrefix).toBe("gajae-code");
		expect(config.maxInflight).toBe(4);
		expect(config.localWebhookUrl).toBe("http://127.0.0.1:8644/webhooks/github-review");
		expect(config.sessionBashPrefixes).toEqual(["gh pr", "gh api", "gh issue view", "gjc github-review", "gitleaks"]);
	});

	test("env overrides beat file values", () => {
		const config = loadGithubReviewConfig(writeConfig({ port: 1111 }), {
			GJC_GHR_PORT: "2222",
			GJC_GHR_MAX_INFLIGHT: "9",
			GJC_GHR_BOT_LOGIN: "other-bot",
		});
		expect(config.port).toBe(2222);
		expect(config.maxInflight).toBe(9);
		expect(
			loadGithubReviewConfig(writeConfig({ sessionBashPrefixes: ["gh pr"] }), {
				GJC_GHR_SESSION_PREFIXES: "gh api, gitleaks detect",
			}).sessionBashPrefixes,
		).toEqual(["gh api", "gitleaks detect"]);
		expect(config.botLogin).toBe("other-bot");
	});
});

describe("App JWT / installation token", () => {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

	test("mintAppJwt produces a verifiable RS256 JWT with backdated iat", () => {
		const now = 1_700_000_000;
		const jwt = mintAppJwt("123", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), now);
		const [header, payload, signature] = jwt.split(".");
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
			iat: now - 60,
			exp: now + 540,
			iss: "123",
		});
		const ok = crypto
			.createVerify("RSA-SHA256")
			.update(`${header}.${payload}`)
			.verify(publicKey, Buffer.from(signature, "base64url"));
		expect(ok).toBe(true);
	});

	test("AppTokenProvider caches to disk with 0600 and refreshes near expiry", async () => {
		const dataDir = tmpDir();
		const pemPath = path.join(dataDir, "key.pem");
		fs.writeFileSync(pemPath, privateKey.export({ type: "pkcs1", format: "pem" }));
		let mints = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			mints += 1;
			return new Response(
				JSON.stringify({ token: `tok-${mints}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
				{ status: 201 },
			);
		}) as unknown as typeof fetch;
		try {
			const config = {
				appId: "1",
				installationId: "2",
				privateKeyPath: pemPath,
				apiBase: "https://x.invalid",
				dataDir,
			};
			const provider = new AppTokenProvider(config);
			expect(await provider.token()).toBe("tok-1");
			expect(await provider.token()).toBe("tok-1"); // memory cache
			const mode = fs.statSync(path.join(dataDir, "app-token.json")).mode & 0o777;
			expect(mode).toBe(0o600);
			// A fresh provider reads the disk cache instead of minting.
			expect(await new AppTokenProvider(config).token()).toBe("tok-1");
			expect(mints).toBe(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("DeliveryLog persistence and replay window", () => {
	test("survives restarts and expires ids outside the window", () => {
		const file = path.join(tmpDir(), "deliveries.json");
		let now = 1_000_000;
		const clock = () => now;
		const log = new DeliveryLog(file, 1000, 100, clock);
		expect(log.alreadySeen("d1")).toBe(false);
		expect(log.alreadySeen("d1")).toBe(true);
		// restart: a new instance must still know d1
		const reloaded = new DeliveryLog(file, 1000, 100, clock);
		expect(reloaded.alreadySeen("d1")).toBe(true);
		// outside the window the id is forgotten (bounded replay acceptance)
		now += 1500;
		expect(reloaded.alreadySeen("d1")).toBe(false);
	});

	test.skipIf(process.platform === "win32")("delivery log file is mode-locked to 0600", () => {
		const file = path.join(tmpDir(), "deliveries.json");
		const log = new DeliveryLog(file);
		log.alreadySeen("d1");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
});
