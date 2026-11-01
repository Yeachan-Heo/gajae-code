/** Slash search accepts the leading slash users type in the command input. */
export const matchesSlashFilter = (name: string, description: string, filter: string) =>
	`${name} ${description}`.toLowerCase().includes(filter.trim().replace(/^\//, "").toLowerCase());
