/**
 * Re-exports from @gajae-code/ai.
 * All credential storage types and the AuthStorage class now live in the ai package.
 */

export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialIfAbsentReason,
	AuthCredentialIfAbsentResult,
	AuthCredentialIfAbsentSnapshotResult,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	OAuthCredential,
	SerializedAuthStorage,
	StoredAuthCredential,
} from "@gajae-code/ai";
export {
	AuthBrokerClient,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
} from "@gajae-code/ai";
