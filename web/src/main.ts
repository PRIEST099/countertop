import './styles.css';
import { completeRedirect, discover, link, refresh, type Discovery, type Tokens } from './oauth';
import { connect, readUi, type Connection, type WireEvent } from './mcp';
import { AppHost, DEVICES, type Device } from './apps';
import { Agent } from './agent';
import { Voice, type VoiceState } from './voice';
import { evaluate, observeResult, type Observed } from './readiness';
import { appAudioEvent, audioLog, deviceNow, marks, setClock } from './demo';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const cfg = await fetch('/api/config').then((r) => r.json());
const params = new URLSearchParams(location.search);

// ---- state ------------------------------------------------------------------------------------------
let device: Device = DEVICES.find((d) => d.id === (params.get('device') ?? 'show8')) ?? DEVICES[0];
let discovery: Discovery | null = null;
let tokens: Tokens | null = null;
let conn: Connection | null = null;
const observed: Observed = { latencies: [], uiResults: [], textlessResults: [] };
let wireCount = 0;

// ---- device frame & scaling ---------------------------------------------------------------------------
const screen = $('screen');
const deviceEl = $('device-frame');
const deviceWrap = $('device-wrap');
const deviceSelect = $<HTMLSelectElement>('device-select');
DEVICES.forEach((d) => deviceSelect.append(new Option(d.label, d.id, false, d.id === device.id)));

function layoutDevice() {
  screen.style.width = `${device.width}px`;
  screen.style.height = `${device.height}px`;
  screen.style.setProperty('--k', String(Math.min(device.width / 1280, device.height / 800))); // on-screen type scales with the device
  const fullW = device.width + 92;
  const fullH = device.height + 92;
  const s = Math.min(deviceWrap.clientWidth / fullW, deviceWrap.clientHeight / fullH, 1);
  deviceEl.style.width = `${fullW}px`;
  deviceEl.style.height = `${fullH}px`;
  deviceEl.style.transform = `translate(-50%, -50%) scale(${s})`;
}
new ResizeObserver(layoutDevice).observe(deviceWrap);
deviceSelect.onchange = () => {
  device = DEVICES.find((d) => d.id === deviceSelect.value)!;
  layoutDevice();
  host.resize();
};

function tickClock() {
  const now = deviceNow();
  $('clock').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, '');
  $('date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
try {
  setClock(params.get('clock'));
} catch (e) {
  console.warn('[demo]', (e as Error).message);
}
tickClock();
setInterval(tickClock, 1000);

const phrases = (params.get('phrases')?.split('|') ?? [
  "Make tonight's story — Maya lost her first tooth today and she's nervous about the dentist",
  'Read my bedtime story',
  'How did bedtime go last night?',
]).filter(Boolean);
$('suggestions').innerHTML = phrases.map((p, i) => `<button class="suggestion" data-i="${i}"><b>${i === 0 ? 'Parent' : i === 1 ? 'Bedtime' : 'Next morning'}</b>“${esc(p)}”</button>`).join('');
$('suggestions').querySelectorAll<HTMLButtonElement>('.suggestion').forEach((b) => (b.onclick = () => handleUtterance(phrases[Number(b.dataset.i)])));

// ---- captions & light bar --------------------------------------------------------------------------
let captionTimer = 0;
let captionHold = 0; // > 0 while someone is speaking (or Alexa is thinking): captions must stay up
function scheduleCaptionHide(ms = 4500) {
  clearTimeout(captionTimer);
  if (captionHold > 0) return;
  captionTimer = window.setTimeout(() => {
    $('captions').classList.remove('on');
    screen.classList.remove('captioned');
  }, ms);
}
function caption(you?: string, alexa?: string) {
  const c = $('captions');
  if (you !== undefined) c.querySelector('.you')!.textContent = you ? `“${you}”` : '';
  if (alexa !== undefined) c.querySelector('.alexa')!.textContent = alexa;
  const on = !!c.textContent?.trim();
  c.classList.toggle('on', on);
  // On the home screen the clock and suggestions dim while someone talks, like an Echo Show.
  screen.classList.toggle('captioned', on);
  scheduleCaptionHide(7000);
}
function setVoiceState(s: VoiceState) {
  $('lightbar').className = `lightbar ${s === 'idle' ? '' : s}`;
  $('mic').classList.toggle('listening', s === 'listening');
  // Keep captions up while listening, thinking or speaking; start the fade only once everyone is done.
  if (s === 'idle') scheduleCaptionHide();
  else clearTimeout(captionTimer);
}

// ---- side panel ------------------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === `tab-${t.dataset.tab}`));
  };
});
const convo = $('tab-convo');
function addConvo(html: string) {
  convo.querySelector('.empty')?.remove();
  convo.insertAdjacentHTML('beforeend', html);
  convo.scrollTop = convo.scrollHeight;
}
const msBadge = (ms: number, kind: 'tool' | 'model' = 'tool') => `<span class="ms ${kind === 'model' ? 'model' : ms < 500 ? 'fast' : 'slow'}">${ms} ms</span>`;

