/**
 * Print the meaningful body of a harvested page (nav/HUD boilerplate stripped).
 * Usage: node scripts/trono/page-text.js <name> [limit]
 *        node scripts/trono/page-text.js quests_main 4000
 */
const fs = require('fs');
const path = require('path');

const name = process.argv[2];
const limit = parseInt(process.argv[3] || '4000', 10);
if (!name) {
  console.error('usage: node scripts/trono/page-text.js <page-name> [limit]');
  process.exit(1);
}

const file = path.join(__dirname, 'state', 'pages', `${name}.html`);
if (!fs.existsSync(file)) {
  console.error('missing page:', file);
  process.exit(1);
}

let html = fs.readFileSync(file, 'utf8');
html = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|section|article|details|summary)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ');
html = html
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>');

const text = html
  .split('\n')
  .map((l) => l.replace(/[ \t]+/g, ' ').trim())
  .filter((l) => l.length > 0)
  .join('\n');

console.log(text.slice(0, limit));
