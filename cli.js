#!/usr/bin/env node
import { downloadPage } from './src/downloadPage.js'

function parseArgs(argv) {
  const args = { out: 'page.json', waitMs: 1500, excludeHeader: false, excludeFooter: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') args.out = argv[++i]
    else if (arg === '--wait') args.waitMs = Number(argv[++i])
    else if (arg === '--no-header') args.excludeHeader = true
    else if (arg === '--no-footer') args.excludeFooter = true
    else positional.push(arg)
  }
  args.url = positional[0]
  return args
}

const args = parseArgs(process.argv.slice(2))

if (!args.url) {
  console.error('Usage: node cli.js <url> [--out <file>] [--wait <ms>] [--no-header] [--no-footer]')
  process.exit(1)
}

downloadPage({
  url: args.url,
  outFile: args.out,
  waitMs: args.waitMs,
  excludeHeader: args.excludeHeader,
  excludeFooter: args.excludeFooter,
})
  .then(tree => console.log(`done, ${tree.length} top-level node(s) saved to ${args.out}`))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
