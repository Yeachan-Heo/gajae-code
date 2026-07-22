Discover project and user runtime skills without loading full skill content.

<instruction>
- Searches only custom runtime skill locations: nearest project `.gjc/skills`; then, under the home directory, canonical `<config>/agent/skills`, configured legacy `<config>/skills`, and historical legacy `.gjc/skills`. `<config>` is the home-relative directory name from `GJC_CONFIG_DIR`, then `PI_CONFIG_DIR`, then `.gjc`; even an absolute-looking configured name is joined beneath `<home>`. Duplicate names use that exact precedence. Built-in, bundled, and internal workflow skills are intentionally excluded.
- Returns thin metadata only: name, description, source scope, path, and use conditions when present.
- When zero candidates are returned because discovery config is disabled (`skills.enabled`, `skills.enablePiProject`, `skills.enablePiUser`), the result carries a `notice` explaining which setting blocked the search — an empty result without a `notice` means the searched scopes genuinely contain no matching skills.
- To load a selected skill's full `SKILL.md`, invoke it through the existing `skill` tool with the exact `name` returned here.
</instruction>

Input:
- `query` (optional): words to match against skill name, description, source, or use conditions.
- `source` (optional): `all`, `project`, or `user`.
- `limit` (optional): maximum results, 1-50.
