# Agent: Hermes Bot

- **Version**: 0.9.3
- **Description**: Talk to your own Hermes agent from Rokid Glasses. AIUI recognises speech and sends the resulting text to the Hermes API; the reply is displayed and read aloud.
- **Author**: Rokid Glasses bots contributors

## Capabilities

- **Permissions**:
  - microphone (`RECORD_AUDIO`, speech recognition)
  - network (HTTP over the tailnet to the Hermes API server)
  - camera (`CAMERA`, scanning the setup QR code)
- **Skills**:
  - speech-recognition
  - speech-synthesis

## Configuration

Scanned from a QR code (`rokid-utils/hermes-bot-qr`) and kept in
localStorage under `hermes.settings`: `{"hermes": "<url>", "key": "<API_SERVER_KEY>"}`.
