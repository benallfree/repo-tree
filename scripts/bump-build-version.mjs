#!/usr/bin/env node
/**
 * Local install build: package.json version becomes {semver}-b{N}.
 * Semver base is the X.Y.Z prefix (strips any existing -bN). N lives in .build-number.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const buildNumberPath = path.join(root, '.build-number')
const buildBasePath = path.join(root, '.build-base')

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const match = String(pkg.version).match(/^(\d+\.\d+\.\d+)(?:-b(\d+))?$/)
if (!match) {
  console.error(`package.json version must look like 1.2.3 or 1.2.3-b4, got: ${pkg.version}`)
  process.exit(1)
}

const base = match[1]
let storedBase = ''
try {
  storedBase = fs.readFileSync(buildBasePath, 'utf8').trim()
} catch {
  storedBase = ''
}

let build = 0
if (storedBase === base) {
  try {
    build = parseInt(fs.readFileSync(buildNumberPath, 'utf8').trim(), 10) || 0
  } catch {
    build = match[2] ? parseInt(match[2], 10) : 0
  }
} else if (match[2]) {
  build = parseInt(match[2], 10)
}

build += 1
fs.writeFileSync(buildBasePath, `${base}\n`)
fs.writeFileSync(buildNumberPath, `${build}\n`)

const next = `${base}-b${build}`
pkg.version = next
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(next)
