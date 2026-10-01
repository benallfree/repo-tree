#!/usr/bin/env node
/** Print changelog body for ## [version] through next ## [ or EOF. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version) {
  console.error('usage: changelog-notes.mjs <semver>')
  process.exit(1)
}

const changelogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')
const text = fs.readFileSync(changelogPath, 'utf8')
const header = `## [${version}]`
const start = text.indexOf(header)
if (start < 0) {
  console.error(`section not found: ${header}`)
  process.exit(1)
}

const afterHeader = text.indexOf('\n', start) + 1
const rest = text.slice(afterHeader)
const next = rest.search(/^## \[/m)
const body = (next < 0 ? rest : rest.slice(0, next)).trim()

const install = `

### Install

Download \`repo-tree-${version}.vsix\` and install with **Extensions: Install from VSIX...**

Walkthrough: https://youtu.be/XgD1qGyHyfU`

console.log(body + install)
