/**
 * Tombstone for the removed legacy `worktree` CLI command module.
 *
 * The `gjc worktree`/`wt` command was unregistered during the
 * workflow-surface narrowing and its implementation was deliberately
 * removed. This module exists only to fail imports with actionable
 * migration guidance.
 */
export {};

throw new Error(
	"@gajae-code/coding-agent/commands/worktree was deliberately removed: the `gjc worktree` command and its cleanup implementation are gone. Inspect leftover managed worktrees under ~/.gjc/wt manually and use `git worktree remove` or `git worktree prune` instead.",
);
