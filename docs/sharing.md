# Live shared playground (issue #30)

Two members (father + son) in one playground at the same time: same files,
same chat, same preview, either one driving the agent or editing. This note
records the model, the auth boundary, and what v1 deliberately leaves out.

## Model

- One playground is one Durable Object. Members join by invite code (12
  chars from `crypto.getRandomValues`); the join maps each member's own
  cookie onto the same shared DO and mints a per-browser `ab_member`
  credential. The owner's cookie is never shared — joining never grants the
  owner's stored token.
- Membership is granted by an invite-minted per-browser `ab_member`
  credential; each member then links their own GitHub account (OAuth
  callback stores the token under their member id), and the GitHub user id
  rides along as linked identity metadata for attribution.
- Creating the first invite associates the owner's existing stored token
  with their new owner member slot and sets their `ab_member` cookie, so
  the owner keeps working without re-login (otherwise the first invite
  would lock them out of their own playground).
- The owner cannot leave: they are the only role that may invite, so
  removal is refused instead of stranding an ownerless playground.

## Auth: caller-has-access, not object-has-token

- Solo sessions keep the old gate (`requireLogin`: the DO holds a token).
- Shared playgrounds require caller-has-access (`requireAccess` in
  `src/index.ts`): the request must carry the member's own `ab_member`
  credential, and the token returned is that member's own. A member token
  without user metadata (or vice versa) fails closed to re-login — never
  an owner fallback. An unreadable share state rejects instead of failing
  open into owner-token authentication.
- Git pushes are attributed to the actor: `commitPush`, `pushCurrentToRemote`,
  `pullFromRemote`, `cloneFromGitHub`, and `gitRun` take an `as?: { token,
  user }` override; on shared playgrounds the edge always passes the
  member's own credentials. Agent turns resolve the sending member's
  credentials under the turn mutex (`activeActor`) and clear them when the
  turn settles — agent git never falls back to the stored owner token.
  There is deliberately no fallback to the owner's token anywhere — a
  member without write access gets the collaborator-access error from
  `assertPushAccess` (and the per-actor `diagnosePushFailure`), not an
  owner-token push.
- The sandboxed app iframe cannot present cookies or `ab_member`, and the
  invite URL discloses the playground id — so a bare `?sid=` no longer
  suffices. The cookie-authenticated, member-gated parent mints a
  short-lived preview capability (`POST /api/share/preview`, 1h, capped)
  per mount; the shim presents it on every state/mutate call, and `/api`,
  `/api/app-state`, and `/api/app-mutate` all verify it.
- BYOK stays per-browser: the key travels per chat request and lives only in
  the turn-scoped holder (serialized by the turn mutex), so one member's key
  is never exposed to the other.
- `ab_member` is `HttpOnly` (page scripts never need it) with `Secure` on
  https; `ab_session` stays script-readable because the parent needs it for
  the iframe URL.

## Concurrency (v1, simple)

- The existing serialization is kept: one agent turn at a time (`turnTail`),
  one git op at a time (`gitQueue`). No multi-cursor OT/CRDT for v1.
- It is made visible: the turn tracks `{ active, actor, startedAt, queued }`
  (`getTurnStatus`), the Sharing panel shows whose turn runs and how many
  wait, 409s name the running actor (`turnBusyError`), and the chat shows a
  "queued behind X's turn…" hint when the stream does not open promptly.
- Whole-FileMap saves carry `baseVersion` (`FILES_VERSION`, exposed as
  `version` by `/api/state`, `/api/files`, `/api/file`). The compare writes
  atomically inside one serialized DO operation (`saveFilesIfVersion`,
  `saveFileIfVersion`) — edge check-then-set would still race concurrent
  teammate saves. Shared playgrounds require the version; solo saves keep
  the opt-in guard for older clients. A mismatch 409s with the server
  files, which the client adopts and prompts reload — last-writer-wins with
  a reload prompt, never a silent overwrite.

## Shared state

- Chat transcript attributes each user turn to its author (`ChatMessage.author`),
  including across the post-turn Pi transcript synchronization
  (`resolveRebuiltAuthor`).
- The live invite code is owner-only: member-visible projections omit it
  (members invite nobody); the owner receives it in status and invite
  responses.
- Snapshots record who checkpointed (`by`); audit records who ran which
  turn, pushed, pulled, snapshotted, resumed, joined, or left. Joins are
  recorded under an anonymous member actor until OAuth links an identity,
  and `getShareStatus` exposes only the newest 20 entries of the capped
  100.
- The R2 image namespace is the DO id name — and a shared playground is one
  DO, so both members resolve the same prefix. The per-playground namespace
  falls out of the shared-DO design with no code change.

## Safe paths that are NOT sharing

- `?sid=` app URLs still address the owning object and stay token-gated;
  they are never presented as share links.
- A deployed app URL and a GitHub repo remain the no-join-needed ways to
  share output: the deploy is a separate app, not a session or co-edit
  link (the capsule itself may accept writes to its own app data), and
  the repo is co-edit via git.

## Acceptance check

- [x] Two browsers, two GitHub logins, one playground: both see live
      files/chat/preview (same DO; author labels; shared image namespace).
- [x] One agent turn at a time; the other sees queued/waiting (turn status,
      named 409s, queued chat hint) — no lost turns or clobbered FileMaps.
- [x] Teammate edits surface reload instead of vanishing (version guard).
- [x] Push attributed to the actor; no write access → collaborator error.
- [x] No share path copies the owner's cookie (invite mints credentials).

## Non-goals

Offline editing, per-file ACLs, and multi-cursor co-editing in one editor
for v1.
