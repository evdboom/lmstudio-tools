# Folio Local Audio Research And Design

Research date: 2026-10-22. Basic read-aloud is now implemented: a configurable
OpenAI-compatible speech proxy, persistent WAV cache, voice preview, and queued
beat playback. See [the setup instructions](../README.md#local-read-aloud).
The broader performance/effects design below remains proposed. Provider-specific
model quality and Intel GPU acceleration have not been benchmarked locally.

Implemented presets are `kokoro` (Kokoro at port 8880, WAV) and `chatterbox`
(external Chatterbox server at port 8004, WAV by default); `portable` is a Kokoro
alias. Folio sends complete paragraphs, not fixed-size text fragments. The
Chatterbox server can then split each paragraph into sentence-aware internal
chunks. Folio rejects paragraphs over 20,000 characters rather than truncating
them. The previous `laptop` and `desktop` names remain compatibility aliases.
Each supports service URL,
model, and voice overrides. Execution device remains the service's
responsibility. Chatterbox temperature, reference cloning, and synthesis speed
factor are managed separately by its UI; Folio currently leaves them at server
defaults. Folio queries `/get_predefined_voices`, stores filenames such as
`Emily.wav` as IDs, displays the friendly name, and auto-selects the first
available voice if the configured choice is missing. MP3 is an explicit format
override; the Chatterbox server needs FFmpeg available to encode MP3.
The supplied Compose file has separate Kokoro `cpu` and NVIDIA `cuda` profiles;
neither establishes an Intel-accelerated container path. Cached clips can replay
without the provider, but portable whole-story audio manifests are not yet built.

## Hardware Requirements

The eventual implementation must support both machines without assuming CUDA:

- Desktop: NVIDIA RTX 4060 Ti, 8188 MiB dedicated VRAM, observed with nvidia-smi.
- Laptop: user-reported Intel Arc "t140", with up to 48 GB shared system memory.
  Confirm the exact adapter name, driver, and runtime device support on that
  machine before choosing an accelerated backend.

Shared system memory is not equivalent to 48 GB of dedicated GPU VRAM. Memory
bandwidth, available RAM, runtime allocation limits, supported operators, and
compute throughput still constrain model choice. Do not automatically select a
large model from the advertised shared-memory limit or reserve all of that RAM.

Story prose generation, audio rendering, and listening are separate operations.
Approved audio must play without LM Studio or a TTS model running.

## Proposed Profiles

These names describe implementation targets, not existing configuration keys.

| Profile | Initial provider and execution | Role and fallback |
| --- | --- | --- |
| portable | Kokoro on CPU, using Kokoro-FastAPI CPU or kokoro-onnx | Required baseline on both machines; Piper is an alternative after voice audition. |
| desktop-expressive | Chatterbox Turbo on CUDA | First expressive English trial; compare Original separately for emotion controls. Explicitly choose portable if unavailable. |
| desktop-directed | Qwen3-TTS 1.7B or IndexTTS-2.5 | Optional audition after measuring memory and reviewing licenses; one model loaded at a time. |
| laptop-intel | Kokoro ONNX through an Intel-capable execution provider | Experimental until an end-to-end OpenVINO/ONNX test passes on the laptop; retain CPU fallback. |
| laptop-expressive | Chatterbox Nano on CPU | Optional expressive trial; upstream supports CPU, but laptop speed and quality remain unmeasured. |
| remote-render | Folio server using a configured desktop TTS service | Optional trusted-network rendering; must not silently send text to another host or cloud. |

Intel GPU support in OpenVINO does not prove that the Kokoro graph, its dynamic
shapes, quantization, wrapper, and installed provider versions work together.
Test the exact combination. PyTorch XPU is another possible research path, not a
drop-in replacement for CUDA-dependent TTS projects.

Docker Desktop's documented Windows `--gpus` path uses NVIDIA with WSL 2. Do not
reuse the desktop CUDA image or NVIDIA passthrough flags on Intel. A CPU container
is a portable baseline; native Windows OpenVINO is a candidate for Intel GPU
testing. Linux Intel device passthrough instructions do not establish Windows
Docker support.

## Speech Model Comparison

| Model | Storytelling fit | Important limits |
| --- | --- | --- |
| Kokoro-82M | Lightweight preset narrator; cross-machine baseline. Model weights Apache-2.0; kokoro-onnx wrapper MIT. | Not a documented general-purpose gasp/effects engine; compare voices on real prose. |
| Chatterbox Turbo, 350M | Voice references and inline vocal cues such as `[laugh]`, `[chuckle]`, `[cough]`, and `[sigh]`. MIT model card. | English; do not assume arbitrary cues work. Original-model CFG/exaggeration controls are ignored by Turbo. Outputs include Perth watermarking. |
| Chatterbox Original / Multilingual | Reference voices and emotion exaggeration; Multilingual includes Dutch. | Distinct from Turbo's cue support; test each engine separately. |
| Chatterbox Nano, 110M | CPU-oriented sibling of Turbo with paralinguistic support. | A laptop trial candidate, not a measured real-time guarantee. Server wrappers may not yet support Nano. |
| Qwen3-TTS 1.7B | CustomVoice offers preset speakers with delivery instructions. VoiceDesign creates a reference persona; Base clones a reference. Apache-2.0. | Separate model variants, not one universal API. 0.6B CustomVoice does not support the 1.7B instruction control. Do not assume Base cloning accepts the same style controls. 8 GB fit must be measured. |
| IndexTTS-2.5 | Reference voice with separate emotion reference/vector, pronunciation and speed controls. Card estimates roughly 6 GB inference VRAM. | Custom bilibili license; review before distribution/commercial use. Additional text-emotion model can increase resource use. Prosody is not modelled across concatenated segments. |
| Dia 1.6B | English short dialogue with speaker labels and explicit `(gasps)`, `(laughs)`, `(sighs)`. Apache-2.0. | Recommended short clips around 5-20 seconds; voice references and retries needed. Upstream memory figures vary, so 8 GB fit is not assured. |
| Dia2 1B / 2B | Audio-prefix-conditioned streaming dialogue. Apache-2.0. | Two-minute generation limit in reviewed docs; do not infer Dia's vocal-cue support applies unchanged. |
| Orpheus 3B | Preset voices with documented `<gasp>`, `<sigh>`, `<laugh>`, and other vocal tags. | Heavier and more involved deployment; no verified local 8 GB budget. Upstream links community LM Studio and FastAPI integrations, not guarantees of compatibility. |
| CosyVoice 3, 0.5B | Voice cloning and instruction-controlled emotion, speed, and volume. | Another audition candidate; backend/model-specific API and deployment work. Not needed for the first integration. |
| Bark | Explicit gasps/laughter/sighs; useful experimental short performances. MIT model card. | Roughly 13-14 second generation window; can deviate from text. Less suitable for faithful whole-story narration. |
| VibeVoice | Long-form multi-speaker experimentation. | Original long-form TTS code was removed upstream; community fork exists. Distinguish it from official Realtime 0.5B. Community FAQ describes uncontrolled background sounds/music. |
| Fish S2-Pro / Drama 3 | Expressive multi-character scenes and inline directions. | Current deployment docs call for 24 GB for S2-Pro and at least 48 GB for Drama 3 FP8. Not initial desktop/laptop targets; custom/research weight terms apply. |

Parameter counts do not include every auxiliary component and are not VRAM
requirements. Marketing speed and quality comparisons are not local benchmarks.

## Vocal Performance Versus Effects

1. Vocal delivery: calm narration, a whisper, hesitation, sadness, emphasis.
   Use model-specific instructions, controls, or approved reference takes.
2. Human vocal events: a gasp, sigh, laugh, cough, or breath. Prefer the selected
   character's speech model when its cue support is verified. Otherwise use an
   approved separate clip. A standalone cue may fail even when inline cues work.
3. Environmental effects: rain, a door, footsteps, room ambience. Use separate
   assets/tracks; do not ask a narrator model to produce a reliable sound mix.

Stable Audio Open 1.0 is an environmental-effects candidate: up to 47 seconds of
stereo audio, gated weights under Stability's community terms, and a documented
limitation on realistic vocals. AudioLDM2 and Tango are alternatives with
noncommercial weight terms. None is a verified 8 GB deployment here. A small
licensed or self-recorded effects library is the predictable first option.

Generated effects require audition, trimming, gain control, and sometimes retries.
Keep ambience and one-shot effects optional, independently adjustable, and quieter
than speech. Do not remove intentional breaths through blanket silence trimming.

## Folio Integration Contract

- Keep accepted prose unchanged and audio optional. Build an audio performance
  plan after prose review, with spans that reference exact source text, speaker
  IDs, delivery notes, pauses, and optional vocal/effect events.
- The current **Suggest Chatterbox vocal cues** run option adds a persistent
  ongoing narration instruction, independently of audio-profile readiness. It
  is always enableable and off by default; it targets Turbo specifically and
  does not guarantee the selected engine will interpret tags. The tags remain
  visible in authored narration.
- Before speech synthesis, Folio strips recognized Chatterbox cue tags unless
  the active Chatterbox service reports Turbo with
  `supports_paralinguistic_tags`. If capability probing fails, tags are
  stripped. Em/en dashes are converted to comma pauses in the TTS request only;
  stored and displayed story prose is not rewritten.
- When Turbo tags are preserved, Folio canonicalizes recognized tokens to their
  exact lowercase spellings because the model's special tokens are
  case-sensitive. For example, `[Sigh]` becomes `[sigh]` before synthesis.
- Vocal-cue guidance uses a per-tag usage table matching Turbo's
  [published added-token vocabulary](https://huggingface.co/ResembleAI/chatterbox-turbo/blob/main/added_tokens.json).
  Delivery cues prefix the affected sentence or opening dialogue quotation
  mark; they must not be appended as labels after the words they describe.
  Reaction cues belong where the sound actually happens, which may be after
  speech. `[softly]` and `[breathing hard]` are unsupported: describe these in
  ordinary prose, not invented tags. Review receives automated flags for
  unknown cues, incorrect case and misplaced delivery cues. Existing sessions
  automatically receive refreshed cue guidance when loaded.
- Validate span coverage/order and source hashes. Reject plans that rewrite,
  omit, duplicate, or invent spoken text. An LLM may propose direction, but the
  application owns validation and provider translation.
- Let users choose narrator-only, cast dialogue, and enhanced-effects modes.
  Preserve a cast's approved reference clips and pronunciation overrides.
- Make provider, service URL, model variant, voice, and execution device separate
  settings. The service controls local CPU/CUDA/OpenVINO/XPU execution; Folio
  should not infer it from a model name. Select machine settings explicitly.
- Query provider capabilities before exposing cloning, style instructions,
  timestamps, or cue controls. Translate a small canonical cue vocabulary per
  provider; never send unsupported tags as literal speech accidentally.
- Never silently change voices/models mid-story. Same-model device fallback may
  be automatic when configured, but report the actual execution backend. A
  different model/voice requires an explicit choice; preserve the original plan.
- Route browser requests through Folio to the configured service. Bind services
  to localhost by default, keep endpoints operator-controlled, and protect remote
  access. Browser localhost is not the desktop when reading from a phone.
- Render bounded utterances/paragraphs, with one active inference job initially.
  Support queued offline rendering, cancellation, retrying individual takes,
  progress, and conservative memory/thread/concurrency budgets per machine.
- Cache approved clips by source text, performance plan, model/version, voice
  reference hash, settings, and seed where applicable. Device/precision changes
  may change output; record them in render metadata. A seed is not a guarantee
  of identical output across runtimes or hardware.
- Persist a versioned audio manifest and clips separately from the story
  blueprint. Invalidate only affected clips after prose/voice edits. Make the
  audio package portable between machines without relying on absolute paths.
- Allow already-rendered desktop audio to play on the laptop without a model.
  Play/pause/stop/seek, beat navigation, playback speed, and separate effects
  volume must not depend on generation services remaining available.

## Deployment And Audition Order

1. Both machines: audition Kokoro CPU on the same approved story passage.
   Kokoro-FastAPI provides CPU Docker images and an OpenAI-compatible speech API.
2. Desktop: audition Chatterbox Turbo through the community
   Chatterbox-TTS-Server, which documents NVIDIA Docker Compose, a Web UI,
   reference voices, chunking, and an OpenAI-compatible endpoint. Keep ports
   loopback-only. Verify that the wrapper supports the selected model/version.
3. Laptop: verify the exact Intel adapter and drivers, then test Kokoro ONNX with
   an appropriate Intel execution provider outside the CUDA container. Promote
   acceleration only after comparing it with the working CPU baseline.
4. Desktop: compare Qwen3-TTS 1.7B CustomVoice and IndexTTS-2.5 on controlled
   delivery. Official local Python/Web UI paths exist; a supported Docker image
   was not verified for either. Do not invent a one-command container recipe.
5. Compare short character performances in Turbo, Dia, and optionally Orpheus.
   Add generated environmental effects only after narration is satisfactory.

For every trial, record cold load time, time to first clip, total render time,
audio duration, peak dedicated/shared GPU memory and RAM, device actually used,
pronunciation, word omissions/repetitions, cue success, voice drift, and boundary
quality. Real-time factor is render seconds divided by generated audio seconds;
below 1 is faster than real time. Test both short cues and several minutes of
prose, plus restart/cache reuse, service failures, and playback without inference.

## Sources

- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx)
- [Piper](https://github.com/OHF-Voice/piper1-gpl)
- [Chatterbox](https://github.com/resemble-ai/chatterbox)
- [Official Chatterbox Turbo special-token inventory](https://huggingface.co/ResembleAI/chatterbox-turbo/blob/main/added_tokens.json)
- [Community Chatterbox Turbo tag descriptions](https://github.com/wobba/ComfyUI-ChatterBox-Turbo#emotion--paralinguistic-tags)
- [Chatterbox Turbo weights](https://huggingface.co/ResembleAI/chatterbox-turbo)
- [Community Chatterbox server](https://github.com/devnen/Chatterbox-TTS-Server)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- [Qwen CustomVoice weights](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)
- [IndexTTS-2.5 model card](https://huggingface.co/IndexTeam/IndexTTS-2.5)
- [Dia](https://github.com/nari-labs/dia) and [Dia2](https://github.com/nari-labs/dia2)
- [Orpheus](https://github.com/canopyai/Orpheus-TTS)
- [CosyVoice](https://github.com/QwenAudio/CosyVoice)
- [Bark](https://github.com/suno-ai/bark)
- [VibeVoice upstream](https://github.com/microsoft/VibeVoice) and [community fork](https://github.com/vibevoice-community/VibeVoice)
- [Fish requirements and Docker](https://speech.fish.audio/install/)
- [Stable Audio Open 1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0)
- [AudioLDM2](https://github.com/haoheliu/AudioLDM2) and [Tango](https://github.com/declare-lab/tango)
- [Docker Desktop Windows GPU support](https://docs.docker.com/desktop/features/gpu/)
- [OpenVINO GPU support and limitations](https://docs.openvino.ai/2026/openvino-workflow/running-inference/inference-devices-and-modes/gpu-device.html)
- [ONNX Runtime OpenVINO provider](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html)