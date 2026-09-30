import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appendGitignoreLine, toGitignorePattern } from './gitignore'

describe('appendGitignoreLine', () => {
  it('creates a one-line ignore file', () => {
    assert.equal(appendGitignoreLine('', 'src/tmp.txt'), 'src/tmp.txt\n')
  })

  it('appends after existing rules and adds a missing newline', () => {
    assert.equal(appendGitignoreLine('node_modules/', 'src/tmp.txt'), 'node_modules/\nsrc/tmp.txt\n')
    assert.equal(appendGitignoreLine('node_modules/\n', 'src/tmp.txt'), 'node_modules/\nsrc/tmp.txt\n')
  })

  it('skips a path that is already listed', () => {
    assert.equal(appendGitignoreLine('src/tmp.txt\n', 'src/tmp.txt'), null)
    assert.equal(appendGitignoreLine('foo\nsrc/tmp.txt\n', 'src/tmp.txt'), null)
  })

  it('does not treat a longer path as a duplicate', () => {
    assert.equal(appendGitignoreLine('src/tmp.txt.bak\n', 'src/tmp.txt'), 'src/tmp.txt.bak\nsrc/tmp.txt\n')
  })

  it('escapes brackets and marks directories', () => {
    assert.equal(toGitignorePattern('src/file[1].txt', false), 'src/file\\[1].txt')
    assert.equal(toGitignorePattern('src/tmp', true), 'src/tmp/')
  })
})
