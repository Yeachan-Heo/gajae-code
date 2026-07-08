Discover project and user runtime skills without loading full skill content.

<instruction>
- Searches only custom runtime skill locations: project `.gjc/skills` and user `~/.gjc/skills`.
- Built-in, bundled, and internal workflow skills are intentionally excluded.
- Returns thin metadata only: name, description, source scope, path, and use conditions when present.
- To load a selected skill's full `SKILL.md`, invoke it through the existing `skill` tool with the exact `name` returned here.
</instruction>

Input:
- `query` (optional): words to match against skill name, description, source, or use conditions.
- `source` (optional): `all`, `project`, or `user`.
- `limit` (optional): maximum results, 1-50.
