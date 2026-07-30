/**
 * DashScope Token Plan canonical request headers.
 *
 * Reproduces QwenLM/qwen-code's DashScopeOpenAICompatibleProvider.buildHeaders()
 * defaultHeaders so the built-in `alibaba-token-plan` provider emits the same
 * client identity / cache / auth-type fingerprint upstream sends. DashScope is
 * compatibility-sensitive to this fingerprint; a non-identical set can cause
 * request instability and affect first-event latency (gajae-code #3557).
 *
 * Upstream pin (reproduce EXACTLY here):
 *   Repository:    QwenLM/qwen-code
 *   Commit:        f4cd6e1d8bbb1c24e7e5d1a40187d8e28aa7c4fb
 *   Version:       0.21.1
 *   Source:        packages/core/src/core/openaiContentGenerator/provider/dashscope.ts
 *   buildHeaders():
 *     const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
 *     const defaultHeaders = {
 *       'User-Agent': userAgent,
 *       'X-DashScope-CacheControl': 'enable',
 *       'X-DashScope-UserAgent': userAgent,
 *       'X-DashScope-AuthType': authType,
 *     };
 *     return customHeaders ? { ...defaultHeaders, ...customHeaders } : defaultHeaders;
 *
 * The Token Plan preset authenticates with AuthType.USE_OPENAI ('openai'), so
 * X-DashScope-AuthType is the constant 'openai'. Pin the version so an upstream
 * bump is an explicit parity update rather than silent drift.
 */
export const QWEN_CODE_UPSTREAM_REPO = "QwenLM/qwen-code";
export const QWEN_CODE_UPSTREAM_COMMIT = "f4cd6e1d8bbb1c24e7e5d1a40187d8e28aa7c4fb";
export const QWEN_CODE_UPSTREAM_VERSION = "0.21.1";

// Upstream Token Plan preset uses AuthType.USE_OPENAI = 'openai'.
const QWEN_CODE_TOKEN_PLAN_AUTH_TYPE = "openai";

/**
 * The Qwen Code CLI version string used in identity headers. Pinned to the
 * upstream version at {@link QWEN_CODE_UPSTREAM_COMMIT}; change both together
 * as an explicit parity update.
 */
export function qwenCodeUserAgent(version: string = QWEN_CODE_UPSTREAM_VERSION): string {
	// process.platform / process.arch are read verbatim, matching upstream
	// (e.g. "linux", "darwin", "win32"; "x64", "arm64"). No normalization.
	return `QwenCode/${version} (${process.platform}; ${process.arch})`;
}

/**
 * Canonical DashScope Token Plan headers (upstream defaultHeaders, no caller
 * overrides applied). Exposed for tests/fixtures so the pinned wire set lives
 * in exactly one place.
 */
export function dashscopeTokenPlanDefaultHeaders(
	version: string = QWEN_CODE_UPSTREAM_VERSION,
): Readonly<Record<string, string>> {
	const userAgent = qwenCodeUserAgent(version);
	return Object.freeze({
		"User-Agent": userAgent,
		"X-DashScope-CacheControl": "enable",
		"X-DashScope-UserAgent": userAgent,
		"X-DashScope-AuthType": QWEN_CODE_TOKEN_PLAN_AUTH_TYPE,
	});
}

/**
 * Merge canonical DashScope Token Plan identity headers onto a caller's header
 * map, reproducing upstream buildHeaders() precedence EXACTLY:
 *   `{ ...defaultHeaders, ...customHeaders }` — caller wins per header.
 *
 * This mirrors GJC's existing kimi-code injection order
 * (`headers = { ...getKimiCommonHeaders(), ...headers }`): canonical identity as
 * the base, caller-supplied headers overriding individual keys. A caller that
 * pins `User-Agent` takes that key; the other canonicals still apply.
 *
 * A null/undefined `callerHeaders` returns the canonical set alone (upstream
 * `customHeaders ? {...} : defaultHeaders` shortcut).
 */
export function mergeDashScopeTokenPlanHeaders(
	callerHeaders: Record<string, string> | undefined,
	version: string = QWEN_CODE_UPSTREAM_VERSION,
): Record<string, string> {
	const defaults = dashscopeTokenPlanDefaultHeaders(version);
	if (!callerHeaders) return { ...defaults };
	return { ...defaults, ...callerHeaders };
}
