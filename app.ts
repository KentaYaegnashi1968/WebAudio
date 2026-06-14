import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

export interface AudioTrack {
  id: string;
  name: string;
  audioBuffer: AudioBuffer | null;
  reversedBuffer: AudioBuffer | null;
  volume: number; // 0.0 to 1.5
  pan: number; // -1.0 to 1.0 (Left to Right)
  pitch: number; // -12 to 12 (Semitones)
  isReversed: boolean;
  isMuted: boolean;
  isSoloed: boolean;
  offset: number; // Delay in seconds
  duration: number; // Cache buffer duration
  peaks: number[]; // Relative visual peaks
}

interface ActiveNode {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  protected readonly Math = Math;

  // State Signals
  tracks = signal<AudioTrack[]>([]);
  currentPosition = signal<number>(0);
  playbackState = signal<'playing' | 'paused' | 'stopped'>('stopped');
  isLooping = signal<boolean>(false);
  zoomFactor = signal<number>(20); // Pixels per second
  showGrid = signal<boolean>(true);
  statusMessage = signal<string>('Ready to create and edit audio project.');
  isProcessing = signal<boolean>(false);
  activePanel = signal<'file' | 'view' | 'effects' | 'about' | null>(null);

  // Master Volume Signal
  masterVolume = signal<number>(0.8);

  // Master Effects Signals
  reverbEnabled = signal<boolean>(false);
  reverbDecay = signal<number>(1.8);
  delayEnabled = signal<boolean>(false);
  delayTime = signal<number>(0.3);
  delayFeedback = signal<number>(0.4);
  filterEnabled = signal<boolean>(false);
  filterCutoff = signal<number>(1800);
  compressorEnabled = signal<boolean>(false);
  compressorThreshold = signal<number>(-15);

  // Web Audio Context & Output Node Graph
  protected audioCtx!: AudioContext;
  private masterGainNode!: GainNode;
  private masterFilterNode!: BiquadFilterNode;
  private masterDelayNode!: DelayNode;
  private masterDelayFeedbackNode!: GainNode;
  private masterDelayWetNode!: GainNode;
  private masterReverbNode!: ConvolverNode;
  private masterReverbWetNode!: GainNode;
  private masterCompressorNode!: DynamicsCompressorNode;

  // Dictionary for active sources during live playing
  private activeNodesMap = new Map<string, ActiveNode>();

  // Playback timer controls
  private animationId: number | null = null;
  private playStartTime = 0;
  private playPositionAnchor = 0;

  // Dynamic calculations based on state signals
  totalDuration = computed(() => {
    const list = this.tracks();
    if (list.length === 0) return 10.0; // Default 10s timeline
    const endTimes = list.map((t) => {
      const rate = Math.pow(2, t.pitch / 12);
      const effLen = t.audioBuffer ? t.audioBuffer.duration / rate : 0;
      return t.offset + effLen;
    });
    return Math.max(...endTimes, 5.0); // At least 5s duration limit
  });

  // Dynamic axis ticks for timeline ruler
  timelineTicks = computed(() => {
    const total = Math.ceil(this.totalDuration());
    const result: number[] = [];
    const step = total > 60 ? 10 : (total > 20 ? 5 : 1);
    for (let i = 0; i <= total; i += step) {
      result.push(i);
    }
    return result;
  });

  // Track height scaling configuration
  trackHeight = signal<'normal' | 'compact' | 'expanded'>('normal');

  // Forms for editing track info or inputs
  @ViewChild('audioFileInput') audioFileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('videoFileInput') videoFileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('timelineContainer') timelineContainer!: ElementRef<HTMLDivElement>;

