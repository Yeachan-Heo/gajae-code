Searches the web for up-to-date information beyond knowledge cutoff.

<instruction>
- You SHOULD prefer primary sources (papers, official docs) and corroborate key claims with multiple sources
- You MUST include links for cited sources in the final response
</instruction>

<xai>
- With provider `xai`, use `xai_search_mode: "web"` for normal web search, `"x"` for X/Twitter search, or `"web_and_x"` when both surfaces are relevant.
- xAI web filters: `allowed_domains` or `excluded_domains` (max 5, mutually exclusive), plus `enable_image_understanding` and `enable_image_search`.
- xAI X filters: `allowed_x_handles` or `excluded_x_handles` (max 20, mutually exclusive), `from_date`, `to_date`, `enable_image_understanding`, and `enable_video_understanding`.
- Use `no_inline_citations` with provider `xai` when the answer should omit inline citation markdown while still returning structured sources.
</xai>

<caution>
Searches are performed automatically within a single API call—no pagination or follow-up requests needed.
</caution>
