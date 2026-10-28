// shik-agent: Handoff policy layer (working title).
// ---------------------------------------------------------------------------
// Recipient-specific reconstruction of a held history, inside the kernel.
//
// In the SHIK tuple ⟨id, K, P, M, H⟩ this module is P applied to M: the holder's
// disclosure policy projects the held history (facts with provenance) into a
// view for one recipient. The projection is deterministic: filter by the
// holder's selection and the recipient's category allow-list, order, and
// render every line verbatim with its source id. No cognition engine is in the
// path, so no text can be generated. K signs the exact output, audience and
// expiry on the device. H receives the share log.
//
// The same mechanism runs in the browser prototype; `test/handoff.test.ts`
// checks that both produce byte-identical views from `fixtures/jordan.json`.
// Runs on Node 22 (Web Crypto via globalThis.crypto), which is what the Pi
// body runs. Not yet verified on Raspberry Pi hardware.

import type { webcrypto } from 'node:crypto';
type JsonWebKey = webcrypto.JsonWebKey; type CryptoKey = webcrypto.CryptoKey;

export type SourceKind = 'clin' | 'pat' | 'unk';
export interface Source { kind: SourceKind; who?: string; date?: string; doc?: string; via?: string }
/** `unconfirmed`: entered by a helper and not yet confirmed by the holder; never enters a view. */
export interface Fact { id: string; cat: string; text: string; src: Source; unconfirmed?: boolean }
export interface RecipientPolicy { label: string; title: string; offered: string[] }
export interface HeldHistory {
  person: { id: string; name: string; given: string; note?: string };
  categories: Record<string, string>;
  clinical: string[];
  policy: Record<string, RecipientPolicy>;
  facts: Fact[];
}
export interface ViewLine { id: string; cat: string; text: string; source: string; kind: SourceKind }
export interface View { recipient: string; title: string; prepared: string; lines: ViewLine[]; refused: { id: string; cat: string; reason: string }[] }
export interface Check { ok: boolean; warn?: boolean; t: string; d: string }

/** A recipient whose policy offers any clinical category gets clinical text by the holder's choice; others never do. */
export const offersClinical = (h: HeldHistory, recipient: string) => (h.policy[recipient]?.offered ?? []).some((c) => h.clinical.includes(c));

export function sourceLabel(s: Source): string {
  if (s.kind === 'clin') return `clinician-sourced: ${s.who}, ${s.date}, ${s.doc}`;
  if (s.kind === 'pat') return `patient-reported: ${s.who}, ${s.date}${s.via ? ', ' + s.via : ''}`;
  return 'unknown';
}

/** P applied to M: the reconstruction. Refusals are returned, never silent. */
export function buildView(h: HeldHistory, recipient: string, selectedIds: string[]): View {
  const pol = h.policy[recipient];
  if (!pol) throw new Error(`unknown recipient: ${recipient}`);
  const lines: ViewLine[] = []; const refused: View['refused'] = [];
  for (const id of selectedIds) {
    const f = h.facts.find((x) => x.id === id); if (!f) continue;
    if (f.unconfirmed) { refused.push({ id, cat: f.cat, reason: `entered by a helper and not yet confirmed by ${h.person.given}` }); continue; }
    if (!pol.offered.includes(f.cat)) { refused.push({ id, cat: f.cat, reason: `category "${h.categories[f.cat]}" is not offered to ${pol.label}` }); continue; }
    lines.push({ id: f.id, cat: f.cat, text: f.text, source: sourceLabel(f.src), kind: f.src.kind });
  }
  const order = Object.keys(h.categories);
  lines.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.id.localeCompare(b.id));
  return { recipient, title: pol.title, prepared: `Prepared by ${h.person.name} for ${pol.label}. Every line is from ${h.person.given}'s held history, verbatim, with its source.`, lines, refused };
}

