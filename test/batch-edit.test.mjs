import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createLine, createNote, createEvent, noteIsAbove } from '../src/core/chart.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { BATCH_ACTIONS, applyBatchAction, captureSelection, controlSelection, controlLineOffset, commitSelectionEdit, nudgeSelection } from '../src/application/batch-edit.mjs';
import { copyObjects, cutObjects, pasteObjects, projectClipboard } from '../src/application/clipboard.mjs';
import { eventList } from '../src/application/event-commands.mjs';
import { Timeline } from '../src/ui/timeline.mjs';
import { clipboardBeat, drawClipboard } from '../src/ui/clipboard-preview.mjs';
import { openFiles } from '../src/platform/files.mjs';
import { materializeProject } from '../src/platform/migration.mjs';
import { readZip, writeZip } from '../src/platform/archive.mjs';

function fixture() {
  const chart = createChart(); chart.judgeLineList.push(createLine('Target'));
  chart.judgeLineList[0].notes = [createNote(1, 2, -200), { ...createNote(2, 4, 100, 6), extra: { value: 9 } }];
  chart.judgeLineList[0].eventLayers[0].moveXEvents = [createEvent(20, 40, 1, 3), createEvent(40, 80, 4, 6)];
  const session = new EditorSession(chart); session.selection = new Set([0, 1]);
  return session;
}

test('混合复制以共同起点投影至鼠标拍数，跨线/层粘贴保留字段且一次撤销', () => {
  const session = fixture(); session.eventSelection.add('moveXEvents:0');
  assert.equal(copyObjects(session), 3);
  const projected = projectClipboard(session, 10);
  assert.deepEqual(projected.notes.map(note => beatValue(note.startTime)), [11, 13]);
  assert.deepEqual(projected.notes.map(note => note.positionX), [-200, 100]);
  assert.equal(beatValue(projected.events[0].event.startTime), 10);
  const original = session.chart;
  session.selectLine(1); session.eventLayer = 2;
  pasteObjects(session, 10);
  assert.deepEqual(session.notes, projected.notes);
  assert.deepEqual(eventList(session, 'moveXEvents'), [projected.events[0].event]);
  assert.equal(session.selection.size, 2); assert.equal(session.eventSelection.size, 1);
  assert.equal(session.history.undoStack.length, 1);
  assert.notEqual(session.notes[1].extra, session.clipboard[1].extra);
  session.travel('undo'); assert.equal(session.chart, original);
  session.travel('redo'); assert.deepEqual(session.notes, projected.notes);
});

test('混合剪切原子提交，无选中项时不清空剪贴板或增加历史', () => {
  const session = fixture(); session.eventSelection.add('moveXEvents:1'); const original = session.chart;
  assert.equal(cutObjects(session), 3);
  assert.equal(session.notes.length, 0); assert.equal(eventList(session, 'moveXEvents').length, 1);
  assert.equal(session.history.undoStack.length, 1);
  const clipboard = session.clipboard;
  assert.equal(copyObjects(session), 0); assert.equal(cutObjects(session), 0);
  assert.equal(session.clipboard, clipboard); assert.equal(session.history.undoStack.length, 1);
  session.travel('undo'); assert.equal(session.chart, original);
  assert.equal(session.clipboard.length, 2);
});

test('镜像/原时间粘贴和虚影共享坐标，透明度事件不反转', () => {
  const session = fixture(); session.eventSelection = new Set(['moveXEvents:0', 'alphaEvents:0']); copyObjects(session);
  const projected = projectClipboard(session, 20, { keepTime: true, mirror: true });
  assert.deepEqual(projected.notes.map(note => beatValue(note.startTime)), [2, 4]);
  assert.deepEqual(projected.notes.map(note => note.positionX), [200, -100]);
  assert.equal(projected.events[0].event.start, -20); assert.equal(projected.events[1].event.start, 255);
  session.selectLine(1); pasteObjects(session, 20, { keepTime: true, mirror: true });
  assert.deepEqual(session.notes, projected.notes);
});

test('12 项执行列表正确处理镜像轴、类型、方向、真假和吸附', () => {
  assert.equal(BATCH_ACTIONS.length, 12);
  const session = fixture();
  applyBatchAction(session, 'MirrorMid', 11); assert.deepEqual(session.notes.map(note => note.positionX), [100, -200]);
  applyBatchAction(session, 'MirrorY', 11); assert.deepEqual(session.notes.map(note => note.positionX), [-100, 200]);
  applyBatchAction(session, 'SideDown', 11); assert.deepEqual(session.notes.map(note => note.above), [2, 0]);
  applyBatchAction(session, 'SideSwitch', 11); assert.ok(session.notes.every(noteIsAbove));
  applyBatchAction(session, 'SideUp', 11); assert.ok(session.notes.every(noteIsAbove));
  applyBatchAction(session, 'ToFake', 11); assert.ok(session.notes.every(note => note.isFake === 1));
  applyBatchAction(session, 'ToReal', 11); assert.ok(session.notes.every(note => note.isFake === 0));
  applyBatchAction(session, 'ToHold', 11); assert.deepEqual(session.notes.map(note => beatValue(note.endTime)), [2.25, 6]);
  for (const [action, type] of [['ToTap', 1], ['ToFlick', 3], ['ToDrag', 4]]) {
    applyBatchAction(session, action, 11); assert.ok(session.notes.every(note => note.type === type && beatValue(note.endTime) === beatValue(note.startTime)));
  }
  applyBatchAction(session, 'AttachX', 11); assert.deepEqual(session.notes.map(note => note.positionX), [-135, 135]);
  assert.deepEqual(session.notes[1].extra, { value: 9 });
});

