Discover bundled GJC workflow, project, and user runtime skills without loading full skill content.

<instruction>
- Includes the four bundled GJC workflow skills (`autoresearch`, `deep-interview`, `ralplan`, `ultragoal`) as `source: "bundled"` candidates from the generated bundled catalog; they are always available, cannot be replaced by filesystem copies, and are included for `source: "all"` but excluded by explicit `source: "project"`/`"user"` requests.
- Returns thin metadata only: name, description, source scope, path, and use conditions when present. Bundled paths are stable catalog identifiers, not filesystem paths.
- In trusted Git projects, `.gjc/skills` may be a symlink to a directory inside the same repository (for example `../.agents/skills`). Link and target identities remain checked through body loading; external targets and symlinked user/profile roots are refused. Do not replace a safe project link with copied files to make discovery work.
- Claude Code (`.claude/skills`) and Codex (`.codex/skills`) layouts are explicit import sources into `.gjc`, never invokable candidates. They are not returned as candidates; instead, each convention skill found in a trusted scope is reported in `diagnostics` with the exact copy command that enables it (copy into `.gjc/skills`), so a skill placed in a documented convention location is discoverable in a normal session without being silently loaded.
- Discovery is on by default in a normal session. `query` matching is conjunctive substring: every whitespace-separated term must appear in a skill's name, description, source, or use conditions, unless a term equals the exact skill name — one keyword that appears nowhere in the candidate's metadata drops every candidate, so query with exact names or few terms known to appear literally, not topic keyword lists. When zero candidates are returned, the result carries a `notice` if discovery config disabled a requested scope, a non-empty query filtered out scanned skills, or diagnostics explain observed skills that were skipped or filtered. Only an empty result without a `notice` means no skills were scanned and no diagnostics were produced; never report a zero-candidate result as proof no skill exists.
- When skills were scanned but not advertised (protected-name collision with a bundled workflow skill, include/ignore/disable policy filters, invalid frontmatter, shadowing), the result carries a bounded `diagnostics` list explaining why.
- To load a selected skill's full `SKILL.md`, invoke it through the existing `skill` tool with the exact `name` returned here.
</instruction>

Input:
- `query` (optional): words to match against skill name, description, source, or use conditions. Every term must appear (conjunctive substring), or one term must equal the exact skill name.
- `source` (optional): `all`, `project`, or `user`.
- `limit` (optional): maximum results, 1-50.
