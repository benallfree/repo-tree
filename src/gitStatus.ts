/** Matches vscode.git `Status` enum (extensions/git/src/api/git.d.ts). */
export const GitStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const

export type GitStatusValue = (typeof GitStatus)[keyof typeof GitStatus]

export function statusLetter(status: GitStatusValue): string {
  switch (status) {
    case GitStatus.INDEX_MODIFIED:
    case GitStatus.MODIFIED:
    case GitStatus.BOTH_MODIFIED:
      return 'M'
    case GitStatus.INDEX_ADDED:
    case GitStatus.INTENT_TO_ADD:
    case GitStatus.BOTH_ADDED:
      return 'A'
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.DELETED_BY_THEM:
    case GitStatus.DELETED_BY_US:
    case GitStatus.BOTH_DELETED:
      return 'D'
    case GitStatus.INDEX_RENAMED:
    case GitStatus.INTENT_TO_RENAME:
      return 'R'
    case GitStatus.TYPE_CHANGED:
      return 'T'
    case GitStatus.UNTRACKED:
      return 'U'
    case GitStatus.IGNORED:
      return 'I'
    case GitStatus.INDEX_COPIED:
      return 'C'
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
      return '!'
    default:
      return '?'
  }
}

/** CSS class on file rows; maps to gitDecoration.* theme colors in repoWebview. */
export function statusCssClass(status: GitStatusValue): string {
  switch (status) {
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
      return 'status-untracked'
    case GitStatus.INDEX_ADDED:
      return 'status-added'
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.DELETED_BY_THEM:
    case GitStatus.DELETED_BY_US:
    case GitStatus.BOTH_DELETED:
      return 'status-deleted'
    case GitStatus.INDEX_RENAMED:
    case GitStatus.INTENT_TO_RENAME:
      return 'status-renamed'
    case GitStatus.IGNORED:
      return 'status-ignored'
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
    case GitStatus.BOTH_ADDED:
    case GitStatus.BOTH_MODIFIED:
    case GitStatus.INDEX_COPIED:
      return 'status-conflict'
    default:
      return 'status-modified'
  }
}

/** Right-side badge text like stock SCM (e.g. `9+, M`, `1, U`). */
export function formatStatusBadge(
  status: GitStatusValue,
  insertions?: number,
  deletions?: number
): string {
  const letter = statusLetter(status)
  if (status === GitStatus.UNTRACKED) {
    if (insertions !== undefined && insertions > 0) {
      return `${insertions}, ${letter}`
    }
    return letter
  }
  const parts: string[] = []
  if (insertions !== undefined && insertions > 0) {
    parts.push(`${insertions}+`)
  }
  if (deletions !== undefined && deletions > 0) {
    parts.push(`${deletions}-`)
  }
  if (parts.length === 0) {
    return letter
  }
  return `${parts.join(' ')}, ${letter}`
}
