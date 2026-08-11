import { installGuideCache, readGuideCache, type VerifiedGuideCache } from "./cache";
import {
	GUIDE_ADVISORY_MAX_BYTES,
	GUIDE_MANIFEST_MAX_BYTES,
	type GuideEntryV1,
	type GuideManifestV1,
	parseGuideManifest,
} from "./manifest";
import { GUIDE_PINNED_KEYS, guideAdvisoryDigest, verifyGuideAdvisoryText, verifyGuideManifest } from "./verify";

/**
 * HTTPS-only, allowlisted, credential-free fetch boundary for advisory guides.
 *
 * The catalog refuses any URL that is not https, whose host is not in the
 * allowlist, whose path is outside the allowlisted prefix, or that carries
 * userinfo. Every request uses `credentials: "omit"`, no authorization or
 * cookie headers, and `redirect: "error"` so a redirect can never escape the
 * allowlist. Responses are bounded by byte caps and a timeout. This boundary
 * is the only network surface of the guide subsystem — advisories are fetched
 * as data, verified against the signed manifest, and never executed.
 */
export interface GuideFetchAllowlistEntry {
	host: string;
	/** Every fetched path must start with this prefix. */
	pathPrefix: string;
}

export const GUIDE_FETCH_ALLOWLIST: readonly GuideFetchAllowlistEntry[] = [
	{ host: "guides.gajae-code.com", pathPrefix: "/" },
];
export const GUIDE_FETCH_TIMEOUT_MS = 10_000;
export const GUIDE_FETCH_MAX_MANIFEST_BYTES = GUIDE_MANIFEST_MAX_BYTES;
export const GUIDE_FETCH_MAX_SIGNATURE_BYTES = 1024;
export const GUIDE_FETCH_USER_AGENT = "gajae-code-sdk-guides/1";

export interface GuideFetchPolicy {
	httpsOnly: true;
	credentials: "omit";
	redirect: "error";
	allowlist: readonly GuideFetchAllowlistEntry[];
	maxManifestBytes: number;
	maxSignatureBytes: number;
	timeoutMs: number;
	userAgent: string;
}

export function guideFetchPolicy(): GuideFetchPolicy {
	return {
		httpsOnly: true,
		credentials: "omit",
		redirect: "error",
		allowlist: GUIDE_FETCH_ALLOWLIST,
		maxManifestBytes: GUIDE_FETCH_MAX_MANIFEST_BYTES,
		maxSignatureBytes: GUIDE_FETCH_MAX_SIGNATURE_BYTES,
		timeoutMs: GUIDE_FETCH_TIMEOUT_MS,
		userAgent: GUIDE_FETCH_USER_AGENT,
	};
}

/** True when a URL satisfies the HTTPS allowlist boundary. */
export function isGuideFetchUrlAllowed(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
	return GUIDE_FETCH_ALLOWLIST.some(
		entry => parsed.hostname === entry.host && parsed.pathname.startsWith(entry.pathPrefix),
	);
}

export type GuideFetchErrorCode =
	| "fetch_forbidden"
	| "fetch_failed"
	| "oversize"
	| "timeout"
	| "network_error"
	| "invalid_manifest"
	| "unsupported_version"
	| (string & {});

export interface GuideOnlineManifest {
	url: string;
	manifest: GuideManifestV1;
	signatureBytes: Uint8Array;
	fetchedAt: number;
}

export type GuideFetchResult =
	| { ok: true; value: GuideOnlineManifest }
	| { ok: false; error: { code: GuideFetchErrorCode; message: string; status?: number } };

function fetchFailure(code: GuideFetchErrorCode, message: string, status?: number): GuideFetchResult {
	return { ok: false, error: { code, message, ...(status === undefined ? {} : { status }) } };
}

const guideUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseFatalUtf8Json(bytes: Uint8Array): unknown {
	return JSON.parse(guideUtf8Decoder.decode(bytes));
}

type BoundedFetchResult =
	| { ok: true; value: { bytes: Uint8Array } }
	| {
			ok: false;
			error: { code: "fetch_failed" | "oversize" | "timeout" | "network_error"; message: string; status?: number };
	  };

function isFetchTimeout(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name === "TimeoutError" || error.name === "AbortError") return true;
	return /timed ?out|aborted|timeout/i.test(error.message);
}

