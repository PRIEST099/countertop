import { isToolVisibilityAppOnly } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { callTool, type Connection } from './mcp';
import type { AppHost } from './apps';
import { deviceNow } from './demo';

type Block = { text?: string; toolUse?: { toolUseId: string; name: string; input: any }; toolResult?: any };
interface Msg {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface AgentEvents {
  onToolCall(name: string, input: any, result: CallToolResult, ms: number): void;
  onModel(ms: number, stopReason: string): void;
  onError(message: string): void;
}

/**
 * Stands in for the Alexa+ reasoning layer: an LLM (Claude on Amazon Bedrock, via the Countertop
 * server) chooses tools from the linked add-on, Countertop calls them over MCP, renders any MCP App
 * on the device, and speaks the final reply.
 */
export class Agent {
  private messages: Msg[] = [];
  modelContext: string | null = null;

  constructor(private conn: () => Connection | null, private host: AppHost, private ev: AgentEvents) {}

  reset() {
    this.messages = [];
  }

  private system() {
    const c = this.conn();
    const now = deviceNow();
    return [
      `You are Alexa, the voice assistant on an Echo Show in a family's home (simulated by Countertop). It is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`,
      'Speak like Alexa: warm, natural, and brief — usually one or two short sentences. No markdown, lists, emoji, URLs, ids, or tool names in what you say.',
      c ? `The customer has linked the add-on "${c.serverTitle ?? c.serverName}". ${c.instructions ?? ''} Use its tools whenever a request fits, passing along everything the customer said. Prefer a tool call over asking questions when you can fill the inputs from what was said.` : 'No add-on is linked yet.',
      'When a tool result says narratedOnScreen is true, the screen has its own narrator that reads the story pages AND asks the story\'s choice question aloud. Then do NOT read story text or repeat the question: reply with at most four warm words (like "Here\'s tonight\'s story!" or "Great choice!").',
      'If a tool asks for confirmation (needsConfirmation), ask the customer and only call again after a clear yes.',
      this.modelContext ? `What the screen currently shows: ${this.modelContext}` : 'The screen currently shows the home screen.',
    ].join('\n');
  }

  private tools() {
    const c = this.conn();
    if (!c) return [];
    return [...c.tools.values()]
      .filter((t) => !isToolVisibilityAppOnly(t))
      .map((t) => {
        const { $schema, ...schema } = (t.inputSchema ?? { type: 'object', properties: {} }) as any;
        return { name: t.name, description: (t.description ?? t.title ?? t.name).slice(0, 1000), inputSchema: { json: schema } };
      });
  }

  /** Keep the context small: drop oldest turns, always starting on a plain user utterance. */
  private trimmed() {
    let m = this.messages;
    if (m.length > 24) {
      m = m.slice(-24);
      while (m.length && !(m[0].role === 'user' && m[0].content.some((b) => b.text))) m = m.slice(1);
    }
    return m;
  }

  async turn(utterance: string): Promise<string> {
    this.messages.push({ role: 'user', content: [{ text: utterance }] });
    for (let step = 0; step < 6; step++) {
      const t = Date.now();
      const r = await fetch('/api/converse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: this.system(), messages: this.trimmed(), tools: this.tools() }),
      });
      const out = await r.json();
      if (!r.ok) {
        this.messages.pop();
        this.ev.onError(out.message ?? 'The assistant model failed');
        // A hosted demo over its usage limit says so, rather than a vague apology.
        return r.status === 429 && out.message ? out.message : "Sorry, I'm having trouble right now.";
      }
      this.ev.onModel(Date.now() - t, out.stopReason);
      console.debug(`[agent] step ${step}: ${out.stopReason}`);
      const msg: Msg = out.message;
      this.messages.push(msg);
      const uses = msg.content.filter((b) => b.toolUse).map((b) => b.toolUse!);
      if (out.stopReason !== 'tool_use' || !uses.length) {
        return spoken(msg.content.map((b) => b.text ?? '').join(' '));
      }
      const results: Block[] = [];
      for (const use of uses) {
        const c = this.conn();
        const started = Date.now();
        let result: CallToolResult;
        try {
          result = c ? await callTool(c, use.name, use.input ?? {}) : { isError: true, content: [{ type: 'text', text: 'No add-on linked' }] };
        } catch (e) {
          result = { isError: true, content: [{ type: 'text', text: String(e) }] };
        }
        this.ev.onToolCall(use.name, use.input, result, Date.now() - started);
        this.host.show(use.name, use.input ?? {}, result).catch((e) => this.ev.onError(`UI: ${e}`));
        results.push({
          toolResult: { toolUseId: use.toolUseId, content: [{ text: forModel(result) }], status: result.isError ? 'error' : 'success' },
        });
      }
      this.messages.push({ role: 'user', content: results });
    }
    return '';
  }
}

/** What the model sees from a tool result: its text plus structured facts, never the UI payload in _meta. */
function forModel(r: CallToolResult) {
  const text = (r.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  const facts = r.structuredContent ? `\n${JSON.stringify(r.structuredContent)}` : '';
  return (text + facts).slice(0, 4000) || '(empty result)';
}

/** What Alexa says out loud: never tool-call markup a model wrote as text instead of calling a tool. */
export function spoken(text: string) {
  return text
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, ' ')
    .replace(/<\/?(invoke|parameter|antml:[a-z_]+)[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
