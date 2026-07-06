# GJC dogfood local skill template

Issue #93 requested a gaebal-gajae/operator dogfood skill. The live issue has no comment approving a fifth bundled default workflow skill, so this stays a local template instead of changing the default workflow surface. Operators can copy it into a user or project override when they want GJC-first session guidance.

The installable skill body is everything from the first frontmatter marker down; the frontmatter must be the **first line** of the installed file or the skill scan silently skips it (the scan requires a parsed `description`). Install into the user-level scan location (`~/.gjc/agent/skills/`, not `~/.gjc/skills/`):

```sh
mkdir -p ~/.gjc/agent/skills/gjc-dogfood
sed -n '/^---$/,$p' docs/gjc-dogfood-skill-template.md > ~/.gjc/agent/skills/gjc-dogfood/SKILL.md
```

For a single project, install to `<project>/.gjc/skills/gjc-dogfood/SKILL.md` with the same extraction. Do not commit that project `.gjc` copy unless the project explicitly wants a local override.

Filesystem skill discovery is off by default, so enable it once (`skills.enabled` plus the native user/project scans are `false` in `DEFAULT_SKILL_DISCOVERY_SETTINGS`):

```sh
gjc config set skills.enabled true
gjc config set skills.enablePiUser true      # for the ~/.gjc/agent/skills/ install
gjc config set skills.enablePiProject true   # for the <project>/.gjc/skills/ install
```

Then verify in a new session: `/skill:gjc-dogfood` should autocomplete.

---
name: gjc-dogfood
description: Use when running or reviewing work through GJC sessions, dogfooding Gajae-Code, or migrating an operator workflow from OMX to GJC.
---

# GJC Dogfood Operator Workflow

Use GJC first for coding, review, planning, and follow-up sessions. Treat OMX as a fallback only when GJC is unavailable, broken, or missing a required capability.

## Locate and launch GJC

- Installed CLI: run `command -v gjc` and then launch with `gjc --tmux`.
- Repository checkout: from the gajae-code repo, prefer `bun packages/coding-agent/src/cli.ts --tmux` when testing source changes before install.
- Worktree isolation: for branch-specific work, either let GJC create a managed sibling worktree with `gjc --tmux --worktree <branch-like-name>` or `cd <existing-worktree-path>` and run `gjc --tmux` there. Do not pass filesystem paths to `--worktree`.
- Name sessions explicitly with the project and issue, for example `gajae-code-93-dogfood-skill`, so tmux panes, logs, and exports remain traceable.

## Start the session

- Put git operations inside the GJC session: fetch, branch/worktree setup, focused commits, pushes, and PR creation should be visible in-session.
- Submit the initial prompt with the issue URL, target branch, acceptance criteria, verification limits, and any existing plan/spec link.
- Verify the prompt was accepted: the TUI should show the user prompt, an active assistant turn, or a tool/action request. If the session silently idles, resend once with a shorter prompt and capture the failure.
- Verify working state before leaving the session unattended: confirm the target cwd/worktree, branch, and issue scope are visible in the transcript or command output.

## During work

- Keep session names and branch names issue-scoped.
- Prefer GJC workflow skills only when they fit: `deep-interview` for unclear requirements, `ralplan` for planning, `ultragoal` for durable ledgers, and `team` for coordinated tmux execution.
- Keep evidence in the session: issue reads, focused tests/checks, screenshots only when visual behavior matters, and PR URLs.
- When GJC is weaker than OMX, finish the urgent work with the smallest safe fallback and file a gajae-code follow-up issue with the missing capability, exact command/session context, expected behavior, and evidence.

## Fallback policy

Use OMX or another operator path only when:

- `gjc` cannot be located or launched after checking installed and repo-local commands;
- authentication, model routing, tmux, or prompt submission is broken;
- GJC lacks a required capability that OMX already has;
- an urgent production/review deadline would be missed by debugging GJC first.

Record the fallback reason and create or link the gajae-code issue that would make GJC sufficient next time.

## Evidence checklist

Report:

- project, issue, branch/worktree, and session name;
- whether GJC was installed or repo-local;
- prompt acceptance and working-state evidence;
- git operations performed in-session;
- focused verification commands and results;
- PR/issue URLs;
- follow-up gajae-code issues for any GJC gap or fallback.
