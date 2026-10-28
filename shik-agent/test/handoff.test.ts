// Kernel-side tests for the Handoff policy layer. Run: npm run test:handoff
// Writes the three views to test/expected/*.txt so the browser prototype can be
// checked for byte-identical output (see scripts/compare-browser.md).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildView, renderText, runChecks, generateHolderKey, signView, seal, receive, type HeldHistory } from '../dist/handoff.js';

const here = dirname(fileURLToPath(import.meta.url));
const h: HeldHistory = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'jordan.json'), 'utf8'));
let failures = 0;
const assert = (cond: boolean, msg: string) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

const allOffered = (r: string) => h.facts.filter((f) => h.policy[r].offered.includes(f.cat)).map((f) => f.id);
mkdirSync(join(here, 'expected'), { recursive: true });

// 1. Three views from one history, deterministic and verbatim
for (const r of ['care', 'crisis', 'teacher', 'employer']) {
  const v = buildView(h, r, allOffered(r)); const text = renderText(h, v);
  writeFileSync(join(here, 'expected', r + '.txt'), text);
  const checks = runChecks(h, v, text);
  assert(checks.every((c) => c.ok), `${r}: all checks pass (${checks.map((c) => c.t).join(' | ')})`);
  assert(renderText(h, buildView(h, r, allOffered(r))) === text, `${r}: rebuild is byte-identical`);
}
const teacher = renderText(h, buildView(h, 'teacher', allOffered('teacher')));
assert(!/F41|F32|sertraline|hydroxyzine|therapy|safety|988/i.test(teacher), 'teacher view carries no diagnosis, medication, therapy or safety text');

// 2. Policy refusal at build: a diagnosis forced into the teacher view
const forced = buildView(h, 'teacher', [...allOffered('teacher'), 'F01']);
assert(forced.refused.length === 1 && forced.refused[0].id === 'F01', 'forced diagnosis is refused at build, visibly');
assert(!forced.lines.some((l) => l.id === 'F01'), 'refused fact is not in the output');

// 3. Sign, seal, receive
const key = await generateHolderKey();
const relay = new Map<string, string>();
const v = buildView(h, 'care', allOffered('care')); const text = renderText(h, v);
const jws = await signView(h, key, v, text, 86400);
const sealed = await seal(jws, 'View for ' + h.policy.care.label, Math.floor(Date.now() / 1000) + 86400);
relay.set(sealed.id, sealed.blob);
const get = (id: string) => relay.get(id) ?? null;
const ok = await receive(h, sealed.shlink, get);
assert(ok.ok && ok.payload?.text === text, 'valid handoff verifies and the received text equals the signed text');

// 4. Four failures
const tampered = await receive(h, sealed.shlink, get, { tamper: (p) => { p.lines[0].text += ' (and two other things).'; } });
assert(!tampered.ok && tampered.log.at(-1)?.t === 'Signature invalid', 'altered line in transit: signature invalid');
const wrongAud = await receive(h, sealed.shlink, get, { audience: 'employer' });
assert(!wrongAud.ok && wrongAud.log.at(-1)?.t === 'Audience mismatch', 'care-team view opened as employer: audience mismatch');
const expiredJws = await signView(h, key, v, text, -60);
const expSealed = await seal(expiredJws, 'x', 0); relay.set(expSealed.id, expSealed.blob);
const expired = await receive(h, expSealed.shlink, get);
assert(!expired.ok && expired.log.at(-1)?.t === 'Expired', 'expired code: refused');
const badBlob = sealed.blob.slice(0, -4) + (sealed.blob.endsWith('AAAA') ? 'BBBB' : 'AAAA');
relay.set('bad', badBlob);
const badLink = sealed.shlink; // same key, different relay reference is not reachable through the link, so alter the stored blob instead
relay.set(sealed.id, badBlob);
const corrupt = await receive(h, badLink, get);
assert(!corrupt.ok && corrupt.log.at(-1)?.t === 'Decryption failed', 'ciphertext altered at the relay: decryption failed');
relay.set(sealed.id, sealed.blob);

// 5. A view relabeled for another audience after signing fails even before the policy check
const relabeled = await receive(h, sealed.shlink, get, { tamper: (p) => { p.aud = 'employer'; }, audience: 'employer' });
assert(!relabeled.ok && relabeled.log.at(-1)?.t === 'Signature invalid', 'audience relabeled in transit: signature invalid');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
