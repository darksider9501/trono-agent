/**
 * Peek helper: print a slice of a harvested state file around a needle.
 * Usage: node scripts/trono/peek.js <file> <needle> [before] [after] [--unescape]
 */
const fs = require('fs');
const path = require('path');

const [, , file, needle, beforeArg, afterArg] = process.argv;
const unescape = process.argv.includes('--unescape');
const before = parseInt(beforeArg || '600', 10);
const after = parseInt(afterArg || '600', 10);

const target = path.isAbsolute(file) ? file : path.join(__dirname, file);
if (!fs.existsSync(target)) {
  console.error('missing file:', target);
  process.exit(1);
}

let text = fs.readFileSync(target, 'utf8');
if (unescape) {
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

const i = text.indexOf(needle);
if (i === -1) {
  console.error(`needle not found: ${needle}`);
  process.exit(2);
}
console.log(text.slice(Math.max(0, i - before), Math.min(text.length, i + after)));