async function boundedFetch(
	fetchImpl: typeof fetch,
	url: string,
	policy: GuideFetchPolicy,
	maxBytes: number,
): Promise<BoundedFetchResult> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			credentials: "omit",
			redirect: "error",
			signal: AbortSignal.timeout(policy.timeoutMs),
			headers: { "user-agent": policy.userAgent },
		});
	} catch (error) {
		if (isFetchTimeout(error))
			return {
				ok: false,
				error: { code: "timeout", message: `Fetch timed out after ${policy.timeoutMs}ms: ${url}` },
			};
		return {
			ok: false,
			error: { code: "network_error", message: error instanceof Error ? error.message : String(error) },
		};
	}
	if (!response.ok)
		return {
			ok: false,
			error: {
				code: "fetch_failed",
				message: `Fetch failed with HTTP ${response.status}: ${url}`,
				status: response.status,
			},
		};
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const declaredBytes = Number(declared);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
			return {
				ok: false,
				error: { code: "oversize", message: `Response exceeds the ${maxBytes}-byte fetch cap: ${url}` },
			};
	}
	let bytes: ArrayBuffer;
	try {
		bytes = await response.arrayBuffer();
	} catch (error) {
		if (isFetchTimeout(error))
			return {
				ok: false,
				error: { code: "timeout", message: `Fetch timed out after ${policy.timeoutMs}ms: ${url}` },
			};
		return {
			ok: false,
			error: { code: "network_error", message: error instanceof Error ? error.message : String(error) },
		};
	}
	if (bytes.byteLength > maxBytes)
		return {
			ok: false,
			error: { code: "oversize", message: `Response exceeds the ${maxBytes}-byte fetch cap: ${url}` },
		};
	return { ok: true, value: { bytes: new Uint8Array(bytes) } };
}

/**
 * Fetches the manifest at `url` and its detached signature at `<url>.sig`,
 * bounded by the HTTPS allowlist policy. The manifest is parsed and shape
 * validated here; signature verification and advisory hash checks happen in
 * the caller so a rejected refresh can fall back to cache/bundled.
 */
export async function fetchGuideManifestOnline(params: {
	url: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: number;
}): Promise<GuideFetchResult> {
	const policy = guideFetchPolicy();
	if (!isGuideFetchUrlAllowed(params.url))
		return fetchFailure("fetch_forbidden", `URL ${params.url} is outside the HTTPS allowlist.`);
	const timeoutMs = params.timeoutMs ?? policy.timeoutMs;
	const fetchImpl = params.fetchImpl ?? fetch;
	const effectivePolicy: GuideFetchPolicy = { ...policy, timeoutMs };

	const manifestResponse = await boundedFetch(fetchImpl, params.url, effectivePolicy, policy.maxManifestBytes);
	if (!manifestResponse.ok) return { ok: false, error: manifestResponse.error };
	const signatureResponse = await boundedFetch(
		fetchImpl,
		`${params.url}.sig`,
		effectivePolicy,
		policy.maxSignatureBytes,
	);
	if (!signatureResponse.ok) return { ok: false, error: signatureResponse.error };

	let manifestValue: unknown;
	try {
		manifestValue = parseFatalUtf8Json(manifestResponse.value.bytes);
	} catch {
		return fetchFailure("invalid_manifest", `Manifest at ${params.url} is not valid UTF-8 JSON.`);
	}
	const parsed = parseGuideManifest(manifestValue);
	if (!parsed.ok)
		return fetchFailure(parsed.error.code, `Manifest at ${params.url} is invalid: ${parsed.error.message}`);
	return {
		ok: true,
		value: {
			url: params.url,
			manifest: parsed.manifest,
			signatureBytes: signatureResponse.value.bytes,
			fetchedAt: params.now ?? Date.now(),
		},
	};
}

/**
 * Trusted-by-compilation bundled manifests. The seed manifest is signed by the
 * bundled pinned key (`verify.ts`), and every bundled advisory ships its text
 * so fresh-install `list`/`show` work offline with no cache. The seed is
 * selected only when no valid online or cached manifest exists; because the
 * bundled manifest is itself signature-verified at module load, bundling the
 * signature here preserves the normal verify path for bundled content.
 */
