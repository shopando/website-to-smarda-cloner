// Merges a second convertPageToSmarda() pass — taken at a narrower viewport —
// into the base (full-width) tree as a breakpoint override. Both trees have
// the same shape (same DOM, just resized), so nodes line up by position;
// only the style properties that actually differ at this width get added, as
// a new breakpoint key next to "default" (see css.js's style format).
function diffState(basePairs, otherPairs) {
  const changed = {}
  for (const prop in otherPairs) {
    if (otherPairs[prop] !== basePairs[prop]) changed[prop] = otherPairs[prop]
  }
  return changed
}

function diffLayers(baseLayer, otherLayer) {
  const diff = {}
  for (const state in otherLayer) {
    const changed = diffState(baseLayer[state] || {}, otherLayer[state])
    if (Object.keys(changed).length) diff[state] = changed
  }
  return diff
}

const FIELDS = ['style', 'layout', 'animation']

function mergeNode(baseNode, otherNode, breakpointKey) {
  if (!baseNode || !otherNode) return
  for (const field of FIELDS) {
    if (!baseNode[field] || !otherNode[field]) continue
    const diff = diffLayers(baseNode[field].default || {}, otherNode[field].default || {})
    if (Object.keys(diff).length) baseNode[field][breakpointKey] = diff
  }
  const baseChildren = baseNode.children || []
  const otherChildren = otherNode.children || []
  for (let i = 0; i < Math.min(baseChildren.length, otherChildren.length); i++) {
    mergeNode(baseChildren[i], otherChildren[i], breakpointKey)
  }
}

export function mergeBreakpoint(baseTree, otherTree, breakpointKey) {
  for (let i = 0; i < Math.min(baseTree.length, otherTree.length); i++) {
    mergeNode(baseTree[i], otherTree[i], breakpointKey)
  }
}
