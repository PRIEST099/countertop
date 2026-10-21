import { AppBridge, PostMessageTransport, getToolUiResourceUri, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { callTool, readUi, type Connection } from './mcp';

export interface Device {
  id: string;
  label: string;
  width: number;
  height: number;
  deviceClass: string;
}

export const DEVICES: Device[] = [
  { id: 'show8', label: 'Echo Show 8 · 1280×800', width: 1280, height: 800, deviceClass: 'hub-landscape-large' },
  { id: 'show5', label: 'Echo Show 5 · 960×480', width: 960, height: 480, deviceClass: 'hub-landscape-small' },
  { id: 'show15', label: 'Echo Show 15 · 1920×1080', width: 1920, height: 1080, deviceClass: 'hub-landscape-xl' },
];

interface Mounted {
  uri: string;
  iframe: HTMLIFrameElement;
  bridge: AppBridge;
  ready: Promise<void>;
}

export interface AppHostCallbacks {
  onModelContext(text: string | null): void;
  onAppMessage(text: string): void;
  onToolCallFromApp(name: string, args: unknown, result: CallToolResult, ms: number): void;
  onLog(params: { level?: string; logger?: string; data?: unknown }): void;
}

/**
 * Renders MCP Apps inside the simulated Echo Show screen, following the MCP Apps host protocol:
 * double-iframe sandbox on a separate origin, ui/initialize handshake, tool input/result
 * notifications, and app→server tool calls proxied through the host.
 */
export class AppHost {
  private mounted: Mounted | null = null;
  constructor(
    private screen: HTMLElement,
    private sandboxOrigin: string,
    private getConn: () => Connection | null,
    private getDevice: () => Device,
    private cb: AppHostCallbacks,
  ) {}

  get isOpen() {
    return !!this.mounted;
  }

  /** The ui:// resource for a tool call: the tool definition first (MCP Apps), then the result (Alexa+ style). */
  uiUriFor(toolName: string, result?: CallToolResult): string | undefined {
    const tool = this.getConn()?.tools.get(toolName);
    return (tool && getToolUiResourceUri(tool)) ?? ((result as any)?._meta?.ui?.resourceUri as string | undefined);
  }

  hostContext(): McpUiHostContext {
    const d = this.getDevice();
    return {
      theme: 'dark',
      platform: 'web',
      displayMode: 'fullscreen',
      availableDisplayModes: ['fullscreen'],
      containerDimensions: { width: d.width, height: d.height },
      locale: 'en-US',
      // Alexa+-style fields
      deviceClass: d.deviceClass,
      maxWidth: d.width,
      maxHeight: d.height,
      isMobile: false,
    } as McpUiHostContext;
  }

  /** Show a tool result: reuse the on-screen app when it's the same UI resource, otherwise mount it. */
  async show(toolName: string, input: Record<string, unknown>, result: CallToolResult) {
    const conn = this.getConn();
    const uri = this.uiUriFor(toolName, result);
    if (!conn || !uri) return false;
    if (this.mounted?.uri !== uri) await this.mount(conn, uri);
    const m = this.mounted!;
    await m.ready;
    await m.bridge.sendToolInput({ arguments: input });
    await m.bridge.sendToolResult(result);
    return true;
  }

  async mount(conn: Connection, uri: string) {
    this.close();
    const { html, meta } = await readUi(conn, uri);
    const iframe = document.createElement('iframe');
    iframe.className = 'app-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    iframe.setAttribute('allow', 'autoplay');
    const src = new URL(`${this.sandboxOrigin}/sandbox.html`);
    if (meta?.csp) src.searchParams.set('csp', JSON.stringify(meta.csp));

    const bridge = new AppBridge(conn.client, { name: 'Countertop', version: '0.1.0' }, {
      openLinks: {},
      serverTools: conn.client.getServerCapabilities()?.tools,
      serverResources: conn.client.getServerCapabilities()?.resources,
      updateModelContext: { text: {} },
      message: { text: {} },
    } as any, { hostContext: this.hostContext() });

    bridge.oncalltool = async (params) => {
      const t = Date.now();
      const result = await callTool(conn, params.name, (params.arguments ?? {}) as Record<string, unknown>);
      this.cb.onToolCallFromApp(params.name, params.arguments, result, Date.now() - t);
      return result;
    };
    bridge.onupdatemodelcontext = async (params) => {
      const text = (params.content ?? []).map((c: any) => c.text).filter(Boolean).join('\n');
      this.cb.onModelContext(text || null);
      return {};
    };
    bridge.onmessage = async (params) => {
      const text = (params as any).content?.map((c: any) => c.text).join(' ') ?? '';
      if (text) this.cb.onAppMessage(text);
      return {};
    };
    bridge.onopenlink = async (params) => {
      window.open(params.url, '_blank', 'noopener');
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: 'fullscreen' });
    bridge.onloggingmessage = (p) => this.cb.onLog(p as any);
    bridge.onsizechange = async () => {}; // the device screen has a fixed size

    let initialized!: () => void;
    const ready = new Promise<void>((r) => (initialized = r));
    bridge.oninitialized = () => initialized();

    const proxyReady = new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.method === 'ui/notifications/sandbox-proxy-ready') {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
    });
    iframe.src = src.toString();
    this.screen.append(iframe);
    this.mounted = { uri, iframe, bridge, ready };

    await proxyReady;
    await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    await bridge.sendSandboxResourceReady({ html, csp: meta?.csp, permissions: meta?.permissions });
    this.screen.classList.add('has-app');
  }

  resize() {
    this.mounted?.bridge.sendHostContextChange(this.hostContext());
  }

  close() {
    const m = this.mounted;
    if (!m) return;
    this.mounted = null;
    m.bridge.teardownResource({}).catch(() => {});
    setTimeout(() => {
      m.iframe.remove();
      m.bridge.close().catch(() => {});
    }, 150);
    this.screen.classList.remove('has-app');
    this.cb.onModelContext(null);
  }
}
