### Fixed

- Fixed Anthropic requests with hidden thinking (`thinking.display: "omitted"`, set by `hideThinkingBlock`) failing with "Anthropic stream stalled while waiting for the next event" whenever the model thought for longer than one idle window. In that mode Anthropic streams nothing but `ping` keepalives until the thinking block ends, and pings did not count as progress. Pings now count as progress while a thinking block of a non-summarized request is open, bounded at three idle windows (30 min at the default) so a proxy that only pings still times out.
