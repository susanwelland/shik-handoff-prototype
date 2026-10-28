// The kernel server serving the Handoff policy layer to bodies over localhost.
// Proves: the intended recipient can verify; altered content fails; a helper
// can enter facts but cannot confirm them or authorize a share.
// Run: npm run test:handoff
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelStore } from '../dist/kernel-store.js';
import { KernelServer } from '../dist/kernel-server.js';
import { generateHolderKey, receive, type HeldHistory } from '../dist/handoff.js';

const here = dirname(fileURLToPath(import.meta.url));
const history: HeldHistory = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'jordan.json'), 'utf8'));
const store = new KernelStore(join(mkdtempSync(join(tmpdir(), 'shik-')), 'kernel.json'), 'shik-test');
const key = await generateHolderKey();
const server = new KernelServer(store, 0, { history, key, holderSecret: 'jordan-unlock-demo' });
const port = await new Promise<number>((r) => server.start(r));
const base = `http://127.0.0.1:${port}`;
const call = async (p: string, body: unknown, session?: string) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { 'x-shik-session': session } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
let failures = 0; const assert = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const allIds = () => history.facts.map((f) => f.id);

// Reading is open to any body on the device
const id = await (await fetch(base + '/shik/identity')).json();
assert(id.handoff === true, 'kernel identity reports a held history');
const hist = await (await fetch(base + '/shik/handoff/history')).json();
assert(hist.facts.length === 18 && hist.fingerprint === key.fp, 'a body can read the held history and the device key fingerprint');

// A helper (no holder session) enters a fact: accepted, but unconfirmed and kept out of every view
const added = await call('/shik/handoff/facts', { cat: 'pattern', text: 'Appointment moved to Thursdays at 3 pm.', enteredBy: "Jordan's sister" });
assert(added.status === 200 && added.body.unconfirmed === true, 'helper can enter a fact; it is marked unconfirmed');
const careUnconfirmed = await call('/shik/handoff/view', { recipient: 'care', selected: allIds() });
assert(careUnconfirmed.body.view.refused.some((r: any) => r.id === added.body.id && /not yet confirmed/.test(r.reason)), 'unconfirmed helper fact is refused from the view, with the reason');

// A helper cannot confirm or share
const helperConfirm = await call('/shik/handoff/confirm', { id: added.body.id });
assert(helperConfirm.status === 403, 'helper cannot confirm a fact (403)');
const helperShare = await call('/shik/handoff/share', { recipient: 'care', selected: allIds(), ttl: 3600 });
assert(helperShare.status === 403 && /only Jordan can authorize/.test(helperShare.body.error), 'helper cannot authorize a share (403, reason named)');
const badUnlock = await call('/shik/handoff/unlock', { secret: 'guess' });
assert(badUnlock.status === 403, 'wrong unlock secret is refused');

