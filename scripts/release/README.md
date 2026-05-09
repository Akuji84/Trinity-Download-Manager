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

This is only the first security step:

- local secret layout
- repo ignore rules
- safe deploy script shape

It does **not** yet wire the app to the updater endpoint. That should happen only after the signing key and deployment path are established and kept out of git.
