# Pre-registered code-mode repository tasks

These eight tasks are fixed before measurement. Each begins with a repository-wide search without a `paths` filter, reads a path chosen from that result, then searches for a distinctive identifier copied from the read output. The harness records and validates the chain; no task can be counted green from an answer alone.

## TASK CM01 | In-process benchmark client setup
Prompt:
Investigate how the TypeScript edit benchmark constructs an in-process GJC agent session. Start with a repository-wide search for `createAgentSession` and do not set `paths`. From the returned matches, choose the source for the benchmark's in-process client, read the path returned by search, then use a distinctive session option or API identifier copied from that read as the query for a repository-wide search. Explain how model/auth/session setup and active tool selection are configured.
Dependency contract:
1. Search the repository without a `paths` filter for `createAgentSession`.
2. Read the relevant source path returned by that search.
3. Search for the copied identifier `modelPattern` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the discovered source path, a concrete session option, and the tool-selection behavior.
Required answer terms: `in-process-client.ts`, `modelPattern`, `authStorage`, `toolNames`

## TASK CM02 | Codex freeform tool capability
Prompt:
Investigate the OpenAI Codex Responses provider's freeform custom-tool capability gate. Start with a repository-wide search for `supportsFreeformApplyPatchCodex` and do not set `paths`. Read the provider path returned by search, then search for a distinctive capability or grammar field copied from that read result. Explain which model capability is checked and where a custom tool's grammar is serialized.
Dependency contract:
1. Search the repository without a `paths` filter for `supportsFreeformApplyPatchCodex`.
2. Read the provider source path returned by that search.
3. Search for the copied identifier `applyPatchToolType` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the provider source path, the capability name, and the grammar serialization field.
Required answer terms: `openai-codex-responses.ts`, `applyPatchToolType`, `customFormat`, `syntax`

## TASK CM03 | Read tool argument schema
Prompt:
Investigate the built-in read tool's input schema and truncation behavior. Start with a repository-wide search for `const readSchema` and do not set `paths`. Read the source path returned by search, then search for a distinctive schema field or truncation identifier copied from that read result. Explain the required path input and one supported truncation option or default.
Dependency contract:
1. Search the repository without a `paths` filter for `const readSchema`.
2. Read a source path returned by that search.
3. Search for the copied identifier `truncation` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the source path, the path argument, and the truncation detail.
Required answer terms: `read.ts`, `readSchema`, `path`, `truncation`

## TASK CM04 | Search result metadata
Prompt:
Investigate the built-in search tool's result metadata. Start with a repository-wide search for `interface SearchToolDetails` and do not set `paths`. Read the source path returned by search, then search for a distinctive result-property identifier copied from that read result. Explain what file and match information is returned to callers.
Dependency contract:
1. Search the repository without a `paths` filter for `interface SearchToolDetails`.
2. Read a source path returned by that search.
3. Search for the copied identifier `fileMatches` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the source path, a file-list property, and a match-related property.
Required answer terms: `search.ts`, `files`, `fileMatches`, `matchCount`

## TASK CM05 | Session usage accounting
Prompt:
Investigate how AgentSession computes session statistics. Start with a repository-wide search for `getSessionStats(): SessionStats` and do not set `paths`. Read the session implementation path returned by search, then search for a distinctive usage accumulator copied from that read result. Explain how input, cache-read, and cache-write usage is accumulated.
Dependency contract:
1. Search the repository without a `paths` filter for `getSessionStats(): SessionStats`.
2. Read a session source path returned by that search.
3. Search for the copied identifier `cacheRead` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the source path and usage-accounting fields.
Required answer terms: `agent-session.ts`, `assistantMessages`, `cacheRead`, `cacheWrite`

## TASK CM06 | Model round-trip boundaries
Prompt:
Investigate where the core agent loop emits model-turn start events. Start with a repository-wide search for `turn_start` and do not set `paths`. From the results choose the agent-loop source, read that returned path, then search for a distinctive event-stream identifier copied from that read result. Explain where initial and subsequent turn boundaries are emitted relative to the loop.
Dependency contract:
1. Search the repository without a `paths` filter for `turn_start`.
2. Read a core agent-loop source path returned by that search.
3. Search for the copied identifier `turn_end` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the source path and at least two relevant turn-boundary facts.
Required answer terms: `agent-loop.ts`, `turn_start`, `turn_end`, `runLoop`

## TASK CM07 | Custom tool wire name contract
Prompt:
Investigate the AI tool type's `customWireName` contract. Start with a repository-wide search for `customWireName` and do not set `paths`. From the returned matches choose the AI tool type definition, read that path, then search for a distinctive tool-format or dispatch identifier copied from the read result. Explain how custom tool wire names differ from internal names and how dispatch can match them.
Dependency contract:
1. Search the repository without a `paths` filter for `customWireName`.
2. Read the AI tool type source path returned by that search.
3. Search for the copied identifier `customFormat` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the source path, the wire-name purpose, and the related format/dispatch contract.
Required answer terms: `packages/ai/src/types.ts`, `customWireName`, `customFormat`, `activeToolForCallName`

## TASK CM08 | Root benchmark command conventions
Prompt:
Investigate the root package's benchmark script conventions. Start with a repository-wide search for `bench:orchestration-tokens` and do not set `paths`. From the returned matches choose the root package manifest, read that path, then search for a distinctive benchmark script name copied from the manifest. Explain how the repository exposes benchmark commands and identify existing benchmark script values.
Dependency contract:
1. Search the repository without a `paths` filter for `bench:orchestration-tokens`.
2. Read the root package manifest path returned by that search.
3. Search for the copied identifier `bench:composer-stability-v3` from the immediately preceding read, without a fixed path filter.
Final answer:
Return the shared JSON answer/evidence format. Evidence should establish the manifest path and at least two existing benchmark command names.
Required answer terms: `package.json`, `bench:orchestration-tokens`, `bench:edit`, `bench:composer-stability-v3`
