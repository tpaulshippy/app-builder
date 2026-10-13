# GitHub setup

Saving to GitHub needs an OAuth App so users can log in without pasting
tokens. Git operations themselves run server-side in the session's Durable
Object with [just-git](https://github.com/blindmansion/just-git) (pure
TypeScript, Smart HTTP to github.com). Tokens stay in DO storage; the browser
only ever sees the login redirect.

## 1. Create the OAuth App

GitHub Settings → Developer settings → OAuth Apps → New:

- Homepage URL: `https://<your-worker>.workers.dev`
- Authorization callback URL: `https://<your-worker>.workers.dev/api/github/callback`

For local dev (`wrangler dev`), create a second app with callback
`http://localhost:8787/api/github/callback` — GitHub requires an exact match.

## 2. Set Worker secrets

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Locally, the same keys work in `.dev.vars` (gitignored).

## 3. Flow

1. User opens the **GitHub** tab → **Log in with GitHub**.
2. Worker redirects to github.com with `state` = session id.
3. GitHub redirects to `/api/github/callback?code&state`; the Worker exchanges
   the code for a token and stores it (plus the user) in that session's DO,
   then sets the session cookie to `state` so the browser lands back on the
   same session.
4. **Open repo** (`owner/repo`) clones via just-git into the session's files;
   **Create + push** creates the repo via the GitHub API then pushes the
   current files as the first commit; **Commit + push** / **Pull** /
   **Status** / **Log** / **Run git** work from the panel, and `git_status`,
   `git_log`, `git` tools expose the same to the agent.

## Limits (MVP)

- Working tree is text-only (`FileMap` is `path → string`). Binary, oversized
  (>1 MB), and unsafe-path files are skipped on clone/pull and reported in the
  panel — but commit, pull, status, and Run git re-materialize them from the
  git object store first, so status stays clean and commits leave them
  untouched. They just are not editable here. File deletion goes through
  `git rm` in the panel's Run git box.
- The git database (`/repo/.git`) is snapshotted to DO SQLite after every op;
  very large histories will be slow. Shallow or small repos work best.
- History rewrites are refused server-side (`reset`, `rebase`, force pushes).
- OAuth scope is `repo workflow` (`workflow` covers pushes touching
  `.github/workflows/*`, which GitHub 403s under `repo` alone). Revoke from GitHub Settings to disconnect; **Log out**
  clears the session copy including the repo link and stored history.
- If you logged in before the `workflow` scope was added, Log out/in again to grant it.
- Clone reads public repos without write access, so a push can still 403 after a
  good clone: the push error names the fix (collaborator access, fork, or reconnect).
