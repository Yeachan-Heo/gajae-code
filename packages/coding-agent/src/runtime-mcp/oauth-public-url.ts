import { validatePublicHttpUrl } from "../web/insane/url-guard";

export async function assertPublicOAuthUrl(url: string, options: { signal?: AbortSignal } = {}): Promise<void> {
	if (options.signal?.aborted) throw abortReason(options.signal);
	const checked = await validatePublicHttpUrl(url, { signal: options.signal });
	if (options.signal?.aborted) throw abortReason(options.signal);
	if (!checked.ok) {
		throw new Error(`Refusing non-public OAuth endpoint: ${checked.reason ?? url}`);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("OAuth URL validation aborted");
}
