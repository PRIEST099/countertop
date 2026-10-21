import { Client, StreamableHTTPClientTransport, type Tool, type Resource, type CallToolResult } from '@modelcontextprotocol/client';

export interface WireEvent {
  dir: 'out' | 'in';
  at: number;
  msg: any;
  latencyMs?: number;
}

/** Wraps a transport to record every JSON-RPC message and per-request latency for the inspector. */
class TapTransport {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: any, extra?: any) => void;
  private sentAt = new Map<string | number, number>();
  constructor(private inner: any, private tap: (e: WireEvent) => void) {}
  get sessionId() {
    return this.inner.sessionId;
  }
  setProtocolVersion(v: string) {
    this.inner.setProtocolVersion?.(v);
  }
  async start() {
    this.inner.onmessage = (m: any, extra: any) => {
      const sent = m?.id !== undefined ? this.sentAt.get(m.id) : undefined;
      if (sent) this.sentAt.delete(m.id);
      this.tap({ dir: 'in', at: Date.now(), msg: m, latencyMs: sent ? Date.now() - sent : undefined });
      this.onmessage?.(m, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (e: Error) => this.onerror?.(e);
    return this.inner.start();
  }
  async send(m: any, opts?: any) {
    if (m?.id !== undefined && m?.method) this.sentAt.set(m.id, Date.now());
    this.tap({ dir: 'out', at: Date.now(), msg: m });
    return this.inner.send(m, opts);
  }
  close() {
    return this.inner.close();
  }
}

export interface Connection {
  url: string;
  client: Client;
  serverName: string;
  serverTitle?: string;
  instructions?: string;
  protocolVersion?: string;
  tools: Map<string, Tool>;
  resources: Map<string, Resource>;
  htmlCache: Map<string, { html: string; meta: any; mimeType?: string }>;
}

export async function connect(url: string, accessToken: string | undefined, tap: (e: WireEvent) => void): Promise<Connection> {
  const client = new Client({ name: 'Countertop', version: '0.1.0' }, { capabilities: {} });
  const inner = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
  const transport = new TapTransport(inner, tap);
  await client.connect(transport as any);
  const info = client.getServerVersion();
  const [{ tools }, resources] = await Promise.all([
    client.listTools(),
    client.getServerCapabilities()?.resources ? client.listResources() : Promise.resolve({ resources: [] as Resource[] }),
  ]);
  return {
    url,
    client,
    serverName: info?.name ?? url,
    serverTitle: (info as any)?.title,
    instructions: client.getInstructions?.(),
    protocolVersion: client.getNegotiatedProtocolVersion?.() ?? (inner as any).protocolVersion,
    tools: new Map(tools.map((t) => [t.name, t])),
    resources: new Map(resources.resources.map((r) => [r.uri, r])),
    htmlCache: new Map(),
  };
}

export async function callTool(conn: Connection, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await conn.client.callTool({ name, arguments: args })) as CallToolResult;
}

export async function readUi(conn: Connection, uri: string) {
  const hit = conn.htmlCache.get(uri);
  if (hit) return hit;
  const res = await conn.client.readResource({ uri });
  const c: any = res.contents[0];
  const html = c.text ?? atob(c.blob ?? '');
  const meta = (c._meta ?? (conn.resources.get(uri) as any)?._meta)?.ui ?? {};
  const out = { html, meta, mimeType: c.mimeType as string };
  conn.htmlCache.set(uri, out);
  return out;
}
