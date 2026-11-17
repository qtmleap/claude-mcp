# Execution Profiles Implementation Plan

Spec: `docs/superpowers/specs/2026-11-17-execution-profiles-design.md`.

1. Preserve the primary dirty baseline and verify source/runtime drift. Implement
   in clean public-master worktree `project-contexts`, base `a5eeb33`; native
   read-only feasibility inspection is refreshed against these current files.
2. Obtain independent LocalGPT review of this spec/current actual files through
   its studio LocalMCP access. Resolve material issues without routine re-reviews.
3. Native implementer writes focused failing tests for registered contexts,
   remote execution lifecycle, path/env boundaries, and existing API compatibility.
4. Implement the minimum local/Docker execution abstraction, registry/config,
   read-only context tool, profile-aware job admission/evidence, and explicit
   unsupported remote resume. Preserve existing local sessions and job semantics.
5. Add opt-in deployment example, practical shared-client/profile documentation,
   and a non-generating verification path. Do not alter the running service.
6. Run tests, audit, targeted real process/container fixture checks, and applicable
   isolated image build. Main independently verifies final source fingerprint.
7. Produce the task-only delta against public-master base `a5eeb33`; get one
   independent read-only actual-delta review and fix material findings.
8. Commit the coherent owned changes on this clean task branch. Preserve the
   old dirty primary checkout; do not merge across its unrelated work or push.
   Report exact branch/commit/worktree and deployment state plainly.

Main owns coordination/prose/integration/verification. Implementation worker owns
code and tests. No simultaneous writers on the same source paths. Retain live
IDs, manifests, tests, and cleanup evidence under ignored task records.
