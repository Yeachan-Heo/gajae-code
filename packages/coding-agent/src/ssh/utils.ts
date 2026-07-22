export function sanitizeHostName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

export function validateSshDestination(username: string | undefined, host: string): string | undefined {
	if (host.startsWith("-") || username?.startsWith("-")) {
		return "username and host must not begin with '-'";
	}
	if (/\0|\r|\n/.test(host) || (username !== undefined && /\0|\r|\n/.test(username))) {
		return "username and host must not contain NUL or line breaks";
	}
	return undefined;
}

export function buildSshTarget(username: string | undefined, host: string): string {
	const validationError = validateSshDestination(username, host);
	if (validationError) {
		throw new Error(`Invalid SSH destination: ${validationError}`);
	}
	return username ? `${username}@${host}` : host;
}
