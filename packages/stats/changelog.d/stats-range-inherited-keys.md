### Fixed

- The stats dashboard treated `?range=constructor` and `?range=__proto__` as inherited `Object` members instead of unknown ranges, bypassing the documented 24-hour fallback and returning unfiltered stats. Unknown range names now always fall back to the last 24 hours.