/** The exact text the recipient receives. Byte-identical to the browser prototype. */
export function renderText(h: HeldHistory, v: View): string {
  let out = v.title + '\n' + v.prepared + '\n'; let cat: string | null = null;
  for (const l of v.lines) {
    if (l.cat !== cat) { cat = l.cat; out += '\n' + h.categories[cat].toUpperCase() + '\n'; }
    out += '[' + l.id + '] ' + (l.kind === 'unk' ? 'UNKNOWN: ' : '') + l.text + '\n      (' + l.source + ')\n';
  }
  if (!offersClinical(h, v.recipient)) out += `\n${h.person.given} chose not to share medical details with this recipient. The supports above are ${h.person.given}'s own statements.\n`;
  return out;
}

const STOP = new Set(['about', 'after', 'since', 'where', 'with', 'every', 'their', 'there', 'which', 'daily', 'between', 'twice', 'needed', 'three', 'times', 'weeks', 'university', 'counseling', 'center', 'example', 'march', 'september', 'single', 'place', 'reported', 'review', 'known', 'prior', 'focus', 'sleep', 'month', 'again', 'acute']);
export function sensitiveTerms(h: HeldHistory): string[] {
  const terms = new Set<string>();
  for (const f of h.facts) if (h.clinical.includes(f.cat))
    for (const w of f.text.match(/[A-Za-z][A-Za-z-]{4,}|[A-Z]\d{2}\.\d/g) ?? []) { const k = w.toLowerCase(); if (!STOP.has(k)) terms.add(k); }
  return [...terms];
}

/** Checks run at build and again at receipt. Any failure blocks the view. */
export function runChecks(h: HeldHistory, v: View, text: string): Check[] {
  const res: Check[] = []; const pol = h.policy[v.recipient];
  if (offersClinical(h, v.recipient)) res.push({ ok: true, t: 'Leakage check not applicable', d: `This recipient is offered clinical categories by ${h.person.given}'s choice.` });
  else {
    const terms = sensitiveTerms(h); const low = text.toLowerCase(); const hits = terms.filter((t) => low.includes(t));
    res.push({ ok: hits.length === 0, t: `Sensitive-detail leakage: ${hits.length} of ${terms.length} clinical terms found`, d: hits.length ? 'Found: ' + hits.join(', ') : 'Terms are taken from the diagnosis, medication, therapy, safety and history facts and searched for in the output.' });
    const badCat = v.lines.filter((l) => !pol.offered.includes(l.cat));
    res.push({ ok: badCat.length === 0, t: `Category allow-list: ${badCat.length} lines outside ${pol.label}'s allow-list`, d: 'Allowed: ' + pol.offered.map((c) => h.categories[c]).join(', ') });
  }
  const untraced = v.lines.filter((l) => { const f = h.facts.find((x) => x.id === l.id); return !f || f.text !== l.text; });
  res.push({ ok: untraced.length === 0, t: `Source traceability: ${v.lines.length - untraced.length} of ${v.lines.length} lines equal a source fact verbatim`, d: untraced.length ? 'Unsupported: ' + untraced.map((l) => l.id).join(', ') : 'No generated or paraphrased text. An unsupported statement would fail here.' });
  const n = (k: SourceKind) => v.lines.filter((l) => l.kind === k).length;
  res.push({ ok: true, t: `Provenance: ${n('clin')} clinician-sourced, ${n('pat')} patient-reported, ${n('unk')} marked unknown`, d: 'Unknowns are stated, not filled in.' });
  if (v.refused.length) res.push({ ok: true, warn: true, t: `${v.refused.length} selection refused by the disclosure rule`, d: v.refused.map((r) => `${r.id}: ${r.reason}`).join('; ') });
  return res;
}

