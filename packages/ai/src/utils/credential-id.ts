import type { Message } from "../types";

/**
 * Drop the local stored-credential row id from assistant messages before a
 * context leaves this process for a remote server (pi-native gateway, proxy).
 *
 * `credentialId` names a row in the local auth store; a remote server
 * authenticates upstream with its own credentials, so the number is
 * meaningless there and must not cross the wire. Returns `messages` itself when
 * no message carries the field; otherwise copies the array and only the
 * messages that carry it.
 */
export function stripCredentialIds(messages: Message[]): Message[] {
	let stripped: Message[] | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant" || !Object.hasOwn(message, "credentialId")) continue;
		stripped ??= messages.slice();
		const { credentialId: _credentialId, ...rest } = message;
		stripped[index] = rest;
	}
	return stripped ?? messages;
}
