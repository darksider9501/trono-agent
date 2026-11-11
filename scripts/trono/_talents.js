const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, 'state', 'sections', 'pages_talents_php.html');
const html = fs.readFileSync(file, 'utf8');

const nodes = [...html.matchAll(/<button[^>]*?data-node="([a-z0-9_]+)"([\s\S]{0,1400}?)>/g)].map((m) => {
  const attrs = {};
  for (const a of m[2].matchAll(/data-([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return {
    key: m[1],
    branch: attrs.branch,
    name: attrs.name,
    rank: attrs.rank,
    max: attrs.max,
    state: attrs.state,
    reason: attrs.reason,
    fxNow: attrs['fx-now'],
    fxNext: attrs['fx-next'],
    parents: attrs['parents-keys'],
    levelRule: attrs['level-rule']
  };
});

const seen = new Set();
const uniq = nodes.filter((n) => (seen.has(n.key) ? false : seen.add(n.key)));
console.log(`nodes: ${uniq.length}`);
for (const n of uniq) {
  console.log(
    `${(n.branch || '?').padEnd(10)} ${String(n.key).padEnd(28)} ${String(n.rank || 0)}/${n.max || '?'} ` +
      `[${n.state || '?'}] ${n.name || ''} | now:${n.fxNow || ''} -> next:${n.fxNext || ''} | parents:${n.parents || '-'} | ${n.levelRule || ''}`
  );
}