const wire = $('tab-wire');
function onWire(e: WireEvent) {
  const m = e.msg;
  const label = m.method ? `${m.method}${m.params?.name ? ` · ${m.params.name}` : ''}` : m.error ? `error ${m.error.code}` : `result #${m.id}`;
  if (e.dir === 'in' && e.latencyMs !== undefined && !m.error) {
    const req = pendingMethods.get(m.id);
    if (req && req !== 'initialize') observed.latencies.push({ method: req, ms: e.latencyMs });
  }
  if (e.dir === 'out' && m.id !== undefined && m.method) pendingMethods.set(m.id, m.params?.name ? `${m.method} ${m.params.name}` : m.method);
  wire.insertAdjacentHTML(
    'beforeend',
    `<details class="wire"><summary><span class="dir">${e.dir === 'out' ? '→' : '←'}</span><span class="method">${esc(label)}</span>${e.latencyMs !== undefined ? msBadge(e.latencyMs) : ''}</summary><pre>${esc(JSON.stringify(m, null, 2).slice(0, 12000))}</pre></details>`,
  );
  $('wire-count').textContent = String(++wireCount);
  wire.scrollTop = wire.scrollHeight;
  scheduleReadiness();
}
const pendingMethods = new Map<string | number, string>();

let readinessTimer = 0;
function scheduleReadiness() {
  clearTimeout(readinessTimer);
  readinessTimer = window.setTimeout(renderReadiness, 300);
}
function renderReadiness() {
  const checks = evaluate(discovery, conn, observed);
  if (!checks.length) return;
  const pass = checks.filter((c) => c.status === 'pass').length;
  const icon = { pass: '✓', warn: '!', fail: '✕', pending: '…' };
  $('tab-ready').innerHTML =
    `<div class="score"><strong>${pass}/${checks.length}</strong> checks passing against the published Alexa+ MCP add-on requirements</div>` +
    checks.map((c) => `<div class="check ${c.status}"><span class="ico">${icon[c.status]}</span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></div>`).join('');
}

// ---- MCP Apps host + agent ---------------------------------------------------------------------------
const host = new AppHost(screen, cfg.sandboxOrigin, () => conn, () => device, {
  onModelContext: (text) => (agent.modelContext = text),
  onAppMessage: (text) => handleUtterance(text),
  onToolCallFromApp: (name, _args, result, ms) => {
    observeResult(observed, name, result, conn);
    if (name !== 'log_reading_progress') addConvo(`<div class="toolchip">📱 app → ${esc(name)} ${msBadge(ms)}</div>`);
  },
  onLog: (p) => (p.logger === 'audio' ? appAudioEvent(p.data) : console.debug('[app]', p.data)),
});

const agent = new Agent(() => conn, host, {
  onToolCall: (name, input, result, ms) => {
    observeResult(observed, name, result, conn);
    addConvo(`<div class="toolchip" title="${esc(JSON.stringify(input))}">🛠 ${esc(name)} ${msBadge(ms)}${result.isError ? ' <span class="ms slow">error</span>' : ''}</div>`);
  },
  onModel: (ms) => addConvo(`<div class="toolchip">🧠 Bedrock · ${esc(cfg.modelId.replace(/^us\.anthropic\./, ''))} ${msBadge(ms, 'model')}</div>`),
  onError: (message) => addConvo(`<div class="toolchip" style="color:var(--bad)">⚠ ${esc(message)}</div>`),
});

const voice = new Voice({
  state: setVoiceState,
  interim: (text) => caption(text, ''),
  final: (text) => handleUtterance(text),
  error: (msg) => {
    setVoiceState('idle');
    caption('', msg);
  },
});

let busy = false;
const queue: string[] = [];
async function handleUtterance(text: string) {
  text = text.trim();
  if (!text) return;
  voice.stopSpeaking(); // barge-in: talking over Alexa interrupts her, like on a real Echo
  if (busy) {
    queue.push(text);
    return;
  }
  if (/^(alexa[, ]+)?(stop|go home|cancel|never mind|close)\b/i.test(text)) {
    voice.stopSpeaking();
    host.close();
    caption(text, '');
    return;
  }
  busy = true;
  addConvo(`<div class="msg you"><div class="who">You</div><div class="bubble">${esc(text)}</div></div>`);
  caption(text, '');
  setVoiceState('thinking');
  try {
    if (tokens && tokens.expiresAt - Date.now() < 60_000) await relink(true);
    const reply = await agent.turn(text.replace(/^alexa[, ]+/i, ''));
    if (reply) {
      addConvo(`<div class="msg alexa"><div class="who">Alexa</div><div class="bubble">${esc(reply)}</div></div>`);
      caption(undefined, reply);
      await voice.say(reply);
    }
  } finally {
    busy = false;
    setVoiceState('idle');
    const next = queue.shift();
    if (next) handleUtterance(next);
  }
}

