export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
export const TASK_ID_DESCRIPTION = "filesystem-safe identifier matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$";

const ALLOCATED_TASK_ID_PATTERN = new RegExp(
	`^\\d+-${TASK_ID_PATTERN.source.slice(1, -1)}(?:\\.\\d+-${TASK_ID_PATTERN.source.slice(1, -1)})*$`,
);

export function isValidTaskId(id: string): boolean {
	return TASK_ID_PATTERN.test(id);
}

export function getTaskIdValidationError(id: unknown): string | undefined {
	if (typeof id !== "string") return "Task id must be a string.";
	if (isValidTaskId(id)) return undefined;
	return `Task id ${JSON.stringify(id)} is invalid. Use ${TASK_ID_DESCRIPTION}.`;
}

export function validateTaskId(id: string): string {
	const error = getTaskIdValidationError(id);
	if (error) throw new Error(error);
	return id;
}

export function isValidAllocatedTaskId(id: string): boolean {
	return ALLOCATED_TASK_ID_PATTERN.test(id);
}

export function validateAllocatedTaskId(id: string): string {
	if (!isValidAllocatedTaskId(id)) {
		throw new Error(`Allocated task id ${JSON.stringify(id)} is invalid for filesystem artifact paths.`);
	}
	return id;
}
