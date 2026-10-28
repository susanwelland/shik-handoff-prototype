# Handoff validation record

Run on October 28, 2026 against the prototype in this folder and the SHIK
kernel service at commit 4dfd797 on branch claude/github-connection-4OGg0 of
susanwelland/shik-live (folder `shik-agent/`). Synthetic person throughout.
Real cryptography: ECDSA P-256 (ES256) and AES-GCM 256 from the Web Crypto
API, in the browser and in Node 22.

## 1. Kernel: signing, verification, rejection and the helper boundary

`npm run test:handoff` in `shik-agent/` builds the kernel and runs two
suites. The first exercises the policy layer directly; the second starts the
kernel's localhost server and drives it as a body would.

```
PASS care: all checks pass (Leakage check not applicable | Source traceability: 18 of 18 lines equal a source fact verbatim | Provenance: 7 clinician-sourced, 9 patient-reported, 2 marked unknown)
PASS care: rebuild is byte-identical
PASS teacher: all checks pass (Sensitive-detail leakage: 0 of 36 clinical terms found | Category allow-list: 0 lines outside Teacher or disability resource office's allow-list | Source traceability: 3 of 3 lines equal a source fact verbatim | Provenance: 0 clinician-sourced, 3 patient-reported, 0 marked unknown)
PASS teacher: rebuild is byte-identical
PASS employer: all checks pass (Sensitive-detail leakage: 0 of 36 clinical terms found | Category allow-list: 0 lines outside Employer's allow-list | Source traceability: 3 of 3 lines equal a source fact verbatim | Provenance: 0 clinician-sourced, 3 patient-reported, 0 marked unknown)
PASS employer: rebuild is byte-identical
PASS teacher view carries no diagnosis, medication, therapy or safety text
PASS forced diagnosis is refused at build, visibly
PASS refused fact is not in the output
PASS valid handoff verifies and the received text equals the signed text
PASS altered line in transit: signature invalid
PASS care-team view opened as employer: audience mismatch
PASS expired code: refused
PASS ciphertext altered at the relay: decryption failed
PASS audience relabeled in transit: signature invalid
ALL PASS

[kernel] self-hosted identity server on http://127.0.0.1:<port>
PASS kernel identity reports a held history
PASS a body can read the held history and the device key fingerprint
PASS helper can enter a fact; it is marked unconfirmed
PASS unconfirmed helper fact is refused from the view, with the reason
PASS helper cannot confirm a fact (403)
PASS helper cannot authorize a share (403, reason named)
PASS wrong unlock secret is refused
PASS holder unlock issues a session
PASS holder confirms the helper-entered fact
PASS kernel refuses the forced diagnosis and reports it
PASS kernel teacher view equals the expected fixture output
PASS holder signs and seals a view; kernel returns a handoff link
PASS intended recipient verifies and receives the exact signed text
PASS the care view opened as the employer is rejected
PASS altered content fails verification
PASS ciphertext altered at the relay fails to decrypt
PASS refusals, confirmation and the share are all in the kernel history H
ALL PASS
```

Forty-seven checks (thirty-three before the crisis delegation was added, fourteen after). What each proves:

- The intended recipient verifies and receives the exact signed text.
- Altered content fails verification: one changed line, a corrupted
  ciphertext blob, and an audience relabeled after signing are each rejected
  with a named cause. Nothing is shown.
- A view opened by the wrong audience is rejected. An expired code is refused.
- A helper can read the history and enter a fact, which stays unconfirmed and
  out of every view until the holder confirms it. A helper cannot confirm and
  cannot authorize a share. Each refusal is appended to the kernel's history.
- A diagnosis forced into the teacher view is refused at build, visibly.

## 1b. Crisis: a family delegate, authorized in advance

When the person arrives in crisis they cannot unlock their phone, and
providers depend on family. While well, Jordan signs a crisis authorization
with the device key: it names the delegate, allows only the crisis care-team
view (diagnosis, medication, safety plan, history, unknowns; no therapy
notes, personal patterns, or school and work supports), expires, and can be
revoked. The delegate cannot choose lines or send any other view. The
recipient verifies the authorization's signature, scope and expiry and sees
who shared it.

