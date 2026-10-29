import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { macOSAdHocSignOptions, verifyMacOSAdHocSigning } from '../tools/macos-signing.mjs';

const jit = 'com.apple.security.cs.allow-jit';
const libraryValidation = 'com.apple.security.cs.disable-library-validation';
const unsignedMemory = 'com.apple.security.cs.allow-unsigned-executable-memory';
const microphone = 'com.apple.security.device.audio-input';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'rpen-macos-signing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'RePhiEdit Next.app');
  const helpers = ['Helper', 'Helper (GPU)', 'Helper (Renderer)', 'Helper (Plugin)'].map(name => join(bundle, 'Contents/Frameworks', 'RePhiEdit Next ' + name + '.app'));
  for (const path of helpers) await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
  return { root, bundle, helpers };
}

function signedMetadata(overrides = new Map()) {
  const options = macOSAdHocSignOptions(), inspected = [];
  return {
    inspected,
    exec(program, args, settings) {
      if (program === 'codesign') {
        if (args[0] === '--verify') { assert.deepEqual(args.slice(0, 3), ['--verify', '--deep', '--strict']); return ''; }
        assert.deepEqual(args.slice(0, 3), ['--display', '--entitlements', ':-']);
        const path = args.at(-1); inspected.push(path);
        const entitlements = Object.fromEntries(options.optionsForFile(path).entitlements.map(key => [key, true]));
        return JSON.stringify({ ...entitlements, ...overrides.get(path) });
      }
      assert.equal(program, 'plutil');
      assert.deepEqual(args, ['-convert', 'json', '-o', '-', '--', '-']);
      // Stand in for macOS's XML-to-JSON conversion while checking that the
      // verifier inspects codesign's actual output, not the signing options.
      return settings.input;
    }
  };
}

test('临时签名为主程序与 Helper 配置 library validation 例外并保留 JIT、录音和 Plugin 权限', () => {
  const options = macOSAdHocSignOptions();
  assert.equal(options.identity, '-'); assert.equal(options.continueOnError, false);
  for (const name of ['Next.app', 'Helper.app', 'Helper (GPU).app', 'Helper (Renderer).app', 'Helper (Plugin).app']) {
    const signing = options.optionsForFile('/package/' + name);
    assert.equal(signing.hardenedRuntime, true);
    assert.ok(signing.entitlements.includes(jit), name);
    assert.ok(signing.entitlements.includes(libraryValidation), name);
    assert.equal(signing.entitlements.includes(unsignedMemory), name.includes('(Plugin)'));
  }
  assert.ok(options.optionsForFile('/package/Next.app').entitlements.includes(microphone));
});

test('签名验证读取每个进程的实际 entitlements，并跳过框架符号链接', async context => {
  const { root, bundle, helpers } = await fixture(context), runner = signedMetadata();
  const framework = join(bundle, 'Contents/Frameworks/Electron Framework.framework');
  await mkdir(framework);
  const linked = join(root, 'linked-framework');
  await mkdir(join(linked, 'Unexpected Helper.app/Contents/MacOS'), { recursive: true });
  // A directory junction does not require Windows symbolic-link privileges.
  // The linked helper must not be followed or included in the signed processes.
  await symlink(linked, join(framework, 'Versions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await verifyMacOSAdHocSigning(bundle, runner), 5);
  assert.deepEqual(new Set(runner.inspected), new Set([bundle, ...helpers]));
});

test('即使 codesign --verify 成功，主程序缺少 library validation 例外也必须拒绝发布', async context => {
  const { bundle } = await fixture(context);
  const runner = signedMetadata(new Map([[bundle, { [libraryValidation]: false }]]));
  await assert.rejects(verifyMacOSAdHocSigning(bundle, runner), /Missing ad-hoc signing entitlement com.apple.security.cs.disable-library-validation/);
});

test('主程序正常时仍拒绝缺少 library validation 例外的 Renderer Helper', async context => {
  const { bundle, helpers } = await fixture(context);
  const runner = signedMetadata(new Map([[helpers[2], { [libraryValidation]: undefined }]]));
  await assert.rejects(verifyMacOSAdHocSigning(bundle, runner), /disable-library-validation.*Helper \(Renderer\)/);
});

test('签名验证拒绝遗失的 JIT、Plugin 执行内存或主程序麦克风权限', async context => {
  const { bundle, helpers } = await fixture(context);
  for (const [path, key, message] of [[helpers[1], jit, /allow-jit/], [helpers[3], unsignedMemory, /plugin executable-memory/], [bundle, microphone, /microphone/]]) {
    await assert.rejects(verifyMacOSAdHocSigning(bundle, signedMetadata(new Map([[path, { [key]: false }]]))), message);
  }
});

test('签名损坏立即失败，不将其标记为已验证', async context => {
  const { bundle } = await fixture(context);
  await assert.rejects(verifyMacOSAdHocSigning(bundle, { exec: () => { throw Error('code object is not signed at all'); } }), /not signed at all/);
});

test('发布检查拒绝没有最终 DMG 安装与签名验证记录的旧 macOS 构建', async context => {
  const { root } = await fixture(context), sourceCommit = 'a'.repeat(40);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const macOSVerification of [undefined, { signedProcesses: 5 }, { signedProcesses: 0, installedFromDmg: true }]) {
    await writeFile(join(root, 'macos.json'), JSON.stringify({
      kind: 'editor', platform: 'darwin', arch: 'arm64', version,
      sourceCommit, verified: true, sourceFilesVerified: 1, macOSVerification
    }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/verify-release-assets.mjs', import.meta.url)), root, sourceCommit], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing macOS signing or installed DMG verification/);
  }
});
