// shik-agent: local kernel server (the "SHIK MCP server" seam).
// Exposes the Core Self Layer over a tiny local HTTP interface so ANY cognition
// client: on-device or remote: can read the agent's identity through one
// standard surface, exactly as the MCP paper proposes (here as plain HTTP/JSON;
// a full MCP/JSON-RPC transport is the M3 drop-in). Bind to localhost only: the
// identity lives on hardware you own and is not exposed to the network.
//
// Handoff (working title): when a held history is loaded, the kernel also
// serves the policy layer. A body (phone, browser, kiosk) asks the kernel for
// a view; the kernel reconstructs it under the holder's policy, runs the
// checks, signs it with the device key and seals it for transport. The private
// key never leaves this process.
import { createServer, IncomingMessage, Server } from 'node:http';
import { KernelStore } from './kernel-store.js';
import { buildView, renderText, runChecks, signView, signDelegation, seal, receive, type HeldHistory, type HolderKey, type Delegation } from './handoff.js';

/**
 * `holderSecret` stands in for the device unlock (PIN or biometric) that only
 * the holder has. A helper body can read the history and enter facts for the
 * holder to confirm; it can never obtain a holder session, so it can never
 * confirm a fact or authorize a share.
 */
export interface HandoffContext { history: HeldHistory; key: HolderKey; holderSecret?: string }

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''; req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export class KernelServer {
  private server: Server | null = null;
  private relay = new Map<string, string>();   // ciphertext only; a hosted relay would hold the same
  private holderSessions = new Set<string>();  // issued only by a successful holder unlock
  private delegations = new Map<string, { del: Delegation; revoked: boolean }>();  // delegate token -> holder-signed crisis authorization
  private factSeq = 100;
  constructor(private store: KernelStore, private port = 8137, private handoff: HandoffContext | null = null) {}

  private isHolder(req: IncomingMessage): boolean {
    const t = req.headers['x-shik-session']; return typeof t === 'string' && this.holderSessions.has(t);
  }

  start(onListen?: (port: number) => void) {
    this.server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const send = (code: number, body: unknown) => { res.statusCode = code; res.end(JSON.stringify(body)); };
      const s = this.store.get();
      try {
        switch (req.url) {
          case '/shik/identity':         // MCP: shik://identity
            return send(200, { id: s.id, turnCount: s.turnCount, currentTopic: s.currentTopic, handoff: !!this.handoff });
          case '/shik/memories':         // MCP: shik://memories
            return send(200, { memories: s.coreMemories });
          case '/shik/session/current':  // MCP: shik://session/current
            return send(200, { context: s.sessionContext, events: s.events.slice(0, 30) });
          case '/shik/presence':
            return send(200, { presenceHistory: s.presenceHistory });
        }
        if (req.url?.startsWith('/shik/handoff/')) return this.handleHandoff(req, send);
        return send(404, { error: 'not found' });
      } catch (e) {
        return send(400, { error: String((e as Error).message ?? e) });
      }
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      const addr = this.server!.address(); const port = typeof addr === 'object' && addr ? addr.port : this.port;
      console.log(`[kernel] self-hosted identity server on http://127.0.0.1:${port}`);
      onListen?.(port);
    });
  }

  private async handleHandoff(req: IncomingMessage, send: (code: number, body: unknown) => void) {
    const h = this.handoff;
    if (!h) return send(404, { error: 'no held history loaded on this kernel' });
    const url = req.url!;
    if (url === '/shik/handoff/history' && req.method === 'GET')
      return send(200, { person: h.history.person, fingerprint: h.key.fp, recipients: Object.fromEntries(Object.entries(h.history.policy).map(([k, p]) => [k, { label: p.label, offered: p.offered }])), facts: h.history.facts });
    if (url === '/shik/handoff/view' && req.method === 'POST') {
      const { recipient, selected } = await readJson(req);
      const v = buildView(h.history, String(recipient), Array.isArray(selected) ? selected.map(String) : []);
      const text = renderText(h.history, v);
      return send(200, { view: v, text, checks: runChecks(h.history, v, text) });
    }
    if (url === '/shik/handoff/unlock' && req.method === 'POST') {   // the holder's device unlock
      const { secret } = await readJson(req);
      if (!h.holderSecret || String(secret) !== h.holderSecret) { this.store.logEvent('handoff.unlock.refused', 'Unlock refused'); return send(403, { error: 'unlock refused' }); }
      const token = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
      this.holderSessions.add(token); this.store.logEvent('handoff.unlock', 'Holder unlocked');
      return send(200, { session: token });
    }
    if (url === '/shik/handoff/facts' && req.method === 'POST') {   // a helper or the holder enters a patient-reported fact
      const { cat, text, enteredBy } = await readJson(req);
      if (!h.history.categories[String(cat)]) return send(400, { error: 'unknown category' });
      const holder = this.isHolder(req); const id = 'F' + String(++this.factSeq);
      const date = new Date().toISOString().slice(0, 10);
      h.history.facts.push({ id, cat: String(cat), text: String(text), src: { kind: 'pat', who: h.history.person.given, date, via: holder ? undefined : `entered by ${String(enteredBy || 'a helper')}, confirmation by ${h.history.person.given} pending` }, unconfirmed: !holder });
      this.store.logEvent('handoff.fact', `${holder ? 'Holder' : 'Helper'} entered ${id}${holder ? '' : ' (unconfirmed)'}`);
      return send(200, { id, unconfirmed: !holder });
    }
    if (url === '/shik/handoff/confirm' && req.method === 'POST') {   // only the holder confirms a helper-entered fact
      if (!this.isHolder(req)) return send(403, { error: `only ${h.history.person.given} can confirm a fact; a helper session cannot` });
      const { id } = await readJson(req); const f = h.history.facts.find((x) => x.id === String(id));
      if (!f) return send(404, { error: 'no such fact' });
      f.unconfirmed = false; f.src.via = (f.src.via ?? '').replace(/, confirmation by .* pending$/, `, confirmed by ${h.history.person.given}`) || undefined;
      this.store.logEvent('handoff.confirm', `Holder confirmed ${f.id}`);
      return send(200, { id: f.id, unconfirmed: false });
    }
    if (url === '/shik/handoff/delegate' && req.method === 'POST') {   // holder, while well, authorizes a delegate for the crisis view only
      if (!this.isHolder(req)) return send(403, { error: `only ${h.history.person.given} can grant a crisis authorization` });
      const { delegate, ttl } = await readJson(req);
      if (!h.history.policy.crisis) return send(400, { error: 'no crisis policy in this history' });
      const del = await signDelegation(h.key, String(delegate || 'a family member'), 'crisis', Number.isFinite(Number(ttl)) ? Number(ttl) : 90 * 86400);
      const token = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
      this.delegations.set(token, { del, revoked: false });
      this.store.logEvent('handoff.delegate', `Holder authorized ${del.delegate} for the crisis view until ${new Date(del.exp * 1000).toISOString().slice(0, 10)}`);
      return send(200, { delegateToken: token, delegation: del });
    }
    if (url === '/shik/handoff/revoke' && req.method === 'POST') {
      if (!this.isHolder(req)) return send(403, { error: `only ${h.history.person.given} can revoke a crisis authorization` });
      const { delegateToken } = await readJson(req); const d = this.delegations.get(String(delegateToken));
      if (!d) return send(404, { error: 'no such authorization' });
      d.revoked = true; this.store.logEvent('handoff.revoke', `Holder revoked ${d.del.delegate}'s crisis authorization`);
      return send(200, { revoked: true });
    }
    if (url === '/shik/handoff/crisis-share' && req.method === 'POST') {   // the delegate, during a crisis: crisis view only, holder's pre-chosen content only
      const t = req.headers['x-shik-delegate']; const d = typeof t === 'string' ? this.delegations.get(t) : undefined;
      const refuse = (why: string) => { this.store.logEvent('handoff.crisis.refused', why); return send(403, { error: why }); };
      if (!d) return refuse('crisis share refused: no crisis authorization from the holder');
      if (d.revoked) return refuse('crisis share refused: the holder revoked this authorization');
      if (d.del.exp < Math.floor(Date.now() / 1000)) return refuse('crisis share refused: the authorization has expired');
      const { recipient, ttl } = await readJson(req);
      if (recipient !== undefined && String(recipient) !== d.del.scope) return refuse(`crisis share refused: the delegate may share only the ${h.history.policy[d.del.scope].label} view`);
      const pol = h.history.policy[d.del.scope];
      const ids = h.history.facts.filter((f) => pol.offered.includes(f.cat)).map((f) => f.id);   // the delegate does not choose lines
      const v = buildView(h.history, d.del.scope, ids); const text = renderText(h.history, v); const checks = runChecks(h.history, v, text);
      if (checks.some((c) => !c.ok)) return send(409, { error: 'checks failed; nothing signed', checks });
      const ttlSec = Math.min(Number.isFinite(Number(ttl)) ? Number(ttl) : 86400, 86400);
      const jws = await signView(h.history, h.key, v, text, ttlSec, Math.floor(Date.now() / 1000), d.del);
      const sealed = await seal(jws, 'Crisis view, shared by ' + d.del.delegate, Math.floor(Date.now() / 1000) + ttlSec);
      this.relay.set(sealed.id, sealed.blob);
      this.store.logEvent('handoff.crisis.share', `${d.del.delegate} shared the crisis view under the holder's authorization, ${v.lines.length} lines`);
      return send(200, { shlink: sealed.shlink, id: sealed.id, checks });
    }
    if (url === '/shik/handoff/share' && req.method === 'POST') {
      if (!this.isHolder(req)) { this.store.logEvent('handoff.share.refused', 'Share refused: no holder session'); return send(403, { error: `only ${h.history.person.given} can authorize a share; a helper or an unlocked-less body cannot. Holder unlock required.` }); }
      const { recipient, selected, ttl } = await readJson(req);
      const v = buildView(h.history, String(recipient), Array.isArray(selected) ? selected.map(String) : []);
      const text = renderText(h.history, v); const checks = runChecks(h.history, v, text);
      if (checks.some((c) => !c.ok)) return send(409, { error: 'checks failed; nothing signed', checks });
      const ttlSec = Number.isFinite(Number(ttl)) ? Number(ttl) : 86400;
      const jws = await signView(h.history, h.key, v, text, ttlSec);
      const sealed = await seal(jws, 'View for ' + h.history.policy[v.recipient].label, Math.floor(Date.now() / 1000) + ttlSec);
      this.relay.set(sealed.id, sealed.blob);
      this.store.logEvent('handoff.share', `Signed view for ${h.history.policy[v.recipient].label}, ${v.lines.length} lines`);   // H, append-only
      return send(200, { shlink: sealed.shlink, id: sealed.id, fingerprint: h.key.fp, checks });
    }
    if (url.startsWith('/shik/handoff/relay/') && req.method === 'GET') {
      const blob = this.relay.get(url.slice('/shik/handoff/relay/'.length));
      return blob ? send(200, { blob }) : send(404, { error: 'no such reference' });
    }
    if (url === '/shik/handoff/verify' && req.method === 'POST') {   // a recipient body asking the kernel's verifier
      const { shlink, audience } = await readJson(req);
      const r = await receive(h.history, String(shlink), (id) => this.relay.get(id) ?? null, { audience: audience ? String(audience) : undefined });
      return send(200, { ok: r.ok, log: r.log, text: r.ok ? r.payload?.text : undefined, fingerprint: r.fp });
    }
    return send(404, { error: 'not found' });
  }

  stop() {
    this.server?.close();
  }
}
