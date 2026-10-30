import { open, mkdir, lstat, readdir, readFile, realpath, chmod, symlink, statfs } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { insideUpdatePath, updateFileHash, applicationInventory, ensureWindowsApplicationAccess } from './update-install.mjs';

const MAX_EXPANDED = 8 * 1024 ** 3, MAX_FILES = 100000;
export function updateEntryName(value) {
  if (typeof value !== 'string' || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value) || value.startsWith('/') || value.length > 2048) throw Error('Unsafe archive entry');
  const name = value.replace(/\/$/, '');
  if (!name || name.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('Unsafe archive path');
  return name;
}
async function destination(root, name, directory = false) {
  const file = join(root, updateEntryName(name));
  if (!insideUpdatePath(root, file)) throw Error('Archive path escapes output');
  await mkdir(directory ? file : dirname(file), { recursive: true, mode: 0o700 });
  // No extracted symlink may ever act as the parent of a later entry.
  let parent = directory ? file : dirname(file);
  while (parent !== root) { if ((await lstat(parent)).isSymbolicLink()) throw Error('Archive link used as directory'); parent = dirname(parent); }
  return file;
}
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function checkedBytes(size, crc) {
  let count = 0, sum = 0xffffffff;
  return new Transform({ transform(bytes, encoding, callback) {
    count += bytes.length; if (count > size) return callback(Error('Archive expands beyond declared size'));
    for (const byte of bytes) sum = crcTable[(sum ^ byte) & 255] ^ (sum >>> 8);
    callback(null, bytes);
  }, flush(callback) { callback(count !== size || ((sum ^ 0xffffffff) >>> 0) !== crc ? Error('Archive checksum mismatch') : null); } });
}
async function exactRead(file, length, position) {
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const result = await file.read(bytes, offset, length - offset, position + offset); if (!result.bytesRead) throw Error('Truncated archive'); offset += result.bytesRead; }
  return bytes;
}
async function space(root, bytes) { const disk = await statfs(root); if (Number(disk.bavail) * Number(disk.bsize) < bytes + 128 * 1024 ** 2) throw Object.assign(Error('Not enough disk space'), { code: 'UPDATE_SPACE' }); }
export async function extractUpdateZip(archive, output, progress = () => {}) {
  const file = await open(archive, 'r');
  try {
    const size = (await file.stat()).size, tail = await exactRead(file, Math.min(size, 65557), Math.max(0, size - 65557));
    let at = tail.length - 22;
    while (at >= 0 && (tail.readUInt32LE(at) !== 0x06054b50 || at + 22 + tail.readUInt16LE(at + 20) !== tail.length)) at--;
    if (at < 0 || tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6)) throw Error('Invalid ZIP directory');
    const count = tail.readUInt16LE(at + 10), length = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16);
    if (count === 65535 || count > MAX_FILES || tail.readUInt16LE(at + 8) !== count || length > 64 * 1024 ** 2 || start + length > size - tail.length + at) throw Error('Unsupported ZIP directory');
    const central = await exactRead(file, length, start), entries = [], names = new Set(); let offset = 0, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid ZIP entry');
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), crc = central.readUInt32LE(offset + 16), packed = central.readUInt32LE(offset + 20), bytes = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28), extra = central.readUInt16LE(offset + 30), comment = central.readUInt16LE(offset + 32), mode = central.readUInt32LE(offset + 38) >>> 16, local = central.readUInt32LE(offset + 42);
      if (offset + 46 + nameLength + extra + comment > central.length || flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || packed === 0xffffffff || bytes === 0xffffffff) throw Error('Unsupported ZIP file');
      const rawName = new TextDecoder('utf-8', { fatal: true }).decode(central.subarray(offset + 46, offset + 46 + nameLength));
      const name = updateEntryName(rawName), directory = rawName.endsWith('/');
      if (names.has(name.toLowerCase())) throw Error('Duplicate ZIP path'); names.add(name.toLowerCase());
      if (directory && (bytes || packed)) throw Error('Invalid ZIP directory size');
      expanded += bytes; if (expanded > MAX_EXPANDED || local + 30 + packed > start) throw Error('Invalid ZIP size');
      entries.push({ name, rawName, directory, flags, method, crc, packed, bytes, local }); offset += 46 + nameLength + extra + comment;
    }
    if (offset !== central.length) throw Error('Invalid ZIP directory length');
    await space(output, expanded * 2);
    let completed = 0;
    for (const entry of entries) {
      const header = await exactRead(file, 30, entry.local);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== entry.method) throw Error('ZIP header mismatch');
      const length = header.readUInt16LE(26), data = entry.local + 30 + length + header.readUInt16LE(28);
      if (data + entry.packed > start || new TextDecoder('utf-8', { fatal: true }).decode(await exactRead(file, length, entry.local + 30)) !== entry.rawName) throw Error('ZIP path mismatch');
      const target = await destination(output, entry.name, entry.directory);
      if (!entry.directory) {
        const source = entry.packed ? createReadStream(archive, { start: data, end: data + entry.packed - 1 }) : Readable.from([]);
        await pipeline(...[source, entry.method === 8 ? createInflateRaw() : null, checkedBytes(entry.bytes, entry.crc), createWriteStream(target, { flags: 'wx', mode: 0o600 })].filter(Boolean));
      }
      progress(++completed / entries.length);
    }
  } finally { await file.close(); }
}

