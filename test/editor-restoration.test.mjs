import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../src/ui/timeline.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { createNote, createEvent, createChart } from '../src/core/chart.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { LineRuntime } from '../src/core/scene.mjs';
import { recentHits, HOLD_HIT_INTERVAL } from '../src/core/hit-effects.mjs';
import { visibleBeats, visibleSeconds } from '../src/core/note-editing.mjs';
import { mergeGuides, pickGuide, formatLineNumbers } from '../src/core/preview-guides.mjs';
import { insertEvent } from '../src/application/event-commands.mjs';
import { AudioTransport } from '../src/platform/audio.mjs';
import { RpeSkin } from '../src/ui/skin.mjs';

function canvas() {
  return { clientWidth: 600, clientHeight: 600, style: {}, addEventListener() {}, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) };
}
function editor(notes) {
  const session = new EditorSession(); session.insertNotes(notes);
  const timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {});
  return { session, timeline };
}
function pointer(horizontal, vertical) { return { button: 0, clientX: horizontal, clientY: vertical }; }

test('仅音符视图按实际横向扩展倍率放大，音符额外应用默认视觉缩放且不改坐标间距', () => {
  const { timeline } = editor([]);
  const size = timeline.noteWidth(createNote(1, 0, 0));
  const spacing = timeline.horizontal(135) - timeline.horizontal(0);
  timeline.notesCanvas.clientWidth = 1224; timeline.notesOnly = true;
  assert.ok(Math.abs(timeline.noteWidth(createNote(1, 0, 0)) / size - 1224 / 600 * .9) < 1e-10);
  assert.ok(Math.abs((timeline.horizontal(135) - timeline.horizontal(0)) / spacing - 1224 / 600) < 1e-10);
});

test('编辑区音符宽度按当前编辑区域宽度等比缩放，size 只改变宽度', () => {
  const { timeline } = editor([]);
  const base = createNote(1, 0, 0);
  const wide = { ...base, size: 2 };
  const normalWidth = timeline.noteWidth(base);
  timeline.notesCanvas.clientWidth = 1200;
  const resizedWidth = timeline.noteWidth(base);
  assert.ok(Math.abs(resizedWidth / normalWidth - 2) < 1e-10);
  assert.ok(Math.abs(timeline.noteWidth(wide) / resizedWidth - 2) < 1e-10);
  timeline.noteScale = 200 / 175;
  assert.ok(Math.abs(timeline.noteWidth(base) / 1200 - 200 / 1350) < 1e-10);
  timeline.getSession().chart.judgeLineList.push(structuredClone(timeline.getSession().chart.judgeLineList[0]));
  timeline.getSession().setMultiLineEnabled(true, 'notes');
  timeline.getSession().addMultiLine(1);
  timeline.getSession().multiLineMerge = false;
  timeline.multiLineWidth = 420;
  assert.ok(Math.abs(timeline.noteWidth(base) / 420 - 200 / 1350) < 1e-10);
});

test('编辑区皮肤音符的实际绘制宽高随分辨率等比变化，单音符 size 不改变高度', () => {
  const { timeline } = editor([]), skin = new RpeSkin(() => {}), calls = [];
  skin.images.set('Tap2', { naturalWidth: 200, naturalHeight: 20 });
  const context = { drawImage(...args) { calls.push(args); } };
  const paint = size => skin.head(context, 1, 0, 0, timeline.noteBaseWidth({ size }), false, undefined, 5 * timeline.renderNoteScale, 68 * timeline.renderNoteScale);
  paint(1); timeline.notesCanvas.clientWidth *= 2; paint(1); paint(3);
  assert.ok(Math.abs(calls[1][3] / calls[0][3] - 2) < 1e-10);
  assert.ok(Math.abs(calls[1][4] / calls[0][4] - 2) < 1e-10);
  assert.ok(Math.abs(calls[2][3] / calls[1][3] - 3) < 1e-10);
  assert.equal(calls[2][4], calls[1][4]);
});

test('点击不吸附，拖拽不限制横坐标；界外可见音符可拾取拉回，不显示远处音符的边缘替身', () => {
  const { session, timeline } = editor([createNote(1, 2, -730)]);
  const start = pointer(timeline.horizontal(-730), timeline.vertical(2));
  assert.ok(timeline.hit({ x: start.clientX, y: start.clientY }));
  timeline.down(start); assert.equal(timeline.movedNote(session.notes[0]).positionX, -730); timeline.up(start);
  assert.equal(session.notes[0].positionX, -730);
  timeline.down(start); timeline.move(pointer(timeline.horizontal(900), start.clientY)); timeline.up(pointer(timeline.horizontal(900), start.clientY));
  assert.equal(session.notes[0].positionX, 945);
  assert.equal(timeline.clampNoteHorizontal(timeline.horizontal(-3000), 68), null);
  assert.equal(timeline.clampNoteHorizontal(timeline.horizontal(-675), 68), timeline.horizontal(-675));
  for (const count of [10, 11, 10.5]) {
    timeline.gridCount = count;
    for (const position of [-2000, -675, 675, 2000]) assert.equal(timeline.notePositionAt(timeline.horizontal(position)), timeline.snapXPosition(position));
  }
});