  constructor() {
    // Reactive binding triggers for master effects nodes parameters:
    effect(() => {
      const enabled = this.reverbEnabled();
      const decay = this.reverbDecay();
      if (this.masterReverbWetNode && this.audioCtx) {
        this.masterReverbWetNode.gain.setTargetAtTime(enabled ? 0.45 : 0.0, this.audioCtx.currentTime, 0.02);
        if (enabled) {
          const impulse = this.createImpulseResponse(decay, 2.0);
          this.masterReverbNode.buffer = impulse;
        }
      }
    });

    effect(() => {
      const enabled = this.delayEnabled();
      const time = this.delayTime();
      const fb = this.delayFeedback();
      if (this.masterDelayWetNode && this.audioCtx) {
        this.masterDelayWetNode.gain.setTargetAtTime(enabled ? 0.35 : 0.0, this.audioCtx.currentTime, 0.02);
        this.masterDelayNode.delayTime.setTargetAtTime(time, this.audioCtx.currentTime, 0.02);
        this.masterDelayFeedbackNode.gain.setTargetAtTime(fb, this.audioCtx.currentTime, 0.02);
      }
    });

    effect(() => {
      const enabled = this.filterEnabled();
      const cutoff = this.filterCutoff();
      if (this.masterFilterNode && this.audioCtx) {
        const targetFreq = enabled ? cutoff : 22000;
        this.masterFilterNode.frequency.setTargetAtTime(targetFreq, this.audioCtx.currentTime, 0.02);
      }
    });

    effect(() => {
      const enabled = this.compressorEnabled();
      const thresh = this.compressorThreshold();
      if (this.masterCompressorNode && this.audioCtx) {
        if (enabled) {
          this.masterCompressorNode.threshold.setTargetAtTime(thresh, this.audioCtx.currentTime, 0.02);
          this.masterCompressorNode.ratio.setTargetAtTime(8, this.audioCtx.currentTime, 0.02);
        } else {
          this.masterCompressorNode.ratio.setTargetAtTime(1, this.audioCtx.currentTime, 0.02);
        }
      }
    });

    effect(() => {
      const masterVol = this.masterVolume();
      if (this.masterGainNode && this.audioCtx) {
        this.masterGainNode.gain.setTargetAtTime(masterVol, this.audioCtx.currentTime, 0.02);
      }
    });
  }

  ngOnInit() {
    this.statusMessage.set('StudioWave workstation loaded. Add tracks or synthesize a synth demo to begin.');
  }

  ngOnDestroy() {
    this.stopPlayheadTicker();
    this.stopActivePlaybackNodes();
    if (this.audioCtx) {
      this.audioCtx.close();
    }
  }

