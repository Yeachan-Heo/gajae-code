### Added

- Subagents can call the display-only `report_metric` tool to show a small bar chart of comparable numbers, such as sizes per format or timings per variant, in the live task card and the `subagent` await panel. Bars fit the terminal width, fall back to one text line when it is too narrow, and use `#` under the ASCII symbol preset. Charts never reach the parent model ([#7440](https://github.com/Yeachan-Heo/gajae-code/issues/7440)).
