import { DEFAULT_LINE_WIDTH } from './visual-constants.mjs';

export function lineGuides(states, lines, order, width, height, scale) {
  return order.filter(index => states[index] && lines[index]).map(index => {
    const state = states[index];
    return { index, x: width / 2 + state.x * scale, y: height / 2 - state.y * scale, rotation: state.rotation,
      halfWidth: Math.abs(state.scaleX) * DEFAULT_LINE_WIDTH * scale / 2, alpha: state.alpha };
  });
}

export function mergeGuides(guides, scale, enabled = true) {
  const groups = [];
  for (const guide of guides) {
    const group = enabled && groups.find(candidate => Math.hypot(candidate.x - guide.x, candidate.y - guide.y) < 10 * scale && Math.abs(candidate.rotation - guide.rotation) < 0.01);
    if (group) group.indices.push(guide.index);
    else groups.push({ ...guide, indices: [guide.index] });
  }
  return groups;
}

export function matchingGuides(guides, point, radius = 10) {
  return guides.filter(guide => {
    if (guide.segment) {
      const [start, end] = guide.segment, dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
      const amount = length ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
      return Math.hypot(point.x - start.x - amount * dx, point.y - start.y - amount * dy) <= radius;
    }
    const angle = guide.rotation * Math.PI / 180;
    const deltaX = point.x - guide.x; const deltaY = point.y - guide.y;
    const across = deltaX * Math.cos(angle) + deltaY * Math.sin(angle);
    const perpendicular = -deltaX * Math.sin(angle) + deltaY * Math.cos(angle);
    return Math.abs(across) <= Math.max(guide.halfWidth, radius) && Math.abs(perpendicular) <= radius;
  });
}

export function sortedGuideMatches(guides, point, radius = 10) {
  return matchingGuides(guides, point, radius).sort((left, right) => right.alpha - left.alpha || left.index - right.index);
}

export function pickGuide(guides, point, selected, radius = 10) {
  const matches = matchingGuides(guides, point, radius);
  if (!matches.length) return null;
  return matches[(matches.findIndex(guide => guide.index === selected) + 1) % matches.length].index;
}

export function formatLineNumbers(indices, lines = null) {
  const sorted = [...indices].sort((left, right) => left - right);
  const groups = [];
  for (let index = 0; index < sorted.length; index++) {
    const first = sorted[index]; let last = first;
    const firstParent = Number(lines?.[first]?.father ?? -1);
    while (firstParent < 0 && sorted[index + 1] === last + 1 && Number(lines?.[sorted[index + 1]]?.father ?? -1) < 0) last = sorted[++index];
    const suffix = firstParent >= 0 ? `(${firstParent})` : '';
    groups.push(last === first ? `${first}${suffix}` : `${first}–${last}`);
  }
  return groups.join(', ');
}
