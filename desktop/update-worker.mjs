import { parentPort, workerData } from 'node:worker_threads';
import { prepareUpdatePackage } from './update-package.mjs';
import { verifyApplicationInventory, updateFileHash } from './update-install.mjs';
let last = 0;
try {
  let result;
  if (workerData.action === 'prepare') result = await prepareUpdatePackage(workerData, value => { const now = Date.now(); if (now - last > 150) { last = now; parentPort.postMessage({ progress: value }); } });
  else if (workerData.action === 'verify') { if (await updateFileHash(workerData.archive) !== workerData.sha256) throw Object.assign(Error('Update checksum mismatch'), { code: 'UPDATE_CHECKSUM' }); await verifyApplicationInventory(workerData.source, workerData.files); result = true; }
  else throw Error('Unsupported update task');
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: { code: error.code === 'UPDATE_SPACE' || error.code === 'UPDATE_CHECKSUM' ? error.code : 'UPDATE_PACKAGE' } }); }
