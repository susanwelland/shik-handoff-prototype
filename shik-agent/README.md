# shik-agent: the Raspberry Pi body (`shik-pi-01`)

The on-device daemon that gives SHIK a **physical body** (M2). It embodies the
SHIK thesis directly:

- **Identity lives on hardware you own.** The Core Self Layer (memory, context,
  history, presence) is persisted locally to a flat file (`KernelStore`) and
  served over a localhost-only kernel server: the "SHIK as MCP server" seam.
- **Reasoning is outsourced through one standard interface.** The body bundles
  no model SDK; it calls a single mind endpoint (`SHIK_MIND_URL`). Pointing that
  at a different model is the *swap-the-model-in-one-line* guarantee. The body
  speaks the same cognition-identity interface as the browser body.
- **The body is swappable hardware.** The agent emits abstract intent
  (`light: thinking`); `hardware.ts` maps it to real actuators. Swapping the LED
  ring for an e-ink face changes only that file.

See [`../docs/HARDWARE_RPI.md`](../docs/HARDWARE_RPI.md) for the bill of
materials, wiring, and resilience/security design.

## Run it headless (no hardware, no Pi)

Runs on any machine with Node 22+. Mic is simulated from **stdin**, actuators
log to stdout.

```bash
cd shik-agent
SHIK_BODY=headless SHIK_STATE_PATH=./data/kernel.json npm run dev
# then type a sentence and press enter: SHIK perceives it as speech,
# the mind curates the kernel, and the body renders the resulting actions.
```

Point it at a running SHIK Live instance for real cognition:

```bash
SHIK_BODY=headless SHIK_MIND_URL=http://localhost:3000/api/cognition npm run dev
```

Power-cycle test (the portability thesis): stop the daemon and start it again ,
it re-binds the **same** identity with memory intact, and appends a new entry to
the presence history.

## Build

```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

## On a real Pi

1. Flash Raspberry Pi OS (64-bit), enable SSH.
2. `git clone` this repo to `/opt/shik-agent`, `npm run build`.
3. Provide `pi-body.ts` exporting `PiBody` (ReSpeaker LEDs, Pi Camera via
   libcamera, I2S mic/speaker, PIR/BH1750). It is loaded as an optional dynamic
   import: absent it, the daemon runs headless.
4. Install the unit: `sudo cp shik-agent.service /etc/systemd/system/` then
   `sudo systemctl enable --now shik-agent`.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SHIK_AGENT_ID` | `did:shik:pi-01` | Stable agent identifier (the SHIK `id`) |
| `SHIK_BODY_ID` | `shik-pi-01` | This body's id |
| `SHIK_BODY_NAME` | `the Pi on the shelf` | Friendly name SHIK uses for the body |
| `SHIK_STATE_PATH` | `./data/kernel.json` | Where identity is persisted |
| `SHIK_MIND_URL` | `http://localhost:3000/api/cognition` | The swappable mind endpoint |
| `SHIK_KERNEL_PORT` | `8137` | Localhost kernel server port |
| `SHIK_BODY` | _(auto)_ | `headless` forces the mock body |

## Handoff policy layer (working title)

The kernel can hold a person's history as facts with provenance and
reconstruct a recipient-specific view under the holder's policy: filter by
the holder's selection and the recipient's category allow-list, order, render
every line verbatim with its source id. No cognition engine is in the path.
The device key signs the exact text, audience and expiry; transport is
AES-GCM with a one-time key in the link; the kernel's relay holds ciphertext
only. Checks (sensitive-detail leakage, source traceability, provenance and
unknown counts) run at build and again at receipt, and any failure blocks the
view. Refusals are reported, never silent.

- `src/handoff.ts`: the mechanism (P applied to M, signed by K, logged to H).
- `src/kernel-server.ts`: `/shik/handoff/history`, `/view`, `/facts`,
  `/confirm`, `/unlock`, `/share`, `/relay/:id`, `/verify` on localhost, for a
  body (phone, browser, kiosk) that asks the kernel for a view. Reading and
  entering facts is open to any body on the device; a helper-entered fact is
  marked unconfirmed and never enters a view. Confirming a fact and
  authorizing a share require a holder session, issued only by the holder's
  unlock. A helper cannot obtain one.
- `fixtures/jordan.json`: one synthetic adult's history, 18 facts, three
  recipients (care team, teacher, employer).
- `test/handoff.test.ts`, `test/handoff-server.test.ts`: `npm run test:handoff`.
  Writes `test/expected/*.txt`; the browser prototype's views are compared
  against these for byte-identical output.

Demonstrated on Node 22 (what the Pi body runs). Not yet exercised on
Raspberry Pi hardware. Countersigned clinical sources, a USB-stick kernel (Pi
Zero in USB gadget mode) and sound-based pairing are proposed, not built.
Synthetic data only; not a medical device.
