import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { convertPageToSmarda, collectBreakpoints } from './convertPageToSmarda.js'
import { mergeBreakpoint } from './mergeBreakpoint.js'

// a site can define far more @media cutoffs than are worth a whole extra
// pass (utility-class frameworks especially) — cap it and say so, rather than
// silently eating however many the site happens to have
const MAX_BREAKPOINTS = 6

export async function downloadPage({ url, outFile, waitMs = 1500, excludeHeader = false, excludeFooter = false }) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    // give client-side widgets (sliders, carousels, lazy layout) time to settle
    // into their final DOM/CSS state before we read it
    await page.waitForTimeout(waitMs)

    const options = { excludeHeader, excludeFooter }
    const tree = await page.evaluate(convertPageToSmarda, options)

    const breakpoints = await page.evaluate(collectBreakpoints)
    const testWidths = breakpoints.slice(0, MAX_BREAKPOINTS)
    if (breakpoints.length > MAX_BREAKPOINTS) {
      console.log(`site defines ${breakpoints.length} breakpoint widths, only testing the narrowest ${MAX_BREAKPOINTS}: ${testWidths.join(', ')}`)
    }

    for (const width of testWidths) {
      await page.setViewportSize({ width, height: 900 })
      // let responsive JS (nav collapse, carousels re-initializing, ...) catch up
      await page.waitForTimeout(300)
      const breakpointTree = await page.evaluate(convertPageToSmarda, options)
      mergeBreakpoint(tree, breakpointTree, `max:${width}px`)
    }

    await writeFile(outFile, JSON.stringify(tree, null, 2))
    return tree
  } finally {
    await browser.close()
  }
}
