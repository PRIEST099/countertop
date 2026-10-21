# Countertop

**An open-source, voice-first smart-display simulator for testing MCP servers and MCP Apps the way Alexa+ uses them:** account linking, Echo Show-sized screens, an LLM that chooses your tools, spoken replies, a JSON-RPC inspector, and an **Alexa+ readiness report**.

![Countertop running the Once Upon Tonight add-on](docs/img/countertop.jpg)

## Why this exists

Alexa+ now integrates services through the **Model Context Protocol**. But the official Alexa+ add-on console, CLI and web simulator are **partner-only preview** today, so most developers, hackathon builders included, can't see their MCP server the way Alexa+ will use it. Countertop gives you that loop locally, in about a minute:

- **Talk to your add-on.** Push-to-talk (hold Space) uses the browser's speech recognition. Replies are spoken with Amazon Polly. Typing works too.
- **A real agent picks your tools.** Claude on Amazon Bedrock plays the Alexa+ reasoning layer. It sees your tools' names, descriptions and schemas, exactly as you publish them, and decides what to call. If your descriptions are vague, you'll hear it.
- **Your MCP Apps on an Echo Show.** Echo Show 5, 8 and 15 sizes, rendered through a proper **MCP Apps host**:
  - a double-iframe sandbox on a separate origin;
  - CSP from your `_meta.ui.csp`, enforced as an HTTP header;
  - the `ui/initialize` handshake and tool input/result notifications;
  - app → server `tools/call`, `ui/update-model-context`, `ui/message`, and Alexa-style host-context fields (`deviceClass`, `maxWidth`, `maxHeight`).
- **Account linking like Alexa+:**
  - unauthenticated probe → Protected Resource Metadata (RFC 9728) → Authorization Server Metadata (RFC 8414);
  - Dynamic Client Registration when offered;
  - authorization code + **PKCE S256** + `resource` (RFC 8707) → refresh.
- **Inspector:** every JSON-RPC message in and out, with per-request latency badges against Alexa+'s **500 ms** budget.
- **Alexa+ readiness report:** grades your server against the published Alexa+ MCP add-on requirements while you use it:

  | Check | Why it matters on Alexa+ |
  |---|---|
  | Streamable HTTP endpoint, protocol `2025-11-25` | Legacy HTTP+SSE isn't supported |
  | Unauthenticated → `401`, no `WWW-Authenticate` | Alexa+ discovers auth through `/.well-known` |
  | PRM at the root path; `resource` equals the endpoint exactly | A trailing-slash mismatch breaks linking |
  | Auth server metadata advertises `S256`; refresh tokens | Account linking fails without S256 |
  | Tools have descriptions + object schemas; snake_case names | Alexa+ builds your add-on from `tools/list` |
  | Every round trip < 500 ms | Published latency requirement |
  | `ui://` resources are `text/html;profile=mcp-app`, declare CSP, are content-hashed | Undeclared hosts are blocked; hashes allow safe caching |
  | UI tool results carry `_meta.ui.resourceUri` | Alexa+ renders custom visuals from the result |
  | Every result has spoken `text` | Voice-only Echo devices have no screen |

## Quick start

Requirements: Node 20+, Chrome or Edge (for speech recognition), and AWS credentials with Amazon Bedrock (Claude Haiku 4.5) and Amazon Polly access in `us-east-1`.

```bash
git clone https://github.com/PRIEST099/countertop && cd countertop
npm install
aws login            # or any standard AWS credential source
npm start            # http://localhost:5310  (MCP Apps sandbox on http://127.0.0.1:5311)
```

Open http://localhost:5310, paste your MCP server URL, and click **Link add-on**. Then hold **Space** (or click the ring) and talk.

Try it with [Once Upon Tonight](https://github.com/PRIEST099/once-upon-tonight), an Alexa+ bedtime-story add-on. It runs without AWS in mock mode:

```bash
git clone https://github.com/PRIEST099/once-upon-tonight && cd once-upon-tonight && npm install && AI_MODE=mock npm start
```

URL options: `?server=<mcp url>`, `?device=show5|show8|show15`, `?phrases=Make a story|Read my story` (suggested phrases on the home screen), `?demo=1` (typed lines are spoken aloud).

## Record a demo of your add-on (no microphone needed)

1. Start Countertop with `DEMO_AUDIO_DIR=demo-out/audio npm start`.
2. Write a scene script: `utter` lines in a chosen Polly voice, `waitIdle`, `waitAppAudio`, `appClick`, `mark`… (see the header of `scripts/record-demo.ts`).
3. Run `npm run record-demo -- my-script.json demo-out`.

You get one screen recording per scene, plus a timeline of every sound that played: the person's line, Alexa's reply, and your MCP App's own audio (apps can report playback with `app.sendLog({ logger: 'audio', data: { event: 'start' | 'stop', url, at } })`). That's enough to lay the audio back in sync in any editor; the Once Upon Tonight demo video was assembled this way in Remotion.

`npm run walkthrough` drives a scripted conversation headlessly and saves screenshots, which also makes a quick UI smoke test.

## How it works

```mermaid
flowchart LR
  Mic["🎙️ Web Speech API"] --> Agent
  Agent["Agent loop (browser)"] -- "/api/converse" --> Bedrock["Countertop server → Amazon Bedrock (Claude)"]
  Agent -- "MCP Streamable HTTP + Bearer" --> Server["Your MCP server"]
  Agent --> Host["MCP Apps host (AppBridge)"]
  Host -- "postMessage" --> Sandbox["Sandbox proxy :5311 (CSP header)"] --> View["Your ui:// app"]
  View -- "tools/call, update-model-context" --> Host --> Server
  Agent -- "/api/tts" --> Polly["Amazon Polly"] --> Speaker["🔊"]
```

- The **agent loop runs in the browser**, so every MCP request is visible in the inspector. The server only proxies Bedrock and Polly, so AWS credentials never reach the page.
- Tools with `visibility: ["app"]` are hidden from the model, as the MCP Apps spec requires.
- The model sees tool `content` + `structuredContent`, never `_meta`, which mirrors how hosts keep view payloads out of model context.
- What the app reports through `ui/update-model-context` is added to the system prompt, so "what's that dragon's name?" works while a page is on screen.

| File | |
|---|---|
| `server/index.ts` | UI server, Bedrock `Converse` proxy, Polly TTS, OAuth callback, sandbox origin with a CSP header |
| `web/src/oauth.ts` | Discovery, DCR, PKCE popup or redirect, token exchange, refresh |
| `web/src/mcp.ts` | MCP client with a tapping transport (wire log + latency) |
| `web/src/apps.ts` | MCP Apps host: sandbox, AppBridge, host context per device |
| `web/src/agent.ts` | The Alexa+-style reasoning loop |
| `web/src/readiness.ts` | Alexa+ readiness checks |
| `web/src/voice.ts` | Push-to-talk speech recognition and spoken replies |

## Limits

Countertop is **not** Amazon software and is not affiliated with Amazon. It approximates the published Alexa+ add-on behavior so you can iterate before you get access to the official tools. Where the docs are silent (for example, which MCP Apps bridge methods the Alexa+ webview supports), Countertop follows the MCP Apps specification.

## License

[MIT](LICENSE). Built during the Amazon Developer "Build, Ship, Shape" hackathon (Oct 2026) as the open-source companion to Once Upon Tonight.
