import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const jit = 'com.apple.security.cs.allow-jit';
const libraryValidation = 'com.apple.security.cs.disable-library-validation';
const unsignedMemory = 'com.apple.security.cs.allow-unsigned-executable-memory';
// Preserve osx-sign's main-process capabilities when overriding its defaults.
const mainCapabilities = [
  'com.apple.security.device.audio-input', 'com.apple.security.device.bluetooth',
  'com.apple.security.device.camera', 'com.apple.security.device.print',
  'com.apple.security.device.usb', 'com.apple.security.personal-information.location',
  'com.apple.security.personal-information.photos-library'
];

export function macOSAdHocSignOptions() {
  return {
    identity: '-', identityValidation: false, continueOnError: false,
    optionsForFile: path => ({
      hardenedRuntime: true, timestamp: 'none',
      // Ad-hoc signatures have no Team ID. Hardened Runtime would otherwise
      // reject Electron Framework before any JavaScript can run.
      entitlements: [jit, libraryValidation,
        ...(path.includes('(Plugin).app') ? [unsignedMemory] :
          path.includes('(GPU).app') || path.includes('(Renderer).app') ? [] : mainCapabilities)]
    })
  };
}

export async function verifyMacOSAdHocSigning(bundle, { exec = execFileSync } = {}) {
  exec('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
  const processes = [bundle];
  async function findHelpers(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // Do not follow framework symlinks.
      const path = join(directory, entry.name);
      if (entry.name.endsWith('.app')) processes.push(path);
      await findHelpers(path);
    }
  }
  await findHelpers(join(bundle, 'Contents/Frameworks'));
  if (processes.length < 2) throw Error('Missing Electron helper applications: ' + bundle);
  for (const path of processes) {
    const xml = exec('codesign', ['--display', '--entitlements', ':-', path], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const entitlements = JSON.parse(exec('plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    for (const key of [jit, libraryValidation]) {
      if (entitlements[key] !== true) throw Error('Missing ad-hoc signing entitlement ' + key + ': ' + path);
    }
    if (path.includes('(Plugin).app') && entitlements[unsignedMemory] !== true) throw Error('Missing plugin executable-memory entitlement: ' + path);
    if (path === bundle && entitlements[mainCapabilities[0]] !== true) throw Error('Missing microphone entitlement: ' + path);
  }
  return processes.length;
}
