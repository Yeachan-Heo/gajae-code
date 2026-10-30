### Fixed

- Master sessions inject the peer snapshot once, before the first accepted provider request, as documented. The check for an earlier snapshot looked for the wrong session entry type, so it never matched and every new prompt turn collected and injected a fresh snapshot ([#7438](https://github.com/Yeachan-Heo/gajae-code/issues/7438)).
