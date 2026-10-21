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

/**
 * Demo clock: `?clock=18:45` or `countertop.setClock('18:45')` makes the device show a chosen time
 * (24h, today) that keeps ticking from there; the agent's sense of time follows it too.
 * `setClock()` with no argument goes back to real time.
 */
let clockOffset = 0;
export const deviceNow = () => new Date(Date.now() + clockOffset);
export function setClock(hhmm?: string | null) {
  if (!hhmm) return void (clockOffset = 0);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`clock must be HH:MM (24h), got "${hhmm}"`);
  const t = new Date();
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  clockOffset = t.getTime() - Date.now();
}

export function appAudioEvent(data: any) {
  if (data?.event === 'start') audioLog.push({ kind: 'app', url: data.url, start: data.at ?? Date.now(), offsetMs: data.offsetMs ?? 0 });
  if (data?.event === 'stop') {
    const open = [...audioLog].reverse().find((e) => e.kind === 'app' && e.end === undefined);
    if (open) open.end = data.at ?? Date.now();
  }
}
