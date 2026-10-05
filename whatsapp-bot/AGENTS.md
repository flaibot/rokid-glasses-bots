# Agent: WhatsApp Bot

- **Version**: 0.1.0
- **Description**: Read your recent WhatsApp chats and reply by voice. Also
  handles "send a WhatsApp to Mom saying I'm on my way" from Rokid's
  assistant: it finds the contact, shows the message, and sends it only
  when you tap. Talks to the whatsapp-bridge on your Mac over the tailnet.
- **Author**: Rokid Glasses bots contributors

## Capabilities

- **Permissions**:
  - microphone (`RECORD_AUDIO`, speech recognition for replies)
  - network (HTTP over the tailnet to the whatsapp-bridge)
  - camera (`CAMERA`, scanning the setup QR code)
- **Skills**:
  - speech-recognition

## Configuration

Scanned from a QR code (`rokid-utils/whatsapp-bot-qr`) and kept in
localStorage under `whatsapp.settings`:
`{"whatsapp": "<bridge url>", "key": "<bridge token>"}`.
