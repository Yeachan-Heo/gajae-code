/**
 * Recognizes legacy provider safety-stop labels persisted before `errorKind`.
 * Keep this anchored and conservative so incidental transient-error prose stays retryable.
 */
export function isLegacyProviderSafetyStopMessage(errorMessage: string): boolean {
	return /^(?:refusal(\s*\(|:|$)|content flagged by safety filters|blocked under .{0,40}usage policy)/i.test(
		errorMessage,
	);
}
