/**
 * Countertop server.
 *  :5310  the simulator UI + /api/converse (Amazon Bedrock) + /api/tts (Amazon Polly) + /oauth/callback
 *  :5311  the MCP Apps sandbox proxy, on a different origin from the host as the MCP Apps spec requires.
 * AWS credentials stay on this server; the browser never sees them.
 */
import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand, type VoiceId, type Engine } from '@aws-sdk/client-polly';

const HOST_PORT = Number(process.env.PORT ?? 5310);
const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 5311);
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID = process.env.ASSISTANT_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const VOICE = (process.env.ASSISTANT_VOICE ?? 'Joanna') as VoiceId;
const dist = path.resolve('web/dist');

const bedrock = new BedrockRuntimeClient({ region: REGION });
const polly = new PollyClient({ region: REGION });

// ---- host app -------------------------------------------------------------------------------------
const host = express();
host.use(express.json({ limit: '4mb' }));

/** One assistant turn. The browser runs the agent loop and calls MCP tools itself; this only reaches the model. */
host.post('/api/converse', async (req, res) => {
  const { system, messages, tools } = req.body ?? {};
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

/** The assistant's voice (Amazon Polly neural). */
host.post('/api/tts', async (req, res) => {
  try {
    const out = await polly.send(
      new SynthesizeSpeechCommand({ Text: String(req.body?.text ?? '').slice(0, 2500), VoiceId: VOICE, Engine: 'neural' as Engine, OutputFormat: 'mp3' }),
    );
    res.type('audio/mpeg').send(Buffer.from(await out.AudioStream!.transformToByteArray()));
  } catch (err: any) {
    console.error('[tts]', err);
    res.status(502).json({ error: String(err?.message ?? err) });
  }
});

host.get('/api/config', (_req, res) =>
  res.json({ modelId: MODEL_ID, voice: VOICE, sandboxOrigin: `http://127.0.0.1:${SANDBOX_PORT}`, defaultServer: process.env.MCP_SERVER_URL ?? 'http://localhost:8787/mcp' }),
);

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
host.listen(HOST_PORT, () => console.log(`🍳 Countertop on http://localhost:${HOST_PORT}  (assistant model ${MODEL_ID}, voice ${VOICE})`));

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
  res.sendFile(path.join(dist, 'sandbox.html'));
});
sandbox.use(express.static(dist, { index: false }));
sandbox.listen(SANDBOX_PORT, '127.0.0.1', () => console.log(`🔒 MCP Apps sandbox on http://127.0.0.1:${SANDBOX_PORT}`));
