import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const run = (contents, fn, ...args) => contents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true);

export async function prepareNative(contents) {
  await run(contents, async () => {
    const { createChart } = await import('/src/core/chart.mjs');
    const { builtinEditorSkins } = await import('/src/platform/editor-skins.mjs');
    const { builtinMods } = await import('/src/platform/mods.mjs');
    const put = async (name, stores, records) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => { for (const [store, keyed] of stores) request.result.createObjectStore(store, keyed ? { keyPath: 'id' } : undefined); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try { await new Promise((resolve, reject) => {
        const tx = db.transaction(stores.map(([store]) => store), 'readwrite');
        for (const [store, value, key] of records) key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      }); } finally { db.close(); }
    };
    const chart = createChart(); chart.META.name = '迁移测试'; chart.META.background = 'cover.png'; chart['x-native-test'] = { preserved: true };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; canvas.getContext('2d').fillRect(0, 0, 16, 16);
    const cover = await new Promise(resolve => canvas.toBlob(resolve));
    const music = new Uint8Array(4 * 1024 * 1024); music[123] = 42;
    await put('rpe-next-library', [['projects', true], ['summaries', true], ['revisions', true], ['preferences', false]], [
      ['projects', { id: 'native-migration-project', chart, chartName: 'chart.json', assets: [['music.bin', new Blob([music])], ['cover.png', new Uint8Array(await cover.arrayBuffer())]], imported: Date.now() }],
      ['summaries', { id: 'native-migration-project', thumbnail: cover }],
      ['preferences', { marker: 'library-preferences' }, 'current'],
    ]);
    await put('rpe-next-recovery', [['drafts', true]], [['drafts', { id: 'native-migration-draft', projectId: 'native-migration-project', name: 'draft', chart, assets: [['music.bin', new Blob([music])]], updated: Date.now() }]]);
    const skin = (await builtinEditorSkins())[0];
    const files = new Map(skin.files), manifest = JSON.parse(new TextDecoder().decode(files.get('skin.json'))); manifest.id = 'native-migration-skin'; manifest.name = 'Native Migration Skin';
    files.set('skin.json', new TextEncoder().encode(JSON.stringify(manifest)));
    await put('rpe-next-editor-skins', [['packages', true]], [['packages', { id: manifest.id, files: [...files] }]]);
    const mod = (await builtinMods())[0], modFiles = new Map(mod.files), modManifest = JSON.parse(new TextDecoder().decode(modFiles.get('mod.json'))); modManifest.id = 'native-migration-mod';
    modFiles.set('mod.json', new TextEncoder().encode(JSON.stringify(modManifest)));
    await put('rpe-next-mods', [['packages', true]], [['packages', { id: modManifest.id, files: [...modFiles] }]]);
    // The package store must preserve arbitrary package data, including original files.
    const { NOTE_SKIN_IMAGES } = await import('/src/core/note-skin.mjs');
    const png = new Uint8Array(await cover.arrayBuffer());
    const noteFiles = [['info.yml', new TextEncoder().encode('name: Native Note Test\nauthor: Test\nhitFx: [1, 1]\nholdAtlas: [4, 4]\nholdAtlasMH: [4, 4]\n')], ...NOTE_SKIN_IMAGES.map(name => [name, png])];
    await put('rpe-next-note-skins', [['packages', true]], [['packages', { id: 'pack-123456789012345678901234', files: noteFiles, originalFiles: [...noteFiles, ['marker', new Uint8Array([9])]] }]]);
    localStorage.setItem('rpe-next-editor-v1', JSON.stringify({ lineScale: 2.3, judgementColor: '#fedcba' }));
    localStorage.setItem('rpe-collab-name', 'Native Tester');
  });
}

