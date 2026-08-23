# Skills

GJC supports custom `SKILL.md` skills that live as plain files on disk, following
the same file convention as Claude Code and OpenAI Codex. Filesystem skill
discovery is **on by default** — a valid skill placed in a canonical `.gjc`
location is advertised in a normal session (listed in the session's `<skills>`
catalog and invokable via `/skill:<name>`) with no configuration ceremony.

The four bundled GJC workflow skills — `autoresearch`, `deep-interview`, `ralplan`, and
`ultragoal` — are always available and can never be replaced by a filesystem
skill with the same name.

## Canonical locations (loaded directly)

Project scope (trusted from the repository you open):

| Location | Scope notes |
|---|---|
| `<project>/.gjc/skills/<name>/SKILL.md` | Native GJC location; discovered from every ancestor of `cwd` up to the repo root (closest first) |

User scope (installed once, available in every project). The canonical root is
the **agent directory** printed by `gjc config path` (`~/.gjc/agent` by default;
`--agent-dir` / `GJC_CODING_AGENT_DIR` move it) — the same directory
`gjc migrate` writes user skills into:

| Location | Scope notes |
|---|---|
| `<agentDir>/skills/<name>/SKILL.md` | Canonical GJC user location (the agent directory from `gjc config path`) |
| `~/.gjc/agent/skills/<name>/SKILL.md` | Location of the canonical root in the default profile |
| `<config>/skills/<name>/SKILL.md` | Configured legacy root (`<config>` is the home-relative directory from `GJC_CONFIG_DIR`, then `PI_CONFIG_DIR`, then `.gjc`) |
| `~/.gjc/skills/<name>/SKILL.md` | Historical legacy user location (still honored) |

An agent-directory profile is a **separate user scope** (the same contract as
MCP user config): under `--agent-dir` / `GJC_CODING_AGENT_DIR`, only
`<agentDir>/skills` is scanned — the default profile's home-relative roots are
not read into a profile, and a profile's skills never leak into the default
profile. The legacy roots above apply in the default profile, exactly as
before.

## Claude Code / Codex layouts (explicit import sources)

GJC recognizes the Claude Code and Codex skill layouts but never loads them
directly — `.gjc` is the only runtime authority, so a session never silently
executes content owned by another host's configuration:

| Location | Convention |
|---|---|
| `<project>/.claude/skills/<name>/SKILL.md` | Claude Code project skills |
| `<project>/.codex/skills/<name>/SKILL.md` | OpenAI Codex project skills |
| `~/.claude/skills/<name>/SKILL.md` | Claude Code user skills |
| `~/.codex/skills/<name>/SKILL.md` | Codex user skills |

These are **import sources**: the `skill_discovery` tool and
`gjc skills discover` surface them as diagnostics naming the exact copy command
that enables each skill, so a skill placed in a documented convention location
is discoverable in a normal session. Foreign user-home layouts are enumerated
for import only and are never loaded into sessions.

Importing is a plain file copy into a canonical location:

```sh
# import one Claude Code project skill into the current repository
mkdir -p .gjc/skills/my-skill
cp .claude/skills/my-skill/SKILL.md .gjc/skills/my-skill/SKILL.md

# import one Codex user skill into your user-wide GJC skills
mkdir -p "$(gjc config path)/skills/my-skill"
cp ~/.codex/skills/my-skill/SKILL.md "$(gjc config path)/skills/my-skill/SKILL.md"
```

## Installing a skill

Copy a skill directory (its `SKILL.md` must start with YAML frontmatter that
includes `name` and `description`):

```sh
# project-local, per repository
mkdir -p .gjc/skills/my-skill
cp my-skill/SKILL.md .gjc/skills/my-skill/SKILL.md

# user-wide, available in every project
mkdir -p "$(gjc config path)/skills/my-skill"
cp my-skill/SKILL.md "$(gjc config path)/skills/my-skill/SKILL.md"
```

Start a new session and invoke the skill with `/skill:my-skill`, or let the
model discover it with the `skill_discovery` tool.

## Trust and disable

Skill discovery is controlled by three settings, all on by default:

| Setting | Effect |
|---|---|
| `skills.enabled` | Master switch for all filesystem skill discovery |
| `skills.trustProjectSkills` | Load project-scoped `.gjc/skills` and surface project `.claude`/`.codex` import candidates |
| `skills.trustUserSkills` | Load user-scoped skills (the agent directory's `skills` root and legacy home-relative roots) and surface user-home import candidates |

```sh
gjc config set skills.trustProjectSkills false   # ignore repo-controlled skills only
gjc config set skills.trustUserSkills false      # ignore personal skills only
gjc config set skills.enabled false              # disable all filesystem skill discovery
```

The deprecated `skills.enablePiProject` / `skills.enablePiUser` settings remain
supported as aliases: an explicitly configured legacy value is honored unless
the corresponding trust setting is also configured. `gjc config set` accepts
either name.

Bundled workflow skills are never affected by these switches — they remain
available even with discovery fully disabled.

## Precedence

Duplicate names resolve deterministically, first location wins:

1. project scope beats user scope;
2. within project scope, the `.gjc/skills` directory nearest to `cwd` wins
   (ancestors are walked from `cwd` up to the repo root, closest first);
3. within user scope: the agent directory's `skills` root (`gjc config path`);
   in the default profile its home-relative legacy roots follow at lower
   precedence: `<config>/agent/skills` > legacy `<config>/skills` >
   legacy `~/.gjc/skills` (under an agent-directory profile only the agent
   directory is scanned).

Shadowed duplicates are diagnosed rather than silent. Bundled workflow skill
names are reserved: a project skill named `autoresearch`, `deep-interview`, `ralplan`,
or `ultragoal` produces a protected-name collision warning, and the bundled
definition always wins in sessions.

## Diagnostics

Invalid skills and policy filters produce actionable diagnostics instead of
silent skips:

- a `SKILL.md` without a leading YAML frontmatter block;
- a skill without a `description` in its frontmatter;
- a skill shadowed by a higher-precedence location;
- a skill filtered by `skills.ignoredSkills` / `skills.includeSkills` /
  `disabledExtensions`;
- a protected-name collision with a bundled workflow skill;
- a Claude Code / Codex import candidate (with the copy command that enables it);
- disabled discovery scopes (the `skill_discovery` tool returns a `notice`
  explaining which setting blocked an otherwise-empty result).

Inspect what is discoverable and why from the CLI:

```sh
gjc skills discover                # project + user skills with diagnostics
gjc skills discover --source project --json
```

## Custom directories

`skills.customDirectories` adds extra user-scope scan roots; tilde expansion is
supported. Skills loaded from custom directories follow the same filters
(include/ignore/disabled) as discovered skills.
