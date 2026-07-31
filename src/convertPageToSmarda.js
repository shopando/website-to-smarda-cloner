// Runs inside the page (via page.evaluate) — must be fully self-contained, no
// references outside this function body. Every distinct min-width/max-width
// pixel value used in any @media rule on the page, regardless of whether it
// currently matches — downloadPage.js resizes the viewport to each one in
// turn and re-runs convertPageToSmarda() to capture that breakpoint's
// overrides (see mergeBreakpoint.js).
export function collectBreakpoints() {
  const widths = new Set()

  function walkRules(cssRules) {
    for (const rule of cssRules) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        const text = rule.conditionText || rule.media.mediaText
        for (const match of text.matchAll(/(?:min|max)-width:\s*(\d+)/g)) widths.add(Number(match[1]))
        walkRules(rule.cssRules)
      } else if (rule.type === CSSRule.SUPPORTS_RULE) {
        walkRules(rule.cssRules)
      } else if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
        walkSheet(rule.styleSheet)
      }
    }
  }

  function walkSheet(sheet) {
    let cssRules
    try { cssRules = sheet.cssRules } catch { return }
    if (cssRules) walkRules(cssRules)
  }

  for (const sheet of document.styleSheets) walkSheet(sheet)
  return [...widths].sort((a, b) => a - b)
}

