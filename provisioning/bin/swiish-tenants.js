#!/usr/bin/env node
// Usage:
//   swiish-tenants validate [--platform platform.yaml] [--tenants tenants/]
//   swiish-tenants render   [--platform platform.yaml] [--tenants tenants/] [--out out/]

const path = require('path');
const { build, write, ValidationError } = require('../lib/render');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const command = args[0];

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index > 0 && args[index + 1] ? path.resolve(args[index + 1]) : fallback;
}

if (!['validate', 'render'].includes(command)) {
  console.error('Usage: swiish-tenants <validate|render> [--platform file] [--tenants dir] [--out dir]');
  process.exit(2);
}

const platformFile = option('platform', path.join(root, 'platform.yaml'));
const tenantsDir = option('tenants', path.join(root, 'tenants'));

try {
  const outputs = build(platformFile, tenantsDir);
  if (command === 'render') {
    const outDir = option('out', path.join(root, 'out'));
    write(outputs, outDir);
    console.log(`Rendered ${outputs.length} tenant(s) to ${outDir}`);
  } else {
    console.log(`OK: ${outputs.length} tenant(s) valid (${outputs.map(o => o.id).join(', ')})`);
  }
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(`Validation failed:\n${err.problems.map(p => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.error(err.message);
  process.exit(1);
}
