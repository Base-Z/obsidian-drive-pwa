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
