Discover project and user runtime skills without loading full skill content.

<instruction>
- Searches canonical GJC skill locations in precedence order: project `.gjc/skills` (ancestors from cwd to repo root, closest first), then the user scope. The user scope is the agent directory's `skills` root (printed by `gjc config path`; `--agent-dir` / `GJC_CODING_AGENT_DIR` move it) — an agent-directory profile is a separate scope whose scan does not include the home. In the default profile the home-relative legacy roots follow at lower precedence: canonical `<config>/agent/skills`, configured legacy `<config>/skills`, and historical legacy `.gjc/skills`. `<config>` is the home-relative directory name from `GJC_CONFIG_DIR`, then `PI_CONFIG_DIR`, then `.gjc`; even an absolute-looking configured name is joined beneath `<home>`. Project scope shadows user scope; within a scope, earlier locations above win. Bundled GJC workflow skills (`autoresearch`, `deep-interview`, `ralplan`, `ultragoal`) are always available and cannot be replaced by filesystem skills.
- Returns thin metadata only: name, description, source scope, path, and use conditions when present.
- Claude Code (`.claude/skills`) and Codex (`.codex/skills`) layouts are explicit import sources into `.gjc`, never invokable candidates. They are not returned as candidates; instead, each convention skill found in a trusted scope is reported in `diagnostics` with the exact copy command that enables it (copy into `.gjc/skills`), so a skill placed in a documented convention location is discoverable in a normal session without being silently loaded.
- Discovery is on by default in a normal session. When zero candidates are returned because discovery config is disabled (`skills.enabled` master switch, or `skills.trustProjectSkills` / `skills.trustUserSkills` scope trust), the result carries a `notice` explaining which setting blocked the search — an empty result without a `notice` means the searched scopes genuinely contain no matching skills.
- When skills were scanned but not advertised (protected-name collision with a bundled workflow skill, include/ignore/disable policy filters, invalid frontmatter, shadowing), the result carries a bounded `diagnostics` list explaining why.
- To load a selected skill's full `SKILL.md`, invoke it through the existing `skill` tool with the exact `name` returned here.
</instruction>

Input:
- `query` (optional): words to match against skill name, description, source, or use conditions.
- `source` (optional): `all`, `project`, or `user`.
- `limit` (optional): maximum results, 1-50.