const BUNDLED_GUIDE_MANIFEST_ID = "gajae-code-advisory-bundled";
const BUNDLED_GUIDE_SIGNATURE_HEX =
	"682028a6834dfd2b39db57fb6cc185b9e2bdf21a3256d907fbbb8ddb20a0ce285f3a21b970df7d4055acfb2aede13d8f69931249c6d27fc092bfa2b60e936303";

const bundledGuideAdvisoryTexts: Readonly<Record<string, string>> = {
	"getting-started":
		"GJC ships a small set of signed advisory guides with the client so `gjc sdk guides list` and `gjc sdk guides show <guideId>` work offline on a fresh install. Guides are advisory text only: they are rendered for reading and never executed or applied as configuration. To receive newer guides, run `gjc sdk guides refresh --url <https manifest url>`. The manifest must come from the allowlisted HTTPS host and must be signed by a pinned Ed25519 key; a rejected refresh falls back to the last verified cache, then to the bundled seed, and any rejection is reported in the warnings list.",
	"sdk/session-cli":
		"`gjc sdk session` is the broker-bound command family for operating live GJC SDK sessions from the terminal: `list` enumerates managed sessions, `inspect` shows session details, `send` submits a prompt turn, `status` reports session health, and `tail` follows the event stream. The explicit `raw` hatch dispatches one SDK operation as `control`, `query`, or `global`. Authority resolves through the local broker and endpoint credentials are never rendered by the CLI.",
	"troubleshooting/sdk-connection":
		"When an SDK connection fails, first check that the session host is alive and healthy: `gjc sdk session status` reports readiness and liveness. If the broker is gone, restart it and re-list sessions; detached hosts are reaped after a bounded absence grace. Fetch-boundary failures (offline host, allowlisted URL violations, signature rejections) are reported as typed errors with exit code 1 so scripts can fail closed instead of silently serving unverified content.",
};

function bundledGuideSeedEntry(id: string, title: string): GuideEntryV1 {
	const text = bundledGuideAdvisoryTexts[id];
	if (text === undefined) throw new Error(`Bundled guide ${id} has no advisory text.`);
	return { id, title, sha256: guideAdvisoryDigest(new TextEncoder().encode(text)) };
}

/**
 * Trusted-by-compilation bundled manifests. The seed manifest is signed by the
 * bundled pinned key (`verify.ts`), and every bundled advisory ships its text
 * so fresh-install `list`/`show` work offline with no cache. The seed is
 * selected only when no valid online or cached manifest exists; because the
 * bundled manifest is itself signature-verified at module load, bundling the
 * signature here preserves the normal verify path for bundled content.
 */
export const BUNDLED_GUIDE_MANIFESTS: readonly GuideManifestV1[] = [
	{
		version: 1,
		manifestId: BUNDLED_GUIDE_MANIFEST_ID,
		keyId: GUIDE_PINNED_KEYS[0].keyId,
		sequence: 1,
		issuedAt: Date.UTC(2026, 0, 1),
		expiresAt: Date.UTC(2036, 0, 1),
		minimumSdkVersion: 1,
		guides: [
			bundledGuideSeedEntry("getting-started", "Getting started with the SDK advisory catalog"),
			bundledGuideSeedEntry("sdk/session-cli", "Using the SDK session CLI"),
			bundledGuideSeedEntry("troubleshooting/sdk-connection", "Troubleshooting SDK connection failures"),
		],
	},
];
for (const manifest of BUNDLED_GUIDE_MANIFESTS) {
	for (const entry of manifest.guides) Object.freeze(entry);
	Object.freeze(manifest.guides);
	Object.freeze(manifest);
}
Object.freeze(BUNDLED_GUIDE_MANIFESTS);
{
	const selfVerification = verifyGuideManifest({
		manifest: BUNDLED_GUIDE_MANIFESTS[0],
		signatureBytes: Buffer.from(BUNDLED_GUIDE_SIGNATURE_HEX, "hex"),
		now: Date.UTC(2026, 0, 2),
	});
	if (!selfVerification.ok)
		throw new Error(
			`Bundled guide manifest failed self-verification: ${selfVerification.error.code} ${selfVerification.error.message}`,
		);
}

export type GuideCatalogSource = "online" | "cache" | "bundled";

export interface GuideCatalogGuideV1 {
	id: string;
	title: string;
	sha256: string;
	/** Advisory text; undefined when the bundled manifest does not ship content for this guide. */
	text: string | undefined;
}

