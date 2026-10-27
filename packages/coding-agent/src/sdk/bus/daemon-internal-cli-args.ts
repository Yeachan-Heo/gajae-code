import { CliParseError } from "@gajae-code/utils/cli";

const MAX_DAEMON_OWNER_ID_LENGTH = 1024;
const INVALID_DAEMON_OWNER_ID_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u;

export function isValidDaemonInternalOwnerId(ownerId: string): boolean {
	return (
		ownerId.length > 0 &&
		ownerId.length <= MAX_DAEMON_OWNER_ID_LENGTH &&
		!ownerId.startsWith("-") &&
		!INVALID_DAEMON_OWNER_ID_CHARACTERS.test(ownerId)
	);
}

export function requireDaemonInternalOwnerId(argv: readonly string[]): string {
	const ownerIdFlagIndex = argv.indexOf("--owner-id");
	const ownerId = ownerIdFlagIndex === -1 ? undefined : argv[ownerIdFlagIndex + 1];
	if (!ownerId || ownerId.startsWith("--")) throw new CliParseError("Missing required flag: --owner-id");
	if (!isValidDaemonInternalOwnerId(ownerId)) throw new CliParseError("Invalid value for --owner-id.");
	return ownerId;
}
