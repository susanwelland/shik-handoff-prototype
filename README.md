# SHIK Handoff prototype

Kernel service and validation record for the Handoff prototype: a person-held health-context history that signs and seals a view for each recipient, and a recipient that verifies it or rejects it with a named cause.

All data is synthetic (one made-up person, Jordan Sample). No real clinic, school or employer system is involved. No Raspberry Pi hardware run has been done.

- `shik-agent/` is the kernel service, the Handoff code and the tests. Run `npm run test:handoff` in that folder (Node 22 or later).
- `shik-agent/HANDOFF_TESTS.md` is the validation record. Its header names the run commit in the original private repo.

Provenance: copied file for file from the private repository susanwelland/shik-live, folder `shik-agent/`, at commit 571b44f. This repository has a new history, so that commit hash does not exist here. The `../docs/` links inside `shik-agent/README.md` point to files that were not copied.
