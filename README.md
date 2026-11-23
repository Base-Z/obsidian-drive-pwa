# PWA Projects

A small collection of installable, offline-capable Progressive Web Apps on a
shared theme, served as a static site. Two deployments run from this one tree:

| Deployment | URL | Notes |
|---|---|---|
| **GitHub Pages** (public, always-on) | `https://<username>.github.io/<repo>/` | Works anywhere; real TLS. |
| **Caddy on the LAN** (local dev) | `https://<lan-ip>:8443/` | Locally-trusted TLS for phone testing. |

There is no build step. The same files serve both, because every path is
relative — nothing hard-codes the mount point.

## Apps

| # | App | What |
|---|---|---|
| 0001 | PWA Proof of Concept | Offline demo — installs and runs with no network. |
| 0002 | Phone Sensor Diagnostics | Probes the phone's sensors, compares them to specs, plots readings. |
| 0003 | **Obsidian Drive** | Cloud-first Obsidian emulator: reads and edits Markdown notes directly in Google Drive, with check-out locking. Runs in a bundled **sandbox** vault until a Google OAuth client id is configured. |
| 0004 | **TubeDigest** | Gemini-generated timestamped summaries of new videos from your YouTube subscriptions. Exported from Google AI Studio. **Has a build step** — source lives in `../0004-tubedigest/`, which builds into `0004/`. |

## Layout

```
/                 landing menu (project 0000)
/shared/          shared stylesheet + status bar used by every app
/0001/ /0002/ /0003/
                  one directory per app: index.html, manifest.webmanifest, sw.js, icons/
```

Each app registers its own service worker from its own directory, so its
cache scope is that directory alone.

## Configuration (app 0003)

`0003/js/config.js` holds the Google OAuth values. The **Client ID is not a
secret** — it is a public identifier and is safe to commit:

```js
clientId: '<your-id>.apps.googleusercontent.com',
scopes:   'https://www.googleapis.com/auth/drive',
```

The Google Cloud OAuth client must have the site origin registered as an
**Authorised JavaScript origin** — bare origin, no path, no trailing slash
(e.g. `https://<username>.github.io`). Google does **not** accept raw IP
addresses, which is why this site is hosted on GitHub Pages rather than only
on the LAN.

No client secret, key or token is ever stored in this repository.

## Configuration (app 0004)

`0004/` is **generated output**, not source. Its source is `../0004-tubedigest/` (Vite + React +
Firebase Auth + an Express/Gemini backend); `npm run build` there writes into `0004/`. Do not edit
`0004/` by hand — edits are lost on the next build.

TubeDigest needs its backend for the summarise features. It runs as a systemd --user service
(`tubedigest.service`) on `127.0.0.1:3000`, and the LAN origin reaches it through the Caddy
`handle /api/*` reverse proxy. The **Gemini key lives only in `../0004-tubedigest/.env.local`**,
which is gitignored — it is never in this repository and never in the built output.

Google sign-in on GitHub Pages works because `base-z.github.io` is on the Firebase project's
authorised-domains list. A raw LAN IP can never be an authorised Google origin, so sign-in is
unavailable from `https://<lan-ip>:8443` by design.