// Runs inside the page (via page.evaluate) — must be fully self-contained,
// no references outside this function body. `options` is passed in verbatim
// as page.evaluate's second argument (see downloadPage.js).
export function convertPageToSmarda(options = {}) {
  const { excludeHeader = false, excludeFooter = false } = options

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'source',
    'video', 'audio', 'iframe', 'canvas', 'input', 'select', 'textarea', 'option',
    'optgroup', 'link', 'meta', 'head', 'title', 'path', 'defs', 'use', 'br',
  ])

  // Elements whose id/class contains any of these substrings (case-insensitive)
  // are dropped whole, subtree included — this is not cookie-banner-specific,
  // it's a general "known noise no client site wants copied" list. Add more
  // keywords/categories here as they come up; one flat list, easy to edit.
  const NOISE_KEYWORDS = [
    // cookie / privacy consent banners (generic terms + common vendor widgets)
    'cookie', 'consent', 'gdpr', 'dsgvo', 'coi-',
    'cookiebot', 'onetrust', 'usercentrics', 'klaro', 'iubenda', 'borlabs',
    'termly', 'cookieyes', 'cookiescript', 'cc-window', 'cc-banner', 'cookielawinfo',
  ]
  const HEADER_KEYWORDS = ['header']
  const FOOTER_KEYWORDS = ['footer']

  function idAndClass(el) {
    return `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase()
  }

  function matchesKeyword(el, keywords) {
    const text = idAndClass(el)
    return keywords.some(keyword => text.includes(keyword))
  }

  function isNoise(el) {
    return matchesKeyword(el, NOISE_KEYWORDS)
  }

  function isHeader(el) {
    return el.tagName.toLowerCase() === 'header' || matchesKeyword(el, HEADER_KEYWORDS)
  }

  function isFooter(el) {
    return el.tagName.toLowerCase() === 'footer' || matchesKeyword(el, FOOTER_KEYWORDS)
  }
  const INLINE_TAGS = new Set([
    'a', 'strong', 'b', 'em', 'i', 'span', 'mark', 'small', 'sup', 'sub',
    'u', 's', 'strike', 'del', 'ins', 'abbr', 'cite', 'q', 'code', 'kbd', 'var', 'time', 'label',
  ])
  const TEXT_TAGS = new Set([
    'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'label', 'blockquote',
    'dt', 'dd', 'figcaption', 'caption', 'legend', 'summary', 'a', 'td', 'th', 'button',
  ])
  // Standard CSS-inherited properties — a fact of the CSS spec, not a curated
  // subset: if nothing sets these on the element itself, the effective value
  // comes from the nearest ancestor. The smarda renderer resets every box:/text:
  // node with `all: initial` (no DOM inheritance between our nodes), so such a
  // node needs this value captured explicitly whenever it has no own rule for
  // it. A text_segment: has no such reset (see extractOwnStyle) and never needs
  // the fallback — it inherits from its text: parent exactly like the source did.
  const INHERITED_KEBAB = new Set([
    'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-stretch',
    'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform',
    'text-shadow', 'white-space', 'direction', 'visibility', 'cursor',
    'list-style-type', 'list-style-position', 'list-style-image',
    'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'quotes',
    'orphans', 'widows', 'tab-size', 'hyphens', 'word-break', 'overflow-wrap', 'word-wrap',
  ])

  // Confirmed tags where the smnd reset's own default `display` diverges from
  // the real browser default (see assets/reset.css) — not a general "restore
  // true defaults" mechanism, just these specific, checked cases.
  const RESET_DISPLAY_DIVERGENCE = {
    a: 'inline',       // smnd resets to inline-block
    label: 'inline',   // smnd resets to block
    li: 'list-item',   // smnd resets to block
  }

  // ---- CSS cascade: every property actually authored on an element, with its
  // original (unresolved) value — not getComputedStyle's fully resolved
  // pixel/keyword snapshot, which collapses percentages/auto/rem into one-off
  // numbers tied to this exact viewport and hides what was never set at all
  // behind spec-initial values like "auto"/"none". No fixed property allowlist:
  // whatever a rule declares (shorthand already expanded to longhand by the
  // browser's own CSS parser) is what gets copied. ----

  function kebabToCamel(kebab) {
    return kebab.replace(/-([a-zA-Z])/g, (match, letter) => letter.toUpperCase())
  }

  function camelToKebab(camel) {
    return camel.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  }

  // Which of the three node fields (style/layout/animation) a property goes
  // in — copied straight from the editor's own field configs, so a node
  // authored by hand and one produced by this downloader put a property in
  // the same place. Source of truth:
  //   backend-new-editor/src/pages/content-editor/styleFields.js (STYLE_FIELDS)
  //   backend-new-editor/src/pages/content-editor/layoutFields.js (LAYOUT_FIELDS)
  //   backend-new-editor/src/pages/content-editor/AnimationEditor.vue (animation-* longhands)
  const STYLE_CAMEL = [
    'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
    'textTransform', 'textDecoration', 'fontStyle',
    'backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundSize', 'backgroundRepeat', 'backgroundAttachment',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset',
    'borderImageSource', 'borderImageSlice', 'borderImageWidth', 'borderImageOutset', 'borderImageRepeat',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'boxShadow', 'textShadow', 'filter', 'backdropFilter', 'mixBlendMode', 'backgroundBlendMode', 'opacity', 'transition', 'transform',
    'whiteSpace', 'overflowWrap', 'wordBreak', 'textOverflow', 'wordSpacing', 'textWrap', 'writingMode', 'direction',
    'pointerEvents', 'cursor', 'userSelect',
    'perspective', 'transformStyle', 'backfaceVisibility',
    'isolation', 'clipPath', 'maskImage', 'maskSize', 'maskRepeat',
    'scrollBehavior', 'overscrollBehaviorX', 'overscrollBehaviorY', 'scrollbarWidth', 'scrollbarGutter', 'scrollbarColor',
    'willChange', 'contain', 'contentVisibility', 'imageRendering',
  ]
  const LAYOUT_CAMEL = [
    'display',
    'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent', 'rowGap', 'columnGap',
    'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'justifyItems',
    'flexGrow', 'flexShrink', 'flexBasis', 'order', 'alignSelf', 'justifySelf',
    'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
    'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'objectFit', 'objectPosition',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'position', 'top', 'right', 'bottom', 'left', 'zIndex',
    'overflowX', 'overflowY', 'float', 'clear',
  ]
  const ANIMATION_CAMEL = [
    'animationName', 'animationDuration', 'animationDelay', 'animationTimingFunction',
    'animationDirection', 'animationFillMode', 'animationIterationCount', 'animationTimeline',
    'animationRangeStart', 'animationRangeEnd',
  ]

  const STYLE_KEBAB = new Set(STYLE_CAMEL.map(camelToKebab))
  const LAYOUT_KEBAB = new Set(LAYOUT_CAMEL.map(camelToKebab))
  const ANIMATION_KEBAB = new Set(ANIMATION_CAMEL.map(camelToKebab))

  // A handful of style/animation fields edit one shorthand (textDecoration,
  // transition, animation-*) but the browser's own CSSOM always explodes a
  // shorthand into its longhands on read — text-decoration-line/-color/-...,
  // transition-property/-duration/-..., animation-play-state and the like
  // never appear in the lists above by name. They belong with their
  // shorthand family regardless, so an unrecognised longhand falls back to a
  // prefix match before defaulting to "style".
  function classify(kebab) {
    if (STYLE_KEBAB.has(kebab)) return 'style'
    if (LAYOUT_KEBAB.has(kebab)) return 'layout'
    if (ANIMATION_KEBAB.has(kebab)) return 'animation'
    if (kebab.startsWith('animation-')) return 'animation'
    if (kebab.startsWith('text-decoration') || kebab.startsWith('transition')) return 'style'
    return 'style'
  }

  function specificity(selector) {
    let stripped = selector.replace(/::?(before|after)\b/g, '')
    const ids = stripped.match(/#[a-zA-Z0-9_-]+/g)
    const classesEtc = stripped.match(/\.[a-zA-Z0-9_-]+|\[[^\]]+\]|:[a-zA-Z-]+(\([^)]*\))?/g)
    stripped = stripped
      .replace(/#[a-zA-Z0-9_-]+/g, '')
      .replace(/\.[a-zA-Z0-9_-]+/g, '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/:[a-zA-Z-]+(\([^)]*\))?/g, '')
    const types = stripped.match(/[a-zA-Z][a-zA-Z0-9-]*/g)
    return (ids ? ids.length : 0) * 10000 + (classesEtc ? classesEtc.length : 0) * 100 + (types ? types.length : 0)
  }

  // Dynamic states we can detect statically, without ever simulating them
  // (no .hover()/.focus() calls): a rule like `.btn:hover { color: red }`
  // only ever matches a REAL hover in the browser's own matching, which never
  // happens headless — so instead we strip the pseudo-class and match the
  // plain selector, keeping the state name alongside. Requires the pseudo to
  // sit on the selector's own last compound (the element itself), not an
  // ancestor (`.card:hover .title` — hover on a different element entirely,
  // needing interactionGroupRoot to attribute correctly) — those are skipped.
  const STATE_NAMES = ['hover', 'focus', 'active', 'visited']

  // ::before/::after (legacy single-colon accepted too) are a different kind
  // of state entirely: a SEPARATE generated box, not a variant of the real
  // element's own look — so its declarations are never layered on top of
  // "initial" the way :hover's are (see ownDeclarations below), and inline
  // style="" never applies to it. Only these two pseudo-elements are
  // supported; any other (::placeholder, ::selection, ...) is dropped.
  const PSEUDO_ELEMENT_NAMES = ['pseudo-before', 'pseudo-after']

  function lastCompound(selector) {
    const parts = selector.split(/\s*[>~+]\s*|\s+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : selector
  }

  function detectState(selector) {
    const pseudoElement = selector.match(/::?(before|after)\b/g)
    if (pseudoElement) {
      if (!/::?(before|after)\b/.test(lastCompound(selector))) return null
      const name = pseudoElement[0].replace(/:/g, '')
      return {
        state: `pseudo-${name}`,
        matchSelector: selector.replace(/::?(before|after)\b/g, ''),
        isPseudoElement: true,
      }
    }
    const pseudoClass = selector.match(/:(hover|focus|active|visited)\b/g)
    if (!pseudoClass) return { state: 'initial', matchSelector: selector, isPseudoElement: false }
    if (!/:(hover|focus|active|visited)\b/.test(lastCompound(selector))) return null
    return { state: pseudoClass[0].slice(1), matchSelector: selector.replace(/:(hover|focus|active|visited)\b/g, ''), isPseudoElement: false }
  }

  const rules = []
  let ruleOrder = 0

  function processStyleRule(rule) {
    for (const rawPart of rule.selectorText.split(',')) {
      const selector = rawPart.trim()
      if (!selector) continue
      const otherPseudoElements = selector.match(/::[a-zA-Z-]+/g) || []
      if (otherPseudoElements.some(p => p !== '::before' && p !== '::after')) continue // unsupported
      const detected = detectState(selector)
      if (!detected) continue // state/pseudo-element on an ancestor selector — can't attribute, skip
      rules.push({
        matchSelector: detected.matchSelector,
        state: detected.state,
        isPseudoElement: detected.isPseudoElement,
        specificity: specificity(selector), // full selector — a pseudo still counts toward it
        order: ruleOrder++,
        style: rule.style,
      })
    }
  }

  function walkRules(cssRules) {
    for (const rule of cssRules) {
      if (rule.type === CSSRule.STYLE_RULE) processStyleRule(rule)
      else if (rule.type === CSSRule.MEDIA_RULE) {
        if (window.matchMedia(rule.conditionText || rule.media.mediaText).matches) walkRules(rule.cssRules)
      } else if (rule.type === CSSRule.SUPPORTS_RULE) {
        if (!rule.conditionText || CSS.supports(rule.conditionText)) walkRules(rule.cssRules)
      } else if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet) walkSheet(rule.styleSheet)
      }
    }
  }

  function walkSheet(sheet) {
    let cssRules
    try { cssRules = sheet.cssRules } catch { return } // cross-origin stylesheet, unreadable
    if (cssRules) walkRules(cssRules)
  }

  for (const sheet of document.styleSheets) walkSheet(sheet)

  // Which rules apply to which element, built with the browser's own selector
  // engine (one querySelectorAll per rule) instead of testing every element
  // against every rule by hand — the naive per-element/per-property `matches()`
  // loop is what made this crawl to a halt on any page with a real stylesheet.
  const elementRules = new WeakMap()
  for (const rule of rules) {
    let matched
    try { matched = document.querySelectorAll(rule.matchSelector) } catch { continue }
    for (const el of matched) {
      let list = elementRules.get(el)
      if (!list) { list = []; elementRules.set(el, list) }
      list.push(rule)
    }
  }

  function betterCandidate(candidate, current) {
    if (candidate.important !== current.important) return candidate.important
    if (candidate.specificity !== current.specificity) return candidate.specificity > current.specificity
    return candidate.order >= current.order
  }

  // per-element winning declared value for every wanted property, in every
  // state — computed once and cached — an ancestor gets looked up by many
  // descendants during inheritance resolution, so this is the difference
  // between O(elements) and O(elements × depth) rule scans.
  // { initial: {kebab: winner}, hover: {kebab: winner}, ... } — a state key is
  // only present when at least one property's value actually differs from
  // initial while in that state (real CSS applies base + state rules
  // together, so most properties don't change at all).
  const ownDeclarationsCache = new WeakMap()

  function ownDeclarations(el) {
    let cached = ownDeclarationsCache.get(el)
    if (cached) return cached

    function cascade(matchesRule, includeInlineStyle) {
      const winners = {}
      const consider = (kebab, value, important, spec, order) => {
        if (!value || kebab.startsWith('--')) return // custom property definition, not a real style
        const candidate = { value, important, specificity: spec, order }
        if (!winners[kebab] || betterCandidate(candidate, winners[kebab])) winners[kebab] = candidate
      }
      for (const rule of elementRules.get(el) || []) {
        if (!matchesRule(rule)) continue
        for (let i = 0; i < rule.style.length; i++) {
          const kebab = rule.style[i]
          consider(kebab, rule.style.getPropertyValue(kebab), rule.style.getPropertyPriority(kebab) === 'important', rule.specificity, rule.order)
        }
      }
      // inline style="" targets the real element only — never a ::before/::after
      if (includeInlineStyle) {
        for (let i = 0; i < el.style.length; i++) {
          const kebab = el.style[i]
          consider(kebab, el.style.getPropertyValue(kebab), el.style.getPropertyPriority(kebab) === 'important', Infinity, Infinity)
        }
      }
      return winners
    }

    const initial = cascade(rule => rule.state === 'initial', true)
    const result = { initial }
    for (const state of STATE_NAMES) {
      const withState = cascade(rule => rule.state === 'initial' || rule.state === state, true)
      const diff = {}
      for (const kebab in withState) {
        if (!initial[kebab] || initial[kebab].value !== withState[kebab].value) diff[kebab] = withState[kebab]
      }
      if (Object.keys(diff).length) result[state] = diff
    }

    // ::before/::after are a wholly separate box — its declarations never
    // layer on top of "initial", and without its own `content` it renders
    // nothing at all, so it's dropped unless one of its rules actually set it
    for (const state of PSEUDO_ELEMENT_NAMES) {
      const own = cascade(rule => rule.state === state, false)
      if (own.content) result[state] = own
    }

    ownDeclarationsCache.set(el, result)
    return result
  }

  function resolveVars(value, el) {
    if (!value || !value.includes('var(')) return value
    const cs = getComputedStyle(el)
    return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (match, name, fallback) => {
      const resolved = cs.getPropertyValue(name).trim()
      return resolved || (fallback ? fallback.trim() : match)
    })
  }

  // a url(...) in an authored value is relative to its stylesheet, not this
  // document — rather than re-deriving that base ourselves, take the browser's
  // own resolved (absolute) value for just this property
  function resolveUrls(camelProp, value, el) {
    if (!value.includes('url(')) return value
    const resolved = getComputedStyle(el)[camelProp]
    return resolved || value
  }

  // splits one state's winning declarations into the three node fields by
  // classify() — { style: {camel: value}, layout: {...}, animation: {...} }
  function classifiedProperties(stateDeclarations, el) {
    const buckets = { style: {}, layout: {}, animation: {} }
    for (const kebab in stateDeclarations) {
      const camel = kebabToCamel(kebab)
      const value = resolveUrls(camel, resolveVars(stateDeclarations[kebab].value, el), el)
      buckets[classify(kebab)][camel] = value
    }
    return buckets
  }

  function hasAnyStyle(layer) {
    return Object.keys(layer.initial).length > 0 ||
      STATE_NAMES.some(state => layer[state]) ||
      PSEUDO_ELEMENT_NAMES.some(state => layer[state])
  }

  // own declarations in every state, split into style/layout/animation — the
  // three fields a node can carry, matching the editor's own panels. Returns
  // only the fields that actually have something in them.
  function extractFields(el, includeInherited) {
    const own = ownDeclarations(el)
    const initialBuckets = classifiedProperties(own.initial, el)

    if (includeInherited) {
      const cs = getComputedStyle(el)
      for (const kebab of INHERITED_KEBAB) {
        const camel = kebabToCamel(kebab)
        const bucket = initialBuckets[classify(kebab)]
        if (bucket[camel] !== undefined) continue
        const value = cs[camel]
        if (value) bucket[camel] = value
      }
      // only box:/text: nodes carry the .smnd reset class (a text_segment:
      // never does, see extractOwnStyle) — for the handful of tags where that
      // reset's own default diverges from the real browser default, an
      // element that never set `display` itself would otherwise silently
      // pick up the reset's value instead of the one it actually rendered
      // with on the source page
      const defaultDisplay = RESET_DISPLAY_DIVERGENCE[el.tagName.toLowerCase()]
      if (defaultDisplay && initialBuckets.layout.display === undefined) {
        initialBuckets.layout.display = defaultDisplay
      }
    }

    const layers = {
      style: { initial: initialBuckets.style },
      layout: { initial: initialBuckets.layout },
      animation: { initial: initialBuckets.animation },
    }
    for (const state of STATE_NAMES) {
      if (!own[state]) continue
      const stateBuckets = classifiedProperties(own[state], el)
      for (const type of ['style', 'layout', 'animation']) {
        if (Object.keys(stateBuckets[type]).length) layers[type][state] = stateBuckets[type]
      }
    }

    for (const state of PSEUDO_ELEMENT_NAMES) {
      if (!own[state]) continue
      const stateBuckets = classifiedProperties(own[state], el)
      if (includeInherited) {
        const cs = getComputedStyle(el, state === 'pseudo-before' ? '::before' : '::after')
        for (const kebab of INHERITED_KEBAB) {
          const camel = kebabToCamel(kebab)
          const bucket = stateBuckets[classify(kebab)]
          if (bucket[camel] !== undefined) continue
          const value = cs[camel]
          if (value) bucket[camel] = value
        }
      }
      for (const type of ['style', 'layout', 'animation']) {
        if (Object.keys(stateBuckets[type]).length) layers[type][state] = stateBuckets[type]
      }
    }

    const fields = {}
    for (const type of ['style', 'layout', 'animation']) {
      if (hasAnyStyle(layers[type])) fields[type] = { default: layers[type] }
    }
    return fields
  }

  // box:/text: nodes: own declarations, plus the resolved effective value for
  // any inherited property that has none of its own — see INHERITED_KEBAB above
  function extractStyle(el) {
    return extractFields(el, true)
  }

  // text_segment:, and the synthetic text:span for a bare text node — both
  // inherit normally (no all:initial reset), so only their own declared
  // overrides are needed, nothing has to be resolved on their behalf
  function extractOwnStyle(el) {
    return extractFields(el, false)
  }

  function assignFields(node, fields) {
    if (fields.style) node.style = fields.style
    if (fields.layout) node.layout = fields.layout
    if (fields.animation) node.animation = fields.animation
  }

  // for a bare text node with no element of its own (see the box: children loop
  // below) — only the typography it renders with, none of the enclosing
  // element's own layout (width/margin/...), which isn't the text run's to carry
  function extractInheritedStyle(el) {
    const cs = getComputedStyle(el)
    const initial = {}
    for (const kebab of INHERITED_KEBAB) {
      const camel = kebabToCamel(kebab)
      const value = cs[camel]
      if (value) initial[camel] = value
    }
    return Object.keys(initial).length ? { default: { initial } } : null
  }

  function isElement(node) { return node.nodeType === 1 }
  function isTextNode(node) { return node.nodeType === 3 }
  function normalizeWs(str) { return str.replace(/\s+/g, ' ') }

  function isVisible(el) {
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden'
  }

  function isInlineOnly(el) {
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase()
      if (tag !== 'br' && !INLINE_TAGS.has(tag)) return false
      if (tag !== 'br' && !isInlineOnly(child)) return false
    }
    return true
  }

  function resolveUrl(href) {
    try { return new URL(href, document.baseURI).href } catch { return href }
  }

  function linkData(el) {
    if (el.tagName.toLowerCase() !== 'a') return null
    const href = el.getAttribute('href')
    if (!href) return null
    const data = { linkedUrl: resolveUrl(href) }
    const target = el.getAttribute('target')
    if (target) data.target = target
    return data
  }

  // an <img> becomes a system:image node (data.src/alt), not a box:/text: node —
  // it carries content the renderer needs a real component for, not styling
  function imageNode(el) {
    const src = el.currentSrc || el.getAttribute('src') || ''
    if (!src) return null
    const data = { src: resolveUrl(src) }
    const alt = el.getAttribute('alt')
    if (alt) data.alt = alt
    const node = { component: 'system:image', data }
    assignFields(node, extractStyle(el))
    return node
  }

  // Builds the content/children of a text: or text_segment: node from its inline
  // DOM subtree. Consecutive text + <br> nodes are grouped into one run; any
  // other inline element (a link, bold, ...) forces the richer text_segment:
  // children form, with each run alongside it as its own segment.
  function buildInline(el) {
    const parts = []
    let needsSegments = false
    let run = null
    const flushRun = () => { if (run) { parts.push(run); run = null } }

    for (const node of el.childNodes) {
      if (isTextNode(node)) {
        const text = normalizeWs(node.textContent)
        if (!text) continue
        if (!run) run = { type: 'run', text: '', hasBr: false }
        run.text += text
        continue
      }
      if (!isElement(node)) continue
      const tag = node.tagName.toLowerCase()
      if (tag === 'br') {
        // <br> is the one HTML tag the renderer understands directly as
        // literal markup inside a content string — it never becomes a
        // component of its own, just text appended to the current run
        if (!run) run = { type: 'run', text: '', hasBr: false }
        run.text += '<br>'
        run.hasBr = true
        continue
      }
      if (!INLINE_TAGS.has(tag)) continue
      flushRun()
      needsSegments = true
      parts.push({ type: 'element', tag, el: node })
    }
    flushRun()

    if (!parts.length) return { content: '' }

    if (!needsSegments) {
      return { content: parts.map(p => p.text).join('') }
    }

    const children = parts.map(p => {
      if (p.type === 'run') {
        // a run with no <br> is a bare text_segment:plain, matching how plain
        // text is normally authored; one WITH a <br> needs a real (non-
        // "plain") tag instead — text_segment:plain renders as bare text with
        // every tag stripped, which would delete the <br> along with it, so
        // only a wrapped content string (any other tag) can carry it through
        return p.hasBr
          ? { component: 'text_segment:span', content: p.text }
          : { component: 'text_segment:plain', content: p.text }
      }
      const segment = { component: `text_segment:${p.tag}` }
      const link = linkData(p.el)
      if (link) segment.data = link
      assignFields(segment, extractOwnStyle(p.el))
      Object.assign(segment, buildInline(p.el))
      return segment
    })
    return { children }
  }

  function walkNode(el) {
    if (!isElement(el)) return null
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag)) return null
    if (isNoise(el)) return null
    if (excludeHeader && isHeader(el)) return null
    if (excludeFooter && isFooter(el)) return null
    if (!isVisible(el)) return null
    if (tag === 'img') return imageNode(el)

    if (TEXT_TAGS.has(tag) && isInlineOnly(el)) {
      const inline = buildInline(el)
      if (!inline.content && !(inline.children && inline.children.length)) return null
      const node = { component: `text:${tag}` }
      const link = linkData(el)
      if (link) node.data = link
      Object.assign(node, inline)
      assignFields(node, extractStyle(el))
      return node
    }

    const children = []
    for (const child of el.childNodes) {
      if (isTextNode(child)) {
        // a bare text node directly between block-level children is almost always
        // source indentation, not real content — only keep it if it has actual text
        const text = normalizeWs(child.textContent).trim()
        if (text) {
          // there is no element of its own — it renders with el's own typography
          const span = { component: 'text:span', content: text }
          const style = extractInheritedStyle(el)
          if (style) span.style = style
          children.push(span)
        }
        continue
      }
      if (!isElement(child)) continue
      const built = walkNode(child)
      if (built) children.push(built)
    }
    if (!children.length) return null

    const node = { component: `box:${tag}`, children }
    const link = linkData(el)
    if (link) node.data = link
    assignFields(node, extractStyle(el))
    return node
  }

  const tree = []
  for (const child of document.body.children) {
    const built = walkNode(child)
    if (built) tree.push(built)
  }

  return tree
}
