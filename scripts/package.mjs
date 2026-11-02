import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = await readdir(root, { withFileTypes: true });
const files = entries.filter(entry => entry.isFile() && (
  /\.(js|html|css)$/.test(entry.name) || ['manifest.json', 'README.md', 'README.de.md'].includes(entry.name)
)).map(entry => entry.name);
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(name); else files.push(name);
  }
}
await collect('icons');
await collect('_locales');
await collect('docs');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const needed of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page || manifest.options_ui?.page, ...Object.values(manifest.icons || {})].filter(Boolean)) {
  if (!files.includes(needed)) throw new Error(`Paketdatei fehlt: ${needed}`);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const localParts = [], centralParts = [];
let offset = 0;
for (const file of files.sort()) {
  const name = Buffer.from(file, 'utf8');
  const data = await readFile(path.join(root, file));
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(centralParts), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const output = path.join(root, '..', 'tab-session-keeper.zip');
const bytes = Buffer.concat([...localParts, directory, end]);
await writeFile(output, bytes);
const versioned = path.join(root, '..', `tab-session-keeper-${manifest.version}.zip`);
await writeFile(versioned, bytes);
console.log(`Erstellt: ${output} (${files.length} Dateien)`);
console.log(`Versioniert: ${versioned}`);
