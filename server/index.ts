/**
 * Countertop server.
 *  :5310  the simulator UI + /api/converse (Amazon Bedrock) + /api/tts (Amazon Polly) + /oauth/callback
 *  :5311  the MCP Apps sandbox proxy, on a different origin from the host as the MCP Apps spec requires.
 * AWS credentials stay on this server; the browser never sees them. Because /api/converse and /api/tts
 * spend them, both servers listen on 127.0.0.1 only unless HOST says otherwise.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand, type VoiceId, type Engine } from '@aws-sdk/client-polly';

const BIND_HOST = process.env.HOST || '127.0.0.1';
const HOST_PORT = Number(process.env.PORT ?? 5310);
const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 5311);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[?::1\]?|[\w.-]+\.localhost)$/i;
const loopbackOnly = LOOPBACK.test(BIND_HOST);
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.ASSISTANT_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const VOICE = (process.env.ASSISTANT_VOICE ?? 'Joanna') as VoiceId;
const dist = path.resolve('web/dist');
/**
 * PUBLIC_DEMO=true is for hosting Countertop for anyone to try: the AWS-backed endpoints get per-visitor and
 * daily limits (so a public copy can't run up a bill), and speech is limited to the assistant's voice.
 * SANDBOX_ORIGIN sets the sandbox's public origin when it's served from its own domain (e.g. behind a CDN).
 */
const PUBLIC_DEMO = process.env.PUBLIC_DEMO === 'true';
const SANDBOX_ORIGIN = process.env.SANDBOX_ORIGIN;
/** The host page's public origin when hosted; the sandbox accepts being embedded by it (and by localhost). */
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '');
const LIMITS = {
  conversePerVisitorPerHour: Number(process.env.CONVERSE_PER_VISITOR_HOUR ?? 40),
  conversePerDay: Number(process.env.CONVERSE_PER_DAY ?? 400),
  ttsCharsPerVisitorPerHour: Number(process.env.TTS_CHARS_PER_VISITOR_HOUR ?? 4000),
  ttsCharsPerDay: Number(process.env.TTS_CHARS_PER_DAY ?? 40000),
};

const bedrock = new BedrockRuntimeClient({ region: REGION });
const polly = new PollyClient({ region: REGION });

// ---- host app -------------------------------------------------------------------------------------
const host = express();
if (PUBLIC_DEMO) host.set('trust proxy', 1); // behind a CDN: the visitor's address is the last X-Forwarded-For hop
host.use(express.json({ limit: PUBLIC_DEMO ? '512kb' : '4mb' }));

/** Usage meters for the public demo: per visitor per hour, and for everyone per UTC day. */
const meters = new Map<string, number>();
const meter = (key: string, add = 0) => {
  const n = (meters.get(key) ?? 0) + add;
  meters.set(key, n);
  return n;
};
const hourKey = () => new Date().toISOString().slice(0, 13);
const dayKey = () => new Date().toISOString().slice(0, 10);
setInterval(() => {
  const h = hourKey();
  const d = dayKey();
  for (const k of meters.keys()) if (!k.includes(h) && !k.includes(d)) meters.delete(k);
}, 10 * 60_000).unref();
const LIMIT_MESSAGE =
  "The live demo has reached its usage limit for now, to keep hosting costs down. Please try again later, or run Countertop locally (it's open source).";
/** True (and answered with 429) when this request would go over a public-demo limit. */
function overLimit(req: express.Request, res: express.Response, kind: 'converse' | 'tts', amount: number) {
  if (!PUBLIC_DEMO) return false;
  const visitor = `${kind}:${req.ip}:${hourKey()}`;
  const day = `${kind}:all:${dayKey()}`;
  const [perVisitor, perDay] =
    kind === 'converse' ? [LIMITS.conversePerVisitorPerHour, LIMITS.conversePerDay] : [LIMITS.ttsCharsPerVisitorPerHour, LIMITS.ttsCharsPerDay];
  if (meter(visitor) + amount > perVisitor || meter(day) + amount > perDay) {
    res.status(429).json({ error: 'LimitReached', message: LIMIT_MESSAGE });
    return true;
  }
  meter(visitor, amount);
  meter(day, amount);
  return false;
}
// On loopback, also refuse other Host names, so a DNS-rebinding web page can't reach the AWS-backed endpoints.
if (loopbackOnly) host.use('/api', (req, res, next) => (LOOPBACK.test(req.hostname) ? next() : res.status(403).json({ error: 'Forbidden host' })));

/** One assistant turn. The browser runs the agent loop and calls MCP tools itself; this only reaches the model. */
host.post('/api/converse', async (req, res) => {
  const { system, messages, tools } = req.body ?? {};
  if (overLimit(req, res, 'converse', 1)) return;
  const started = Date.now();
  try {
    const out = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: system ? [{ text: system }] : undefined,
        messages,
        inferenceConfig: { maxTokens: 700, temperature: 0.3 },
        ...(tools?.length && { toolConfig: { tools: tools.map((t: any) => ({ toolSpec: t })) } }),
      }),
    );
    res.json({ message: out.output?.message, stopReason: out.stopReason, usage: out.usage, latencyMs: Date.now() - started, modelId: MODEL_ID });
  } catch (err: any) {
    console.error('[converse]', err);
    res.status(502).json({ error: err?.name ?? 'Error', message: String(err?.message ?? err) });
  }
});

/**
 * Speech (Amazon Polly neural): the assistant's voice, and, in demo mode, a voice for the
 * person talking, so scripted demos can be recorded without a microphone.
 * With DEMO_AUDIO_DIR set, every clip is also saved so recordings can be re-synced in post.
 */
