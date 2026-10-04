# Tenant provisioning

Tooling for running Swiish as a shared service: **one Swiish instance per
institution**, all configured from Git.

> This folder is operator tooling, not part of the Swiish application. It is
> meant to move to a separate infrastructure repository and is not included
> in the container image.

## Files

| Path | Purpose |
|------|---------|
| `platform.yaml` | Settings shared by all tenants: base domain, image, federation broker, SMTP, defaults |
| `tenants/<id>.yaml` | One manifest per institution |
| `schema/*.schema.json` | JSON Schemas for both (usable for editor autocompletion) |
| `bin/swiish-tenants.js` | `validate` and `render` commands |

All values in `platform.yaml` and `tenants/` are **examples**.

## Usage

```bash
cd provisioning
npm install
npm run validate          # check all manifests (use in CI on every merge request)
npm run render            # write out/<id>/... for every tenant
npm test
```

`render` writes per tenant:

| File | Content |
|------|---------|
| `out/<id>/swiish.env` | Non-secret environment variables (Docker `env_file` / Kubernetes ConfigMap format) |
| `out/<id>/bootstrap.json` | Organisation and branding for the bootstrap addon, mounted at `/app/config/bootstrap.json` |
| `out/<id>/tenant.json` | Facts for deployment and broker automation: host, OIDC client ID, redirect URI, IdP entityID, required secrets |
| `out/tenants.json` | All tenants, e.g. as input for creating broker clients |

The `out/` directory is replaced on every render, so a deleted manifest also
removes its output. `render` refuses to write into a non-empty directory it did
not create.

## Onboarding an institution

1. Add `tenants/<id>.yaml` (copy an example). The `id` becomes the subdomain,
   organisation slug and OIDC client ID suffix. **Do not change it later.**
2. The institution releases the required attributes to the broker's SP in
   DFN-AAI: at least `schacHomeOrganization`, `mail`, `givenName`, `sn`.
3. Open a merge request. CI runs `validate`.
4. After merging, the pipeline renders the configuration, creates the broker
   client and secrets, and deploys the instance (next stage, not yet built).

## What the manifest controls

- **Who may log in:** `identity.homeOrganisations` → `OIDC_REQUIRED_CLAIMS`
  on the home organisation claim. A home organisation can belong to only one
  tenant.
- **Which IdP the broker uses:** `broker.idpHint` in `platform.yaml` →
  `OIDC_AUTH_PARAMS`.
- **Owners:** `identity.owners.emails` / `.entitlements` → `OIDC_OWNER_EMAILS` /
  `OIDC_OWNER_CLAIMS`.
- **Cards:** auto-creation, limit, claim mapping and locked fields. A tenant's
  `cards.mapping` replaces the platform default mapping as a whole.
- **Branding:** organisation name on cards, theme variant, colours, and which
  parts users may customise.

## Secrets

Secrets are never part of manifests or rendered files. `tenant.json` lists
what each instance needs: `JWT_SECRET` (random, generate per tenant),
`OIDC_CLIENT_SECRET` (from the broker), and `SMTP_USER` / `SMTP_PASSWORD`
when SMTP is configured.

## Broker note

`client_secret_basic` sends the client ID URL-encoded (RFC 6749 §2.3.1), so
`swiish-thi` is sent as `swiish%2Dthi`. Compliant brokers decode it. Check this
once with your broker, or set `broker.tokenAuthMethod: client_secret_post`.
