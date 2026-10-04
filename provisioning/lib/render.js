// Validates tenant manifests against the platform settings and renders the
// per-tenant Swiish configuration:
//   swiish.env      non-secret environment variables
//   bootstrap.json  organisation and settings for the bootstrap addon
//   tenant.json     normalized facts for the deployment / broker tooling

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '..', 'schema');
const BOOTSTRAP_PATH = '/app/config/bootstrap.json';

const DEFAULT_CARD_MAPPING = {
  'personal.firstName': 'given_name',
  'personal.lastName': 'family_name',
  'contact.email': 'email'
};
const DEFAULT_LOCKED_FIELDS = ['personal.firstName', 'personal.lastName', 'contact.email'];

class ValidationError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

function createValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const tenantSchema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'tenant.schema.json'), 'utf8'));
  const platformSchema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'platform.schema.json'), 'utf8'));
  ajv.addSchema(tenantSchema);
  return {
    tenant: ajv.getSchema(tenantSchema.$id),
    platform: ajv.compile(platformSchema)
  };
}

function schemaProblems(validate, doc, label) {
  if (validate(doc)) return [];
  return validate.errors.map(e => `${label}: ${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError([`${file}: ${err.message}`]);
  }
}

function loadTenantFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => /\.ya?ml$/.test(f))
    .sort()
    .map(f => ({ file: path.join(dir, f), doc: readYaml(path.join(dir, f)) }));
}

// Applies platform defaults to one tenant and derives all values
function resolveTenant(platform, tenant) {
  const p = platform.spec;
  const t = tenant.spec;
  const id = tenant.metadata.id;
  const defaults = p.defaults || {};
  const broker = p.broker;

  const identity = { autoProvision: true, defaultRole: 'member', roleSync: false, ...defaults.identity, ...t.identity };
  const cards = {
    autoCreate: true,
    limitPerUser: 1,
    adoptExisting: false,
    mapping: DEFAULT_CARD_MAPPING,
    lockedFields: DEFAULT_LOCKED_FIELDS,
    ...defaults.cards,
    ...t.cards
  };
  const host = t.host || `${id}.${p.baseDomain}`;

  return {
    id,
    name: tenant.metadata.name,
    host,
    appUrl: `https://${host}`,
    language: t.language || p.language || null,
    contact: t.contact,
    image: p.image,
    identity,
    cards,
    branding: t.branding || {},
    oidc: {
      issuerUrl: broker.issuerUrl,
      clientId: `${broker.clientIdPrefix ?? 'swiish-'}${id}`,
      redirectUri: `https://${host}/api/auth/oidc/callback`,
      tokenAuthMethod: broker.tokenAuthMethod || 'client_secret_basic',
      providerName: broker.providerName || 'Hochschul-Login',
      scopes: broker.scopes || 'openid email profile',
      idpHint: broker.idpHint
        ? { [broker.idpHint.param]: broker.idpHint.value === 'tenantId' ? id : t.identity.idpEntityId }
        : null,
      homeOrganisationClaim: (broker.claims && broker.claims.homeOrganisation) || 'schac_home_organization',
      entitlementClaim: (broker.claims && broker.claims.entitlement) || 'eduPersonEntitlement'
    }
  };
}

// Rules that span fields or tenants and cannot be expressed in JSON Schema
function crossCheck(resolved) {
  const problems = [];
  const seen = { id: new Map(), host: new Map(), idp: new Map(), homeOrg: new Map(), clientId: new Map() };
  const claim = (kind, value, tenantId, label) => {
    const other = seen[kind].get(value);
    if (other && other !== tenantId) problems.push(`${tenantId}: ${label} "${value}" is already used by ${other}`);
    seen[kind].set(value, tenantId);
  };

  for (const r of resolved) {
    claim('id', r.id, r.id, 'id');
    claim('host', r.host, r.id, 'host');
    claim('clientId', r.oidc.clientId, r.id, 'OIDC client ID');
    claim('idp', r.identity.idpEntityId, r.id, 'idpEntityId');
    for (const org of r.identity.homeOrganisations) claim('homeOrg', org, r.id, 'home organisation');

    for (const field of r.cards.lockedFields) {
      if (!r.cards.mapping[field]) problems.push(`${r.id}: cards.lockedFields contains "${field}" which has no cards.mapping entry`);
    }
    const colors = (r.branding.themeColors || []).map(c => c.name);
    if (new Set(colors).size !== colors.length) problems.push(`${r.id}: branding.themeColors names must be unique`);
  }
  return problems;
}

function list(values) {
  return (values || []).join(',');
}

