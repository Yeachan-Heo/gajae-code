/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export const GEMINI_CLI_VERSION_ENV = "GJC_AI_GEMINI_CLI_VERSION";
export const LEGACY_GEMINI_CLI_VERSION_ENV = "PI_AI_GEMINI_CLI_VERSION";
export const DEFAULT_GEMINI_CLI_VERSION = "0.50.0";

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
 * Antigravity / Cloud Code Assist user agent.
 *
 * Disassembly-confirmed: getUserAgentName() @ 0x5ecb1dd loads "antigravity-ide"
 * via LEA RDX, [RIP-0x284fc90] → 0x367b554 = "antigravity-ide"
 *
 * The LS sets HTTP headers via: fmt.Sprintf("User-Agent: %s", getUserAgentName())
 * So the final header is: User-Agent: antigravity-ide
 *
 * -override_user_agent flag can override this (confirmed at 0x5ecbc37).
 */
export let getAntigravityUserAgent = () => {
	const override = process.env.PI_AI_ANTIGRAVITY_USER_AGENT;
	const userAgent = override || "antigravity-ide";
	getAntigravityUserAgent = () => userAgent;
	return userAgent;
};

export const getAntigravityRequestHeaders = () => ({
	"User-Agent": getAntigravityUserAgent(),
});
