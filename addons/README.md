# Addons

Optional features that are not part of the Swiish core. Every addon is
self-contained in its own folder and **stays inactive unless it is configured**,
so a default install behaves exactly like core Swiish.

| Addon | Purpose | Enabled by |
|-------|---------|------------|
| [`oidc`](oidc/README.md) | Single sign-on via OpenID Connect (Shibboleth, Keycloak, Entra ID, ...), optional automatic card per user filled from SSO attributes | `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` |
| [`card-limit`](card-limit/index.js) | Limits how many cards a user can own | `CARD_LIMIT_PER_USER` |
| [`bootstrap`](bootstrap/index.js) | Creates the organisation and manages its settings from a JSON file instead of the setup wizard | `BOOTSTRAP_FILE` |
| [`health`](health/index.js) | Health check endpoint for orchestrators and monitoring | `HEALTHCHECK_PATH` |
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
- `addons.onStartup()` runs once after the database migrations.
- `addons.isSetupManaged()` disables the first-run setup wizard when an addon
  (bootstrap) provisions the organisation.

An addon module exports `name`, `isEnabled(env)` and optionally
`registerRoutes(app, ctx)`, `beforeCardSave(args, ctx)`, `onStartup(ctx)` and
`managesSetup`; see `addons/index.js`.

## Bootstrap file

With `BOOTSTRAP_FILE=/app/config/bootstrap.json`, Swiish creates the
organisation on first start and writes the listed settings on **every** start.
The file is the source of truth for those settings; settings it does not list
stay editable in the UI. An invalid file stops the server at startup.

```json
{
  "organisation": { "name": "Hochschule München", "slug": "hm" },
  "settings": {
    "default_organisation": "Hochschule München",
    "theme_variant": "swiish",
    "theme_colors": [{ "name": "hm-rot", "hexBase": "#fc5555", "hexSecondary": "#a51e1e" }],
    "allow_theme_customisation": false
  }
}
```

Supported settings: `default_organisation`, `theme_variant` (`swiish`,
`minimal`), `theme_colors`, `allow_theme_customisation`,
`allow_image_customisation`, `allow_links_customisation`,
`allow_privacy_customisation`, `allow_send_details_customisation`.

The setup wizard is disabled. Owners sign in via SSO and get their role from
`OIDC_OWNER_EMAILS` or `OIDC_OWNER_CLAIMS` (oidc addon).

The OIDC addon needs two nullable columns on `users`
(`oidc_issuer`, `oidc_subject`), added by the regular migration
`migrations/20261001000000-add-oidc-identity.js`. They are unused when the addon
is disabled.
