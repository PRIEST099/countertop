/**
 * Demo recording support: a timeline of every sound Countertop and the add-on's UI play, plus
 * named marks, so a scripted screen recording can be re-synced with its audio afterwards
 * (see scripts/record-demo.ts). Times are epoch milliseconds.
 */
export interface AudioEvent {
  kind: 'user' | 'alexa' | 'app';
  file?: string; // saved by the server (DEMO_AUDIO_DIR) for TTS clips
  url?: string; // for clips the add-on's UI played
  text?: string;
  start: number;
  end?: number;
  offsetMs?: number; // where in the clip playback started
}
export const audioLog: AudioEvent[] = [];
export const marks: { name: string; at: number }[] = [];

export function appAudioEvent(data: any) {
  if (data?.event === 'start') audioLog.push({ kind: 'app', url: data.url, start: data.at ?? Date.now(), offsetMs: data.offsetMs ?? 0 });
  if (data?.event === 'stop') {
    const open = [...audioLog].reverse().find((e) => e.kind === 'app' && e.end === undefined);
    if (open) open.end = data.at ?? Date.now();
  }
}
