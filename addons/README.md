# Addons

Optional features that are not part of the Swiish core. Every addon is
self-contained in its own folder and **stays inactive unless it is configured**,
so a default install behaves exactly like core Swiish.

| Addon | Purpose | Enabled by |
|-------|---------|------------|
| [`oidc`](oidc/README.md) | Single sign-on via OpenID Connect (Shibboleth, Keycloak, Entra ID, ...), optional automatic card per user filled from SSO attributes | `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` |
| [`card-limit`](card-limit/index.js) | Limits how many cards a user can own | `CARD_LIMIT_PER_USER` |
| [`caddy`](caddy/README.md) | Reverse proxy with automatic HTTPS certificates (ACME / Let's Encrypt) | Docker Compose override file |

Active addons are listed at startup: `[ADDONS] Enabled: oidc`.

## Configuration with Docker Compose

`docker-compose.yml` only forwards the variables it lists. To use an addon,
pass its variables to the container too, for example:

```yaml
services:
  swiish:
    env_file: .env
```

## How addons hook into core

Core only knows about `addons/index.js`:

- `addons.init(ctx)` / `addons.registerRoutes(app)` in `server.js` mount the routes of active addons.
- `addons.beforeCardSave(...)` runs before `POST /api/cards/:slug` writes a card.
  An addon may adjust the card data or reject the save with an `AddonError`.

An addon module exports `name`, `isEnabled(env)` and optionally
`registerRoutes(app, ctx)` and `beforeCardSave(args, ctx)`; see
`addons/index.js`.

The OIDC addon needs two nullable columns on `users`
(`oidc_issuer`, `oidc_subject`), added by the regular migration
`migrations/20261001000000-add-oidc-identity.js`. They are unused when the addon
is disabled.
