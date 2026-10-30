import { lstat, realpath, readFile, writeFile, rename, mkdir, cp, readdir, readlink, access } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const insideUpdatePath = (root, path) => { const part = relative(resolve(root), resolve(path)); return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
export async function updateFileHash(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
export async function applicationInventory(root) {
  const files = []; const resolved = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw Error('Application directory is a link');
  const walk = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), name = relative(root, file), info = await lstat(file);
      if (!insideUpdatePath(root, file)) throw Error('Invalid application path');
      if (info.isSymbolicLink()) {
        const link = await readlink(file), target = resolve(dirname(file), link);
        if (isAbsolute(link) || !insideUpdatePath(resolved, target) || !insideUpdatePath(resolved, await realpath(file))) throw Error('Application link escapes package');
        files.push({ name, link });
      } else if (info.isDirectory()) await walk(file);
      else if (info.isFile()) files.push({ name, bytes: info.size, sha256: await updateFileHash(file) });
      else throw Error('Unsupported application file');
    }
  };
  await walk(root); return files;
}
export async function verifyApplicationInventory(root, expected) {
  const actual = await applicationInventory(root), byName = new Map(expected.map(file => [file.name, file]));
  if (!expected.length || actual.length !== expected.length) throw Error('Application file inventory changed');
  for (const file of actual) { const old = byName.get(file.name); if (!old || file.sha256 !== old.sha256 || file.bytes !== old.bytes || file.link !== old.link) throw Error('Application file changed: ' + file.name); }
}
export async function assertUpdateJob(job) {
  if (job?.format !== 'rpen-update-job' || !/^[a-f0-9-]{36}$/.test(job.id) || !/^[a-f0-9]{64}$/.test(job.token)) throw Error('Invalid update job');
  if (!Number.isSafeInteger(job.pid) || job.pid <= 0) throw Error('Invalid editor process');
  for (const key of ['directory', 'target', 'source', 'replacement', 'backup', 'executable']) if (!isAbsolute(job[key] ?? '')) throw Error('Update path must be absolute');
  const parent = await realpath(dirname(job.target));
  if (resolve(dirname(job.target)) !== parent || job.target === parent || !basename(job.target).trim() || !insideUpdatePath(job.directory, job.source) || !insideUpdatePath(parent, job.replacement) || !insideUpdatePath(parent, job.backup)) throw Error('Unsafe update location');
  if (dirname(job.replacement) !== parent || dirname(job.backup) !== parent || basename(job.replacement) !== `.rpen-new-${job.id}` || basename(job.backup) !== `.rpen-previous-${job.id}` || !insideUpdatePath(job.target, job.executable)) throw Error('Unsafe update transaction');
  if (insideUpdatePath(job.target, job.directory) || insideUpdatePath(job.source, job.target) || job.source === job.target) throw Error('Update overlaps current application');
  for (const path of [job.directory, job.source, job.target]) if ((await lstat(path)).isSymbolicLink() || resolve(path) !== await realpath(path)) throw Error('Update directory is a link');
  const marker = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8'));
  if (marker.token !== job.token || marker.target !== job.target || marker.id !== job.id || marker.source !== job.source || marker.executable !== job.executable || marker.replacement !== job.replacement || marker.backup !== job.backup) throw Error('Update job identity changed');
  await access(parent, constants.W_OK); return job;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(action, attempts = 35) { for (let i = 0; ; i++) { try { return await action(); } catch (error) { if (i >= attempts || !['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; await delay(200); } } }
export async function ensureWindowsApplicationAccess(root) {
  if (process.platform !== 'win32') return;
  // A ZIP extraction/copy does not carry the original directory ACL. Electron
  // sandbox processes need read/execute access to the new application itself.
  const child = spawn('icacls.exe', [root, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/Q'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(Error('Cannot prepare application sandbox access'))); });
}
export async function replaceApplication(job, { launch, fault = async () => {} } = {}) {
  await assertUpdateJob(job); await verifyApplicationInventory(job.source, job.files);
  await mkdir(job.replacement, { recursive: false, mode: 0o700 });
  await cp(job.source, job.replacement, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: false, preserveTimestamps: true });
  await ensureWindowsApplicationAccess(job.replacement);
  await verifyApplicationInventory(job.replacement, job.files); await fault('beforeSwap');
  // Renames keep the complete old directory intact, including any user files.
  await retry(() => rename(job.target, job.backup));
  let installed = false;
  try {
    await fault('afterBackup'); await retry(() => rename(job.replacement, job.target)); installed = true;
    await fault('afterInstall'); await launch?.(job.executable, job); return { installed: true, backup: job.backup };
  } catch (error) {
    if (installed) await retry(() => rename(job.target, job.replacement));
    await retry(() => rename(job.backup, job.target)); throw error;
  }
}
async function runHelper(path) {
  const job = JSON.parse(await readFile(path, 'utf8')); await assertUpdateJob(job);
  await writeFile(join(job.directory, 'helper-ready.json'), JSON.stringify({ token: job.token, pid: process.pid }), { flag: 'wx' });
  let exited = false;
  for (let i = 0; i < 900; i++) { try { process.kill(job.pid, 0); } catch (error) { if (error.code === 'ESRCH') { exited = true; break; } throw error; } await delay(100); }
  if (!exited) throw Error('Editor is still running; update retained');
  const approved = await readFile(join(job.directory, 'install-approved.json'), 'utf8').then(JSON.parse).catch(() => null);
  const canceled = await readFile(join(job.directory, 'install-canceled.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (approved?.token !== job.token || canceled?.token === job.token) throw Error('Restart was canceled; update retained');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.RPE_UPDATE_TEST;
  const launch = async executable => {
    const child = spawn(executable, ['--rpen-update-job=' + path], { cwd: dirname(executable), env, detached: true, windowsHide: true, stdio: 'ignore' });
    let exitReason;
    child.once('exit', (code, signal) => { exitReason = signal ?? code; });
    await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); }); child.unref();
    for (let i = 0; i < 600; i++) {
      const ready = await readFile(join(job.directory, 'app-ready.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (ready?.token === job.token) return;
      try { process.kill(child.pid, 0); } catch (error) { if (error.code === 'ESRCH') throw Error('Updated editor exited before startup completed (' + exitReason + ')'); }
      await delay(200);
    }
    // Do not kill a live editor or roll back underneath it merely because its
    // library takes longer to initialize. Both the old app and package remain.
    await writeFile(join(job.directory, 'startup-pending.json'), JSON.stringify({ token: job.token }));
  };
  try {
    const result = await replaceApplication(job, { launch }); await writeFile(join(job.directory, 'result.json'), JSON.stringify({ token: job.token, ...result }));
  } catch (error) {
    await writeFile(join(job.directory, 'result.json'), JSON.stringify({ token: job.token, error: error.message }));
    const child = spawn(job.executable, [], { cwd: dirname(job.executable), env, detached: true, windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runHelper(process.argv[2]).catch(async error => { try { await writeFile(join(dirname(process.argv[2]), 'helper-error.txt'), error.stack); } catch {} process.exitCode = 1; });
