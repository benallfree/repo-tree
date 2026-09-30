/** Repo-relative path as a .gitignore pattern. Directories get a trailing slash. */
export function toGitignorePattern(relativePath: string, directory: boolean): string {
  let pattern = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  pattern = pattern.replace(/\[/g, '\\[')
  if (directory) {
    pattern = pattern.replace(/\/+$/, '') + '/'
  }
  return pattern
}

/** Append a pattern to `.gitignore` contents. Null when that line is already present. */
export function appendGitignoreLine(contents: string, entry: string): string | null {
  const normalized = entry.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized === '.gitignore' || normalized === '.gitignore/') {
    return null
  }
  const already = contents.split(/\r?\n/).some((line) => line.trim() === normalized)
  if (already) {
    return null
  }
  const base = contents.length === 0 || contents.endsWith('\n') ? contents : `${contents}\n`
  return `${base}${normalized}\n`
}
