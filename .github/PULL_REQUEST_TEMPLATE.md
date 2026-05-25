<!--
Thanks for contributing to ccpatch.

If this PR adds or modifies a patch, please walk through CONTRIBUTING.md
(the "Add a new patch" section and the PR checklist).
-->

## Summary

<!-- One or two sentences: what does this change and why? -->

## Type of change

- [ ] New patch
- [ ] Patch update (re-anchor / behavior change)
- [ ] Framework / runner change
- [ ] Documentation
- [ ] CI / tooling

## Patch checklist (if applicable)

- [ ] `phase` and `dependsOn` are correct
- [ ] `verify.present` AND `verify.absent` (or `count`) — no weak verifies on new patches
- [ ] `capabilities` honestly declares network / fs / env / exec / tools / telemetry
- [ ] Added to the appropriate section of `ccpatch.yml` (default off unless it's a core bug fix)
- [ ] Updated `THREAT_MODEL.md` with the per-patch row
- [ ] `make test-patches` passes
- [ ] Doctor reports `ok` on the locally installed Claude Code version

## Test plan

<!-- How did you verify this works? Commands, versions, expected output. -->

## Compatibility

- Claude Code version tested: `vX.Y.Z`
- Bundle sha256: `...`
