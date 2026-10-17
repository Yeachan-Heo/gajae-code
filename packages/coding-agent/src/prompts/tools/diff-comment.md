# diff_comment

Leave structured comments on specific diff lines and resolve them after addressing them.

This tool is inspired by [JetBrains/thinkrail](https://github.com/JetBrains/thinkrail) (Apache-2.0).

## Usage

### Add a comment

Add a comment to a specific file and line range:

```
diff_comment op: add
              path: <file>
              start_line: <line>
              end_line: <line>
              comment: <text>
```

Example: annotate lines 10–15 of `src/main.ts` with "This logic needs review":

```
diff_comment op: add
              path: src/main.ts
              start_line: 10
              end_line: 15
              comment: This logic needs review
```

### Resolve a comment

After you address a comment, mark it resolved:

```
diff_comment op: resolve
              comment_id: <id>
              note: <optional brief note>
```

Example:

```
diff_comment op: resolve
              comment_id: abc123
              note: Fixed the edge case
```

### List all comments

View unresolved and resolved comments:

```
diff_comment op: list
```

## Notes

- Comments are stored at the session level and persist across turns.
- Each comment has a unique ID (shown when added).
- Use line numbers that match the current diff context (1-based).
- When you resolve a comment, optionally include a brief note describing what you did.
