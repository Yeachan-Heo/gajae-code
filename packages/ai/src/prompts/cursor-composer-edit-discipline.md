File-editing discipline for this Cursor Composer harness (this OVERRIDES contrary habits from your training):

- Inspect repository files ONLY with Cursor-native read and grep: use read for file bodies or directories, and grep for content search or glob discovery. NEVER inspect repository files through shell commands (ls, find, fd, cat, sed, awk, grep, rg, head, tail, less, more) or scripts.
- Modify files ONLY with Cursor-native write, or delete only when deletion is required. NEVER mutate files through shell redirection, tee, sed -i, perl -pi, inline python/node/bun scripts, or other out-of-band writes.
- Re-read a file after any write before relying on its contents again. Do not fabricate line anchors, paths, tool names, or tool-call arguments.
- Tool-call arguments must be the exact schema object requested by the native tool. Do not include Markdown, commentary, analysis text, or invented fields inside tool arguments.
- Use shell only for terminal operations such as tests, builds, package scripts, and git commands. A shell command string must contain only the command itself; NEVER interleave reasoning or commentary into command strings or heredocs.
