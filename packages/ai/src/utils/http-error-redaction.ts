/** Return a status-only summary without consuming an untrusted response body. */
export function redactedHttpErrorSummary(response: Response): string {
	return `HTTP ${response.status}`;
}