test('方向键保持相对间距，左右半竖线，上下一横线，左右不移动事件', () => {
  const session = fixture(); session.eventSelection.add('moveXEvents:0');
  nudgeSelection(session, 'ArrowRight', 4, 11); assert.deepEqual(session.notes.map(note => note.positionX), [-132.5, 167.5]);
  assert.equal(beatValue(eventList(session, 'moveXEvents')[0].startTime), 1);
  nudgeSelection(session, 'ArrowUp', 4, 11); assert.deepEqual(session.notes.map(note => beatValue(note.startTime)), [2.25, 4.25]);
  assert.equal(beatValue(eventList(session, 'moveXEvents')[0].endTime), 3.25);
  nudgeSelection(session, 'ArrowLeft', 4, 11); nudgeSelection(session, 'ArrowDown', 4, 11);
  assert.deepEqual(session.notes.map(note => note.positionX), [-200, 100]);
  session.selection.clear(); const original = session.chart;
  assert.equal(nudgeSelection(session, 'ArrowLeft', 4, 11), true); assert.equal(session.chart, original);
});

test('控制球预览不修改原谱和历史，移动支持无限延展坐标，跨线循环且可撤销', () => {
  const session = fixture(); const original = structuredClone(session.chart); const snapshot = captureSelection(session);
  const preview = controlSelection(snapshot, 'note-move', { deltaBeat: 0.5, deltaX: 800 });
  assert.deepEqual(preview.chart.judgeLineList[0].notes.map(note => note.positionX), [600, 900]);
  assert.deepEqual(session.chart, original); assert.equal(session.history.undoStack.length, 0);
  const transferred = controlSelection(snapshot, 'note-line', { dragX: -50 });
  assert.equal(transferred.lineIndex, 1); assert.equal(transferred.chart.judgeLineList[0].notes.length, 0);
  assert.deepEqual(transferred.chart.judgeLineList[1].notes, original.judgeLineList[0].notes);
  commitSelectionEdit(session, transferred, '移线'); assert.equal(session.history.undoStack.length, 1);
  session.travel('undo'); assert.deepEqual(session.chart, original);
  assert.deepEqual([49, 50, 99, 100].map(delta => controlLineOffset(delta)), [0, 1, 1, 2]);
  assert.deepEqual([74, 75, 124, 125].map(delta => controlLineOffset(delta, true)), [0, 1, 1, 2]);
});

test('音符整体移动吸附时只量化位移，不改变各音符的相对横坐标', () => {
  const snapshot = captureSelection(fixture());
  const snapped = controlSelection(snapshot, 'note-move', { deltaX: 210, snapX: true, gridCount: 11 });
  assert.deepEqual(snapped.chart.judgeLineList[0].notes.map(note => note.positionX), [70, 370]);
  const unsnapped = controlSelection(snapshot, 'note-move', { deltaX: 70, snapX: false, gridCount: 11 });
  assert.deepEqual(unsnapped.chart.judgeLineList[0].notes.map(note => note.positionX), [-130, 170]);
});

test('缩放球使用中心轴，按 1/2 固定首尾音符，向内拖可翻转且不约束横坐标', () => {
  const snapshot = captureSelection(fixture());
  const positions = options => controlSelection(snapshot, 'note-scale', options).chart.judgeLineList[0].notes.map(note => note.positionX);
  assert.deepEqual(positions({ dragX: 300 }), [-350, 250]);
  assert.deepEqual(positions({ dragX: 300, anchorMode: 1 }), [-200, 400]);
  assert.deepEqual(positions({ dragX: -300, anchorMode: 2 }), [-500, 100]);
  assert.deepEqual(positions({ dragX: -600 }), [100, -200]);
  assert.deepEqual(positions({ dragX: 10000 }), [-5200, 5100]);
});

