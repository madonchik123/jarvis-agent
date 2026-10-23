# Third-party components

Jarvis builds on the following open-source projects and models. Please respect their licences.

| Component | Use | Licence |
|---|---|---|
| [Electron](https://www.electronjs.org/) | desktop shell | MIT |
| React, Framer Motion, Zustand, lucide-react | UI | MIT / ISC |
| [opencode](https://opencode.ai) | agent harness (`opencode serve`) | MIT |
| `jarvis-native` (this repo, `native/`) | C# computer-use engine; its window-centric tool design follows the publicly documented Codex computer-use API surface (no OpenAI code is included) | MIT (this project) |
| [Microsoft.Windows.SDK.Contracts](https://www.nuget.org/packages/Microsoft.Windows.SDK.Contracts) | Windows OCR from .NET Framework (build time) | Microsoft software licence |
| [electron-updater](https://www.electron.build/auto-update) | auto-update from GitHub Releases | MIT |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) | tool server / client | MIT |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + ONNX Runtime | on-device VAD / ASR runtime | Apache-2.0 / MIT |
| [Silero VAD](https://github.com/snakers4/silero-vad) | voice activity detection | MIT |
| Streaming Zipformer RU (Vosk-derived) | wake-word gate | Apache-2.0 |
| [GigaAM v3](https://github.com/salute-developers/GigaAM) | Russian speech recognition | MIT |
| [NVIDIA Parakeet-TDT 110M](https://huggingface.co/nvidia) | English speech recognition | CC-BY-4.0 (attribution: NVIDIA) |
| [OpenAI Whisper](https://github.com/openai/whisper) | optional English recogniser | MIT |
| [Piper](https://github.com/rhasspy/piper) + `ru_RU` voices | fast text-to-speech | MIT |
| `jgkawell/jarvis` Piper voice | community English "Jarvis" voice | MIT (as published by the author) |
| [XTTS-v2](https://huggingface.co/coqui/XTTS-v2) (Coqui) | optional GPU voice cloning | **Coqui Public Model License — non-commercial use only** |
| [Fish Audio](https://fish.audio) cloud TTS | optional cloud voices (own key, or through the shared free voice server) | service terms apply; text is sent to the service |
| Windows OCR (`Windows.Media.Ocr`), UI Automation | on-screen text / controls | part of Windows |

## Notes

* The cloned-voice engine is trained on the user's *own* reference recordings (`RuJarvisSounds/`). Those recordings and the
  resulting fine-tuned weights (`voice/gpt_best.pth`) are **not** part of the distributable and are git-ignored. The voice of
  a film character may be protected; use cloned voices for personal use only.
* "JARVIS" is a Marvel character name; this project is an independent, non-commercial fan implementation.
* No telemetry is collected. Speech is processed locally; the only network traffic is to the model endpoint you configure
  (opencode / Zen) and one-time model downloads from GitHub / Hugging Face.
