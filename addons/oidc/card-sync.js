// Creates and maintains a user's "SSO card" from OIDC claims.
//
// The SSO card is marked with `_sso` in its card data. Fields listed in
// OIDC_CARD_LOCKED_FIELDS are owned by the identity provider: they are
// refreshed on every SSO login and cannot be changed when saving the card.
// All other mapped fields are only used to pre-fill the card on creation.

const util = require('util');
const validator = require('validator');
const { CARD_FIELDS } = require('./config');

const DEFAULT_PRIVACY = { requireInteraction: true, clientSideObfuscation: false, blockRobots: false };
const DEFAULT_SEND_DETAILS = { enabled: true, whatsapp: true, email: true, call: true };
const MAX_SLUG_LENGTH = 50;

function getPath(obj, path) {
  return path.split('.').reduce((o, key) => (o && typeof o === 'object' ? o[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = obj;
  for (const key of keys) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[last] = value;
}

// Reads a claim by name (or dotted path, e.g. address.locality). Multi-valued
// attributes, which Shibboleth releases as arrays, resolve to their first value.
function readClaim(claims, name) {
  let value = name in claims ? claims[name] : getPath(claims, name);
  if (Array.isArray(value)) {
    value = value.find(v => v !== null && v !== undefined && String(v).trim() !== '');
  }
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  return String(value).trim();
}

function normalizeFieldValue(field, value) {
  const spec = CARD_FIELDS[field];
  if (!value) return '';
  if (spec.type === 'email') return validator.isEmail(value) ? value.toLowerCase() : '';
  if (spec.type === 'url') return validator.isURL(value, { protocols: ['http', 'https'] }) ? value : '';
  return value.substring(0, spec.maxLength);
}

// Card values for every mapped field whose claim was released by the provider
function mappedValues(claims, mapping) {
  const values = {};
  for (const [field, claim] of Object.entries(mapping)) {
    const raw = readClaim(claims, claim);
    if (raw !== undefined) values[field] = normalizeFieldValue(field, raw);
  }
  return values;
}

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .substring(0, MAX_SLUG_LENGTH - 4);
}

// Slugs are kept unique across all cards so /:orgSlug/:cardSlug URLs stay unambiguous
async function findAvailableSlug(base, ctx) {
  for (let counter = 1; counter < 1000; counter++) {
    const slug = counter === 1 ? base : `${base}-${counter}`;
    const taken = await ctx.dbGet('SELECT 1 FROM cards WHERE slug = ?', [slug]);
    if (!taken) return slug;
  }
  throw new Error('Could not find an available card slug');
}

function slugBase(claims, values, config) {
  const candidates = [
    config.card.slugClaim && readClaim(claims, config.card.slugClaim),
    [values['personal.firstName'] || readClaim(claims, 'given_name'), values['personal.lastName'] || readClaim(claims, 'family_name')].filter(Boolean).join(' '),
    readClaim(claims, 'preferred_username'),
    (readClaim(claims, 'email') || '').split('@')[0]
  ];
  for (const candidate of candidates) {
    const slug = slugify(candidate);
    if (slug) return slug;
  }
  return 'card';
}

function buildNewCardData(values, orgSettings, config) {
  const data = {
    personal: { firstName: '', lastName: '', title: '', company: '', bio: '', location: '' },
    contact: { email: '', phone: '', website: '' },
    social: { linkedin: '', twitter: '', instagram: '', github: '' },
    theme: { color: (orgSettings.theme_colors && orgSettings.theme_colors[0] && orgSettings.theme_colors[0].name) || 'indigo', style: 'modern' },
    images: { avatar: '', banner: '' },
    links: [],
    privacy: { ...DEFAULT_PRIVACY },
    sendDetails: { ...DEFAULT_SEND_DETAILS }
  };
  for (const [field, value] of Object.entries(values)) {
    setPath(data, field, value);
  }
  // Same organisation policy core applies on every save
  if (orgSettings.default_organisation) {
    data.personal.company = orgSettings.default_organisation;
  }
  data._sso = { managedFields: config.card.lockedFields };
  return data;
}

async function findSsoCard(userId, config, ctx) {
  const card = await ctx.dbGet(
    "SELECT slug, short_code, data FROM cards WHERE user_id = ? AND json_extract(data, '$._sso') IS NOT NULL ORDER BY created_at ASC LIMIT 1",
    [userId]
  );
  if (card || !config.card.adoptExisting) return card;
  // Turn the user's oldest existing card into their SSO card
  return ctx.dbGet('SELECT slug, short_code, data FROM cards WHERE user_id = ? ORDER BY created_at ASC LIMIT 1', [userId]);
}

// Called after every successful SSO login. Errors are logged by the caller and never block the login.
async function syncCardOnLogin(user, claims, config, ctx) {
  const values = mappedValues(claims, config.card.mapping);
  const card = await findSsoCard(user.id, config, ctx);

  if (card) {
    const data = JSON.parse(card.data);
    const before = JSON.stringify(data);
    for (const field of config.card.lockedFields) {
      if (field in values) setPath(data, field, values[field]);
    }
    data._sso = { ...(data._sso || {}), managedFields: config.card.lockedFields };
    if (JSON.stringify(data) !== before) {
      await ctx.dbRun('UPDATE cards SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND user_id = ?', [JSON.stringify(data), card.slug, user.id]);
      await ctx.invalidatePreviewCache(card.slug, card.short_code);
      ctx.log('[OIDC] SSO card updated', { userId: user.id, slug: card.slug });
    }
    return;
  }

  const cardLimit = ctx.addons.getAddon('card-limit');
  if (cardLimit && !(await cardLimit.canCreateCard(user.id, null, ctx))) {
    ctx.log('[OIDC] SSO card not created: card limit reached', { userId: user.id });
    return;
  }

  const orgSettings = await util.promisify(ctx.getOrganizationSettings)(user.organisation_id);
  const slug = await findAvailableSlug(slugBase(claims, values, config), ctx);
  const shortCode = await util.promisify(ctx.ensureUniqueShortCode)(ctx.db);
  const data = buildNewCardData(values, orgSettings, config);

  await ctx.dbRun(
    'INSERT INTO cards (slug, user_id, short_code, data, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [slug, user.id, shortCode, JSON.stringify(data)]
  );
  ctx.log('[OIDC] SSO card created', { userId: user.id, slug });
}

// Keeps provider-managed fields of an SSO card unchanged when the card is saved
async function enforceLockedFields({ targetUserId, slug, data }, config, ctx) {
  const existing = await ctx.dbGet('SELECT data FROM cards WHERE slug = ? AND user_id = ?', [slug, targetUserId]);
  if (!existing) return;

  let existingData;
  try {
    existingData = JSON.parse(existing.data);
  } catch (e) {
    return;
  }
  if (!existingData._sso) return;

  for (const field of config.card.lockedFields) {
    setPath(data, field, getPath(existingData, field) ?? '');
  }
  data._sso = { ...existingData._sso, managedFields: config.card.lockedFields };
}

module.exports = { syncCardOnLogin, enforceLockedFields, readClaim };
