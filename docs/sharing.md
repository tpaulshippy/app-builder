# Live shared playground (issue #30)

Two members (father + son) in one playground at the same time: same files,
same chat, same preview, either one driving the agent or editing. This note
records the model, the auth boundary, and what v1 deliberately leaves out.

## Model

- One playground is one Durable Object. Members join by invite code; the
  join maps each member's own cookie onto the same shared DO and mints a
  per-browser `ab_member` credential. The owner's cookie is never shared —
  joining never grants the owner's stored token.
- Membership is by GitHub user id (stable, not login): each member links
  their own GitHub account after joining (OAuth callback stores the token
  under their member id).

## Auth: caller-has-access, not object-has-token

- Solo sessions keep the old gate (`requireLogin`: the DO holds a token).
- Shared playgrounds require caller-has-access (`requireAccess` in
  `src/index.ts`): the request must carry the member's own `ab_member`
  credential, and the token returned is that member's own.
- Git pushes are attributed to the actor: `commitPush`, `pushCurrentToRemote`,
  `pullFromRemote`, `cloneFromGitHub`, and `gitRun` take an `as?: { token,
  user }` override; on shared playgrounds the edge always passes the
  member's own credentials. There is deliberately no fallback to the owner's
  token — a member without write access gets the collaborator-access error
  from `assertPushAccess` (and the per-actor `diagnosePushFailure`), not an
  owner-token push.
- BYOK stays per-browser: the key travels per chat request and lives only in
  the turn-scoped holder (serialized by the turn mutex), so one member's key
  is never exposed to the other.

## Concurrency (v1, simple)

- The existing serialization is kept: one agent turn at a time (`turnTail`),
  one git op at a time (`gitQueue`). No multi-cursor OT/CRDT for v1.
- It is made visible: the turn tracks `{ active, actor, startedAt, queued }`
  (`getTurnStatus`), the Sharing panel shows whose turn runs and how many
  wait, 409s name the running actor (`turnBusyError`), and the chat shows a
  "queued behind X's turn…" hint when the stream does not open promptly.
- Whole-FileMap saves carry `baseVersion` (`FILES_VERSION`, exposed as
  `version` by `/api/state`, `/api/files`, `/api/file`). A mismatch 409s
  with the server files, which the client adopts and prompts reload —
  last-writer-wins with a reload prompt, never a silent overwrite.

## Shared state

- Chat transcript attributes each user turn to its author (`ChatMessage.author`).
- Snapshots record who checkpointed (`by`); audit records who ran which
  turn, pushed, pulled, snapshotted, resumed, joined, or left (capped at 100,
  tail exposed by `getShareStatus`).
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
