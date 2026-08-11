# Speech-to-text

Gajae-Code can record microphone audio, transcribe it locally with OpenAI Whisper, and insert the result into the interactive composer. It does not submit the transcription automatically, so you can edit it before sending.

## Quick start

1. Install or check the local dependencies:

   ```sh
   gjc setup stt
   gjc setup stt --check
   ```

2. Enable speech-to-text:

   ```sh
   gjc config set stt.enabled true
   ```

   Alternatively, open `/settings` in an interactive session, select **Interaction**, and enable **Speech-to-Text**. The first `false` → `true` transition checks the recorder, Python, and Whisper installation immediately. Missing Whisper dependencies are installed with progress in the status line; if setup fails, GJC disables STT again and shows the actionable error.

3. In the composer, press **Alt+H** once to start recording. Press **Alt+H** again to stop and transcribe.

4. Review the text inserted into the composer, then press **Return** to send it.

Run `/hotkeys` to see the active shortcut after user remaps or extensions are loaded.

If Alt/Option is not reaching GJC, press **Ctrl+P**, select **Toggle speech-to-text**, and repeat the action to stop and transcribe. This command-palette path does not depend on an Alt key sequence.

## macOS keyboard and permissions

On macOS, **Alt+H** means **Option+H** (`⌥H`). The terminal must forward Option as Meta/Esc or use an enhanced keyboard protocol. In Apple Terminal, enable **Settings > Profiles > Keyboard > Use Option as Meta key** for the active profile.

In Ghostty, add this to `~/.config/ghostty/config`, then reload the configuration or restart Ghostty:

```ini
macos-option-as-alt = true
```

Without that setting, Option+H may arrive as the composed Unicode character `˙`, which GJC correctly treats as text rather than an Alt+H shortcut.

The first recording may cause macOS to request microphone access for the terminal application. Grant access under **System Settings > Privacy & Security > Microphone**. Restart the terminal after changing the permission.

If no recorder is installed, use Homebrew:

```sh
brew install sox
# or
brew install ffmpeg
```

## Linux and Windows recorders

On Debian or Ubuntu, install either supported recorder:

```sh
sudo apt install sox
# or
sudo apt install ffmpeg
```

Windows has a PowerShell recording fallback. SoX or FFmpeg can provide better recording support when the fallback is unsuitable.

## Models and language

The default model is `base.en`, configured for English. Change **Speech Model** in `/settings` when you need a different speed/accuracy tradeoff. Multilingual models omit the `.en` suffix.

The first transcription with a model may take longer while Whisper downloads that model. Later transcriptions reuse the local model cache.

## Troubleshooting

- **The shortcut does nothing:** confirm `stt.enabled` is on, run `/hotkeys`, and verify the terminal forwards Alt/Option.
- **Dependency check fails:** run `gjc setup stt --check` and follow the platform-specific recorder, Python, or Whisper diagnostic.
- **No speech detected or the recording is empty:** check the operating-system microphone permission and the selected/default input device.
- **Transcription is slow:** select a smaller Whisper model such as `tiny.en` or `base.en`.
- **Wrong language:** set `stt.language` and choose a multilingual model such as `base`, `small`, or `medium`.

## Remap the shortcut

User keybindings live at `~/.gjc/agent/keybindings.json`. For example:

```json
{
  "app.stt.toggle": "f6"
}
```

On compact Mac keyboards, the physical chord may be **Fn+F6**. A function key avoids Option composed-character behavior and control-code collisions such as Ctrl+H.

See [Keybindings](./keybindings.md) for chord syntax and terminal-specific behavior.