// ------------------------------------------------------------------ K: signing, transport
const te = new TextEncoder(); const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;
export const b64u = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64url');
export const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));
export async function thumbprint(jwk: JsonWebKey): Promise<string> {
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(await subtle.digest('SHA-256', te.encode(canon)));
}
export interface HolderKey { priv: CryptoKey; jwk: JsonWebKey; fp: string }
export async function generateHolderKey(): Promise<HolderKey> {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', kp.publicKey);
  const jwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
  return { priv: kp.privateKey, jwk, fp: await thumbprint(jwk) };
}
/** A crisis delegation the holder signed while well: who may share, which view, until when. */
export interface Delegation { delegate: string; scope: string; grantedAt: number; exp: number; sig: string }
export interface SignedView { iss: string; sub: string; aud: string; iat: number; exp: number; title: string; prepared: string; lines: ViewLine[]; text: string; policyHash: string; del?: Delegation }
export async function signView(h: HeldHistory, key: HolderKey, v: View, text: string, ttlSec: number, now = Math.floor(Date.now() / 1000), del?: Delegation): Promise<string> {
  const policyHash = b64u(await subtle.digest('SHA-256', te.encode(JSON.stringify(h.policy[v.recipient].offered))));
  const payload: SignedView = { iss: 'did:jwk:' + key.fp, sub: h.person.id, aud: v.recipient, iat: now, exp: now + ttlSec, title: v.title, prepared: v.prepared, lines: v.lines, text, policyHash, ...(del ? { del } : {}) };
  const header = { alg: 'ES256', typ: 'handoff-view+jwt', jwk: key.jwk };
  const input = b64u(te.encode(JSON.stringify(header))) + '.' + b64u(te.encode(JSON.stringify(payload)));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.priv, te.encode(input));
  return input + '.' + b64u(sig);
}
const delegationInput = (d: Omit<Delegation, 'sig'>, holderFp: string) => te.encode(JSON.stringify({ t: 'handoff-delegation', holder: holderFp, delegate: d.delegate, scope: d.scope, grantedAt: d.grantedAt, exp: d.exp }));
/** Signed by the holder's key, so a delegate cannot widen or extend it. */
export async function signDelegation(key: HolderKey, delegate: string, scope: string, ttlSec: number, now = Math.floor(Date.now() / 1000)): Promise<Delegation> {
  const d = { delegate, scope, grantedAt: now, exp: now + ttlSec };
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.priv, delegationInput(d, key.fp));
  return { ...d, sig: b64u(sig) };
}
async function verifyDelegation(pubKey: CryptoKey, fp: string, d: Delegation): Promise<boolean> {
  try { return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, unb64u(d.sig), delegationInput(d, fp)); } catch { return false; }
}

export interface Sealed { id: string; blob: string; shlink: string }
/** AES-GCM with a one-time key carried in the link; the relay holds ciphertext only. */
export async function seal(jws: string, label: string, exp: number): Promise<Sealed> {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(jws));
  const id = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const link = { url: 'https://handoff.expertorbit.com/s/' + id, key: b64u(await subtle.exportKey('raw', key)), flag: 'P', label, exp, v: 2 };
  return { id, blob: b64u(iv) + '.' + b64u(ct), shlink: 'shlink:/' + b64u(te.encode(JSON.stringify(link))) };
}

