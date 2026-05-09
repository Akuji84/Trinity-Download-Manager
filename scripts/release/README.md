# Trinity updater release scaffolding

This folder is safe to keep in the public repo because it contains no server credentials, no SSH keys, and no updater signing keys.

## Secret boundaries

Keep these outside the repository:

- updater private signing key
- updater private key password
- SSH private key for the update server
- server hostname if you do not want it public
- deployment user and deployment path if you do not want them public

Use `.env.release.example` as the shape for your local environment. Create your own untracked `.env.release.local` or set the variables in your shell before running any release step.

## Required local environment variables

- `TRINITY_UPDATE_HOST`
- `TRINITY_UPDATE_USER`
- `TRINITY_UPDATE_PATH`
- `TRINITY_SSH_KEY_PATH`
- `TRINITY_UPDATER_PRIVATE_KEY_PATH`
- `TRINITY_UPDATER_PRIVATE_KEY_PASSWORD`
- `TRINITY_UPDATE_BASE_URL`

## Current scope

The app is now wired for in-app updates, but the real update host still stays outside git.

What is already live:

- signed updater artifacts from `npm run tauri build`
- in-app update check / install UI
- build-time endpoint selection through `TRINITY_UPDATE_BASE_URL`

What still depends on your local release environment:

- the real public update URL
- the private signing key
- server deployment access
- publishing the manifest and artifacts

## Current update host

The updater host is now exposed publicly at:

- `https://updates.akuji.org`

Server-side shape:

- Cloudflare Tunnel ingress forwards `updates.akuji.org` to `http://127.0.0.1:8092`
- the local static artifact root is `/home/phoenyx/trinity-updates/releases`
- `trinity-updates.service` serves that directory

That service and tunnel config live on the Ubuntu server only. No tunnel credentials or deploy secrets belong in this repo.
