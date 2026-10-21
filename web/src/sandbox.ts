/**
 * MCP Apps sandbox proxy (outer iframe, separate origin from the host).
 * Host ⇄ this proxy ⇄ inner iframe running the untrusted MCP App HTML.
 * CSP is enforced by the HTTP header the Countertop server sets on sandbox.html.
 */
const READY = 'ui/notifications/sandbox-proxy-ready';
const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';

if (window.self === window.top) throw new Error('sandbox.html must be embedded by the Countertop host');
const referrer = document.referrer;
// A local Countertop, or the public origin the Countertop server declares when it's hosted (PUBLIC_ORIGIN).
const publicOrigin = document.querySelector<HTMLMetaElement>('meta[name="countertop-host-origin"]')?.content;
const allowed = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(referrer) || (!!publicOrigin && referrer.startsWith(`${publicOrigin}/`));
if (!allowed) throw new Error(`Embedding origin not allowed: ${referrer}`);
const HOST_ORIGIN = new URL(referrer).origin;
const OWN_ORIGIN = location.origin;

const inner = document.createElement('iframe');
inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
inner.setAttribute('allow', 'autoplay'); // narration in storybook-style apps
document.body.appendChild(inner);

window.addEventListener('message', (event) => {
  if (event.source === window.parent) {
    if (event.origin !== HOST_ORIGIN) return;
    const msg = event.data;
    if (msg?.method === RESOURCE_READY) {
      const { html, sandbox } = msg.params ?? {};
      if (typeof sandbox === 'string') inner.setAttribute('sandbox', sandbox);
      const doc = inner.contentDocument;
      if (doc && typeof html === 'string') {
        doc.open();
        doc.write(html);
        doc.close();
      } else if (typeof html === 'string') {
        inner.srcdoc = html;
      }
      return;
    }
    inner.contentWindow?.postMessage(msg, '*');
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) return;
    window.parent.postMessage(event.data, HOST_ORIGIN);
  }
});

window.parent.postMessage({ jsonrpc: '2.0', method: READY, params: {} }, HOST_ORIGIN);
