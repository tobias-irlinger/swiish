// OpenID Connect (SSO) addon.
//
// Adds "Login with <provider>" using the Authorization Code flow with PKCE.
// A successful login issues the regular Swiish authToken cookie, so the rest of
// the app does not need to know how the user signed in.
// Optionally creates and maintains a card per user from the provider's claims
// (see card-sync.js). Enabled when OIDC_ISSUER_URL and OIDC_CLIENT_ID are set.

const crypto = require('crypto');
const { load } = require('./config');
const { syncCardOnLogin, enforceLockedFields, readClaim } = require('./card-sync');

const FLOW_COOKIE = 'oidcFlow';
const FLOW_COOKIE_PATH = '/api/auth/oidc';

let config = null;

// openid-client v6 is ESM-only, so it is loaded via dynamic import.
// Discovery runs lazily and is cached; a failed discovery is retried on the next login.
let providerPromise = null;
function getProvider(ctx) {
  if (!providerPromise) {
    providerPromise = (async () => {
      const client = await import('openid-client');
      const issuerUrl = new URL(config.issuerUrl);
      const clientAuth = {
        client_secret_basic: () => client.ClientSecretBasic(config.clientSecret),
        client_secret_post: () => client.ClientSecretPost(config.clientSecret),
        none: () => client.None()
      }[config.tokenAuthMethod];
      if (!clientAuth) {
        throw new Error(`Unsupported OIDC_TOKEN_AUTH_METHOD "${config.tokenAuthMethod}"`);
      }
      // Plain HTTP issuers (e.g. a local test IdP) are only allowed outside production
      const allowInsecure = issuerUrl.protocol === 'http:' && ctx.NODE_ENV !== 'production';
      const oidcConfig = await client.discovery(
        issuerUrl,
        config.clientId,
        undefined,
        clientAuth(),
        allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined
      );
      return { client, oidcConfig };
    })().catch(err => {
      providerPromise = null;
      throw err;
    });
  }
  return providerPromise;
}

// All values of a claim as strings (top-level name or dotted path; arrays for multi-valued attributes)
function claimValues(claims, name) {
  let value = name in claims ? claims[name] : name.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), claims);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) value = [value];
  return value.filter(v => v !== null && typeof v !== 'object').map(v => String(v).trim());
}

// True when every claim in rules has at least one of its expected values
function matchesAllRules(claims, rules) {
  return Object.entries(rules).every(([claim, expected]) => claimValues(claims, claim).some(v => expected.includes(v)));
}

// True when any single claim rule matches
function matchesAnyRule(claims, rules) {
  return Object.entries(rules).some(([claim, expected]) => claimValues(claims, claim).some(v => expected.includes(v)));
}

