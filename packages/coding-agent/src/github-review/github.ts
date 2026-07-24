/**
 * Minimal GitHub REST access for the review bot: App-JWT minting, installation
 * token caching, and a thin fetch wrapper. Zero dependencies by design — the
 * bot posts as the App, reads with the same token, and everything else
 * (reviews themselves) happens inside agent turns via `gh`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GithubReviewConfig } from "./config";

function base64url(buf: Buffer): string {
	return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** RS256 App JWT (9 min lifetime, 1 min clock-skew backdate). */
export function mintAppJwt(appId: string, privateKeyPem: string, nowEpoch = Math.floor(Date.now() / 1000)): string {
	const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = base64url(Buffer.from(JSON.stringify({ iat: nowEpoch - 60, exp: nowEpoch + 540, iss: appId })));
	const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
	return `${header}.${payload}.${base64url(signature)}`;
}

interface CachedToken {
	token: string;
	expires_epoch: number;
}

/**
 * Installation access token provider with disk + memory caching (tokens live
 * 1h; refreshed when <5 min remain). `tokenOrEmpty` never throws — callers on
 * best-effort paths (acks, status lines) skip work when it returns "".
 */
export class AppTokenProvider {
	private cached: CachedToken | null = null;
	private readonly cachePath: string;

	constructor(
		private readonly config: Pick<
			GithubReviewConfig,
			"appId" | "installationId" | "privateKeyPath" | "apiBase" | "dataDir"
		>,
	) {
		this.cachePath = path.join(config.dataDir, "app-token.json");
	}

	async token(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		if (this.cached && this.cached.expires_epoch > now + 300) return this.cached.token;
		const disk = this.readDiskCache();
		if (disk && disk.expires_epoch > now + 300) {
			this.cached = disk;
			return disk.token;
		}
		const pem = fs.readFileSync(this.config.privateKeyPath, "utf8");
		const jwt = mintAppJwt(this.config.appId, pem, now);
		const res = await fetch(`${this.config.apiBase}/app/installations/${this.config.installationId}/access_tokens`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "gjc-github-review",
			},
		});
		const body = (await res.json()) as { token?: string; expires_at?: string; message?: string };
		if (!res.ok || !body.token) {
			throw new Error(`installation token mint failed: ${res.status} ${body.message ?? ""}`);
		}
		const expires = body.expires_at ? Math.floor(Date.parse(body.expires_at) / 1000) : now + 3600;
		this.cached = { token: body.token, expires_epoch: expires };
		this.writeDiskCache(this.cached);
		return body.token;
	}

	async tokenOrEmpty(): Promise<string> {
		try {
			return await this.token();
		} catch {
			return "";
		}
	}

	private readDiskCache(): CachedToken | null {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as CachedToken;
			return typeof parsed.token === "string" && typeof parsed.expires_epoch === "number" ? parsed : null;
		} catch {
			return null;
		}
	}

	private writeDiskCache(token: CachedToken): void {
		try {
			fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
			fs.writeFileSync(this.cachePath, JSON.stringify(token), { mode: 0o600 });
		} catch {
			/* memory cache still works */
		}
	}
}

export interface GithubRequestOptions {
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	body?: unknown;
	token: string;
	timeoutMs?: number;
}

/** Thin GitHub REST client. `request` throws; `tryRequest` returns null (best-effort lanes). */
export class GithubApi {
	constructor(private readonly apiBase: string) {}

	async request<T = unknown>(apiPath: string, options: GithubRequestOptions): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
		try {
			const res = await fetch(`${this.apiBase}${apiPath}`, {
				method: options.method ?? "GET",
				headers: {
					Authorization: `token ${options.token}`,
					Accept: "application/vnd.github+json",
					"User-Agent": "gjc-github-review",
					...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
				signal: controller.signal,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`GitHub ${options.method ?? "GET"} ${apiPath} → ${res.status}: ${text.slice(0, 200)}`);
			}
			if (res.status === 204) return undefined as T;
			return (await res.json()) as T;
		} finally {
			clearTimeout(timer);
		}
	}

	async tryRequest<T = unknown>(apiPath: string, options: GithubRequestOptions): Promise<T | null> {
		try {
			return await this.request<T>(apiPath, options);
		} catch {
			return null;
		}
	}
}
