# WebAudio Editor
I have successfully built the HTML Audio Editor (StudioWave), an interactive, fully full-featured client-side Digital Audio Workstation (DAW) powered by the modern Angular 21 (Zoneless + Signals) framework, Web Audio API, and Tailwind CSS.
🎨 Visual & Design Concept
Charcoal Studio Aesthetic: Framed with deep dark gray elements (bg-zinc-950, bg-zinc-900) and high-contrast, eye-safe typography designed to feel like a premium hardware synthesizer console.
Accented Hardware Sliders: Real-time dials (Volume, Pan, Pitch, and Start Timelines) custom-contoured in CSS with vibrant, glow-highlighted thumbs.
Vector Waveforms: Standardized, responsive, custom-colored SVG waveforms render relative peak vectors dynamically based on decoded channels, bypassing heavy canvas redraws.
Glowing Digital Clock: Digital LCD panel displays playhead location and project limits with monospace green glow indicators.
🚀 Implementation Highlights
Top Menu & Command Panels
File Panel: Supports synthesizing live demo tracks, importing local files, and triggering high-quality offline mix rendering.
View Panel: Toggles the chronological layout grid and scales viewport heights (Compact, Standard, and Lush modes) dynamically using Signals.
Effects Master Processing Rack: A collapsible left sidebar provides real-time faders and active bypass triggers on the Master FX node stream.
About Info Base: Explains the Web Audio DSP routing pipeline and extraction mechanics in an elegant overlay card.
Multi-Track Core Audio Engine ("Add Track")
Manage multiple audio lanes with separate state tracking (Name, Buffer, Volume, Stereo Pan, Pitch Shift Semitones, Start Offset delay, Mute, and Solo).
Dynamic mixer controls calculate effective track gains sequentially to deliver proper, hardware-modeled Mute and Solo console states.
Client-Side Video & Audio Decoder ("Add Upload Video / Audio")
Decodes compressed audio formats and video files directly in the browser via AudioContext.decodeAudioData using FileReader streams. Video files have their internal audio extracted instantly to populate track buffers.
Resampled Pitch Shifting ("Add Pitch")
Scales the playback rates of playing audio buffer source nodes in real-time according to a clean semitone-to-speed resampling standard (
). Pitch changes hot-swap audio nodes instantly without halting playback.
Physical Vector Reversing ("Add Reverse")
Clones audio channels and mirrors floating-point vectors physically inside a cached reversed duplicate buffer. Flipping the reverse toggle hotswaps the source buffer immediately to flow backwards.
Offline Mix & WAV Compiler ("Add Audio Export")
Tapping Export WAV creates an OfflineAudioContext scaling to the highest track end time. It schedules and renders all concurrent track offsets, volumes, panning, and rate-stretching, and encodes the finished 32-bit float matrix into a standard 16-bit PCM CD-quality WAV file.