// Promotes users matching OIDC_OWNER_EMAILS / OIDC_OWNER_CLAIMS; with OIDC_ROLE_SYNC also demotes
async function syncRole(user, claims, ctx) {
  const email = (readClaim(claims, 'email') || user.email || '').toLowerCase();
  const isOwner = config.ownerEmails.includes(email) || matchesAnyRule(claims, config.ownerClaims);
  let role = user.role;
  if (isOwner) {
    role = 'owner';
  } else if (config.roleSync && user.role === 'owner') {
    const owners = await ctx.dbGet("SELECT COUNT(*) AS count FROM users WHERE organisation_id = ? AND role = 'owner'", [user.organisation_id]);
    if (owners.count > 1) {
      role = 'member';
    } else {
      ctx.log('[OIDC] Not demoting the last owner of the organisation', { userId: user.id });
    }
  }
  if (role !== user.role) {
    await ctx.dbRun('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, user.id]);
    await ctx.logAudit('user_role_changed', 'user', user.id, { from: user.role, to: role, source: 'oidc' }, user.id, user.organisation_id).catch(() => {});
    ctx.log('[OIDC] Role updated from claims', { userId: user.id, role });
  }
  return { ...user, role };
}

function redirectWithError(res, code) {
  res.redirect(`/login?oidc_error=${encodeURIComponent(code)}`);
}

// Resolve the local user for an OIDC identity: existing link, then email match, then optional provisioning
async function findOrCreateUser(issuer, claims, ctx) {
  const subject = claims.sub;
  const email = (readClaim(claims, 'email') || '').toLowerCase() || null;
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

  if (email && config.allowedDomains.length > 0) {
    const domain = email.split('@').pop();
    if (!config.allowedDomains.includes(domain)) {
      return { error: 'domain_not_allowed' };
    }
  }

  const linked = await ctx.dbGet(
    'SELECT id, email, organisation_id, role FROM users WHERE oidc_issuer = ? AND oidc_subject = ?',
    [issuer, subject]
  );
  if (linked) {
    return { user: linked };
  }

  if (!email) {
    return { error: 'email_missing' };
  }
  if (config.requireVerifiedEmail && !emailVerified) {
    return { error: 'email_not_verified' };
  }

  const existing = await ctx.dbGet(
    'SELECT id, email, organisation_id, role, oidc_subject FROM users WHERE email = ?',
    [email]
  );
  if (existing) {
    if (existing.oidc_subject) {
      // Account is already bound to a different external identity
      return { error: 'account_conflict' };
    }
    await ctx.dbRun(
      'UPDATE users SET oidc_issuer = ?, oidc_subject = ?, email_verified = CASE WHEN ? THEN 1 ELSE email_verified END, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [issuer, subject, emailVerified ? 1 : 0, existing.id]
    );
    await ctx.logAudit('oidc_identity_linked', 'user', existing.id, { email, issuer }, existing.id, existing.organisation_id).catch(() => {});
    return { user: existing };
  }

  if (!config.autoProvision) {
    return { error: 'not_registered' };
  }

  // Swiish runs a single organisation per instance; provisioned users join it
  const org = await ctx.dbGet('SELECT id FROM organisations ORDER BY created_at ASC LIMIT 1', []);
  if (!org) {
    return { error: 'setup_required' };
  }

  const userId = crypto.randomUUID();
  // password_hash is NOT NULL; store a hash of random bytes so password login is impossible
  const unusablePasswordHash = await ctx.bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  await ctx.dbRun(
    `INSERT INTO users (id, email, password_hash, organisation_id, role, email_verified, oidc_issuer, oidc_subject)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, email, unusablePasswordHash, org.id, config.defaultRole, emailVerified ? 1 : 0, issuer, subject]
  );
  await ctx.logAudit('user_created', 'user', userId, { email, role: config.defaultRole, source: 'oidc', issuer }, userId, org.id).catch(() => {});
  return { user: { id: userId, email, organisation_id: org.id, role: config.defaultRole } };
}

function registerRoutes(app, ctx) {
  // Public: tells the frontend to show the SSO button
  app.get('/api/auth/oidc/config', ctx.apiLimiter, (req, res) => {
    res.json({ enabled: true, providerName: config.providerName });
  });

  // Start the Authorization Code + PKCE flow
  app.get('/api/auth/oidc/login', ctx.apiLimiter, async (req, res) => {
    try {
      const { client, oidcConfig } = await getProvider(ctx);
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      // Flow parameters live in a short-lived signed cookie. It must be SameSite=Lax:
      // the callback is a cross-site top-level navigation coming back from the provider.
      const flowToken = ctx.jwt.sign({ state, nonce, codeVerifier }, ctx.JWT_SECRET, { expiresIn: '10m' });
      res.cookie(FLOW_COOKIE, flowToken, {
        httpOnly: true,
        secure: ctx.NODE_ENV === 'production',
        sameSite: 'lax',
        path: FLOW_COOKIE_PATH,
        maxAge: 10 * 60 * 1000
      });

      const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
        ...config.authParams,
        redirect_uri: config.redirectUri,
        scope: config.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce
      });
      res.redirect(authorizationUrl.href);
    } catch (err) {
      ctx.log('[OIDC] Failed to start login', { error: err.message });
      redirectWithError(res, 'provider_unavailable');
    }
  });

  // Provider redirects back here with ?code=...&state=...
  app.get('/api/auth/oidc/callback', ctx.apiLimiter, async (req, res) => {
    const flowToken = req.cookies[FLOW_COOKIE];
    res.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });

    let flow;
    try {
      flow = ctx.jwt.verify(flowToken, ctx.JWT_SECRET);
    } catch (err) {
      return redirectWithError(res, 'session_expired');
    }

    try {
      const { client, oidcConfig } = await getProvider(ctx);

      // Rebuild the callback URL from the configured redirect URI so it matches behind reverse proxies
      const currentUrl = new URL(config.redirectUri);
      currentUrl.search = new URL(req.originalUrl, 'http://localhost').search;

      const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true
      });

      let claims = tokens.claims();
      // Shibboleth and others often release attributes only through UserInfo
      if ((config.fetchUserInfo || !claims.email) && tokens.access_token && oidcConfig.serverMetadata().userinfo_endpoint) {
        try {
          const userInfo = await client.fetchUserInfo(oidcConfig, tokens.access_token, claims.sub);
          claims = { ...claims, ...userInfo, sub: claims.sub };
        } catch (err) {
          ctx.log('[OIDC] UserInfo request failed', { error: err.message });
        }
      }

      // e.g. only members of this institution (schac_home_organization) may log in
      if (!matchesAllRules(claims, config.requiredClaims)) {
        ctx.log('[OIDC] Login rejected', { reason: 'claim_not_allowed', sub: claims.sub });
        return redirectWithError(res, 'claim_not_allowed');
      }

      const result = await findOrCreateUser(oidcConfig.serverMetadata().issuer, claims, ctx);
      if (result.error) {
        ctx.log('[OIDC] Login rejected', { reason: result.error, sub: claims.sub });
        return redirectWithError(res, result.error);
      }

      const user = await syncRole(result.user, claims, ctx);

      if (config.card.enabled) {
        try {
          await syncCardOnLogin(user, claims, config, ctx);
        } catch (err) {
          ctx.log('[OIDC] SSO card sync failed', { userId: user.id, error: err.message });
        }
      }

      const token = ctx.jwt.sign(
        {
          user_id: user.id,
          organisation_id: user.organisation_id,
          role: user.role
        },
        ctx.JWT_SECRET,
        { expiresIn: ctx.JWT_EXPIRES_IN }
      );

      res.cookie('authToken', token, {
        httpOnly: true,
        secure: ctx.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      });

      ctx.log('[OIDC] Login successful', { userId: user.id });
      res.redirect('/people');
    } catch (err) {
      // The underlying error names the offending claim (aud, iss, nonce, ...) without token contents
      ctx.log('[OIDC] Callback failed', { error: err.message, code: err.code, detail: err.cause instanceof Error ? err.cause.message : undefined });
      redirectWithError(res, 'login_failed');
    }
  });
}

module.exports = {
  name: 'oidc',

  isEnabled(env) {
    if (!env.OIDC_ISSUER_URL || !env.OIDC_CLIENT_ID) return false;
    if (env.DEMO_MODE === 'true') {
      console.warn('[OIDC] Disabled in demo mode');
      return false;
    }
    config = load(env);
    return true;
  },

  registerRoutes,

  async beforeCardSave(args, ctx) {
    await enforceLockedFields(args, config, ctx);
  }
};