test('事件控制球整体平移保持长度，第二球调尾第三球调首，只有第一球横向达到阈值才移线', () => {
  const session = fixture(); session.selection.clear(); session.eventSelection = new Set(['moveXEvents:0', 'moveXEvents:1']);
  const snapshot = captureSelection(session);
  const whole = controlSelection(snapshot, 'event-move', { deltaBeat: 0.25, dragX: 74 });
  assert.equal(whole.lineIndex, 0);
  assert.deepEqual(whole.chart.judgeLineList[0].eventLayers[0].moveXEvents.map(event => [beatValue(event.startTime), beatValue(event.endTime)]), [[1.25, 3.25], [4.25, 6.25]]);
  const tail = controlSelection(snapshot, 'event-end', { deltaBeat: 0.25, dragX: 200 });
  assert.equal(tail.lineIndex, 0);
  assert.deepEqual(tail.chart.judgeLineList[0].eventLayers[0].moveXEvents.map(event => [beatValue(event.startTime), beatValue(event.endTime)]), [[1, 3.25], [4, 6.25]]);
  const head = controlSelection(snapshot, 'event-start', { deltaBeat: 0.25, dragX: -200 });
  assert.equal(head.lineIndex, 0);
  assert.deepEqual(head.chart.judgeLineList[0].eventLayers[0].moveXEvents.map(event => [beatValue(event.startTime), beatValue(event.endTime)]), [[1.25, 3], [4.25, 6]]);
  const first = controlSelection(snapshot, 'event-start', { deltaBeat: 8 }).chart.judgeLineList[0].eventLayers[0].moveXEvents;
  assert.deepEqual(first.map(event => beatValue(event.startTime)), [3, 6]);
  const last = controlSelection(snapshot, 'event-end', { deltaBeat: -8 }).chart.judgeLineList[0].eventLayers[0].moveXEvents;
  assert.deepEqual(last.map(event => beatValue(event.endTime)), [1, 4]);
  const moved = controlSelection(snapshot, 'event-move', { deltaBeat: 2, dragX: 75 });
  assert.equal(moved.lineIndex, 1); assert.equal(moved.chart.judgeLineList[0].eventLayers[0].moveXEvents.length, 0);
  assert.deepEqual(moved.chart.judgeLineList[1].eventLayers[0].moveXEvents.slice(1).map(event => beatValue(event.startTime)), [3, 6]);
  commitSelectionEdit(session, moved, '事件移线'); assert.equal(session.eventSelection.size, 2);
});

test('着色器批量移线正确更新所属线和参数时间，未知字段保留', () => {
  const session = fixture(); session.selection.clear();
  const chart = structuredClone(session.chart);
  chart.effects = [{ shader: 'grayscale', line: 0, start: [2, 0, 1], end: [4, 0, 1], extra: 9, vars: { factor: [createEvent(0, 1, 2, 4)] } }];
  const shaderSession = new EditorSession(chart); shaderSession.eventSelection.add('paintEvents:0');
  const moved = controlSelection(captureSelection(shaderSession), 'event-move', { deltaBeat: 3, dragX: 75 });
  commitSelectionEdit(shaderSession, moved, '移 shader');
  const effect = eventList(shaderSession, 'paintEvents')[0];
  assert.equal(effect.line, 1); assert.equal(effect.extra, 9); assert.equal(beatValue(effect.startTime), 5);
  assert.equal(beatValue(effect.vars.factor[0].startTime), 5);
  shaderSession.travel('undo'); assert.deepEqual(shaderSession.chart, chart);
});

test('剪贴板虚影跟随光标拍数且无命中目标，隐藏后仍可粘贴', () => {
  const session = fixture(); copyObjects(session);
  const rectangles = []; const context = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect(...args) { rectangles.push(args); } };
  const canvas = { clientWidth: 500, clientHeight: 600, addEventListener() {} };
  const timeline = new Timeline(canvas, canvas, () => session, () => {}, () => {});
  timeline.origin = 2; timeline.clipboardPointer = { x: 300, y: timeline.vertical(3.25) };
  assert.equal(clipboardBeat(timeline), 3.25);
  drawClipboard(timeline, context, 500, 600, 'notes');
  assert.equal(rectangles.length, 1); assert.equal(rectangles[0][1] + rectangles[0][3] / 2, timeline.vertical(3.25));
  session.clipboardVisible = false; drawClipboard(timeline, context, 500, 600, 'notes'); assert.equal(rectangles.length, 1);
  pasteObjects(session, clipboardBeat(timeline)); assert.equal(beatValue(session.notes[2].startTime), 3.25);
  assert.equal(session.clipboardVisible, true);
});

test('文件导入和迁移不再以声明的 256 MiB 大小拒绝项目', async () => {
  const chart = createChart(); const bytes = new TextEncoder().encode(JSON.stringify(chart));
  const file = { name: 'chart.json', size: 300 * 1024 * 1024, arrayBuffer: async () => bytes.buffer };
  assert.equal((await openFiles([file])).candidates.length, 1);
  const project = { id: 'batch-size-test', chart, path: 'Charts/test/chart.json', directory: 'Charts/test/', info: {} };
  const result = await materializeProject({ sourceName: 'test', entries: [{ path: project.path, getFile: async () => file }] }, project);
  assert.equal(result.assets.length, 1); assert.equal(result.bytes, file.size);
});

test('ZIP 导出不额外复制文件内容，10000 个文件以上仍可往返', async () => {
  const entries = new Map(Array.from({ length: 10001 }, (unused, index) => [`files/${index}.txt`, new Uint8Array([index % 256])]));
  const restored = await readZip(await writeZip(entries).arrayBuffer());
  assert.equal(restored.size, entries.size); assert.deepEqual(restored.get('files/10000.txt'), entries.get('files/10000.txt'));
  assert.throws(() => writeZip({ size: 65535 }), /ZIP64/);
});
