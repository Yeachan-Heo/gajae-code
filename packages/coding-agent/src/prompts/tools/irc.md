Sends short text messages to other live agents in this process and receives their prose replies.

<instruction>
- The main agent is addressable as `0-Main`. Subagents reuse their task id (e.g. `0-AuthLoader`).
- `op: "list"` returns the current set of visible peers. Use it before sending if you are not sure who is live.
- `op: "send"` delivers `message` to `to`. `to` may be a specific id or `"all"` to broadcast.
- `awaitReply` (optional): wait for a prose reply. Defaults to `true` for DMs and `false` for `to: "all"` broadcasts.
- The recipient generates the reply via an ephemeral side-channel turn that uses their current model, system prompt, and history — it does **not** wait for the recipient's main loop to be free, so it is safe to IRC an agent that is currently inside a long-running tool call.
- The exchange (incoming question + auto-reply) is queued for injection into the recipient's persisted history; the recipient sees it on its next turn and can follow up if needed.
</instruction>

<conditions>
You SHOULD reach for `irc` proactively when continuing alone is wasteful or wrong. When in doubt, prefer messaging.
- **Unexpected state.** You hit something the original task did not describe — a missing file, a config that contradicts the assignment, an API behaving differently than you were told, a tool failing in a way that suggests the spec is wrong. DM `0-Main` (or the spawning agent) for guidance instead of guessing.
- **Blocked by another agent.** A peer holds the file/branch/resource you need, has already started the change you are about to make, or owns a decision you depend on. DM that peer (or broadcast to discover who) before duplicating or stepping on work.
- **Decision points outside your scope.** A genuine fork in the road that the assignment did not pre-decide (e.g. which of two viable APIs to use, whether to refactor adjacent code). Ask the requester rather than picking unilaterally.
- **Coordination opportunities.** Before editing a shared file or relying on another agent's in-flight API, message the relevant peer; proactively share state that affects their work.

Do **not** use `irc` for: routine progress updates, things you can verify with a tool call, or questions whose answer is already in your assignment / repo / docs.
</conditions>

<etiquette>
These rules apply to both sending and replying.
- **Plain prose only.** Do not send structured JSON status payloads (e.g. `{"type":"task_completed",…}`). Write a normal sentence: "Done with the auth refactor — left a TODO in `src/server/auth.ts` for the rate limiter."
- **Do not quote the message you are replying to.** The sender already saw it; the TUI already renders it. Lead with the answer.
- **Use IRC, not terminal tools, to learn about peers.** Do not `search` artifacts, read other sessions' JSONL files, or shell-poke around to figure out what another agent is doing. DM them — they have the live answer and you do not.
- **One round-trip is enough.** Replies arrive synchronously when the recipient is reachable. Do not follow up with "did you get my message?" — they did. If `delivered` is empty or the result was `failed`, the peer is unavailable; move on or report the blocker, do not retry in a loop.
- **Stay terse.** A DM is a chat message, not a memo. One question per send when you can. Share file paths and artifacts via `local://` / `artifact://` URLs instead of pasting blobs.
- **Address peers by id.** Use the exact id from `op: "list"` (e.g. `0-AuthLoader`, `0-Main`). Do not invent friendly names.
- **Do not IRC for things a tool would answer.** If a `read`, `search`, or build command would resolve the question, do that first.
- **When you receive an IRC message, answer it before continuing.** The recipient injects the question + your auto-reply into your history; address it directly, do not repeat it back to the user.
</etiquette>

<output>
- `send`: returns each recipient that received the message and any prose replies that arrived.
- `list`: returns peers and channels visible to the caller.
</output>

<examples>
# List peers
`{"op": "list"}`
# Direct message to the main agent (waits for prose reply)
`{"op": "send", "to": "0-Main", "message": "Should I prefer JWT or session cookies for the auth flow?"}`
# Unexpected state — ask the originator
`{"op": "send", "to": "0-Main", "message": "Assignment says edit src/auth/jwt.ts but the file does not exist. Is the new path src/server/auth/jwt.ts?"}`
# Blocked by a peer — ask them directly
`{"op": "send", "to": "0-AuthLoader", "message": "Are you still touching src/server/auth.ts? I need to add a 401 path; OK to proceed or should I wait?"}`
# Broadcast to discover who owns something (no replies, just informs them)
`{"op": "send", "to": "all", "message": "About to refactor src/server/middleware/*. Anyone already in there?", "awaitReply": false}`
</examples>
