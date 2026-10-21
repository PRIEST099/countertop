import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Discovery } from './oauth';
import type { Connection } from './mcp';

export type Status = 'pass' | 'warn' | 'fail' | 'pending';
export interface Check {
  label: string;
  status: Status;
  detail: string;
}

export interface Observed {
  latencies: { method: string; ms: number }[];
  uiResults: { tool: string; hasResultMeta: boolean }[];
  textlessResults: string[];
}

/**
 * Checks a server against the published Alexa+ MCP add-on requirements (transport, protocol,
 * account linking, tool design, latency, MCP Apps). Static checks run on connect; latency and
 * result-shape checks fill in as you talk to the add-on.
 */
export function evaluate(d: Discovery | null, c: Connection | null, o: Observed): Check[] {
  const checks: Check[] = [];
  const add = (label: string, status: Status, detail: string) => checks.push({ label, status, detail });

  add('Streamable HTTP endpoint', c ? 'pass' : d ? 'fail' : 'pending', c ? `initialize OK at ${c.url}` : 'Connect to run this check');
  if (c) {
    const v = c.protocolVersion;
    add('MCP protocol 2025-11-25', v === '2025-11-25' ? 'pass' : v ? 'warn' : 'pending', v ? `negotiated ${v}` : 'version not reported by the transport');
  }

  if (d) {
    if (d.unauthStatus === 401) {
      add('Unauthenticated request → 401', 'pass', 'account linking required');
      add('Bare 401 (no WWW-Authenticate)', d.wwwAuthenticate ? 'warn' : 'pass', d.wwwAuthenticate ? `header present: ${d.wwwAuthenticate.slice(0, 80)}` : 'Alexa+ discovers auth via /.well-known instead');
      add(
        'Protected Resource Metadata at the root path',
        d.rootPrm ? 'pass' : d.prm ? 'warn' : 'fail',
        d.rootPrm ? '/.well-known/oauth-protected-resource' : d.prm ? `only at ${d.prmUrl}; Alexa+ reads the root path` : 'missing /.well-known/oauth-protected-resource',
      );
      if (d.prm) {
        const same = d.prm.resource === d.mcpUrl;
        add('PRM resource matches endpoint exactly', same ? 'pass' : 'fail', same ? d.prm.resource : `resource "${d.prm.resource}" ≠ endpoint "${d.mcpUrl}" (trailing slash matters)`);
      }
      const as = d.asMeta;
      add('Authorization server metadata', as ? 'pass' : 'fail', as ? as.issuer : 'missing /.well-known/oauth-authorization-server');
      if (as) {
        add('PKCE S256 advertised', as.code_challenge_methods_supported?.includes('S256') ? 'pass' : 'fail', 'Alexa+ account linking fails without S256');
        add('Refresh tokens', as.grant_types_supported?.includes('refresh_token') ? 'pass' : 'warn', 'Alexa+ expects a refresh_token with every token response');
      }
    } else if (d.unauthStatus) {
      add('Account linking', 'warn', `unauthenticated request returned ${d.unauthStatus}; fine for public add-ons`);
    }
  }

  if (c) {
    const tools = [...c.tools.values()];
    const bad = tools.filter((t) => !t.description || (t.inputSchema as any)?.type !== 'object');
    add('Tools have descriptions + object schemas', bad.length ? 'fail' : 'pass', bad.length ? bad.map((t) => t.name).join(', ') : `${tools.length} tools`);
    const names = tools.filter((t) => !/^[a-z][a-z0-9_]{0,63}$/.test(t.name));
    add('Tool names snake_case, ≤ 64 chars', names.length ? 'warn' : 'pass', names.length ? names.map((t) => t.name).join(', ') : 'ok');
    const uiTools = tools.filter((t) => getToolUiResourceUri(t));
    const uiRes = [...c.resources.values()].filter((r) => r.uri.startsWith('ui://'));
    if (uiTools.length || uiRes.length) {
      const wrongMime = uiRes.filter((r) => r.mimeType && r.mimeType !== 'text/html;profile=mcp-app');
      add('MCP Apps resources', wrongMime.length ? 'fail' : 'pass', wrongMime.length ? wrongMime.map((r) => r.uri).join(', ') : `${uiRes.length} ui:// resource(s), ${uiTools.length} tool(s) with UI`);
      const cached = [...c.htmlCache.values()];
      if (cached.length) {
        const noCsp = cached.filter((x) => !x.meta?.csp);
        add('UI declares CSP domains', noCsp.length ? 'warn' : 'pass', noCsp.length ? 'Alexa+ blocks undeclared network/media hosts' : 'connectDomains/resourceDomains set');
      }
      const unversioned = uiRes.filter((r) => !/[-.][0-9a-f]{6,}\./i.test(r.uri));
      add('UI URI is content-hashed', unversioned.length ? 'warn' : 'pass', unversioned.length ? 'version ui:// URIs so hosts can cache safely' : uiRes.map((r) => r.uri).join(', '));
    }
  }

  if (o.latencies.length) {
    const worst = o.latencies.reduce((a, b) => (b.ms > a.ms ? b : a));
    const over = o.latencies.filter((l) => l.ms >= 500);
    add('Round trip under 500 ms', over.length ? 'fail' : 'pass', `${o.latencies.length} calls · slowest ${worst.method} ${worst.ms} ms`);
  } else if (c) add('Round trip under 500 ms', 'pending', 'talk to the add-on to measure');

  if (o.uiResults.length) {
    const missing = o.uiResults.filter((r) => !r.hasResultMeta);
    add('UI tool results carry _meta.ui.resourceUri', missing.length ? 'warn' : 'pass', missing.length ? `missing on ${[...new Set(missing.map((m) => m.tool))].join(', ')} (Alexa+ renders from the result)` : 'present on every UI result');
  }
  if (c && (o.uiResults.length || o.textlessResults.length)) {
    add('Spoken text in every result', o.textlessResults.length ? 'warn' : 'pass', o.textlessResults.length ? `no text content: ${[...new Set(o.textlessResults)].join(', ')}` : 'voice-only devices covered');
  }
  return checks;
}

export function observeResult(o: Observed, toolName: string, result: CallToolResult, c: Connection | null) {
  const tool = c?.tools.get(toolName);
  if (tool && getToolUiResourceUri(tool)) o.uiResults.push({ tool: toolName, hasResultMeta: !!(result as any)?._meta?.ui?.resourceUri });
  if (!(result.content ?? []).some((x: any) => x.type === 'text' && x.text)) o.textlessResults.push(toolName);
}
