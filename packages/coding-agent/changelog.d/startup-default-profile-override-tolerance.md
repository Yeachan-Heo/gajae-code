### Fixed

- An explicit startup selector no longer lets a broken persisted profile block the run: `gjc --mpreset <profile> -p …` and `gjc --model <selector> -p …` now report a failing `modelProfile.default` as a warning and continue with the explicitly selected profile or model, instead of exiting before the override could apply. Without an explicit selector the fatal non-interactive contract is unchanged.
