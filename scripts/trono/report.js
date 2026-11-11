/**
 * Human report over state/sections.json (produced by explore.js).
 *
 *   node scripts/trono/report.js --only=buildings
 *   node scripts/trono/report.js --only=economy --full
 */
const fs = require('fs');
const path = require('path');

const JSON_IN = path.join(__dirname, 'state', 'sections.json');
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const full = args.includes('--full');
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || (full ? 4000 : 700));

const store = JSON.parse(fs.readFileSync(JSON_IN, 'utf8'));
const entries = Object.entries(store).filter(([url]) => !only || url.includes(only));

for (const [url, d] of entries) {
  console.log(`\n=== ${url}  (${d.bytes}B) ===`);
  if (d.config && Object.keys(d.config).length) {
    const cfg = Object.entries(d.config)
      .filter(([, v]) => String(v).length <= 60)
      .slice(0, 14)
      .map(([k, v]) => `${k}=${v}`);
    console.log(`config: ${cfg.join(' | ')}`);
  }
  if (d.endpoints && d.endpoints.length) console.log(`apis: ${d.endpoints.join(', ')}`);
  for (const f of d.forms || []) {
    const fields = f.fields.map((x) => (x.value ? `${x.name}=${x.value.slice(0, 16)}` : x.name)).join('&');
    console.log(`  form[${f.method}] ${f.action} :: ${fields} -> "${f.button}"`);
  }
  if (d.text) console.log(`text: ${d.text.slice(0, limit)}`);
}
console.log(`\n${entries.length} sections`);