// The holder unlocks, confirms, shares
const unlock = await call('/shik/handoff/unlock', { secret: 'jordan-unlock-demo' });
assert(unlock.status === 200 && typeof unlock.body.session === 'string', 'holder unlock issues a session');
const holder = unlock.body.session as string;
const confirmed = await call('/shik/handoff/confirm', { id: added.body.id }, holder);
assert(confirmed.status === 200 && confirmed.body.unconfirmed === false, 'holder confirms the helper-entered fact');
const teacher = await call('/shik/handoff/view', { recipient: 'teacher', selected: ['F13', 'F14', 'F15', 'F01'] });
assert(teacher.body.view.refused.length === 1 && teacher.body.view.refused[0].id === 'F01', 'kernel refuses the forced diagnosis and reports it');
assert(teacher.body.text === readFileSync(join(here, 'expected', 'teacher.txt'), 'utf8'), 'kernel teacher view equals the expected fixture output');
const shared = await call('/shik/handoff/share', { recipient: 'care', selected: ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18'], ttl: 3600 }, holder);
assert(shared.status === 200 && String(shared.body.shlink).startsWith('shlink:/'), 'holder signs and seals a view; kernel returns a handoff link');

// The intended recipient verifies; the wrong audience and altered content fail
const ok = await call('/shik/handoff/verify', { shlink: shared.body.shlink });
assert(ok.body.ok === true && ok.body.text === readFileSync(join(here, 'expected', 'care.txt'), 'utf8'), 'intended recipient verifies and receives the exact signed text');
const wrong = await call('/shik/handoff/verify', { shlink: shared.body.shlink, audience: 'employer' });
assert(wrong.body.ok === false && wrong.body.log.at(-1).t === 'Audience mismatch', 'the care view opened as the employer is rejected');
const relayId = shared.body.id as string;
const blob = (await (await fetch(base + '/shik/handoff/relay/' + relayId)).json()).blob as string;
const tampered = await receive(history, shared.body.shlink, () => blob, { tamper: (p) => { p.lines[0].text += ' (and two other things).'; } });
assert(tampered.ok === false && tampered.log.at(-1)?.t === 'Signature invalid', 'altered content fails verification');
const corrupt = await receive(history, shared.body.shlink, () => blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA'));
assert(corrupt.ok === false && corrupt.log.at(-1)?.t === 'Decryption failed', 'ciphertext altered at the relay fails to decrypt');

// Crisis: the holder pre-authorizes a family delegate for the crisis view only
const noDel = await fetch(base + '/shik/handoff/crisis-share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert(noDel.status === 403, 'without a holder authorization the family member cannot share anything, even in a crisis (403)');
const helperGrant = await call('/shik/handoff/delegate', { delegate: "Jordan's sister" });
assert(helperGrant.status === 403, 'a helper cannot grant itself a crisis authorization (403)');
const grant = await call('/shik/handoff/delegate', { delegate: "Jordan's sister", ttl: 90 * 86400 }, holder);
assert(grant.status === 200 && typeof grant.body.delegateToken === 'string', 'holder, while well, signs a crisis authorization for the sister');
const dTok = grant.body.delegateToken as string;
const dcall = async (body: unknown) => { const r = await fetch(base + '/shik/handoff/crisis-share', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shik-delegate': dTok }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const wide = await dcall({ recipient: 'employer' });
assert(wide.status === 403 && /only the Crisis care team view/.test(wide.body.error), 'the delegate cannot share to the employer or any other recipient');
const cs = await dcall({ recipient: 'crisis' });
assert(cs.status === 200 && String(cs.body.shlink).startsWith('shlink:/'), 'the delegate shares the crisis view; the kernel signs it with the holder key');
const cv = await call('/shik/handoff/verify', { shlink: cs.body.shlink });
assert(cv.body.ok === true && cv.body.log.some((s: any) => s.t === 'Shared by a delegate' && /Jordan's sister/.test(s.d)), 'the recipient verifies it and sees it was shared by a delegate under Jordan\'s authorization');
assert(cv.body.text === readFileSync(join(here, 'expected', 'crisis.txt'), 'utf8'), 'crisis view text equals the expected fixture');
assert(!/cognitive behavioral|behavioral activation|Mornings are hardest|Extended time on exams|10 am start/.test(cv.body.text), 'the crisis view excludes therapy notes, personal patterns and school or work supports');
const cvWrong = await call('/shik/handoff/verify', { shlink: cs.body.shlink, audience: 'employer' });
assert(cvWrong.body.ok === false, 'the crisis view opened as the employer is rejected');
const cblob = (await (await fetch(base + '/shik/handoff/relay/' + cs.body.id)).json()).blob as string;
const widened = await receive(history, cs.body.shlink, () => cblob, { tamper: (p) => { if (p.del) p.del.scope = 'care'; p.aud = 'care'; }, audience: 'care' });
assert(widened.ok === false && widened.log.at(-1)?.t === 'Signature invalid', 'a delegate widening the scope after signing is rejected');
const rv = await call('/shik/handoff/revoke', { delegateToken: dTok }, holder);
assert(rv.status === 200, 'holder revokes the authorization');
const after = await dcall({ recipient: 'crisis' });
assert(after.status === 403 && /revoked/.test(after.body.error), 'after revocation the delegate cannot share');
const short = await call('/shik/handoff/delegate', { delegate: "Jordan's sister", ttl: -60 }, holder);
const expTok = short.body.delegateToken as string;
const expired = await fetch(base + '/shik/handoff/crisis-share', { method: 'POST', headers: { 'content-type': 'application/json', 'x-shik-delegate': expTok }, body: '{}' });
assert(expired.status === 403, 'an expired authorization is refused');

const ev = store.get().events.map((e) => e.type);
assert(['handoff.share.refused','handoff.share','handoff.confirm','handoff.delegate','handoff.crisis.share','handoff.crisis.refused','handoff.revoke'].every((t) => ev.includes(t)), 'refusals, confirmation, the authorization, the crisis share and the revocation are all in the kernel history H');

server.stop();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