const VOICES = new Set(['Joanna', 'Ruth', 'Danielle', 'Kendra', 'Salli', 'Kimberly', 'Ivy', 'Justin', 'Kevin', 'Matthew', 'Stephen', 'Gregory', 'Joey']);
const DEMO_AUDIO_DIR = process.env.DEMO_AUDIO_DIR ? path.resolve(process.env.DEMO_AUDIO_DIR) : undefined;
let clipCounter = 0;
host.post('/api/tts', async (req, res) => {
  try {
    // The public demo speaks only as the assistant (visitors type or talk; their own words aren't voiced).
    const voice = !PUBLIC_DEMO && VOICES.has(req.body?.voice) ? (req.body.voice as VoiceId) : VOICE;
    const text = String(req.body?.text ?? '').slice(0, PUBLIC_DEMO ? 600 : 2500);
    if (overLimit(req, res, 'tts', text.length)) return;
    const out = await polly.send(new SynthesizeSpeechCommand({ Text: text, VoiceId: voice, Engine: 'neural' as Engine, OutputFormat: 'mp3' }));
    const bytes = Buffer.from(await out.AudioStream!.transformToByteArray());
    if (DEMO_AUDIO_DIR) {
      const name = `tts-${String(++clipCounter).padStart(3, '0')}-${voice}.mp3`;
      fs.mkdirSync(DEMO_AUDIO_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEMO_AUDIO_DIR, name), bytes);
      res.set('X-Audio-File', name);
    }
    res.type('audio/mpeg').send(bytes);
  } catch (err: any) {
    console.error('[tts]', err);
    res.status(502).json({ error: String(err?.message ?? err) });
  }
});

host.get('/api/config', (req, res) => {
  // The sandbox must be another origin; reached from another machine (HOST=0.0.0.0), use the page's host name.
  const sandboxHost = LOOPBACK.test(req.hostname) ? '127.0.0.1' : req.hostname;
  res.json({
    modelId: MODEL_ID,
    voice: VOICE,
    demoAudio: Boolean(DEMO_AUDIO_DIR),
    publicDemo: PUBLIC_DEMO,
    sandboxOrigin: SANDBOX_ORIGIN ?? `http://${sandboxHost}:${SANDBOX_PORT}`,
    defaultServer: process.env.MCP_SERVER_URL ?? 'http://localhost:8787/mcp',
  });
});

/** OAuth redirect target: hands the code back to the simulator window that opened the popup. */
host.get('/oauth/callback', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Linking…</title>
<body style="font-family:system-ui;background:#0b0920;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<p>Account linked. You can close this window.</p>
<script>
  const p = new URLSearchParams(location.search);
  if (window.opener) {
    window.opener.postMessage({ type: 'countertop-oauth', code: p.get('code'), state: p.get('state'), error: p.get('error') }, location.origin);
    setTimeout(() => window.close(), 400);
  } else {
    // Same-tab flow: go back to the simulator, which finishes the token exchange.
    const back = new URLSearchParams({ oauth_code: p.get('code') || '', oauth_state: p.get('state') || '', oauth_error: p.get('error') || '' });
    location.replace('/?' + back);
  }
</script></body>`);
});

host.use(express.static(dist, { index: 'index.html' }));
const shown = loopbackOnly || BIND_HOST === '0.0.0.0' || BIND_HOST === '::' ? 'localhost' : BIND_HOST;
host.listen(HOST_PORT, BIND_HOST, () => console.log(`🍳 Countertop on http://${shown}:${HOST_PORT}  (assistant model ${MODEL_ID}, voice ${VOICE}; listening on ${BIND_HOST})`));

// ---- sandbox proxy (separate origin) ---------------------------------------------------------------
const sandbox = express();
sandbox.get('/sandbox.html', (req, res) => {
  // CSP comes from the app's _meta.ui.csp; enforce it with a real header (tamper-proof, unlike <meta>).
  let csp: { connectDomains?: string[]; resourceDomains?: string[] } = {};
  try {
    csp = JSON.parse(String(req.query.csp ?? '{}'));
  } catch {}
  const safe = (xs: string[] = []) => xs.filter((d) => /^https?:\/\/[\w.:-]+$/.test(d)).join(' ');
  const res_ = safe(csp.resourceDomains);
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' 'unsafe-inline' ${res_}`,
      `style-src 'self' 'unsafe-inline' ${res_}`,
      `img-src 'self' data: blob: ${res_}`,
      `media-src 'self' data: blob: ${res_}`,
      `font-src 'self' data: ${res_}`,
      `connect-src 'self' ${safe(csp.connectDomains)}`,
      "frame-src 'self'",
      "base-uri 'none'",
    ].join('; '),
  );
  if (!PUBLIC_ORIGIN) return res.sendFile(path.join(dist, 'sandbox.html'));
  const html = fs.readFileSync(path.join(dist, 'sandbox.html'), 'utf8');
  res.type('html').send(html.replace('<head>', `<head><meta name="countertop-host-origin" content="${PUBLIC_ORIGIN.replace(/"/g, '')}">`));
});
sandbox.use(express.static(dist, { index: false }));
const sandboxBind = loopbackOnly ? '127.0.0.1' : BIND_HOST; // the UI points loopback visitors at 127.0.0.1
sandbox.listen(SANDBOX_PORT, sandboxBind, () => console.log(`🔒 MCP Apps sandbox on http://${sandboxBind}:${SANDBOX_PORT}`));