test('Hold 首尾可拖动且一次撤销，越过可见边界后持续滚动时间', () => {
  const { session, timeline } = editor([createNote(2, 2, 0, 4)]);
  const start = pointer(timeline.horizontal(0), timeline.vertical(4));
  timeline.down(start); assert.equal(timeline.drag.kind, 'endTime');
  timeline.move(pointer(start.clientX, timeline.vertical(5)));
  assert.equal(beatValue(timeline.movedNote(session.notes[0]).endTime), 5);
  timeline.up(pointer(start.clientX, timeline.vertical(5)));
  assert.equal(beatValue(session.notes[0].endTime), 5); session.travel('undo');
  assert.equal(beatValue(session.notes[0].endTime), 4);
  timeline.down(start); timeline.move(pointer(start.clientX, -40));
  timeline.onDragScroll = seconds => { timeline.origin = timeline.tempo.beat(timeline.tempo.seconds(timeline.origin) + seconds); };
  const before = beatValue(timeline.movedNote(session.notes[0]).endTime);
  for (let frame = 0; frame < 60; frame++) timeline.autoScroll(1 / 60);
  assert.ok(beatValue(timeline.movedNote(session.notes[0]).endTime) > before);
});

test('可见时间拍与秒在跨 BPM、倍率及负拍范围往返', () => {
  const tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 240, startTime: [4, 0, 1] }]);
  for (const factor of [1, 2]) for (const beats of [0, 0.25, 3, 9]) {
    const note = createNote(1, 6, 0); note.visibleTime = visibleSeconds(note, beats, tempo, factor);
    assert.ok(Math.abs(visibleBeats(note, tempo, factor) - beats) < 1e-8);
  }
});

test('Hold 连续打击特效只采样存活脉冲，定位不会补放过去特效', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(2, 0, 0, 200), { ...createNote(2, 0, 0, 200), isFake: 1 }];
  const runtime = new LineRuntime(chart.judgeLineList[0], new TempoMap(chart.BPMList));
  const hits = recentHits(runtime, 20, 0);
  assert.ok(hits.length >= 3 && hits.length <= 5);
  assert.ok(hits.every(hit => !hit.entry.note.isFake && hit.time <= 20 && hit.time > 20 - 2 / 3));
  assert.ok(Math.abs(hits[1].time - hits[0].time - HOLD_HIT_INTERVAL) < 1e-8);
  assert.deepEqual(recentHits(runtime, 20, 20), []);
  assert.deepEqual(recentHits(runtime, 101, 0), []);
});

test('判定线编号按距离及方向合并，重合线点击可循环选择', () => {
  const guides = [{ index: 0, x: 10, y: 20, rotation: 0, halfWidth: 100, alpha: 255 }, { index: 1, x: 11, y: 20, rotation: 0, halfWidth: 100, alpha: 255 }, { index: 3, x: 11, y: 20, rotation: 90, halfWidth: 100, alpha: 255 }];
  assert.deepEqual(mergeGuides(guides, 1).map(group => group.indices), [[0, 1], [3]]);
  assert.equal(mergeGuides(guides, 1, false).length, 3);
  assert.equal(pickGuide(guides, { x: 50, y: 20 }, 0), 1);
  assert.equal(pickGuide(guides, { x: 50, y: 20 }, 1), 0);
  assert.equal(pickGuide(guides, { x: 300, y: 300 }, 0), null);
  assert.equal(formatLineNumbers([3, 1, 0, 5]), '0–1, 3, 5');
  assert.equal(formatLineNumbers([0, 1], [{ father: -1 }, { father: 0 }]), '0, 1(0)');
});

test('直接切换空事件层后可添加事件，不引入稀疏层或覆盖其他层', () => {
  const session = new EditorSession(); const original = session.line.eventLayers[0];
  session.eventLayer = 3; insertEvent(session, 'moveXEvents', createEvent(0, 100, 0, 1));
  assert.equal(session.line.eventLayers.length, 4); assert.equal(session.line.eventLayers[0], original);
  assert.deepEqual(session.line.eventLayers[1], {}); assert.deepEqual(session.line.eventLayers[2], {});
});

test('正延迟对应的负谱面时间播放和暂停均不强制归零，负媒体时间正确接入音乐', async () => {
  const context = { currentTime: 0, resume: async () => {}, createGain: () => ({ gain: {}, connect() {} }), destination: {} };
  const audio = new AudioTransport(() => context);
  let plays = 0;
  audio.media = { duration: 120, currentTime: 0, pause() {}, async play() { plays++; } };
  await audio.play(); assert.equal(audio.time - 2, -2);
  audio.media.currentTime = 0.5; audio.pause(); assert.equal(audio.time - 2, -1.5);
  await audio.play(); assert.equal(audio.time - 2, -1.5);
  audio.pause(); audio.seek(-1); await audio.play(); const previous = plays;
  context.currentTime = 0.5; audio.update(); assert.equal(plays, previous); assert.equal(audio.time, -0.5);
  context.currentTime = 1.25; audio.update(); assert.equal(plays, previous + 1); assert.equal(audio.time, 0.25);
});

test('普通 Hold 使用原版 Hold3，和 HL 保持相同的身体宽度基准', () => {
  const skin = new RpeSkin(() => {});
  for (const [name, width] of [['Hold', 989], ['Hold3', 1089], ['HoldHL', 1086], ['HoldHead', 1089], ['HoldHeadHL', 1086], ['HoldEnd', 1089]]) skin.images.set(name, { name, naturalWidth: width, naturalHeight: 50 });
  const calls = []; const context = { save() {}, restore() {}, translate() {}, scale() {}, drawImage(...args) { calls.push(args); } };
  skin.hold(context, 0, 0, -100, 175); skin.hold(context, 0, 0, -100, 175, true);
  assert.equal(calls[0][0].name, 'Hold3'); assert.equal(calls[3][0].name, 'HoldHL');
  assert.equal(calls[0][3], calls[3][3]); assert.equal(calls[2][3], calls[5][3]);
});
