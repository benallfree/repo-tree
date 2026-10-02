import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatStatusBadge, GitStatus, statusLetter } from './gitStatus'

describe('statusLetter', () => {
  it('maps common git statuses', () => {
    assert.equal(statusLetter(GitStatus.MODIFIED), 'M')
    assert.equal(statusLetter(GitStatus.UNTRACKED), 'U')
    assert.equal(statusLetter(GitStatus.DELETED), 'D')
    assert.equal(statusLetter(GitStatus.INDEX_ADDED), 'A')
  })
})

describe('formatStatusBadge', () => {
  it('formats modified with insertions', () => {
    assert.equal(formatStatusBadge(GitStatus.MODIFIED, 9, 0), '9+, M')
  })

  it('formats untracked with line count', () => {
    assert.equal(formatStatusBadge(GitStatus.UNTRACKED, 1, 0), '1, U')
  })

  it('returns letter only when no stats', () => {
    assert.equal(formatStatusBadge(GitStatus.DELETED), 'D')
  })
})