export interface Step { ok: boolean; warn?: boolean; t: string; d: string }
export interface ReceiveResult { ok: boolean; log: Step[]; payload?: SignedView; fp?: string }
/** The recipient side: verify before showing. `audience` is who is opening it. */
export async function receive(h: HeldHistory, shlink: string, fetchBlob: (id: string) => string | null, opts: { audience?: string; tamper?: (p: SignedView) => void; now?: number } = {}): Promise<ReceiveResult> {
  const log: Step[] = []; const step = (ok: boolean, t: string, d: string, warn?: boolean) => log.push({ ok, t, d, warn });
  const fail = (t: string, d: string): ReceiveResult => { step(false, t, d); return { ok: false, log }; };
  if (!shlink.startsWith('shlink:/')) return fail('Scan failed', 'Not a handoff link.');
  const link = JSON.parse(td.decode(unb64u(shlink.slice('shlink:/'.length)))); const id = String(link.url).split('/').pop() ?? '';
  step(true, 'Link parsed', `Relay reference ${id.slice(0, 8)}…, one-time key received`);
  const blob = fetchBlob(id); if (!blob) return fail('Fetch failed', 'Relay has no record for this reference.');
  const [ivB, ctB] = blob.split('.');
  step(true, 'Ciphertext fetched', `${Math.floor(ctB.length * 3 / 4)} bytes; the relay never held plaintext`);
  const key = await subtle.importKey('raw', unb64u(link.key), { name: 'AES-GCM' }, false, ['decrypt']);
  let pt: string;
  try { pt = td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(ivB) }, key, unb64u(ctB))); } catch { return fail('Decryption failed', 'Ciphertext altered or wrong key.'); }
  step(true, 'Decrypted', 'AES-GCM authenticated; plaintext is a compact ES256 JWS');
  const parts = pt.split('.'); const hdr = parts[0]; let p = parts[1]; const s = parts[2];
  const header = JSON.parse(td.decode(unb64u(hdr))); const payload: SignedView = JSON.parse(td.decode(unb64u(p)));
  if (opts.tamper) { opts.tamper(payload); p = b64u(te.encode(JSON.stringify(payload))); step(true, 'Adversary altered the view in transit', 'Changed after signing', true); }
  const pub = await subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const fp = await thumbprint(header.jwk);
  const valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(s), te.encode(hdr + '.' + p));
  if (!valid) return fail('Signature invalid', `The text does not match what the holder's device signed (key ${fp.slice(0, 20)}). Rejected; nothing shown.`);
  step(true, 'Unaltered since signing', `ES256 signature by device key ${fp.slice(0, 20)}`);
  if (payload.iss !== 'did:jwk:' + fp) return fail('Issuer mismatch', 'Issuer does not match the signing key.');
  const me = opts.audience ?? payload.aud;
  if (payload.aud !== me) return fail('Audience mismatch', `Signed for ${h.policy[payload.aud]?.label ?? payload.aud}, opened as ${h.policy[me]?.label ?? me}. Rejected.`);
  step(true, 'Audience matches', `Signed for ${h.policy[payload.aud].label}`);
  if (payload.del) {
    const d = payload.del;
    if (!(await verifyDelegation(pub, fp, d))) return fail('Delegation invalid', 'The crisis authorization is not signed by the holder\'s key. Rejected.');
    if (d.scope !== payload.aud) return fail('Delegation out of scope', `The delegate was authorized for ${h.policy[d.scope]?.label ?? d.scope}, not ${h.policy[payload.aud]?.label ?? payload.aud}. Rejected.`);
    if (d.exp < (opts.now ?? Math.floor(Date.now() / 1000))) return fail('Delegation expired', `The holder's crisis authorization ended ${new Date(d.exp * 1000).toISOString()}. Rejected.`);
    step(true, 'Shared by a delegate', `${d.delegate}, under ${h.person.given}'s crisis authorization signed ${new Date(d.grantedAt * 1000).toISOString().slice(0, 10)}; scope ${h.policy[d.scope].label} only`, true);
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp < now) return fail('Expired', `Validity ended at ${new Date(payload.exp * 1000).toISOString()}.`);
  step(true, 'Within validity', `Expires ${new Date(payload.exp * 1000).toISOString()}`);
  const v: View = { recipient: payload.aud, title: payload.title, prepared: payload.prepared, lines: payload.lines, refused: [] };
  const checks = runChecks(h, v, payload.text); for (const c of checks) step(c.ok, c.t, c.d, c.warn);
  if (checks.some((c) => !c.ok)) return fail('Check failed', 'A disclosure or traceability check failed on receipt. Nothing shown.');
  step(true, 'Provenance is the holder\'s assertion', 'Clinician-sourced tags say where the holder recorded each fact from. No clinic countersigned them. Not verified: that the content is true.', true);
  return { ok: true, log, payload, fp };
}