async function run(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  child.stderr.on('data', bytes => { if (error.length < 2000) error += bytes; });
  await new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(Error('Update extraction command failed: ' + command))); });
}
function tarNumber(bytes) { const text = bytes.toString('ascii').replace(/\0.*$/, '').trim(); if (!/^[0-7]*$/.test(text)) throw Error('Invalid tar number'); const n = parseInt(text || '0', 8); if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid tar size'); return n; }
const tarString = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
export async function extractUpdateTar(archive, output, progress = () => {}, { decompress = archive => spawn('xz', ['-dc', '--', archive], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  const child = decompress(archive);
  const ended = new Promise((accept, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(Error('Invalid XZ archive'))); }); ended.catch(() => {});
  const iterator = child.stdout[Symbol.asyncIterator](); let pending = Buffer.alloc(0), expanded = 0, consumed = 0, count = 0, nextName, nextLink, pax = {}; const names = new Set(), links = [], directories = [];
  const take = async (n, sink) => {
    const chunks = []; while (n) {
      if (!pending.length) { const r = await iterator.next(); if (r.done) throw Error('Truncated tar'); pending = r.value; }
      const length = Math.min(n, pending.length), chunk = pending.subarray(0, length); pending = pending.subarray(length); n -= length; consumed += length;
      if (consumed > MAX_EXPANDED + 64 * 1024 ** 2) throw Error('Tar expands beyond limit');
      if (sink) await sink(chunk); else chunks.push(chunk);
    } return sink ? undefined : Buffer.concat(chunks);
  };
  try {
    for (;;) {
      const header = await take(512); if (header.every(byte => byte === 0)) break;
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (sum !== tarNumber(header.subarray(148, 156)) || ++count > MAX_FILES) throw Error('Invalid tar header');
      const prefix = tarString(header.subarray(345, 500)), base = tarString(header.subarray(0, 100));
      const type = String.fromCharCode(header[156] || 48), size = tarNumber(header.subarray(124, 136)), mode = tarNumber(header.subarray(100, 108)) & 0o777;
      if (['L', 'K', 'x', 'g'].includes(type)) {
        if (size > 65536 || type === 'g') throw Error('Unsupported tar extension');
        const content = await take(size); if (size % 512) await take(512 - size % 512);
        if (type === 'L') nextName = tarString(content); else if (type === 'K') nextLink = tarString(content);
        else { let at = 0; const fields = {}; while (at < content.length) { const end = content.indexOf(32, at), length = Number(content.subarray(at, end).toString()); if (end < at || !Number.isSafeInteger(length) || length <= end - at + 1 || at + length > content.length || content[at + length - 1] !== 10) throw Error('Invalid PAX entry'); const text = tarString(content.subarray(end + 1, at + length - 1)), eq = text.indexOf('='); if (eq < 1) throw Error('Invalid PAX field'); fields[text.slice(0, eq)] = text.slice(eq + 1); at += length; } pax = fields; }
        continue;
      }
      if (pax.size !== undefined && Number(pax.size) !== size) throw Error('Tar size override rejected');
      const name = updateEntryName(pax.path ?? nextName ?? (prefix ? prefix + '/' + base : base)), link = pax.linkpath ?? nextLink ?? tarString(header.subarray(157, 257));
      nextName = nextLink = undefined; pax = {};
      if (names.has(name)) throw Error('Duplicate tar path'); names.add(name);
      if (!['0', '5', '2'].includes(type) || (type !== '0' && size)) throw Error('Unsupported tar entry');
      expanded += size; if (expanded > MAX_EXPANDED) throw Error('Tar expands beyond limit');
      const target = await destination(output, name, type === '5');
      if (type === '5') directories.push({ target, mode });
      else if (type === '2') { const to = resolve(dirname(target), link); if (isAbsolute(link) || !insideUpdatePath(output, to)) throw Error('Tar link escapes package'); links.push({ target, link }); }
      else { await space(output, size * 2); const file = await open(target, 'wx', mode | 0o600); try { await take(size, bytes => file.writeFile(bytes)); } finally { await file.close(); } await chmod(target, mode); }
      if (size % 512) await take(512 - size % 512); progress(Math.min(.95, expanded / (800 * 1024 ** 2)));
    }
    // Drain trailing zero blocks so xz can exit without a full stdout pipe.
    let padding = 0;
    for (;;) {
      padding += pending.length; if (padding > 1024 ** 2 || pending.some(byte => byte !== 0)) throw Error('Invalid tar trailer');
      const next = await iterator.next(); if (next.done) break; pending = next.value;
    }
    await ended;
    for (const entry of links) await symlink(entry.link, entry.target);
    for (const entry of links) if (!insideUpdatePath(output, await realpath(entry.target))) throw Error('Tar link escapes package');
    for (const entry of directories.reverse()) await chmod(entry.target, entry.mode);
  } finally { if (child.exitCode === null) child.kill(); }
}

export function updateApplicationPaths(root, platform) {
  const mac = platform === 'darwin';
  return { executable: join(root, mac ? 'Contents/MacOS/RePhiEdit-Next' : platform === 'win32' ? 'RePhiEdit-Next.exe' : 'RePhiEdit-Next'), application: join(root, mac ? 'Contents/Resources/app' : 'resources/app') };
}
export async function validateUpdateApplication(root, release, platform, arch) {
  const paths = updateApplicationPaths(root, platform), metadata = JSON.parse(await readFile(join(paths.application, 'package.json'), 'utf8'));
  if (metadata.name !== 'rpe-next' || metadata.version !== release.version || metadata.main !== 'desktop/main.cjs' || !(await lstat(paths.executable)).isFile()) throw Error('Wrong application in update');
  const build = JSON.parse(await readFile(join(paths.application, 'build-info.json'), 'utf8'));
  if (build.version !== release.version || build.kind !== 'editor' || build.platform !== platform || build.arch !== arch) throw Error('Update platform mismatch');
  await lstat(join(paths.application, 'desktop/main.cjs'));
  if (platform !== 'win32') await chmod(paths.executable, (await lstat(paths.executable)).mode | 0o100);
  return paths;
}
export async function prepareUpdatePackage({ archive, sha256, release, platform, arch, output }, progress = () => {}) {
  if (await updateFileHash(archive) !== sha256) throw Object.assign(Error('Update checksum mismatch'), { code: 'UPDATE_CHECKSUM' });
  await mkdir(output, { recursive: false, mode: 0o700 });
  if (platform === 'win32') await extractUpdateZip(archive, output, progress);
  else if (platform === 'linux') await extractUpdateTar(archive, output, progress);
  else if (platform === 'darwin') {
    const mount = join(dirname(output), 'mount'); await mkdir(mount);
    await run('hdiutil', ['verify', archive]);
    let attached = false;
    try {
      await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, archive]);
      attached = true;
      const bundles = (await readdir(mount)).filter(name => name.endsWith('.app'));
      if (bundles.length !== 1) throw Error('Invalid macOS application image');
      await applicationInventory(join(mount, bundles[0]));
      await run('codesign', ['--verify', '--deep', '--strict', join(mount, bundles[0])]);
      await run('ditto', [join(mount, bundles[0]), join(output, bundles[0])]);
    } finally { if (attached) await run('hdiutil', ['detach', mount]); }
  } else throw Error('Unsupported update platform');
  const entries = await readdir(output, { withFileTypes: true }), folders = entries.filter(e => e.isDirectory());
  if (folders.length !== 1 || entries.length !== 1) throw Error('Invalid update package root');
  const source = join(output, folders[0].name); await validateUpdateApplication(source, release, platform, arch);
  if (platform === 'win32') await ensureWindowsApplicationAccess(source);
  return { source, files: await applicationInventory(source) };
}
