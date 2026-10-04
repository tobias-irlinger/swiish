// Optional addons.
//
// Each addon is self-contained and only activates when its environment
// configuration is present, so a default install behaves exactly like core.
// An addon module exports:
//   name                      - identifier used in logs
//   isEnabled(env)            - whether the addon should load
//   registerRoutes(app, ctx)  - optional, mounts the addon's routes
//   beforeCardSave(args, ctx) - optional, runs before a card is written via
//                               POST /api/cards/:slug; may mutate args.data or
//                               throw an AddonError to reject the save
//   onStartup(ctx)            - optional, runs once after database migrations
//   managesSetup              - optional, true when the addon replaces the
//                               interactive first-run setup

class AddonError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const AVAILABLE_ADDONS = [
  require('./bootstrap'),
  require('./card-limit'),
  require('./health'),
  require('./oidc')
];

let ctx = null;
let active = [];

// ctx carries the core helpers addons may use (db, auth middleware, logging, ...)
function init(coreContext) {
  ctx = { ...coreContext, addons: module.exports };
  active = AVAILABLE_ADDONS.filter(addon => addon.isEnabled(process.env));
  for (const addon of active) {
    console.log(`[ADDONS] Enabled: ${addon.name}`);
  }
}

function isActive(name) {
  return active.some(addon => addon.name === name);
}

function getAddon(name) {
  return active.find(addon => addon.name === name) || null;
}

function registerRoutes(app) {
  for (const addon of active) {
    if (addon.registerRoutes) addon.registerRoutes(app, ctx);
  }
}

// Runs after migrations, before the server accepts requests
async function onStartup() {
  for (const addon of active) {
    if (addon.onStartup) await addon.onStartup(ctx);
  }
}

// When true, the interactive first-run setup (/api/setup/*) is disabled
function isSetupManaged() {
  return active.some(addon => addon.managesSetup);
}

// args: { user, targetUserId, slug, data }
async function beforeCardSave(args) {
  for (const addon of active) {
    if (addon.beforeCardSave) await addon.beforeCardSave(args, ctx);
  }
}

module.exports = {
  AddonError,
  init,
  isActive,
  getAddon,
  registerRoutes,
  onStartup,
  isSetupManaged,
  beforeCardSave
};
