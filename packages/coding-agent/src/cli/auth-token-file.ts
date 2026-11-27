import * as crypto from "node:crypto";
import * as path from "node:path";
import { getConfigRootDir } from "@gajae-code/utils";
import {
	createSecureTokenFileExclusive,
	readSecureTokenFile,
	writeSecureTokenFile,
} from "../session/secure-token-file";

/** Per-command bearer-token file with exclusive creation and a race-safe ensure path. */
export interface AuthTokenFile {
	readonly path: string;
	read(): Promise<string | null>;
	write(token: string): Promise<void>;
	generate(): string;
	ensure(): Promise<string>;
}

export function createAuthTokenFile(fileName: string, label: string): AuthTokenFile {
	let tokenPath: string | undefined;
	const getPath = (): string => (tokenPath ??= path.join(getConfigRootDir(), fileName));
	const read = async (): Promise<string | null> => await readSecureTokenFile(getPath());
	const write = async (token: string): Promise<void> => {
		await writeSecureTokenFile(getPath(), token);
	};
	const createExclusive = async (token: string): Promise<boolean> =>
		await createSecureTokenFileExclusive(getPath(), token);
	const generate = (): string => crypto.randomBytes(32).toString("base64url");
	const ensure = async (): Promise<string> => {
		const existing = await read();
		if (existing) return existing;
		const token = generate();
		if (await createExclusive(token)) return token;
		// Another concurrent invocation won the create race. Its file may exist
		// briefly before the winner writes the token, so retry reads without ever
		// overwriting the winner's file.
		for (let attempt = 0; attempt < 5; attempt++) {
			const fromRace = await read();
			if (fromRace) return fromRace;
			if (attempt < 4) await Bun.sleep(10);
		}
		// If the file disappeared, make one final exclusive-create attempt. Never
		// fall back to an unconditional write after observing EEXIST.
		if (await createExclusive(token)) return token;
		throw new Error(`Unable to initialize ${label} token: another process owns an empty token file.`);
	};
	return {
		get path() {
			return getPath();
		},
		read,
		write,
		generate,
		ensure,
	};
}