// ---- linking & connecting --------------------------------------------------------------------------
const urlInput = $<HTMLInputElement>('server-url');
urlInput.value = params.get('server') ?? sessionStorage.getItem('countertop:url') ?? cfg.defaultServer;
const status = (text: string, kind: '' | 'ok' | 'err' = '') => {
  const s = $('status');
  s.textContent = text;
  s.className = `chip ${kind}`;
};

async function relink(silent = false) {
  if (!discovery || !tokens) return;
  try {
    tokens = await refresh(discovery, tokens);
    sessionStorage.setItem('countertop:tokens', JSON.stringify(tokens));
    conn = await connect(discovery.mcpUrl, tokens.accessToken, onWire);
  } catch (e) {
    if (!silent) throw e;
  }
}

async function linkAddOn() {
  const url = urlInput.value.trim();
  sessionStorage.setItem('countertop:url', url);
  $<HTMLButtonElement>('link').disabled = true;
  host.close();
  agent.reset();
  try {
    status('Discovering…');
    discovery = await discover(url);
    scheduleReadiness();
    if (discovery.errors.length) throw new Error(discovery.errors.join('; '));
    if (discovery.unauthStatus === 401) {
      const saved = sessionStorage.getItem('countertop:tokens');
      tokens = saved ? (JSON.parse(saved) as Tokens) : null;
      if (!tokens || tokens.expiresAt < Date.now()) {
        status('Linking account…');
        tokens = await link(discovery);
        sessionStorage.setItem('countertop:tokens', JSON.stringify(tokens));
      }
    }
    status('Connecting…');
    try {
      conn = await connect(url, tokens?.accessToken, onWire);
    } catch {
      sessionStorage.removeItem('countertop:tokens');
      if (discovery.unauthStatus !== 401) throw new Error('Could not connect');
      tokens = await link(discovery);
      sessionStorage.setItem('countertop:tokens', JSON.stringify(tokens));
      conn = await connect(url, tokens.accessToken, onWire);
    }
    status(`Linked · ${conn.serverTitle ?? conn.serverName} · ${conn.tools.size} tools`, 'ok');
    addConvo(`<div class="toolchip">🔗 linked ${esc(conn.serverTitle ?? conn.serverName)} · ${tokens ? 'OAuth 2.1 + PKCE' : 'no auth'}</div>`);
    // Prefetch UI resources the way Alexa+ registers them at deploy time.
    for (const r of conn.resources.values()) if (r.uri.startsWith('ui://')) await readUi(conn, r.uri).catch(() => {});
    scheduleReadiness();
  } catch (e) {
    status(String((e as Error).message ?? e).slice(0, 80), 'err');
  } finally {
    $<HTMLButtonElement>('link').disabled = false;
  }
}
$('link').onclick = linkAddOn;

// ---- input ------------------------------------------------------------------------------------------
$('mic').onclick = () => voice.listen();
$('home-btn').onclick = () => {
  voice.stopSpeaking();
  host.close();
};
$('say-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('say');
  const text = input.value;
  input.value = '';
  if (DEMO) utter(text, params.get('userVoice') ?? 'Matthew');
  else handleUtterance(text);
  setTimeout(() => input.focus(), 50); // keep typing here, not inside the add-on's screen
};

// ---- demo mode: speak typed lines aloud, expose a small API for scripted recordings ----------------
const DEMO = params.get('demo') === '1';
async function utter(text: string, voiceId: string) {
  console.debug(`[demo] utter (${voiceId}): ${text}`);
  captionHold++;
  caption(text, '');
  try {
    await voice.say(text, { voice: voiceId, kind: 'user' });
  } finally {
    captionHold--;
  }
  await handleUtterance(text);
}
(window as any).countertop = {
  utter,
  say: (text: string) => handleUtterance(text),
  idle: () => !busy && !queue.length && !$('lightbar').className.includes('speaking'),
  mark: (name: string) => marks.push({ name, at: Date.now() }),
  timeline: () => ({ audio: audioLog, marks }),
  link: () => linkAddOn(),
  home: () => host.close(),
  setClock: (hhmm?: string | null) => {
    setClock(hhmm);
    tickClock();
  },
};
let spaceDown = false;
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space' && !spaceDown) {
    spaceDown = true;
    e.preventDefault();
    voice.listen();
  }
  if (e.key === 'Escape') {
    voice.stopSpeaking();
    host.close();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceDown) {
    spaceDown = false;
    voice.stopListening();
  }
});

layoutDevice();
if (params.get('oauth_code') || params.get('oauth_error')) {
  history.replaceState(null, '', location.pathname);
  if (params.get('oauth_error')) status(`Linking declined: ${params.get('oauth_error')}`, 'err');
  else
    completeRedirect(params.get('oauth_code')!, params.get('oauth_state')!)
      .then((t) => {
        sessionStorage.setItem('countertop:tokens', JSON.stringify(t));
        return linkAddOn();
      })
      .catch((e) => status(String(e.message ?? e), 'err'));
} else if (params.get('autolink') !== '0' && sessionStorage.getItem('countertop:tokens')) linkAddOn();