export interface GuideCatalogSelection {
	source: GuideCatalogSource;
	manifest: GuideManifestV1;
	guides: GuideCatalogGuideV1[];
	/** Present when the selection is served from (or was installed into) the verified cache. */
	cache?: VerifiedGuideCache;
	/** Online provenance. */
	url?: string;
	fetchedAt?: number;
	/** Non-fatal provenance notes (e.g. an online refresh was rejected and selection fell back). */
	warnings: string[];
}

export type GuideCatalogResult =
	| { ok: true; value: GuideCatalogSelection }
	| { ok: false; error: { code: string; message: string } };

function catalogFailure(code: string, message: string): GuideCatalogResult {
	return { ok: false, error: { code, message } };
}

export interface GuideCatalogOptions {
	agentDir: string;
	/** Online manifest URL; undefined disables the network entirely. */
	onlineUrl?: string;
	now?: () => number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** Trusted-by-compilation bundled manifests; defaults to `BUNDLED_GUIDE_MANIFESTS`. */
	disableBundled?: boolean;
}

/**
 * Advisory guide catalog service.
 *
 * Selection precedence is `valid online -> valid cache -> bundled`: a freshly
 * fetched, verified manifest wins; otherwise the verified cache; otherwise the
 * bundled seed. Verification failures never throw — they surface as warnings
 * (for online) or as selection fallback, and the cache is never destroyed.
 */
export class GuideCatalog {
	#agentDir: string;
	#onlineUrl: string | undefined;
	#now: () => number;
	#fetchImpl: typeof fetch | undefined;
	#timeoutMs: number | undefined;
	#bundled: readonly GuideManifestV1[];

	constructor(options: GuideCatalogOptions) {
		this.#agentDir = options.agentDir;
		this.#onlineUrl = options.onlineUrl;
		this.#now = options.now ?? Date.now;
		this.#fetchImpl = options.fetchImpl;
		this.#timeoutMs =
			options.timeoutMs === undefined
				? undefined
				: Math.min(GUIDE_FETCH_TIMEOUT_MS, Math.max(1, Math.floor(options.timeoutMs)));
		this.#bundled = options.disableBundled === true ? [] : BUNDLED_GUIDE_MANIFESTS;
	}

