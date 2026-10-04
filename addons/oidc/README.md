# OpenID Connect (SSO) addon

Adds a **"Login with &lt;provider&gt;"** button using the OpenID Connect
Authorization Code flow with PKCE. After a successful login Swiish issues its
regular session cookie, so roles, permissions and the password login keep
working unchanged.

Optionally, every SSO user gets **one card that is created and maintained from
their SSO attributes**.

Tested against generic OpenID providers; written with the
**Shibboleth IdP OIDC OP plugin** in mind (attributes via UserInfo,
`client_secret_basic`, multi-valued attributes, no `email_verified`).

## Quick start

```env
OIDC_ISSUER_URL=https://idp.example.org
OIDC_CLIENT_ID=https://cards.example.org/swiish
OIDC_CLIENT_SECRET=...
OIDC_PROVIDER_NAME=Shibboleth
```

Register this redirect URI with the provider:
`<APP_URL>/api/auth/oidc/callback`

## How users are matched

On each login the local user is resolved in this order:

1. A user already linked to this identity (`iss` + `sub`).
2. A user whose email equals the SSO email. That user is then linked.
   Requires `email_verified=true` unless `OIDC_REQUIRE_VERIFIED_EMAIL=false`.
3. If `OIDC_AUTO_PROVISION=true`: a new user is created in the organisation with
   `OIDC_DEFAULT_ROLE`. Provisioned users cannot log in with a password.

Otherwise the login is rejected and the login page shows why.

Before that, `OIDC_REQUIRED_CLAIMS` is checked on **every** login, e.g.
`schac_home_organization=hm.edu` so only members of one institution can log
in through a shared federation broker.

## Roles from claims

After a login, users become **owner** if their email is in `OIDC_OWNER_EMAILS`
or any rule in `OIDC_OWNER_CLAIMS` matches (e.g.
`eduPersonEntitlement=urn:mace:hm.edu:swiish:owner`). With `OIDC_ROLE_SYNC=true`
owners who no longer match are demoted to member, except the last owner of the
organisation.

## SSO card

With `OIDC_CARD_AUTO_CREATE=true`:

- On the **first** SSO login a card is created. All fields in `OIDC_CARD_MAPPING`
  are filled from the user's claims. The URL slug is derived from the name
  (`max-mustermann`), or from `OIDC_CARD_SLUG_CLAIM` if set.
- Fields in `OIDC_CARD_LOCKED_FIELDS` are **owned by the identity provider**:
  - they are shown read-only in the editor,
  - the server ignores changes to them when the card is saved,
  - they are **refreshed on every SSO login**.
- All other mapped fields are only used as initial values. After that the user
  maintains them, together with images, links, theme and so on.
- If the user deletes the SSO card, it is created again on the next SSO login.
- Combine with `CARD_LIMIT_PER_USER=1` (card-limit addon) to allow exactly one
  card per user. Users who already own cards from before SSO can have their
  oldest card converted with `OIDC_CARD_ADOPT_EXISTING=true`.

Mappable card fields: `personal.firstName`, `personal.lastName`, `personal.title`,
`personal.company`, `personal.bio`, `personal.location`, `contact.email`,
`contact.phone`, `contact.website`, `social.linkedin`, `social.twitter`,
`social.instagram`, `social.github`.

`personal.company` is still overridden by the organisation name when the
organisation sets one, the same as for any other card.

Claims can be top-level names (`given_name`) or dotted paths
(`address.locality`). For multi-valued attributes the first value is used.

## Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_ISSUER_URL` | – | Issuer; must serve `/.well-known/openid-configuration`. Required. |
| `OIDC_CLIENT_ID` | – | Client ID. Required. |
| `OIDC_CLIENT_SECRET` | – | Client secret. Leave empty for a public client (PKCE only). |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` / `none` | `client_secret_basic`, `client_secret_post` or `none`. |
| `OIDC_REDIRECT_URI` | `<APP_URL>/api/auth/oidc/callback` | Override the callback URL. |
| `OIDC_SCOPES` | `openid email profile` | Requested scopes. Add `phone` etc. as needed. |
| `OIDC_PROVIDER_NAME` | `SSO` | Label of the login button. |
| `OIDC_FETCH_USERINFO` | `true` | Merge the UserInfo response into the ID token claims. |
| `OIDC_AUTH_PARAMS` | – | Extra authorization request parameters in query string form, e.g. `kc_idp_hint=hm` for a federation broker. Flow parameters cannot be overridden. |
| `OIDC_REQUIRED_CLAIMS` | – | `claim=value` pairs, comma-separated. Each listed claim must match one of its values. |
| `OIDC_OWNER_EMAILS` | – | Comma-separated emails that become owners on login. |
| `OIDC_OWNER_CLAIMS` | – | `claim=value` pairs; any match makes the user an owner. |
| `OIDC_ROLE_SYNC` | `false` | Demote owners who no longer match (never the last owner). |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | Require `email_verified` before linking or provisioning by email. |
| `OIDC_AUTO_PROVISION` | `false` | Create unknown SSO users. |
| `OIDC_DEFAULT_ROLE` | `member` | Role of provisioned users (`member` or `owner`). |
| `OIDC_ALLOWED_DOMAINS` | – | Comma-separated email domains allowed to log in via SSO. |
| `OIDC_CARD_AUTO_CREATE` | `false` | Create and maintain an SSO card per user. |
| `OIDC_CARD_MAPPING` | `personal.firstName=given_name,personal.lastName=family_name,contact.email=email,contact.phone=phone_number` | `field=claim` pairs. |
| `OIDC_CARD_LOCKED_FIELDS` | `personal.firstName,personal.lastName,contact.email` | Provider-owned fields (must be mapped). |
| `OIDC_CARD_SLUG_CLAIM` | – | Claim to build the card slug from, e.g. `preferred_username`. |
| `OIDC_CARD_ADOPT_EXISTING` | `false` | Turn the user's oldest existing card into the SSO card. |

Plain `http://` issuers are accepted outside `NODE_ENV=production` only.

## Shibboleth IdP

Requires Shibboleth IdP v4.1+ or v5 with the OIDC OP plugin installed. The
snippets below are an example; adapt them to your IdP version and conventions.

**1. Register Swiish as a relying party**, for example in a metadata file loaded
via `metadata-providers.xml`:

```xml
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
    xmlns:oidcmd="urn:mace:shibboleth:metadata:oidc:1.0"
    entityID="https://cards.example.org/swiish">
  <SPSSODescriptor protocolSupportEnumeration="http://openid.net/specs/openid-connect-core-1_0.html">
    <Extensions>
      <oidcmd:OAuthRPExtensions
          token_endpoint_auth_method="client_secret_basic"
          grant_types="authorization_code"
          response_types="code">
        <oidcmd:ClientSecret>CHANGE-ME</oidcmd:ClientSecret>
      </oidcmd:OAuthRPExtensions>
    </Extensions>
    <AssertionConsumerService
        Binding="https://tools.ietf.org/html/rfc6749#section-3.1.2"
        Location="https://cards.example.org/api/auth/oidc/callback" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>
```

**2. Enable the `OIDC.SSO` profile** for this relying party in
`relying-party.xml`. Do not enable `OIDC.Registration` for it.

**3. Release the attributes** you map. They need OIDC claim encoders in the
attribute registry, for example `given_name`, `family_name`, `email` and
`phone_number`. Add a rule to `attribute-filter.xml` that releases them to the
client ID. Custom attributes such as a job title can be released under any
claim name and mapped, e.g. `personal.title=title`.

**4. Configure Swiish:**

```env
OIDC_ISSUER_URL=https://idp.example.org
OIDC_CLIENT_ID=https://cards.example.org/swiish
OIDC_CLIENT_SECRET=CHANGE-ME
OIDC_PROVIDER_NAME=Shibboleth
OIDC_SCOPES=openid email profile phone
# Shibboleth does not release email_verified by default; the institution's IdP is authoritative
OIDC_REQUIRE_VERIFIED_EMAIL=false
OIDC_ALLOWED_DOMAINS=example.org
OIDC_AUTO_PROVISION=true
OIDC_CARD_AUTO_CREATE=true
OIDC_CARD_MAPPING=personal.firstName=given_name,personal.lastName=family_name,contact.email=email,contact.phone=phone_number,personal.title=title
OIDC_CARD_LOCKED_FIELDS=personal.firstName,personal.lastName,contact.email
CARD_LIMIT_PER_USER=1
```

Shibboleth issues pairwise `sub` values by default. That is fine: users are
linked by `iss` + `sub` after their first login.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /api/auth/oidc/config` | `{ enabled, providerName }` for the login page; 404 when the addon is off |
| `GET /api/auth/oidc/login` | Starts the login (redirects to the provider) |
| `GET /api/auth/oidc/callback` | Redirect URI; sets the session cookie and redirects to `/people` |

## Not included

- Single logout at the provider (logging out of Swiish ends the Swiish session only).
- Mapping roles from claims or groups.
- Profile pictures from the `picture` claim; users upload their own.