  // Lazy Initialization of Audio Context and Routing Graph
  initAudio() {
    if (!this.audioCtx) {
      try {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
        this.setupMasterFXGraph();
      } catch (err) {
        this.statusMessage.set('Failed to initialize AudioContext in this browser: ' + String(err));
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  private setupMasterFXGraph() {
    const ctx = this.audioCtx;

    // 1. Create Core Nodes
    this.masterFilterNode = ctx.createBiquadFilter();
    this.masterFilterNode.type = 'lowpass';
    this.masterFilterNode.frequency.setValueAtTime(22000, ctx.currentTime);

    this.masterCompressorNode = ctx.createDynamicsCompressor();
    this.masterCompressorNode.threshold.setValueAtTime(-15, ctx.currentTime);
    this.masterCompressorNode.knee.setValueAtTime(15, ctx.currentTime);
    this.masterCompressorNode.ratio.setValueAtTime(1, ctx.currentTime); // bypass initially

    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.setValueAtTime(this.masterVolume(), ctx.currentTime);

    // Create parallel Delay loop structures
    this.masterDelayNode = ctx.createDelay(2.0);
    this.masterDelayNode.delayTime.setValueAtTime(this.delayTime(), ctx.currentTime);
    this.masterDelayFeedbackNode = ctx.createGain();
    this.masterDelayFeedbackNode.gain.setValueAtTime(this.delayFeedback(), ctx.currentTime);
    this.masterDelayWetNode = ctx.createGain();
    this.masterDelayWetNode.gain.setValueAtTime(0.0, ctx.currentTime);

    // Create parallel Reverb structures
    this.masterReverbNode = ctx.createConvolver();
    this.masterReverbWetNode = ctx.createGain();
    this.masterReverbWetNode.gain.setValueAtTime(0.0, ctx.currentTime);

    // 2. Routing Connections
    // Main dry path
    this.masterFilterNode.connect(this.masterCompressorNode);

    // Filter outputs to parallel Delay chain
    this.masterFilterNode.connect(this.masterDelayNode);
    this.masterDelayNode.connect(this.masterDelayFeedbackNode);
    this.masterDelayFeedbackNode.connect(this.masterDelayNode); // Feedback loop hook
    this.masterDelayNode.connect(this.masterDelayWetNode);
    this.masterDelayWetNode.connect(this.masterCompressorNode);

    // Filter outputs to parallel Reverb chain
    this.masterFilterNode.connect(this.masterReverbNode);
    this.masterReverbNode.connect(this.masterReverbWetNode);
    this.masterReverbWetNode.connect(this.masterCompressorNode);

    // Master limiting compression redirects to gain block and speakers
    this.masterCompressorNode.connect(this.masterGainNode);
    this.masterGainNode.connect(ctx.destination);
  }

  // Generates impulse response decay envelope inside offline and active contexts on-the-fly
  private createImpulseResponse(duration: number, decay = 2.0): AudioBuffer {
    const rate = this.audioCtx ? this.audioCtx.sampleRate : 44100;
    const len = rate * duration;
    // Create dual-channel stereo convolver buffer
    const buffer = (this.audioCtx || new AudioContext()).createBuffer(2, len, rate);
    const leftCh = buffer.getChannelData(0);
    const rightCh = buffer.getChannelData(1);

    for (let i = 0; i < len; i++) {
      const percentage = i / len;
      const decayAmplitude = Math.exp(-percentage * decay);
      // Gaussian distribution white noise envelope
      leftCh[i] = (Math.random() * 2 - 1) * decayAmplitude;
      rightCh[i] = (Math.random() * 2 - 1) * decayAmplitude;
    }
    return buffer;
  }

  // Project Transport Deck Handlers (Play, Pause, Stop, Seek)
  play() {
    this.initAudio();
    if (this.tracks().length === 0) {
      this.statusMessage.set('Create or import a track to start playback.');
      return;
    }

    if (this.playbackState() === 'playing') return;

    const startAt = this.currentPosition() >= this.totalDuration() ? 0 : this.currentPosition();
    this.currentPosition.set(startAt);
    
    this.playbackState.set('playing');
    this.startActivePlaybackNodes(startAt);
    this.startPlayheadTicker();
    this.statusMessage.set('Playing project mix...');
  }

  pause() {
    if (this.playbackState() !== 'playing') return;
    this.playbackState.set('paused');
    this.stopActivePlaybackNodes();
    this.stopPlayheadTicker();
    this.statusMessage.set('Playback paused.');
  }

  stop() {
    this.playbackState.set('stopped');
    this.stopActivePlaybackNodes();
    this.stopPlayheadTicker();
    this.currentPosition.set(0);
    this.statusMessage.set('Playback stopped.');
  }

  toggleLoop() {
    this.isLooping.update((p) => !p);
  }

  seekTo(time: number) {
    const total = this.totalDuration();
    const clampedTime = Math.max(0, Math.min(time, total));
    const wasPlaying = this.playbackState() === 'playing';

    if (wasPlaying) {
      this.stopActivePlaybackNodes();
    }

    this.currentPosition.set(clampedTime);

    if (wasPlaying) {
      this.startActivePlaybackNodes(clampedTime);
      this.playStartTime = this.audioCtx.currentTime;
      this.playPositionAnchor = clampedTime;
    }
  }

  onTimelineClick(event: MouseEvent) {
    const el = event.currentTarget as HTMLDivElement;
    const rect = el.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickedSec = clickX / this.zoomFactor();
    this.seekTo(clickedSec);
  }

  // Sync Timer Playhead update loops
  private startPlayheadTicker() {
    this.playStartTime = this.audioCtx.currentTime;
    this.playPositionAnchor = this.currentPosition();

    const tick = () => {
      if (this.playbackState() !== 'playing') return;
      const elapsed = this.audioCtx.currentTime - this.playStartTime;
      const calculatedPos = this.playPositionAnchor + elapsed;
      const totalLen = this.totalDuration();

      if (calculatedPos >= totalLen) {
        if (this.isLooping()) {
          this.seekTo(0);
        } else {
          this.stop();
          return;
        }
      } else {
        this.currentPosition.set(calculatedPos);
      }
      this.animationId = requestAnimationFrame(tick);
    };
    this.animationId = requestAnimationFrame(tick);
  }

  private stopPlayheadTicker() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  // Active Multi-track playing node routers
  private startActivePlaybackNodes(startTime: number) {
    this.initAudio();

    const hasAnySolo = this.tracks().some((t) => t.isSoloed);

    this.tracks().forEach((track) => {
      if (!track.audioBuffer) return; // Skip unloaded/empty tracks

      const pitchRatio = Math.pow(2, track.pitch / 12);
      const scaledDuration = track.duration / pitchRatio;
      const trackEndPlayBoundary = track.offset + scaledDuration;

      // Skip tracks completely outside the playhead's current offset
      if (startTime >= trackEndPlayBoundary) return;

      const triggerDelay = Math.max(0, track.offset - startTime);
      const startingBuffOffset = Math.max(0, startTime - track.offset) * pitchRatio;

      // Configure Active Sources
      const source = this.audioCtx.createBufferSource();
      source.buffer = track.isReversed ? track.reversedBuffer : track.audioBuffer;
      source.playbackRate.value = pitchRatio;

      const trackGain = this.audioCtx.createGain();
      const trackVol = this.calculateEffectiveTrackGain(track, hasAnySolo);
      trackGain.gain.setValueAtTime(trackVol, this.audioCtx.currentTime);

      const trackPanner = this.audioCtx.createStereoPanner();
      trackPanner.pan.setValueAtTime(track.pan, this.audioCtx.currentTime);

      // Route through nodes standard graph: source -> Gain -> Pan -> masterFilter
      source.connect(trackGain);
      trackGain.connect(trackPanner);
      trackPanner.connect(this.masterFilterNode);

      // Start source schedule
      source.start(this.audioCtx.currentTime + triggerDelay, startingBuffOffset);

      this.activeNodesMap.set(track.id, {
        source,
        gainNode: trackGain,
        pannerNode: trackPanner,
      });
    });
  }

  private stopActivePlaybackNodes() {
    this.activeNodesMap.forEach((node) => {
      try {
        node.source.stop();
      } catch (err) {
        console.debug('Redundant termination caught:', err);
      }
    });
    this.activeNodesMap.clear();
  }

  // Mixer Volume Calculations (Supports Mute and Solo states)
  private calculateEffectiveTrackGain(track: AudioTrack, anySoloActive: boolean): number {
    if (track.isMuted) return 0.0;
    if (anySoloActive && !track.isSoloed) return 0.0;
    return track.volume;
  }

  // Real-time slider controllers (instantly changes variables in play)
  onTrackVolumeChange(track: AudioTrack, event: Event) {
    const input = event.target as HTMLInputElement;
    const vol = parseFloat(input.value);
    
    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, volume: vol } : t))
    );

