/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export const GEMINI_CLI_VERSION_ENV = "GJC_AI_GEMINI_CLI_VERSION";
export const LEGACY_GEMINI_CLI_VERSION_ENV = "PI_AI_GEMINI_CLI_VERSION";
export const DEFAULT_GEMINI_CLI_VERSION = "0.52.0";

export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version =
		process.env[GEMINI_CLI_VERSION_ENV] || process.env[LEGACY_GEMINI_CLI_VERSION_ENV] || DEFAULT_GEMINI_CLI_VERSION;
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

/**
 * Full Antigravity system instruction as observed in the real IDE binary.
 * This is the complete prompt injected by the Antigravity language server,
 * including BNF lexer definition for syntax highlighting, messaging system
 * description, and reactive wakeup protocol.
 *
 * Wire-format fidelity note: The `%s` placeholders are literal in the real
 * Antigravity IDE prompt. The Cloud Code Assist service either expands them
 * server-side or the model handles them as-is. Preserved for byte-faithful
 * emulation of the observed IDE wire format.
 *
 * Evidence: Disassembly of the Antigravity LS binary confirms this exact
 * string is loaded and injected as the system instruction.
 */
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
The USER will send you requests, which you must always prioritize addressing. Along with each USER request, we will attach additional metadata about their current state, such as what files they have open and where their cursor is.
This information may or may not be relevant to the coding task, it is up for you to decide.<lexer>
  <config>
    <name>BNF</name>
    <alias>bnf</alias>
    <filename>*.bnf</filename>
    <mime_type>text/x-bnf</mime_type>
  </config>
  <rules>
    <state name="root">
      <rule pattern="(&lt;)([ -;=?-~]+)(&gt;)">
        <bygroups>
          <token type="Punctuation"/>
          <token type="NameClass"/>
          <token type="Punctuation"/>
        </bygroups>
      </rule>
      <rule pattern="::=">
        <token type="Operator"/>
      </rule>
      <rule pattern="[^&lt;&gt;:]+">
        <token type="Text"/>
      </rule>
      <rule pattern=".">
        <token type="Text"/>
      </rule>
    </state>
  </rules>
</lexer>You are connected to a messaging system where you may receive messages from: %s.

## Receiving Messages

You receive messages automatically at the start of each invocation. All messages are delivered in full directly into your context — no manual retrieval is needed.

## Reactive Wakeup (No Polling Needed)

The system automatically resumes your execution when:
%s

This means you do **NOT** need to poll in a loop while waiting for messages or updates. After launching anything that performs work asynchronously, you may continue other work or simply stop by calling no more tools. The system will notify you when there is something to process.
`;
/**
 * Antigravity / Cloud Code Assist user agent — 2.5.5 arm64 1.107.0 re-decompiled.
 *
 * Prior 2.0.3 x64 claim (LEA RDX,[RIP-0x284fc90]->0x367b554 "antigravity-ide" @0x5ecb1dd,
 * -override_user_agent @0x5ecbc37) is stale.
 *
 * 2.5.5 arm64 language_server_macos_arm (126MB Go1.26.5, __lrodata_gopcln 37MB, gosym 126300 funcs):
 * - IDE GetUserAgentName 0x1018e9a70 sz48, CLI 0x1018ec950 sz48, Hub 0x1018ef450 sz48 identical:
 *   adrp x27,#0x107b91000; add #0x880 -> bss override (SetUserAgentNameOverride @ override_user_agent_name 0x254cd06)
 *   ldp x2,x3,[x27]; cmp x3,#0; mov x4,#0xb; csel x1,x3,x4,ne; adrp x3,#0x102472000; add #0xc7b; csel x0,x2,x3,ne; ret
 *   fallback va 0x102472c7b fileoff 0x2472c7b len 0xb (11) => "antigravity" (616e746967726176697479)
 *   raw "antigravity-ide" @0x24c59ab va 0x1024c59ab count2 doc "**IDE**: `antigravity-ide/`" only,
 *   ADRP page 0x1024c5000+0x9ab exact 0 hits; "antigravity/ide" 0; "aidev_client" 1 (log cloudcode-paaidev_client)
 * - SetHTTPHeaders: IDE 0x1018e9ca0 16 ret, Standalone 0x1018ea350 16 ret, Stubby 0x1018f01d0 16 ret,
 *   CLI 0x1018ecfc0 704 (X-Goog-User-Project @0x1018ed1b8 only), Hub 0x1018ef6d0 832 (cloudcode-paaidev_client + X-Goog-User-Project)
 *   no UA / x-goog-api-client ADRP; raw x-goog @0x24ea019 false positive generationConfig.x-goog-api-client,
 *   google-api-nodejs-client 0, gl-node 0, Client-Metadata 0. loadCodeAssist/onboardUser literals exist
 *   (0x27a4f5d/0x27a53f5) but ADRP 0 hits — headers not synthesized there.
 * - Flag renamed: -override_user_agent -> override_user_agent_name @0x254cd06.
 */
export let getAntigravityUserAgent = () => {
	const override = process.env.PI_AI_ANTIGRAVITY_USER_AGENT?.trim() || process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
	const userAgent = override || "antigravity";
	getAntigravityUserAgent = () => userAgent;
	return userAgent;
};

export const getAntigravityRequestHeaders = () => ({
	"User-Agent": getAntigravityUserAgent(),
});
