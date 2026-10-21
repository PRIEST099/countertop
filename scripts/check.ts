/**
 * `npm run check -- <mcp-url> [--token <bearer>]` — the Alexa+ readiness checks that don't need a
 * browser, from a terminal or CI. Always: unauthenticated probe → bare 401, Protected Resource
 * Metadata at the root path, Authorization Server Metadata (S256, refresh tokens). When the server
 * allows unauthenticated access, or you pass a bearer token (--token or MCP_TOKEN): MCP initialize
 * over Streamable HTTP, tools/list, ui:// resources, and every round trip against the 500 ms budget.
 * Uses the same checks as the browser's readiness tab. Read-only: initialize, list and read calls.
 * Exits 1 if any check fails.
 */
import { discover } from '../web/src/oauth';
import { connect, readUi, type Connection, type WireEvent } from '../web/src/mcp';
import { authChecks, connectionChecks, latencyCheck, serverChecks, type Check, type Observed } from '../web/src/readiness';

const USAGE = 'usage: npm run check -- <mcp-url> [--token <bearer>]   (or MCP_TOKEN=<bearer>)';
const args = process.argv.slice(2);
let url: string | undefined;
let token = process.env.MCP_TOKEN;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--token') token = args[++i];
  else if (a.startsWith('--token=')) token = a.slice('--token='.length);
  else if (a === '-h' || a === '--help') exit(0, USAGE);
  else if (!url && !a.startsWith('-')) url = a;
  else exit(2, `unknown argument: ${a}\n${USAGE}`);
}
if (!url || !URL.canParse(url)) exit(2, USAGE);
token = token?.replace(/^Bearer\s+/i, '').trim() || undefined;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [green, yellow, red, dim, bold] = [32, 33, 31, 2, 1].map(paint);
const ICON: Record<Check['status'], string> = { pass: green('✓'), warn: yellow('!'), fail: red('✕'), pending: dim('…') };

const all: Check[] = [];
function section(title: string, checks: Check[], extra: Partial<Record<string, string>> = {}) {
  console.log(`\n${bold(title)}`);
  for (const c of checks) {
    console.log(`  ${ICON[c.status]} ${c.label}  ${dim(c.detail)}`);
    if (extra[c.label]) console.log(`    ${dim(extra[c.label]!)}`);
  }
  all.push(...checks);
}
function exit(code: number, message?: string): never {
  if (message) (code ? console.error : console.log)(message);
  process.exit(code);
}
setTimeout(() => exit(1, red('✕ timed out after 30 s')), 30_000).unref();

console.log(`${bold('Countertop')} · Alexa+ readiness for ${url}`);

// ---- account linking ---------------------------------------------------------------------------------
const d = await discover(url);
if (!d.unauthStatus) {
  section('Account linking', [{ label: 'Endpoint reachable', status: 'fail', detail: d.errors.join('; ') }]);
  exit(1);
}
section('Account linking', authChecks(d));

// ---- MCP: initialize, tools, resources, latency ---------------------------------------------------------
if (d.unauthStatus === 401 && !token) {
  console.log(`\n${bold('MCP server')}\n  ${dim('– skipped: the server requires account linking; pass --token <bearer> to check initialize, tools, resources and latency')}`);
} else {
  const latencies: Observed['latencies'] = [];
  const sent = new Map<string | number, string>();
  const tap = (e: WireEvent) => {
    const m = e.msg;
    if (e.dir === 'out' && m?.id !== undefined && m.method) sent.set(m.id, m.method === 'resources/read' ? `resources/read ${m.params?.uri}` : m.method);
    if (e.dir === 'in' && e.latencyMs !== undefined && !m?.error && sent.has(m.id)) latencies.push({ method: sent.get(m.id)!, ms: e.latencyMs });
  };
  let c: Connection | undefined;
  const checks: Check[] = [];
  try {
    c = await connect(url, token, tap);
  } catch (e) {
    checks.push({ label: 'Streamable HTTP endpoint', status: 'fail', detail: `initialize failed: ${(e as Error).message ?? e}` });
  }
  if (c) {
    // Read every ui:// resource the way Alexa+ registers them, so the CSP and mime checks see the real content.
    for (const r of c.resources.values()) {
      if (!r.uri.startsWith('ui://')) continue;
      await readUi(c, r.uri).catch((e) => checks.push({ label: `Read ${r.uri}`, status: 'fail', detail: String((e as Error).message ?? e) }));
    }
    checks.unshift(...connectionChecks(c), ...serverChecks(c));
    const latency = latencyCheck(latencies);
    if (latency) checks.push(latency);
    await c.client.close().catch(() => {});
  }
  const breakdown = latencies.map((l) => `${l.method} ${l.ms} ms`).join(' · ');
  section('MCP server', checks, { 'Round trip under 500 ms': breakdown });
}

const count = (s: Check['status']) => all.filter((c) => c.status === s).length;
const failed = count('fail');
console.log(`\n${count('pass')}/${all.length} passing · ${count('warn')} warning(s) · ${failed ? red(`${failed} failed`) : '0 failed'}`);
exit(failed ? 1 : 0);
