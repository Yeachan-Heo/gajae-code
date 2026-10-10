### Fixed

- Auth broker credential requests do not follow redirects, so a 307 or 308 cannot replay the JSON body to another host.
