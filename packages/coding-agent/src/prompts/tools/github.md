GitHub CLI tool with a single op-based dispatch. Wraps `gh` for repositories, pull requests, search, checkout, push, and Actions watch workflows. For reading a single issue or PR view, use the `issue://<N>` or `pr://<N>` URL schemes (cached automatically). For reading PR diffs, use `pr://<N>/diff` (changed-file listing), `pr://<N>/diff/<i>` (single file slice, 1-indexed), or `pr://<N>/diff/all` (full unified diff).

<instruction>
Pick the operation via `op`. Each op uses a subset of the parameters. Search ops (`search_issues`, `search_prs`, `search_code`, `search_commits`) default `repo` to the current checkout's `owner/repo` when omitted; pass an explicit `repo:`/`org:`/`user:` qualifier in `query` to search outside it.
- `repo_view` — Read repository metadata. Optional `repo` (owner/repo) and `branch`. Falls back to the current checkout or default `gh` repo.
- `pr_create` — Create a pull request. Either provide `title` (and optional `body`) or set `fill: true` to auto-fill from commits. Optional `base` (target, defaults to repo default), `head` (source, defaults to current branch), `draft`, `repo`, `reviewer[]`, `assignee[]`, `label[]`. Returns the new PR URL plus a summary.
- `pr_checkout` — Check one or more pull requests out into dedicated git worktrees. Optional `pr` (number, URL, branch, or array of any of those — pass an array to batch-check-out multiple PRs in one call), `repo`, `force` (reset existing local branch).
- `pr_push` — Push a checked-out PR branch back to its source branch. Requires the branch to have been checked out via `op: pr_checkout` (carries push metadata). Optional `branch`; defaults to the current checked-out git branch. Optional `forceWithLease`.
- `search_issues` — Search issues using normal GitHub issue search syntax. Optional `query` (required unless `since`/`until` is set), `repo`, `limit`, `since`, `until`, `dateField`.
- `search_prs` — Search pull requests using normal GitHub PR search syntax. Optional `query` (required unless `since`/`until` is set), `repo`, `limit`, `since`, `until`, `dateField`.
- `search_code` — Search code with GitHub code search syntax. Required `query`. Optional `repo`, `limit`. Returns matching paths with surrounding fragments. Date filtering (`since`/`until`) is **not** supported by GitHub code search.
- `search_commits` — Search commits across GitHub. Optional `query` (required unless `since`/`until` is set), `repo`, `limit`, `since`, `until`. `dateField` is ignored — always uses `committer-date`.
- `search_repos` — Search repositories across GitHub. Optional `query` (required unless `since`/`until` is set), `limit`, `since`, `until`, `dateField` (use query qualifiers like `org:`, `language:` instead of `repo`).
- Date filter format for `since` / `until`: relative duration `<n><unit>` (`m`/`h`/`d`/`w`/`mo`/`y`, e.g. `3d`, `12h`, `2w`), an ISO date `YYYY-MM-DD`, or an ISO datetime. Translated to a single GitHub-search qualifier (`created:≥…`, `created:≤…`, or `created:since..until`). `dateField: "updated"` maps to `updated:` for issues/prs and `pushed:` for repos. When you only want a date filter and no keywords, omit `query` entirely.
- `run_watch` — Watch a GitHub Actions workflow run. Optional `run` (id or URL). Omitting `run` watches all workflow runs for the current HEAD commit; `branch` falls back to the current branch. Optional `tail` (log lines per failed job). Streams snapshots, fast-fails on the first detected job failure (with a brief grace period to capture concurrent failures), then fetches tailed logs for the failed jobs. The full failed-job logs are saved as a session artifact for on-demand reads.
</instruction>

<output>
Returns a concise readable summary tailored to the chosen op (repo metadata, PR metadata, diff text, search results, checkout info, push target, or workflow run snapshot). For `run_watch`, the full failed-job logs are saved as a session artifact when failures occur.
</output>
