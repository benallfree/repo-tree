#!/usr/bin/env node
/**
 * Local dev install: package.json + symlink use {semver}-next-b{N}.
 * Committed package.json is release semver only; N lives in .build-number.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEV_SUFFIX = '-next-b'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const buildNumberPath = path.join(root, '.build-number')
const buildBasePath = path.join(root, '.build-base')

function releaseSemverFromGit() {
  try {
    const raw = execSync('git show HEAD:package.json', { cwd: root, encoding: 'utf8' })
    const m = String(JSON.parse(raw).version).match(/^(\d+\.\d+\.\d+)$/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function parseVersion(version) {
  const next = String(version).match(/^(\d+\.\d+\.\d+)-next-b(\d+)$/)
  if (next) {
    return { base: next[1], build: parseInt(next[2], 10) }
  }
  const legacy = String(version).match(/^(\d+\.\d+\.\d+)(?:-b(\d+))?$/)
  if (legacy) {
    return {
      base: legacy[1],
      build: legacy[2] ? parseInt(legacy[2], 10) : 0,
    }
  }
  return null
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const gitBase = releaseSemverFromGit()
const fromPkg = parseVersion(pkg.version)

if (!fromPkg && !gitBase) {
  console.error(
    `package.json version must look like 1.2.3 or 1.2.3-next-b4, got: ${pkg.version}`
  )
  process.exit(1)
}

const base = gitBase ?? fromPkg.base

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
    build = fromPkg?.build ?? 0
  }
} else if (fromPkg && fromPkg.base === base) {
  build = fromPkg.build
}

build += 1
fs.writeFileSync(buildBasePath, `${base}\n`)
fs.writeFileSync(buildNumberPath, `${build}\n`)

const installId = `${base}${DEV_SUFFIX}${build}`
pkg.version = installId
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(installId)
