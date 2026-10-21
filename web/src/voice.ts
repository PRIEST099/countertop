/**
 * Voice in: the browser's Web Speech API (push-to-talk, like pressing the Action button on an Echo).
 * Voice out: Amazon Polly via the Countertop server, falling back to speechSynthesis.
 */
import { audioLog, type AudioEvent } from './demo';

export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
export const speechInputSupported = !!SR;

export class Voice {
  private rec: any = null;
  private audio = new Audio();
  constructor(private on: { state(s: VoiceState): void; interim(text: string): void; final(text: string): void; error(msg: string): void }) {}

  listen() {
    this.stopSpeaking();
    if (!SR) return this.on.error('Speech recognition needs Chrome or Edge. Type instead.');
    this.rec?.abort();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.on.interim((finalText + interim).trim());
    };
    rec.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.on.error(`Mic: ${e.error}`);
    };
    rec.onend = () => {
      this.rec = null;
      const text = finalText.trim();
      if (text) this.on.final(text);
      else this.on.state('idle');
    };
    this.rec = rec;
    rec.start();
    this.on.state('listening');
  }

  stopListening() {
    this.rec?.stop();
  }

  /** Speak `text`. `voice` picks a Polly voice (demo mode uses it for the person talking). */
  async say(text: string, opts: { voice?: string; kind?: AudioEvent['kind'] } = {}) {
    if (!text.trim()) return;
    const kind = opts.kind ?? 'alexa';
    if (kind === 'alexa') this.on.state('speaking');
    try {
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: opts.voice }) });
      if (!r.ok) throw new Error('tts failed');
      const file = r.headers.get('X-Audio-File') ?? undefined;
      this.audio.src = URL.createObjectURL(await r.blob());
      await this.audio.play();
      const ev: AudioEvent = { kind, file, text, start: Date.now() };
      audioLog.push(ev);
      await new Promise<void>((res) => {
        this.audio.onended = () => res();
        this.audio.onpause = () => res();
      });
      ev.end = Date.now();
    } catch {
      await new Promise<void>((res) => {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => res();
        u.onerror = () => res();
        speechSynthesis.speak(u);
      });
    }
    if (kind === 'alexa') this.on.state('idle');
  }

  stopSpeaking() {
    this.audio.pause();
    speechSynthesis.cancel();
  }
}
