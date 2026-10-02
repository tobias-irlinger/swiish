# Caddy addon (automatic HTTPS / ACME)

Swiish itself only serves plain HTTP. This optional Docker Compose override
puts [Caddy](https://caddyserver.com/) in front of it. Caddy obtains and renews
TLS certificates automatically via ACME (Let's Encrypt).

## Requirements

- A public DNS record for your domain pointing to the host.
- Ports 80 and 443 reachable from the internet (needed for the ACME challenge).

## Usage

Add to your `.env`:

```env
SWIISH_DOMAIN=cards.example.org
ACME_EMAIL=admin@example.org
```

Start Swiish together with Caddy from the repository root:

```bash
docker compose -f docker-compose.yml -f addons/caddy/docker-compose.caddy.yml up -d
```

The override:

- sets `APP_URL` and `ALLOWED_ORIGINS` to `https://$SWIISH_DOMAIN`,
- removes the direct `8095` port mapping so Swiish is only reachable through Caddy
  (`!reset` needs Docker Compose v2.24 or later),
- keeps certificates in the `caddy_data` volume.

To change the proxy setup, edit `addons/caddy/Caddyfile`.
