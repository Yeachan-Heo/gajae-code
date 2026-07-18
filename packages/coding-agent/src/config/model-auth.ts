export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

export function isAuthenticatedOrKeyless(apiKey: string | undefined | null): boolean {
	return apiKey === kNoAuth || isAuthenticated(apiKey);
}