    const activeNode = this.activeNodesMap.get(track.id);
    if (activeNode) {
      const hasAnySolo = this.tracks().some((t) => t.isSoloed);
      const updatedTrack = this.tracks().find((t) => t.id === track.id);
      if (updatedTrack) {
        const finalVol = this.calculateEffectiveTrackGain(updatedTrack, hasAnySolo);
        activeNode.gainNode.gain.setValueAtTime(finalVol, this.audioCtx.currentTime);
      }
    }
  }

  onTrackPanChange(track: AudioTrack, event: Event) {
    const input = event.target as HTMLInputElement;
    const panVal = parseFloat(input.value);

    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, pan: panVal } : t))
    );

    const activeNode = this.activeNodesMap.get(track.id);
    if (activeNode) {
      activeNode.pannerNode.pan.setValueAtTime(panVal, this.audioCtx.currentTime);
    }
  }

  // Re-starts relevant nodes on-the-fly when pitch transitions
  onTrackPitchChange(track: AudioTrack, event: Event) {
    const input = event.target as HTMLInputElement;
    const semitones = parseInt(input.value, 10);

    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, pitch: semitones } : t))
    );

    this.statusMessage.set(`Adjusting pitch of "${track.name}" to ${semitones > 0 ? '+' : ''}${semitones} semitones.`);

    // Pitch changes require source node recreation to prevent audio desync or simple rate glissando
    if (this.playbackState() === 'playing') {
      const currPos = this.currentPosition();
      this.seekTo(currPos); // Rebuild nodes immediately
    }
  }

  onTrackOffsetChange(track: AudioTrack, event: Event) {
    const input = event.target as HTMLInputElement;
    const offsetSec = parseFloat(input.value);

    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, offset: offsetSec } : t))
    );

    if (this.playbackState() === 'playing') {
      const currPos = this.currentPosition();
      this.seekTo(currPos); // Relocate running track offset on layout
    }
  }

  toggleTrackMute(track: AudioTrack) {
    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, isMuted: !t.isMuted } : t))
    );
    this.syncActiveTrackGains();
  }

  toggleTrackSolo(track: AudioTrack) {
    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, isSoloed: !t.isSoloed } : t))
    );
    this.syncActiveTrackGains();
  }

  toggleTrackReverse(track: AudioTrack) {
    this.tracks.update((list) =>
      list.map((t) => (t.id === track.id ? { ...t, isReversed: !t.isReversed } : t))
    );
    this.statusMessage.set(`Toggled reverse state for "${track.name}".`);

    // Live Hot Swapping audio source buffers
    if (this.playbackState() === 'playing') {
      const currPos = this.currentPosition();
      this.seekTo(currPos);
    }
  }

  private syncActiveTrackGains() {
    const hasAnySolo = this.tracks().some((t) => t.isSoloed);
    this.tracks().forEach((t) => {
      const node = this.activeNodesMap.get(t.id);
      if (node) {
        const targetVol = this.calculateEffectiveTrackGain(t, hasAnySolo);
        node.gainNode.gain.setValueAtTime(targetVol, this.audioCtx ? this.audioCtx.currentTime : 0);
      }
    });
  }

  // Tracks structural handlers
  addBlankTrack() {
    this.initAudio();
    const index = this.tracks().length + 1;
    this.addNewTrack(`Empty Track ${index}`, null);
  }

  deleteTrack(id: string) {
    const node = this.activeNodesMap.get(id);
    if (node) {
      try {
        node.source.stop();
      } catch (e) {
        console.debug('Failed to stop track source on delete:', e);
      }
      this.activeNodesMap.delete(id);
    }

    this.tracks.update((list) => list.filter((t) => t.id !== id));
    this.statusMessage.set('Track removed.');
  }

  clearProject() {
    this.stop();
    this.tracks.set([]);
    this.currentPosition.set(0);
    this.statusMessage.set('Workspace reset. All tracks cleared.');
  }

  // 100% Client-side synthesized demo track generators (Chord Arpeggiators)
  loadDemoSynth() {
    this.isProcessing.set(true);
    this.statusMessage.set('Synthesizing demo multi-track patterns...');

    setTimeout(() => {
      try {
        this.initAudio();
        const sampleRate = this.audioCtx.sampleRate || 44100;
        const duration = 10.0; // 10 seconds chord progression
        const numSamples = sampleRate * duration;
        const buffer = this.audioCtx.createBuffer(2, numSamples, sampleRate);

        const leftCh = buffer.getChannelData(0);
        const rightCh = buffer.getChannelData(1);

        // Pattern logic: Am (0s-2.5s) -> F (2.5s-5s) -> C (5s-7.5s) -> G (7.5s-10s)
        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;

          // 1. Root Sine Bass
          let rootBass = 110.00; // A2
          if (t >= 2.5 && t < 5.0) rootBass = 87.31; // F2
          else if (t >= 5.0 && t < 7.5) rootBass = 130.81; // C3
          else if (t >= 7.5) rootBass = 98.00; // G2

          const bassOsc = Math.sin(2 * Math.PI * rootBass * t) * 0.18 + Math.sin(Math.PI * rootBass * t) * 0.1;

          // 2. Chords Pad (Trig envelopes for smooth lush movement)
          let freqs = [220.00, 261.63, 329.63]; // A, C, E
          if (t >= 2.5 && t < 5.0) freqs = [174.61, 220.00, 261.63]; // F, A, C
          else if (t >= 5.0 && t < 7.5) freqs = [261.63, 329.63, 392.00]; // C, E, G
          else if (t >= 7.5) freqs = [196.00, 246.94, 293.66]; // G, B, D

          const padOsc = (
            Math.sin(2 * Math.PI * freqs[0] * t) +
            Math.sin(2 * Math.PI * freqs[1] * t) +
            Math.sin(2 * Math.PI * freqs[2] * t)
          ) * 0.05 * (1 + 0.2 * Math.sin(2 * Math.PI * 4 * t)); // with subtle vibrato

          // 3. High arpeggiator melody
          const noteTick = Math.floor(t * 5.5) % 8; // 8 notes per scale step
          let arpFreqs = [440.00, 523.25, 659.25, 880.00]; // Am
          if (t >= 2.5 && t < 5.0) arpFreqs = [349.23, 440.00, 523.25, 698.46]; // F
          else if (t >= 5.0 && t < 7.5) arpFreqs = [523.25, 659.25, 783.99, 1046.50]; // C
          else if (t >= 7.5) arpFreqs = [392.00, 493.88, 587.33, 783.99]; // G

          const currentArpNote = arpFreqs[noteTick % 4] * (noteTick >= 4 ? 1.5 : 1.0);
          const arpDecay = Math.max(0, Math.exp(-12 * (t % (1 / 5.5))));
          const arpOsc = Math.sin(2 * Math.PI * currentArpNote * t) * 0.08 * arpDecay;

          // 4. Off-beat shaker hats
          const shakerTick = t % 0.25;
          const shakerDecay = Math.max(0, Math.exp(-80 * shakerTick));
          const shakerOsc = (Math.random() * 2 - 1) * 0.025 * shakerDecay;

          // Combined output waveform sum with dynamic fade edges
          const sum = (bassOsc + padOsc + arpOsc + shakerOsc) * Math.sin(Math.PI * t / duration);

          leftCh[i] = sum;
          rightCh[i] = sum;
        }

        this.addNewTrack('Symphonic Demo Synth', buffer);
        this.isProcessing.set(false);
        this.statusMessage.set('Loaded studio synth track! Press Play to hear.');
      } catch (err) {
        this.isProcessing.set(false);
        this.statusMessage.set('Failed to generate synthesizers: ' + err);
      }
    }, 150);
  }

  // Upload selectors for Media files
  triggerAudioUpload() {
    this.audioFileInput.nativeElement.click();
  }

  triggerVideoUpload() {
    this.videoFileInput.nativeElement.click();
  }

  // Deconstruct and swallow media payloads
  onAudioFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadMediaFile(input.files[0], 'audio');
    input.value = ''; // Reset input element
  }

  onVideoFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadMediaFile(input.files[0], 'video');
    input.value = ''; // Reset input element
  }

  private loadMediaFile(file: File, type: 'audio' | 'video') {
    this.initAudio();
    this.isProcessing.set(true);
    this.statusMessage.set(`Reading files and decoding ${type} stream client-side...`);

    const reader = new FileReader();
    reader.onload = (e) => {
      const arrBuffer = e.target?.result as ArrayBuffer;
      if (!arrBuffer) {
        this.isProcessing.set(false);
        this.statusMessage.set('Failed to read media payload buffer.');
        return;
      }

      this.audioCtx.decodeAudioData(
        arrBuffer,
        (decodedBuffer) => {
          const cleanerName = file.name.replace(/\.[^/.]+$/, "");
          this.addNewTrack(cleanerName, decodedBuffer);
          this.isProcessing.set(false);
          this.statusMessage.set(`Imported "${cleanerName}" (${type}) successfully.`);
        },
        (err) => {
          this.isProcessing.set(false);
          this.statusMessage.set(`Decoder error for ${type}: ${err?.message || 'Unsupported stream compression format.'}`);
        }
      );
    };

    reader.onerror = () => {
      this.isProcessing.set(false);
      this.statusMessage.set('Reader failed to swallow local bytes stream.');
    };

    reader.readAsArrayBuffer(file);
  }

  private addNewTrack(name: string, buffer: AudioBuffer | null) {
    const id = 'tr_' + Math.random().toString(36).substring(2, 9);
    
    let reversed: AudioBuffer | null = null;
    let computedPeaks: number[] = [];
    const dur = buffer ? buffer.duration : 0;

    if (buffer) {
      reversed = this.reverseAudioBuffer(buffer);
      computedPeaks = this.extractBufferPeaks(buffer, 350);
    }

    const newTrack: AudioTrack = {
      id,
      name,
      audioBuffer: buffer,
      reversedBuffer: reversed,
      volume: 0.8,
      pan: 0.0,
      pitch: 0,
      isReversed: false,
      isMuted: false,
      isSoloed: false,
      offset: 0,
      duration: dur,
      peaks: computedPeaks,
    };

    this.tracks.update((list) => [...list, newTrack]);
  }

  private reverseAudioBuffer(objBuffer: AudioBuffer): AudioBuffer {
    const channels = objBuffer.numberOfChannels;
    const len = objBuffer.length;
    const rate = objBuffer.sampleRate;
    
    const reversed = this.audioCtx.createBuffer(channels, len, rate);
    for (let c = 0; c < channels; c++) {
      const originalData = objBuffer.getChannelData(c);
      const reversedData = reversed.getChannelData(c);
      for (let i = 0; i < len; i++) {
        reversedData[i] = originalData[len - 1 - i];
      }
    }
    return reversed;
  }

  private extractBufferPeaks(buffer: AudioBuffer, pointsCount = 350): number[] {
    const chData = buffer.getChannelData(0); // Take first mono frame
    const partitionSize = Math.floor(chData.length / pointsCount);
    const result: number[] = [];

    for (let i = 0; i < pointsCount; i++) {
      let maxAmp = 0;
      const startIdx = i * partitionSize;
      const endIdx = Math.min(startIdx + partitionSize, chData.length);
      
      for (let j = startIdx; j < endIdx; j++) {
        const val = Math.abs(chData[j]);
        if (val > maxAmp) {
          maxAmp = val;
        }
      }
      result.push(maxAmp);
    }
    
    // Normalize peaks scale to 0-1
    const absoluteMax = Math.max(...result, 0.01);
    return result.map((p) => p / absoluteMax);
  }

  // Panels state triggers
  togglePanel(panel: 'file' | 'view' | 'effects' | 'about') {
    this.activePanel.update((curr) => (curr === panel ? null : panel));
  }

  closePanels() {
    this.activePanel.set(null);
  }

  // Adjust zoom scales
  zoomIn() {
    this.zoomFactor.update((val) => Math.min(val + 5, 100));
  }

  zoomOut() {
    this.zoomFactor.update((val) => Math.max(val - 5, 2));
  }

  resetZoom() {
    this.zoomFactor.set(20);
  }

  // 100% Core Sound Exporters using OfflineAudioContexts (WAV headers synthesis)
  exportProjectWAV() {
    const activeTracksWithSample = this.tracks().filter((t) => t.audioBuffer);
    if (activeTracksWithSample.length === 0) {
      this.statusMessage.set('Error: Cannot export an empty session mix.');
      return;
    }

    this.isProcessing.set(true);
    this.statusMessage.set('Syncing multi-track nodes for offline rendering...');

    // Calculate maximum duration offset path
    const maxDur = this.totalDuration();
    const targetSampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, targetSampleRate * maxDur, targetSampleRate);

    // Reconstruct tracks graph on Offline Node Context
    activeTracksWithSample.forEach((track) => {
      if (!track.audioBuffer) return;

      const pitchScale = Math.pow(2, track.pitch / 12);
      const source = offlineCtx.createBufferSource();
      source.buffer = track.isReversed ? track.reversedBuffer : track.audioBuffer;
      source.playbackRate.value = pitchScale;

      const trackGain = offlineCtx.createGain();
      // Use standard mixer logic excluding live play soloe changes for final export if normal tracks are active
      const hasAnySolo = this.tracks().some((t) => t.isSoloed);
      const exportGain = this.calculateEffectiveTrackGain(track, hasAnySolo);
      trackGain.gain.setValueAtTime(exportGain, 0);

      const trackPanner = offlineCtx.createStereoPanner();
      trackPanner.pan.setValueAtTime(track.pan, 0);

      source.connect(trackGain);
      trackGain.connect(trackPanner);
      trackPanner.connect(offlineCtx.destination);

      const delaySeconds = Math.max(0, track.offset);
      source.start(delaySeconds, 0);
    });

    offlineCtx
      .startRendering()
      .then((renderedBuffer) => {
        this.statusMessage.set('Offline render complete. Compiling standard WAV audio container...');
        const wavData = this.encodeWAVHeaderAndSubchunk(renderedBuffer);
        const blob = new Blob([wavData], { type: 'audio/wav' });
        const downloadUrl = URL.createObjectURL(blob);

        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = `AudioEditorMix_${Date.now()}.wav`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        // Revoke to clean memory garbage
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 8000);

        this.isProcessing.set(false);
        this.statusMessage.set('Audio mix exported successfully as standard master WAV!');
      })
      .catch((err) => {
        this.isProcessing.set(false);
        this.statusMessage.set('Renderer crash report: ' + err);
      });
  }

  // Implements Raw 16-bit PCM WAV compilation
  private encodeWAVHeaderAndSubchunk(audioBuffer: AudioBuffer): ArrayBuffer {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const samplesCount = audioBuffer.length;
    const dataSize = samplesCount * blockAlign;
    const totalBufferSize = 44 + dataSize;

    const arrayBuffer = new ArrayBuffer(totalBufferSize);
    const view = new DataView(arrayBuffer);

    // Helpers to write strings directly to ASCII
    const writeAscii = (offset: number, valueStr: string) => {
      for (let i = 0; i < valueStr.length; i++) {
        view.setUint8(offset + i, valueStr.charCodeAt(i));
      }
    };

    // Subchunk RIFF Chunk
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // Remaining size info
    writeAscii(8, 'WAVE');

    // Subchunk format details fmt
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true); // Size of fmt chunk
    view.setUint16(20, format, true); // PCM format identifier
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // Subchunk Data details
    writeAscii(36, 'data');
    view.setUint32(40, dataSize, true);

    // Pack floating-point arrays into 16-bit PCM values
    let arrayPos = 44;
    const channelArrays: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelArrays.push(audioBuffer.getChannelData(c));
    }

    for (let i = 0; i < samplesCount; i++) {
      for (let c = 0; c < numChannels; c++) {
        let val = channelArrays[c][i];
        val = Math.max(-1.0, Math.min(1.0, val)); // Clamp limits to safe borders
        // Scale to 16-bit integer
        const pcmVal = val < 0 ? val * 0x8000 : val * 0x7fff;
        view.setInt16(arrayPos, pcmVal, true);
        arrayPos += 2;
      }
    }

    return arrayBuffer;
  }
}