function renderEnv(r, platform) {
  const p = platform.spec;
  const env = {
    NODE_ENV: 'production',
    APP_URL: r.appUrl,
    ALLOWED_ORIGINS: r.appUrl,
    CARD_LANGUAGE: r.language,
    HEALTHCHECK_PATH: p.healthcheckPath || '/healthz',
    BOOTSTRAP_FILE: BOOTSTRAP_PATH,

    OIDC_ISSUER_URL: r.oidc.issuerUrl,
    OIDC_CLIENT_ID: r.oidc.clientId,
    OIDC_TOKEN_AUTH_METHOD: r.oidc.tokenAuthMethod,
    OIDC_REDIRECT_URI: r.oidc.redirectUri,
    OIDC_SCOPES: r.oidc.scopes,
    OIDC_PROVIDER_NAME: r.oidc.providerName,
    OIDC_AUTH_PARAMS: r.oidc.idpHint ? new URLSearchParams(r.oidc.idpHint).toString() : null,
    // Membership is enforced via the home organisation claim; the IdP is authoritative for email
    OIDC_REQUIRED_CLAIMS: list(r.identity.homeOrganisations.map(org => `${r.oidc.homeOrganisationClaim}=${org}`)),
    OIDC_REQUIRE_VERIFIED_EMAIL: 'false',
    OIDC_ALLOWED_DOMAINS: list(r.identity.emailDomains) || null,
    OIDC_AUTO_PROVISION: String(r.identity.autoProvision),
    OIDC_DEFAULT_ROLE: r.identity.defaultRole,
    OIDC_OWNER_EMAILS: list(r.identity.owners && r.identity.owners.emails) || null,
    OIDC_OWNER_CLAIMS: list(((r.identity.owners && r.identity.owners.entitlements) || []).map(e => `${r.oidc.entitlementClaim}=${e}`)) || null,
    OIDC_ROLE_SYNC: String(r.identity.roleSync),

    OIDC_CARD_AUTO_CREATE: String(r.cards.autoCreate),
    OIDC_CARD_MAPPING: list(Object.entries(r.cards.mapping).map(([field, claimName]) => `${field}=${claimName}`)),
    OIDC_CARD_LOCKED_FIELDS: list(r.cards.lockedFields),
    OIDC_CARD_SLUG_CLAIM: r.cards.slugClaim || null,
    OIDC_CARD_ADOPT_EXISTING: String(r.cards.adoptExisting),
    CARD_LIMIT_PER_USER: r.cards.limitPerUser > 0 ? String(r.cards.limitPerUser) : null
  };
  if (p.smtp) {
    Object.assign(env, {
      SMTP_HOST: p.smtp.host,
      SMTP_PORT: String(p.smtp.port || 587),
      SMTP_SECURE: String(Boolean(p.smtp.secure)),
      SMTP_FROM: p.smtp.from
    });
  }
  for (const key of Object.keys(env)) {
    if (env[key] === null || env[key] === undefined || env[key] === '') delete env[key];
    else if (/[\r\n]/.test(env[key])) throw new ValidationError([`${r.id}: ${key} must not contain line breaks`]);
  }
  return env;
}

function renderBootstrap(r) {
  const b = r.branding;
  const settings = { default_organisation: b.displayName || r.name };
  if (b.themeVariant) settings.theme_variant = b.themeVariant;
  if (b.themeColors) {
    settings.theme_colors = b.themeColors.map(c => ({ name: c.name, hexBase: c.primary, hexSecondary: c.secondary }));
  }
  const allow = {
    allowThemeCustomisation: 'allow_theme_customisation',
    allowImageCustomisation: 'allow_image_customisation',
    allowLinksCustomisation: 'allow_links_customisation',
    allowPrivacyCustomisation: 'allow_privacy_customisation',
    allowSendDetailsCustomisation: 'allow_send_details_customisation'
  };
  for (const [key, setting] of Object.entries(allow)) {
    if (b[key] !== undefined) settings[setting] = b[key];
  }
  return { organisation: { name: r.name, slug: r.id }, settings };
}

function renderTenantInfo(r, platform) {
  const secrets = ['JWT_SECRET', 'OIDC_CLIENT_SECRET'];
  if (platform.spec.smtp) secrets.push('SMTP_USER', 'SMTP_PASSWORD');
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    appUrl: r.appUrl,
    contact: r.contact,
    image: r.image,
    oidc: {
      issuerUrl: r.oidc.issuerUrl,
      clientId: r.oidc.clientId,
      redirectUri: r.oidc.redirectUri,
      tokenAuthMethod: r.oidc.tokenAuthMethod,
      idpEntityId: r.identity.idpEntityId
    },
    files: { 'bootstrap.json': BOOTSTRAP_PATH },
    secrets
  };
}

// Validates everything; returns rendered outputs or throws ValidationError with all problems
function build(platformFile, tenantsDir) {
  const validators = createValidators();
  const platform = readYaml(platformFile);
  const problems = schemaProblems(validators.platform, platform, platformFile);
  if (problems.length) throw new ValidationError(problems);

  const tenants = loadTenantFiles(tenantsDir);
  for (const { file, doc } of tenants) {
    problems.push(...schemaProblems(validators.tenant, doc, file));
    if (doc && doc.metadata && doc.metadata.id && path.basename(file).replace(/\.ya?ml$/, '') !== doc.metadata.id) {
      problems.push(`${file}: file name must match metadata.id ("${doc.metadata.id}.yaml")`);
    }
  }
  if (problems.length) throw new ValidationError(problems);

  const resolved = tenants.map(({ doc }) => resolveTenant(platform, doc));
  problems.push(...crossCheck(resolved));
  if (problems.length) throw new ValidationError(problems);

  return resolved.map(r => ({
    id: r.id,
    env: renderEnv(r, platform),
    bootstrap: renderBootstrap(r),
    info: renderTenantInfo(r, platform)
  }));
}

function toEnvFile(env) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

const MARKER = '.swiish-render';

// Writes outputs to outDir. The directory is fully replaced so removed tenants
// disappear; it must be empty or a previous render output.
function write(outputs, outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0 && !fs.existsSync(path.join(outDir, MARKER))) {
    throw new Error(`${outDir} is not empty and was not created by this tool; refusing to overwrite it`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, MARKER), 'Generated by swiish-tenants render. Do not edit.\n');
  for (const o of outputs) {
    const dir = path.join(outDir, o.id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'swiish.env'), toEnvFile(o.env));
    fs.writeFileSync(path.join(dir, 'bootstrap.json'), JSON.stringify(o.bootstrap, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'tenant.json'), JSON.stringify(o.info, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(outDir, 'tenants.json'), JSON.stringify(outputs.map(o => o.info), null, 2) + '\n');
}

module.exports = { build, write, toEnvFile, ValidationError };
