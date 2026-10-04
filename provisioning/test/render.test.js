const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, write, ValidationError } = require('../lib/render');
const bootstrapAddon = require('../../addons/bootstrap');

const root = path.join(__dirname, '..');
const platformFile = path.join(root, 'platform.yaml');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swiish-tenants-'));
}

// Copies the example tenants and lets a test add or change manifests
function tenantsWith(extra = {}) {
  const dir = tempDir();
  for (const f of fs.readdirSync(path.join(root, 'tenants'))) {
    fs.copyFileSync(path.join(root, 'tenants', f), path.join(dir, f));
  }
  for (const [name, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function problemsOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError, err.message);
    return err.problems.join('\n');
  }
  assert.fail('expected a validation error');
}

const minimalTenant = (id, homeOrg) => `
apiVersion: swiish.hm.edu/v1
kind: Tenant
metadata: { id: ${id}, name: Test ${id} }
spec:
  contact: it@${homeOrg}
  identity:
    idpEntityId: https://idp.${homeOrg}/idp/shibboleth
    homeOrganisations: [${homeOrg}]
`;

test('renders the example tenants', () => {
  const outputs = build(platformFile, path.join(root, 'tenants'));
  assert.deepStrictEqual(outputs.map(o => o.id), ['hm', 'thi']);

  const thi = outputs.find(o => o.id === 'thi');
  assert.strictEqual(thi.env.APP_URL, 'https://karten.thi.example.org');
  assert.strictEqual(thi.env.OIDC_CLIENT_ID, 'swiish-thi');
  assert.strictEqual(thi.env.OIDC_AUTH_PARAMS, 'kc_idp_hint=thi');
  assert.strictEqual(thi.env.OIDC_REQUIRED_CLAIMS, 'schac_home_organization=thi.example.org');
  assert.strictEqual(thi.env.CARD_LIMIT_PER_USER, '1');

  const hm = outputs.find(o => o.id === 'hm');
  assert.strictEqual(hm.env.APP_URL, 'https://hm.visitenkarte.example.org');
  assert.strictEqual(hm.env.OIDC_OWNER_CLAIMS, 'eduPersonEntitlement=urn:mace:hm.example.org:swiish:owner');
  assert.match(hm.env.OIDC_CARD_MAPPING, /personal\.title=title/);
});

test('rendered bootstrap.json is accepted by the bootstrap addon', () => {
  const outDir = path.join(tempDir(), 'out');
  write(build(platformFile, path.join(root, 'tenants')), outDir);
  for (const id of ['hm', 'thi']) {
    const config = bootstrapAddon.loadConfig(path.join(outDir, id, 'bootstrap.json'));
    assert.strictEqual(config.slug, id);
  }
});

test('reports schema errors with the file name', () => {
  const dir = tenantsWith({ 'bad.yaml': minimalTenant('bad', 'bad.example.org').replace('spec:', 'spec:\n  colour: red') });
  assert.match(problemsOf(() => build(platformFile, dir)), /bad\.yaml: \/spec must NOT have additional properties \(colour\)/);
});

test('rejects a home organisation claimed by two tenants', () => {
  const dir = tenantsWith({ 'copy.yaml': minimalTenant('copy', 'thi.example.org') });
  // Tenants are read in file name order, so the later one ("thi") is reported
  assert.match(problemsOf(() => build(platformFile, dir)), /thi: home organisation "thi\.example\.org" is already used by copy/);
});

test('rejects locked card fields without a mapping', () => {
  const tenant = minimalTenant('lock', 'lock.example.org') + `
  cards:
    mapping: { personal.firstName: given_name }
    lockedFields: [personal.firstName, contact.email]
`;
  const dir = tenantsWith({ 'lock.yaml': tenant });
  assert.match(problemsOf(() => build(platformFile, dir)), /lock: cards\.lockedFields contains "contact\.email"/);
});

test('requires the file name to match metadata.id', () => {
  const dir = tenantsWith({ 'other-name.yaml': minimalTenant('real', 'real.example.org') });
  assert.match(problemsOf(() => build(platformFile, dir)), /file name must match metadata\.id/);
});

test('render replaces its own output but refuses foreign directories', () => {
  const outputs = build(platformFile, path.join(root, 'tenants'));
  const outDir = path.join(tempDir(), 'out');
  write(outputs, outDir);
  fs.mkdirSync(path.join(outDir, 'removed-tenant'));
  write(outputs, outDir);
  assert.ok(!fs.existsSync(path.join(outDir, 'removed-tenant')), 'stale tenant directories are removed');

  const foreign = tempDir();
  fs.writeFileSync(path.join(foreign, 'important.txt'), 'keep me');
  assert.throws(() => write(outputs, foreign), /refusing to overwrite/);
  assert.ok(fs.existsSync(path.join(foreign, 'important.txt')));
});
