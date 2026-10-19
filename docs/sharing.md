# Sharing threat model (issue #30)

There is no shared live session in v1. This note records what a share link
would grant, what the safe primitives are instead, and what a future
remix-to-own design must guarantee.

## What a session id grants today

- One session id selects one Durable Object (`resolveSession`,
  `src/index.ts`). Auth is only `requireLogin` — "does that object hold a
  GitHub token".
- Sharing `ab_session` (cookie) or `?sid=` therefore shares **everything**:
  files, chat history and snapshots, git history, and **push-as-owner**
  through the stored OAuth token.
- The preview/app APIs are the same boundary: `?sid=` plus
  object-holds-token is enough (`/api/app-state`, `/api/app-mutate`,
  `/api/app`).

Treat `ab_session` / `?sid=` URLs as **passwords**. Never present copying
them as "sharing". The Settings tab says this in-product; this file is the
design record.

## Safe sharing primitives (use these)

- **View:** deploy the capsule (`deploy` in the shell) and share the
  `*.lakebed.app` URL. Viewers get the running app, never the session.
- **Co-edit:** push to a GitHub repo and collaborate there
  (Settings → GitHub → Create/Open, then Commit + push / Pull). Merges
  happen in git, after graduation — never as concurrent writes to one DO.

## Explicitly not built

No multi-cursor live co-edit in one Durable Object for v1:

- One `AppSession` has one turn mutex, one serialized git queue, and one
  QuickJS/bash FS. Concurrent edits break the `turnActive` /
  `FILES_VERSION` guards and the agent turn lock.
- So there is no "join my playground" mode, no shared QuickJS/bash, and no
  second writer to another session's object.

## If a share path is ever built: remix-to-own

The candidate from the issue, recorded here as constraints (not
implemented):

- Publish a snapshot (files + metadata, never tokens) under a team
  registry; consume = **remix into the recipient's own playground object**.
- Recipient writes land in their own Durable Object. No cross-DO writes.
- Requires: membership checks beyond `requireLogin`, image refs moved off
  the per-session R2 namespace, and an audit trail (who published /
  remixed what, when).
- A share link must state exactly what it grants: read-only view, remix a
  copy, and **never** push-as-owner.

## Acceptance check

- [x] This file documents what a share link grants.
- [x] The product offers no "share session / copy share link" affordance;
      the only sharing guidance points at deploy URLs (view) and GitHub
      repos (co-edit).
- [x] No cross-DO writes exist: every API addresses only the caller's own
      session object (`resolveSession`) or the explicitly passed `sid`
      object gated by that object's token — there is no endpoint that
      writes into another session.
