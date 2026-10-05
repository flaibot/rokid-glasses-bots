# Agent: Claude Bot

- **Version**: 0.5.2
- **Description**: Browse the Claude Code sessions on your Mac, grouped by worktree, read them, and reply by voice. Talks to the claude-bridge on the Mac over the tailnet.
- **Author**: Rokid Glasses bots contributors

## Capabilities

- **Permissions**:
  - microphone (`RECORD_AUDIO`, speech recognition for replies)
  - network (HTTP over the tailnet to the claude-bridge)
  - camera (`CAMERA`, scanning the setup QR code)
- **Skills**:
  - speech-recognition

## Configuration

Scanned from a QR code (`rokid-utils/claude-bot-qr`) and kept in localStorage
under `claude.settings`: `{"claude": "<bridge url>", "key": "<bridge token>"}`.