```
PASS without a holder authorization the family member cannot share anything, even in a crisis (403)
PASS a helper cannot grant itself a crisis authorization (403)
PASS holder, while well, signs a crisis authorization for the sister
PASS the delegate cannot share to the employer or any other recipient
PASS the delegate shares the crisis view; the kernel signs it with the holder key
PASS the recipient verifies it and sees it was shared by a delegate under Jordan's authorization
PASS crisis view text equals the expected fixture
PASS the crisis view excludes therapy notes, personal patterns and school or work supports
PASS the crisis view opened as the employer is rejected
PASS a delegate widening the scope after signing is rejected
PASS holder revokes the authorization
PASS after revocation the delegate cannot share
PASS an expired authorization is refused
PASS refusals, confirmation, the authorization, the crisis share and the revocation are all in the kernel history H
```

The page shows the same flow (`crisis.js`, all network blocked): without
authorization the sister's share is disabled; after Jordan authorizes, the
sister can share the crisis view only, cannot change lines, cannot share the
employer view; the recipient sees "Shared by a delegate"; an altered crisis
view is rejected; after Jordan revokes, the sister cannot share. Kernel and
page produce byte-identical text for all four views (crisis 1,555 bytes).

## 2. Kernel and page produce byte-identical views

`compare.js` builds the three views in the browser prototype and compares the
exact text with `test/expected/*.txt` written by the kernel suite.

```
care IDENTICAL 2962 bytes
crisis IDENTICAL 1555 bytes
teacher IDENTICAL 662 bytes
employer IDENTICAL 578 bytes
```

## 3. The page, end to end, at desktop and phone widths

`test2.js` opens the page in Chromium at 1440x900 and 390x844 and drives the
full flow: build, sign, scan, verify, then each adversary case.

```
careVerdict:    Verified: unaltered, signed by Jordan's device, for this recipient, in validity, checks passed.
tamper:         Rejected: Signature invalid. Nothing shown to the recipient.
wrongAud:       Rejected: Audience mismatch. Nothing shown to the recipient.
forceTeacher:   Refused at build: F01, category "Diagnosis" is not offered to Teacher or disability resource office. It is not in the output above.
teacherPreviewHasF01: false
teacherVerdict: Verified: unaltered, signed by Jordan's device, for this recipient, in validity, checks passed.
expired:        Rejected: Expired. Nothing shown to the recipient.
employerVerdict: Verified: unaltered, signed by Jordan's device, for this recipient, in validity, checks passed.
overflow: false (both widths); console errors: []
```

## 4. Offline, and the helper cannot share

`test3.js` blocks every network request, then: switches the device to the
helper, confirms the share button is disabled and the refusal is shown and
logged; switches back to Jordan, signs the teacher view, confirms a real QR
is drawn by the bundled library, scans and verifies, then alters a line and
confirms rejection.

```
blockedRequests: 1 (the web fonts)
helperButtonDisabled: true
helperNote: Refused: a helper can read the history and enter facts for Jordan to confirm, but cannot authorize a share. Jordan must unlock this device.
helperAudit: true
qrDrawn: true
verdict:  Verified: unaltered, signed by Jordan's device, for this recipient, in validity, checks passed.
tampered: Rejected: Signature invalid. Nothing shown to the recipient.
pageErrors: []
```

## What is not verified

- A run on Raspberry Pi hardware. The kernel service runs on Node 22, which
  is what the Pi body runs, but no Pi executed it today.
- That a clinician-sourced fact matches the clinic's original record. The
  signature proves the holder's device signed this exact text for this
  audience; it does not prove the content is true. Countersigned clinical
  sources are proposed.
- The relay and the recipient are simulated in the page and in the kernel's
  localhost server. No clinic, school or employer system is connected.
