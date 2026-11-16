### Fixed

- Fixed the notification-bus SDK host ending an owner's own prompt as `prompt_failed` (`post_start`) when `turn.abort_and_prompt` replaced it; the replaced prompt now settles as `stopped`/`cancelled` with `client_cancel` provenance, matching `turn.abort` and the SDK-only host ([#7559](https://github.com/Yeachan-Heo/gajae-code/issues/7559))
