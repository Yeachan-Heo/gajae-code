const localSubmissionIds = new WeakMap<object, string>();
let nextLocalSubmissionId = 0;

export function createLocalSubmissionId(): string {
	return `gjc-local-${Date.now()}-${++nextLocalSubmissionId}`;
}

export function markLocalSubmission(message: object, submissionId: string): void {
	localSubmissionIds.set(message, submissionId);
}

export function getLocalSubmissionId(message: object): string | undefined {
	return localSubmissionIds.get(message);
}
