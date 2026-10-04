// Bootstrap addon: provisions the organisation and its settings from a JSON
// file instead of the interactive first-run setup.
//
// Enabled by BOOTSTRAP_FILE (path to the JSON file). On every start it
//   - creates the organisation if none exists yet,
//   - writes every setting listed in the file (the file is the source of truth
//     for those settings; settings it does not list stay editable in the UI).
// The setup wizard is disabled; the first owners sign in via SSO
// (see OIDC_OWNER_EMAILS / OIDC_OWNER_CLAIMS in the oidc addon).

const fs = require('fs');
const crypto = require('crypto');

const ALLOW_KEYS = [
  'allow_theme_customisation',
  'allow_image_customisation',
  'allow_links_customisation',
  'allow_privacy_customisation',
  'allow_send_details_customisation'
];
const THEME_VARIANTS = ['swiish', 'minimal'];
const HEX = /^#[0-9a-fA-F]{6}$/;

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .substring(0, 50);
}

// Same shape the settings UI stores for custom hex colours
function themeColor(color, index) {
  if (!color || typeof color.name !== 'string' || !color.name.trim()) {
    throw new Error(`settings.theme_colors[${index}].name is required`);
  }
  if (!HEX.test(color.hexBase || '') || !HEX.test(color.hexSecondary || '')) {
    throw new Error(`settings.theme_colors[${index}] needs hexBase and hexSecondary as #rrggbb`);
  }
  return {
    name: color.name.trim().substring(0, 50),
    colorType: 'custom',
    hexBase: color.hexBase,
    hexSecondary: color.hexSecondary,
    gradientStyle: `linear-gradient(135deg, ${color.hexBase}, ${color.hexSecondary})`,
    buttonStyle: color.hexBase,
    linkStyle: color.hexBase,
    textStyle: color.hexBase
  };
}

// Returns [key, storedValue] pairs for organisation_settings
function parseSettings(settings = {}) {
  const known = new Set(['default_organisation', 'theme_variant', 'theme_colors', ...ALLOW_KEYS]);
  for (const key of Object.keys(settings)) {
    if (!known.has(key)) throw new Error(`unknown setting "${key}"`);
  }

  const entries = [];
  if (settings.default_organisation !== undefined) {
    entries.push(['default_organisation', String(settings.default_organisation).trim().substring(0, 200)]);
  }
  if (settings.theme_variant !== undefined) {
    if (!THEME_VARIANTS.includes(settings.theme_variant)) {
      throw new Error(`settings.theme_variant must be one of ${THEME_VARIANTS.join(', ')}`);
    }
    entries.push(['theme_variant', settings.theme_variant]);
  }
  if (settings.theme_colors !== undefined) {
    if (!Array.isArray(settings.theme_colors) || settings.theme_colors.length === 0) {
      throw new Error('settings.theme_colors must be a non-empty array');
    }
    entries.push(['theme_colors', JSON.stringify(settings.theme_colors.map(themeColor))]);
  }
  for (const key of ALLOW_KEYS) {
    if (settings[key] === undefined) continue;
    if (typeof settings[key] !== 'boolean') throw new Error(`settings.${key} must be true or false`);
    entries.push([key, String(settings[key])]);
  }
  return entries;
}

function loadConfig(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  const name = config.organisation && typeof config.organisation.name === 'string' ? config.organisation.name.trim() : '';
  if (!name || name.length > 200) {
    throw new Error('organisation.name is required (max. 200 characters)');
  }
  const slug = config.organisation.slug || slugify(name);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) {
    throw new Error('organisation.slug may only contain a-z, 0-9 and "-" (max. 50 characters)');
  }
  return { name, slug, settings: parseSettings(config.settings) };
}

const upsertSetting = (ctx, orgId, key, value) => ctx.dbRun(
  `INSERT INTO organisation_settings (organisation_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(organisation_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  [orgId, key, value]
);

module.exports = {
  name: 'bootstrap',
  managesSetup: true,

  isEnabled(env) {
    return Boolean(env.BOOTSTRAP_FILE);
  },

  async onStartup(ctx) {
    let config;
    try {
      config = loadConfig(process.env.BOOTSTRAP_FILE);
    } catch (err) {
      throw new Error(`[BOOTSTRAP] Invalid BOOTSTRAP_FILE: ${err.message}`);
    }

    // Swiish runs a single organisation per instance
    let org = await ctx.dbGet('SELECT id, name FROM organisations ORDER BY created_at ASC LIMIT 1', []);
    if (!org) {
      org = { id: crypto.randomUUID(), name: config.name };
      await ctx.dbRun(
        'INSERT INTO organisations (id, name, slug, subscription_tier) VALUES (?, ?, ?, ?)',
        [org.id, config.name, config.slug, 'individual']
      );
      // Same defaults as the setup wizard; configured settings below override them
      const defaults = [
        ['default_organisation', config.name],
        ['theme_colors', JSON.stringify(ctx.getDefaultThemeColors())],
        ...ALLOW_KEYS.map(key => [key, 'true'])
      ];
      for (const [key, value] of defaults) {
        await upsertSetting(ctx, org.id, key, value);
      }
      console.log(`[BOOTSTRAP] Created organisation "${config.name}" (${config.slug})`);
    } else if (org.name !== config.name) {
      await ctx.dbRun('UPDATE organisations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [config.name, org.id]);
    }

    for (const [key, value] of config.settings) {
      await upsertSetting(ctx, org.id, key, value);
    }
    console.log(`[BOOTSTRAP] Applied ${config.settings.length} managed setting(s)`);
  },

  // Exported for tests and the provisioning tooling
  loadConfig
};
