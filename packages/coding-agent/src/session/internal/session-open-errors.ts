export const SESSION_MIGRATION_BUSY_MESSAGE =
	"Another session migration is still active. Wait for it to finish, then retry.";

export class SessionMigrationBusyError extends Error {
	readonly code = "migration_busy";

	constructor() {
		super(SESSION_MIGRATION_BUSY_MESSAGE);
		this.name = "SessionMigrationBusyError";
	}
}
