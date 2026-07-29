// Prints the discovery roots this process resolves for external CLI credentials.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
//
// Each planted root holds a syntactically valid credential file, so a redirect
// that is honoured shows up as an importable credential whose redacted source
// names the variable that redirected it.
import { discoverExternalCredentials } from "../../src/setup/credential-import";

const homeDir = process.env.GJC_PROBE_HOME_DIR ?? "";
const result = await discoverExternalCredentials({ homeDir, platform: "linux" });
console.log(
	JSON.stringify({
		sources: result.importable.map(credential => credential.source).sort(),
		skipped: result.skipped.map(entry => entry.source).sort(),
	}),
);
