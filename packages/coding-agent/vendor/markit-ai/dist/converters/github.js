const GITHUB_HOSTS = new Set([
    "github.com",
    "www.github.com",
    "gist.github.com",
]);
/**
 * Matches GitHub URLs and fetches clean markdown content directly
 * from raw endpoints or the GitHub API — no HTML scraping needed.
 *
 * Supported patterns:
 *   - Repos:   github.com/owner/repo          → raw README.md
 *   - Files:   github.com/owner/repo/blob/…   → raw file content
 *   - Gists:   gist.github.com/owner/id       → raw gist content
 *   - Issues:  github.com/owner/repo/issues/N  → API (title + body)
 *   - PRs:     github.com/owner/repo/pull/N    → API (title + body)
 */
export class GitHubConverter {
    name = "github";
    accepts(streamInfo) {
        if (!streamInfo.url)
            return false;
        try {
            const { hostname } = new URL(streamInfo.url);
            return GITHUB_HOSTS.has(hostname);
        }
        catch {
            return false;
        }
    }
    async convertUrl(url, _options) {
        const parsed = new URL(url);
        if (parsed.hostname === "gist.github.com") {
            return fetchGist(parsed);
        }
        const segments = parsed.pathname.split("/").filter(Boolean);
        // Need at least owner/repo
        if (segments.length < 2) {
            throw new Error(`Unsupported GitHub URL: ${url}`);
        }
        const [owner, repo, type, ...rest] = segments;
        // github.com/owner/repo/blob/ref/path → raw file
        if (type === "blob" && rest.length >= 2) {
            const ref = rest[0];
            const filePath = rest.slice(1).join("/");
            return fetchRawFile(owner, repo, ref, filePath);
        }
        // github.com/owner/repo/issues/N or /pull/N
        if ((type === "issues" || type === "pull") && rest[0]) {
            const number = Number.parseInt(rest[0], 10);
            if (!Number.isNaN(number)) {
                return fetchIssueOrPr(owner, repo, number);
            }
        }
        // github.com/owner/repo (no subpath or tree/wiki/etc) → README
        if (!type) {
            return fetchReadme(owner, repo);
        }
        throw new Error(`Unsupported GitHub URL pattern: ${url}`);
    }
    async convert(_input, streamInfo) {
        // GitHub URLs are handled entirely via convertUrl.
        // If we end up here, the URL was already fetched by the default path —
        // just delegate to convertUrl.
        if (streamInfo.url) {
            return this.convertUrl(streamInfo.url);
        }
        throw new Error("GitHub converter requires a URL");
    }
}
// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------
async function fetchReadme(owner, repo) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch README: ${res.status} ${res.statusText}`);
    }
    const markdown = (await res.text()).trim();
    const title = extractFirstHeading(markdown) ?? `${owner}/${repo}`;
    return { markdown, title };
}
async function fetchRawFile(owner, repo, ref, filePath) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch file: ${res.status} ${res.statusText}`);
    }
    const content = (await res.text()).trim();
    const filename = filePath.split("/").pop() ?? filePath;
    // If it's markdown, return as-is. Otherwise wrap in a code block.
    if (filePath.endsWith(".md") || filePath.endsWith(".mdx")) {
        const title = extractFirstHeading(content) ?? filename;
        return { markdown: content, title };
    }
    const ext = filename.includes(".") ? filename.split(".").pop() : "";
    const markdown = `# ${filename}\n\n\`\`\`${ext}\n${content}\n\`\`\``;
    return { markdown, title: filename };
}
async function fetchGist(parsed) {
    const segments = parsed.pathname.split("/").filter(Boolean);
    // gist.github.com/owner/id
    const [owner, id] = segments;
    if (!owner || !id) {
        throw new Error(`Unsupported gist URL: ${parsed.href}`);
    }
    const url = `https://gist.githubusercontent.com/${owner}/${id}/raw`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch gist: ${res.status} ${res.statusText}`);
    }
    const content = (await res.text()).trim();
    const title = `gist:${id}`;
    return { markdown: content, title };
}
async function fetchIssueOrPr(owner, repo, number) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
    const res = await fetch(url, {
        headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch issue/PR: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json());
    const title = data.title ?? `#${number}`;
    const parts = [`# ${title}`];
    // Metadata line
    const meta = [];
    if (data.user?.login)
        meta.push(`@${data.user.login}`);
    if (data.state)
        meta.push(data.state);
    if (data.labels?.length) {
        meta.push(data.labels.map((l) => l.name).join(", "));
    }
    if (meta.length > 0)
        parts.push(meta.join(" · "));
    if (data.body?.trim())
        parts.push(data.body.trim());
    return { markdown: parts.join("\n\n"), title };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractFirstHeading(markdown) {
    const match = markdown.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim();
}
