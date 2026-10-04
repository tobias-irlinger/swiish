// Environment configuration for the OpenID Connect addon

// Card fields that may be filled from claims, with the same limits core applies on save
const CARD_FIELDS = {
  'personal.firstName': { maxLength: 100 },
  'personal.lastName': { maxLength: 100 },
  'personal.title': { maxLength: 200 },
  'personal.company': { maxLength: 200 },
  'personal.bio': { maxLength: 1000 },
  'personal.location': { maxLength: 200 },
  'contact.email': { type: 'email' },
  'contact.phone': { maxLength: 50 },
  'contact.website': { type: 'url' },
  'social.linkedin': { type: 'url' },
  'social.twitter': { type: 'url' },
  'social.instagram': { type: 'url' },
  'social.github': { type: 'url' }
};

const DEFAULT_CARD_MAPPING = 'personal.firstName=given_name,personal.lastName=family_name,contact.email=email,contact.phone=phone_number';
const DEFAULT_CARD_LOCKED_FIELDS = 'personal.firstName,personal.lastName,contact.email';

function list(value) {
  return (value || '').split(',').map(v => v.trim()).filter(Boolean);
}

// Parameters the login flow sets itself and that must not be overridden
const RESERVED_AUTH_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];

// "kc_idp_hint=https://idp.example.org&prompt=login" -> { kc_idp_hint: ..., prompt: ... }
function parseAuthParams(value, warn) {
  const params = {};
  for (const [key, val] of new URLSearchParams(value || '')) {
    if (RESERVED_AUTH_PARAMS.includes(key)) {
      warn(`OIDC_AUTH_PARAMS may not set "${key}"; ignored`);
      continue;
    }
    params[key] = val;
  }
  return params;
}

// "claim=value,claim=value2,other=x" -> { claim: ['value', 'value2'], other: ['x'] }
// A rule set matches when every claim matches at least one of its values.
function parseClaimRules(value, name, warn) {
  const rules = {};
  for (const entry of list(value)) {
    const index = entry.indexOf('=');
    const claim = index > 0 ? entry.slice(0, index).trim() : '';
    const expected = index > 0 ? entry.slice(index + 1).trim() : '';
    if (!claim || !expected) {
      warn(`ignoring invalid ${name} entry "${entry}"`);
      continue;
    }
    (rules[claim] = rules[claim] || []).push(expected);
  }
  return rules;
}

// "personal.firstName=given_name,..." -> { 'personal.firstName': 'given_name', ... }
function parseMapping(value, warn) {
  const mapping = {};
  for (const entry of list(value)) {
    const [field, claim] = entry.split('=').map(v => (v || '').trim());
    if (!CARD_FIELDS[field] || !claim) {
      warn(`ignoring invalid OIDC_CARD_MAPPING entry "${entry}"`);
      continue;
    }
    mapping[field] = claim;
  }
  return mapping;
}

function load(env = process.env) {
  const warn = (msg) => console.warn(`[OIDC] Config: ${msg}`);
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const clientSecret = env.OIDC_CLIENT_SECRET || null;

  const cardMapping = parseMapping(env.OIDC_CARD_MAPPING ?? DEFAULT_CARD_MAPPING, warn);
  const cardLockedFields = list(env.OIDC_CARD_LOCKED_FIELDS ?? DEFAULT_CARD_LOCKED_FIELDS).filter(field => {
    if (!cardMapping[field]) {
      warn(`locked field "${field}" has no OIDC_CARD_MAPPING entry and is ignored`);
      return false;
    }
    return true;
  });

  return {
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret,
    // Shibboleth and most providers default to client_secret_basic for confidential clients
    tokenAuthMethod: env.OIDC_TOKEN_AUTH_METHOD || (clientSecret ? 'client_secret_basic' : 'none'),
    redirectUri: env.OIDC_REDIRECT_URI || `${appUrl}/api/auth/oidc/callback`,
    scopes: env.OIDC_SCOPES || 'openid email profile',
    providerName: env.OIDC_PROVIDER_NAME || 'SSO',
    // Shibboleth OPs usually release attributes via UserInfo only, so fetch it by default
    fetchUserInfo: env.OIDC_FETCH_USERINFO !== 'false',
    // Extra authorization request parameters, e.g. an IdP hint for a federation broker
    authParams: parseAuthParams(env.OIDC_AUTH_PARAMS, warn),
    // Every listed claim must match one of its values, otherwise the login is rejected
    requiredClaims: parseClaimRules(env.OIDC_REQUIRED_CLAIMS, 'OIDC_REQUIRED_CLAIMS', warn),

    autoProvision: env.OIDC_AUTO_PROVISION === 'true',
    defaultRole: env.OIDC_DEFAULT_ROLE === 'owner' ? 'owner' : 'member',
    // Users matching an owner email or any owner claim rule become owners on login
    ownerEmails: list(env.OIDC_OWNER_EMAILS).map(e => e.toLowerCase()),
    ownerClaims: parseClaimRules(env.OIDC_OWNER_CLAIMS, 'OIDC_OWNER_CLAIMS', warn),
    // When true, owners who no longer match are demoted to member on login
    roleSync: env.OIDC_ROLE_SYNC === 'true',
    allowedDomains: list(env.OIDC_ALLOWED_DOMAINS).map(d => d.toLowerCase()),
    requireVerifiedEmail: env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false',

    card: {
      enabled: env.OIDC_CARD_AUTO_CREATE === 'true',
      mapping: cardMapping,
      lockedFields: cardLockedFields,
      slugClaim: env.OIDC_CARD_SLUG_CLAIM || null,
      adoptExisting: env.OIDC_CARD_ADOPT_EXISTING === 'true'
    }
  };
}

module.exports = { CARD_FIELDS, load };