export async function smokeNative(contents, service, controls) {
  const checks = [], restart = process.env.RPE_NATIVE_TEST_PHASE === 'restart';
  await run(contents, async () => {
    const deadline = Date.now() + 30000;
    while (!window.rpenMods) { if (Date.now() > deadline) throw Error('App startup timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
    await window.rpenMods.manager.ready;
  });
  const builtins = await run(contents, async () => {
    const { builtinNoteSkins } = await import('/src/platform/note-skins.mjs');
    const { ResourceNoteSkin } = await import('/src/ui/resource-note-skin.mjs');
    const records = await builtinNoteSkins();
    for (const record of records) {
      const runtime = await ResourceNoteSkin.prepare(record, (key, image) => image);
      runtime.dispose();
    }
    return records.map(record => ({ id: record.id, files: record.files.size }));
  });
  assert.ok(builtins.length > 0); assert.ok(builtins.every(record => record.files > 0));
  checks.push('built-in note skin files and images load through the packaged application protocol');
  const storageSettings = await run(contents, () => {
    const panel = document.querySelector('#storage-settings');
    return {
      count: document.querySelectorAll('#storage-settings').length,
      category: panel?.closest('[data-settings-section]')?.dataset.settingsSection,
      navigation: Boolean(document.querySelector('[data-settings-target="storage"]')),
      missingControls: ['storage-refresh', 'library-export-all', 'storage-recovery-manage', 'storage-open-root',
        'storage-move-root', 'storage-backup-folder', 'storage-trash', 'storage-use-root', 'storage-rebuild', 'storage-collect']
        .filter(id => !panel?.querySelector('#' + id))
    };
  });
  assert.equal(storageSettings.count, 1, 'Native storage settings must be present exactly once');
  assert.equal(storageSettings.category, 'storage', 'Native storage settings must belong to the storage navigation category');
  assert.equal(storageSettings.navigation, true, 'Native storage settings must have a navigation entry');
  assert.deepEqual(storageSettings.missingControls, [], 'Native storage and backup controls must remain available');
  checks.push('storage and backup controls appear in the storage navigation category');
  const migration = await run(contents, async () => {
    const library = await import('/src/platform/library.mjs'), recovery = await import('/src/platform/recovery.mjs');
    const { readEditorSkins } = await import('/src/platform/editor-skins.mjs'), { readNoteSkins } = await import('/src/platform/note-skins.mjs'), { readMods } = await import('/src/platform/mods.mjs');
    const { readEditorPreferences } = await import('/src/platform/editor-preferences.mjs'), { localPreferences } = await import('/src/platform/local-preferences.mjs');
    const project = await library.readProject('native-migration-project'), draft = await recovery.readDraft('native-migration-draft');
    const summary = (await library.listProjects()).find(item => item.id === project.id);
    const legacy = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rpe-next-library'); request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('projects'), read = tx.objectStore('projects').get('native-migration-project'); read.onsuccess = () => { resolve(read.result.chart.META.name); db.close(); }; };
    });
    return { name: project.chart.META.name, unknown: project.chart['x-native-test'].preserved, music: project.assets[0][1] instanceof Uint8Array && project.assets[0][1][123] === 42, draft: draft.assets[0][1][123] === 42, thumbnail: summary.thumbnail instanceof Blob && summary.thumbnail.size > 0, editorSkin: (await readEditorSkins()).some(item => item.id === 'native-migration-skin'), noteSkin: (await readNoteSkins())[0].originalFiles.find(([name]) => name === 'marker')[1][0], mod: (await readMods()).some(item => item.id === 'native-migration-mod'), prefs: (await library.readPreferences()).marker, lineScale: readEditorPreferences().lineScale, nickname: localPreferences.getItem('rpe-collab-name'), legacy };
  });
  assert.equal(migration.unknown, true); assert.equal(migration.music, true); assert.equal(migration.draft, true); assert.equal(migration.thumbnail, true);
  assert.equal(migration.editorSkin, true); assert.equal(migration.noteSkin, 9); assert.equal(migration.mod, true); assert.equal(migration.prefs, 'library-preferences'); assert.equal(migration.lineScale, 2.3); assert.equal(migration.nickname, 'Native Tester'); assert.equal(migration.legacy, '迁移测试');
  assert.equal(migration.name, restart ? '原生存储的新版本' : '迁移测试'); checks.push('legacy projects, binary media, unknown fields, drafts, packages and UI settings migrated; legacy data retained');
  if (!restart) {
    const result = await run(contents, async () => {
      const library = await import('/src/platform/library.mjs'), { localPreferences, flushLocalPreferences } = await import('/src/platform/local-preferences.mjs');
      const project = await library.readProject('native-migration-project'); project.chart.META.name = '原生存储的新版本';
      let ticks = 0; const timer = setInterval(() => ticks++, 2);
      try { await library.storeProject(project); } finally { clearInterval(timer); }
      const stale = { ...project }; await library.storeProject(project);
      let conflict = false; try { await library.storeProject(stale); } catch (error) { conflict = error.name === 'ProjectConflictError'; }
      localPreferences.setItem('rpe-next-native-restart-test', 'persistent'); await flushLocalPreferences();
      const { nativeStorage } = await import('/src/platform/native.mjs');
      const root = (await nativeStorage.call('status')).root;
      document.querySelector('#settings-modal').showModal();
      const deadline = performance.now() + 15000;
      while (!document.querySelector('#storage-status').textContent.includes(root)) {
        if (performance.now() > deadline) throw Error('Native storage status did not show the library path: ' + document.querySelector('#storage-status').textContent);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return { ticks, conflict, root, status: document.querySelector('#storage-status').textContent, persistHidden: document.querySelector('#storage-persist').hidden, controls: ['storage-open-root', 'storage-move-root', 'storage-backup-folder', 'storage-trash', 'storage-rebuild', 'storage-collect'].every(id => document.getElementById(id)), revision: project.storageRevision };
    });
    assert.ok(result.ticks > 0); assert.ok(result.conflict); assert.ok(result.controls); assert.ok(result.persistHidden); assert.ok(result.status.includes(result.root));
    checks.push('real preload IPC saves asynchronously, detects stale snapshots and exposes native storage controls');
    const fixtureId = await run(contents, async () => {
      document.querySelector('#settings-modal').close(); document.querySelector('#new').click(); document.querySelector('#metadata').click();
      const button = document.querySelector('#open-project-folder');
      if (button.hidden || !button.disabled) throw Error('Unsaved project folder button state');
      await window.rpenMods.editor.save();
      if (button.disabled) throw Error('Saved project folder button disabled');
      return window.rpenMods.editor.libraryProject.id;
    });
    const folder = await service.call('projectFolder', fixtureId);
    const opened = await controls.openedFolders(async () => {
      await run(contents, async () => {
        const name = document.querySelector('#metadata-editor input'); name.value = '尚未应用的名称';
        document.querySelector('#open-project-folder').click(); await new Promise(resolve => setTimeout(resolve, 100));
        if (name.value !== '尚未应用的名称') throw Error('Opening folder overwrote metadata draft');
      });
    });
    assert.deepEqual(opened, [folder]);
    await run(contents, async () => {
      const editor = window.rpenMods.editor; editor.raw.setHome(true);
      const deadline = Date.now() + 5000;
      let card;
      while (!(card = [...document.querySelectorAll('.project-card')].find(node => node.querySelector('h2').textContent === '原生存储的新版本'))) {
        if (Date.now() > deadline) throw Error('Saved project card not found'); await new Promise(resolve => setTimeout(resolve, 20));
      }
      card.querySelector('.project-open').click();
      while (editor.libraryProject?.id !== 'native-migration-project') { if (Date.now() > deadline) throw Error('Saved project load timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
      document.querySelector('#metadata').click();
      if (document.querySelector('#open-project-folder').disabled) throw Error('Existing saved project folder disabled after loading');
      editor.raw.setHome(true);
    });
    checks.push('metadata folder button enables after saving and opens the saved project folder without replacing typed metadata');
    await run(contents, async () => {
      const library = await import('/src/platform/library.mjs');
      const project = await library.readProject('native-migration-project');
      project.assets[0][1][124] = 73; await library.storeProject(project);
      if ((await library.readProject(project.id)).assets[0][1][124] !== 73) throw Error('Mutable bytes were incorrectly reused');
    });
    checks.push('in-place binary changes are saved rather than mistaken for cached immutable assets');
    const root = (await service.call('status')).root;
    const copied = await service.call('copyTo', join(root, '..', 'independent-backup'));
    assert.ok(await readFile(join(copied.root, 'library.json'))); checks.push('verified independent library backup written');
    await contents.executeJavaScript(`(async()=>{document.querySelector('#settings-modal').close();await import('/src/platform/local-preferences.mjs').then(module=>module.flushLocalPreferences());})()`);
    // Reload must neither overwrite newer native data nor restart completed migration.
    await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload(); });
    await run(contents, async () => { while (!window.rpenMods) await new Promise(resolve => setTimeout(resolve, 20)); const library = await import('/src/platform/library.mjs'); if ((await library.readProject('native-migration-project')).chart.META.name !== '原生存储的新版本') throw Error('Migration overwrote native changes'); });
    checks.push('reload resumes safely without replaying stale legacy records');
    await writeFile(join(root, '..', 'native-test-complete.json'), JSON.stringify({ revision: result.revision }));
    const moved = await controls.selectFolder(join(root, '..', 'moved'), () => run(contents, async () => (await import('/src/platform/native.mjs')).nativeStorage.call('chooseRoot')));
    assert.ok(moved.root.endsWith('RPENLibrary')); assert.ok(await readFile(join(root, 'library.json')));
    assert.equal((await controls.service().call('read', 'projects', 'native-migration-project')).data.chart.META.name, '原生存储的新版本');
    const returned = await controls.selectFolder(root, () => run(contents, async () => (await import('/src/platform/native.mjs')).nativeStorage.call('useRoot')));
    assert.equal(returned.root, root);
    checks.push('privileged folder migration switches the worker and config safely, preserves source and can reopen an existing library');
  } else {
    assert.equal(await run(contents, async () => (await import('/src/platform/local-preferences.mjs')).localPreferences.getItem('rpe-next-native-restart-test')), 'persistent');
    checks.push('full desktop restart rereads native project and UI settings');
    assert.equal(await run(contents, () => Number(document.querySelector('#default-line-thickness').value)), 2.3);
    checks.push('editor display settings are applied automatically after starting another executable directory');
    await run(contents, async () => {
      const { readProject, deleteProject, listProjects } = await import('/src/platform/library.mjs');
      const project = await readProject('native-migration-project'); await deleteProject(project.id, project.storageRevision);
      if ((await listProjects()).some(item => item.id === project.id)) throw Error('Trash item still listed');
      document.querySelector('#settings-modal').showModal(); document.querySelector('#storage-trash').click();
    });
    await run(contents, async () => { while (!document.querySelector('.storage-draft-row button')) await new Promise(resolve => setTimeout(resolve, 20)); document.querySelector('.storage-draft-row button').click(); });
    await run(contents, async () => { const library = await import('/src/platform/library.mjs'); const deadline = Date.now() + 5000; while (!(await library.readProject('native-migration-project'))) { if (Date.now() > deadline) throw Error('Restore timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } });
    checks.push('native trash UI restores project and media');
  }
  if (process.env.RPE_NATIVE_TEST_PHASE !== 'restart') checks.push(...(await (await import('./smoke-asset-library.mjs')).smokeAssetLibrary(contents, controls.service(), controls)).checks);
  return { checks, migration, storage: await controls.service().call('status') };
}