	/**
	 * Fetches, verifies, and installs the online manifest when `onlineUrl` is
	 * configured, then selects per the online/cache/bundled precedence. The
	 * verified cache is always the source of advisory text for online and
	 * cached selections, so a single verified read path serves both.
	 */
	async refresh(): Promise<GuideCatalogResult> {
		const warnings: string[] = [];
		if (this.#onlineUrl !== undefined) {
			const fetched = await fetchGuideManifestOnline({
				url: this.#onlineUrl,
				timeoutMs: this.#timeoutMs,
				fetchImpl: this.#fetchImpl,
				now: this.#now(),
			});
			if (!fetched.ok) {
				warnings.push(`Online refresh rejected: ${fetched.error.code} ${fetched.error.message}`);
			} else {
				const verified = verifyGuideManifest({
					manifest: fetched.value.manifest,
					signatureBytes: fetched.value.signatureBytes,
					now: this.#now(),
				});
				if (!verified.ok) {
					warnings.push(`Online refresh rejected: ${verified.error.code} ${verified.error.message}`);
				} else {
					const advisories = await this.#fetchAdvisories(fetched.value);
					if (!advisories.ok) {
						warnings.push(`Online refresh rejected: ${advisories.error.code} ${advisories.error.message}`);
					} else {
						const installed = await installGuideCache({
							agentDir: this.#agentDir,
							manifest: fetched.value.manifest,
							signatureBytes: fetched.value.signatureBytes,
							advisories: advisories.value,
							now: this.#now(),
						});
						if (!installed.ok) {
							warnings.push(`Cache install rejected: ${installed.error.code} ${installed.error.message}`);
						} else {
							return this.#selectionFromCache(
								installed.value,
								"online",
								fetched.value.url,
								fetched.value.fetchedAt,
								warnings,
							);
						}
					}
				}
			}
		}
		return this.#selectFromCacheOrBundled(
			warnings,
			"No verified online, cached, or bundled guide manifest is available.",
		);
	}

	/** Offline selection: verified cache first, then bundled. Never touches the network. */
	async load(): Promise<GuideCatalogResult> {
		return this.#selectFromCacheOrBundled([], "No verified cached or bundled guide manifest is available.");
	}

	/**
	 * Returns the advisory text for a guide in the currently selected
	 * manifest. Advisory text is data only: it is rendered and never executed
	 * or applied as configuration.
	 */
	async advisory(
		guideId: string,
	): Promise<
		| { ok: true; value: { source: GuideCatalogSource; guideId: string; title: string; text: string } }
		| { ok: false; error: { code: string; message: string } }
	> {
		const selection = await this.load();
		if (!selection.ok) return { ok: false, error: selection.error };
		const guide = selection.value.guides.find(candidate => candidate.id === guideId);
		if (!guide)
			return {
				ok: false,
				error: { code: "not_found", message: `Guide ${guideId} is not in the selected manifest.` },
			};
		if (guide.text === undefined)
			return {
				ok: false,
				error: {
					code: "unavailable",
					message: `Guide ${guideId} is bundled-only; no advisory text is shipped with the client.`,
				},
			};
		return {
			ok: true,
			value: { source: selection.value.source, guideId, title: guide.title, text: guide.text },
		};
	}

	async #selectFromCacheOrBundled(warnings: string[], unavailableMessage: string): Promise<GuideCatalogResult> {
		const cache = await readGuideCache({ agentDir: this.#agentDir, now: this.#now() });
		if (cache.ok) return this.#selectionFromCache(cache.value, "cache", undefined, undefined, warnings);
		if (cache.error.code !== "missing_cache")
			warnings.push(`Cache rejected: ${cache.error.code} ${cache.error.message}`);
		const bundled = this.#bundled[0];
		if (bundled)
			return {
				ok: true,
				value: {
					source: "bundled",
					manifest: bundled,
					guides: bundled.guides.map(entry => ({
						id: entry.id,
						title: entry.title,
						sha256: entry.sha256,
						text: bundledGuideAdvisoryTexts[entry.id],
					})),
					warnings,
				},
			};
		return catalogFailure(
			"unavailable",
			warnings.length === 0 ? unavailableMessage : `${unavailableMessage} ${warnings.join("; ")}`,
		);
	}

	async #fetchAdvisories(
		online: GuideOnlineManifest,
	): Promise<
		| { ok: true; value: { entry: GuideEntryV1; text: Uint8Array }[] }
		| { ok: false; error: { code: string; message: string; status?: number } }
	> {
		const policy = guideFetchPolicy();
		const effectivePolicy: GuideFetchPolicy = { ...policy, timeoutMs: this.#timeoutMs ?? policy.timeoutMs };
		const fetchImpl = this.#fetchImpl ?? fetch;
		const advisories: { entry: GuideEntryV1; text: Uint8Array }[] = [];
		for (const entry of online.manifest.guides) {
			let url: string;
			try {
				url = new URL(`guides/${entry.id}`, online.url).href;
			} catch {
				return {
					ok: false,
					error: { code: "invalid_manifest", message: `Advisory URL for ${entry.id} could not be resolved.` },
				};
			}
			if (!isGuideFetchUrlAllowed(url))
				return {
					ok: false,
					error: { code: "fetch_forbidden", message: `Advisory URL ${url} is outside the HTTPS allowlist.` },
				};
			const fetched = await boundedFetch(fetchImpl, url, effectivePolicy, GUIDE_ADVISORY_MAX_BYTES);
			if (!fetched.ok) return fetched;
			const binding = verifyGuideAdvisoryText(entry, fetched.value.bytes);
			if (!binding.ok) return binding;
			advisories.push({ entry, text: fetched.value.bytes });
		}
		return { ok: true, value: advisories };
	}

	#selectionFromCache(
		cache: VerifiedGuideCache,
		source: "online" | "cache",
		url: string | undefined,
		fetchedAt: number | undefined,
		warnings: string[],
	): GuideCatalogResult {
		return {
			ok: true,
			value: {
				source,
				manifest: cache.manifest,
				guides: cache.guides.map(guide => ({
					id: guide.id,
					title: guide.title,
					sha256: guide.sha256,
					text: guide.text,
				})),
				cache,
				...(url === undefined ? {} : { url, fetchedAt }),
				warnings,
			},
		};
	}
}
