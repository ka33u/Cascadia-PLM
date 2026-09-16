// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Restore the LF working tree that `.gitattributes` already mandates.
 *
 *   npm run eol:check   # report tracked files whose working copy is CRLF
 *   npm run eol:fix     # rewrite them to LF
 *
 * Also runs as `postinstall` with `--soft`, which is the point: `npm ci` is
 * already an unavoidable step when setting up a worktree, so the repair
 * happens exactly where the damage appears without anyone remembering to ask
 * for it. In `--soft` mode it never fails an install and says nothing unless
 * it actually converted something.
 *
 * That entry tests for this file before running it, and has to: Docker's
 * dependency stage runs `npm ci` with only the package manifests copied in, so
 * `scripts/` does not exist yet and node would fail on the missing path long
 * before `--soft` could apply. Adding `--ignore-scripts` there is not the
 * alternative — that stage needs esbuild's own install script.
 *
 * `* text=auto eol=lf` makes git write LF on checkout, so this should never
 * find anything. On Windows it does, for one narrow reason: git only writes a
 * working-tree file when it believes the content changed. A file some other
 * process rewrote with CRLF is stat-dirty but content-clean, so `checkout` and
 * `pull` skip it and the CRLF bytes persist indefinitely. Fresh
 * `git worktree add` trees land in exactly that state — twice now, with nearly
 * the same handful of files each time.
 *
 * What makes it worth a script rather than a paragraph is that `git status`
 * stays **clean** throughout: git normalises CRLF away on the way into the
 * index, so nothing in the usual workflow shows a problem, while every tool
 * that reads bytes off disk sees a file CI never will.
 *
 *   - `publish:reconciled` hashes the file and reports it as drifted content.
 *     Acting on that report is worse than ignoring it: `--fix` records the
 *     CRLF hash, which matches nothing in an LF checkout, so a local-only
 *     phantom becomes a real failure on `main` for everyone. That gate now
 *     recognises the case and points here instead.
 *   - `publish:links` anchors a per-line regex, and a CR terminates a line for
 *     a regex, so the scan silently finds nothing. That one fails **open** —
 *     a check that reports no problems is indistinguishable from a clean tree.
 *   - `format:check` flags every line of every affected file, burying real
 *     drift in the noise.
 *
 * Only CRLF *pairs* are removed. A lone CR is content, not a line ending, and
 * is left exactly where it is.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const CHECK = process.argv.includes('--check')
const SOFT = process.argv.includes('--soft')

/**
 * `git ls-files --eol` is the right oracle: it reports the working tree's
 * line ending *and* the attributes that decide what it ought to be. Selecting
 * on both means a file git deliberately treats as binary (`-text`, usually a
 * stray NUL byte) can never be picked up and mangled here.
 *
 * A published tarball or a Docker build context has no `.git` at all, and
 * `postinstall` still runs there. That is not a failure, it is a tree with
 * nothing to repair.
 */
let records
try {
  records = execFileSync('git', ['ls-files', '--eol', '-z'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean)
} catch {
  if (SOFT) process.exit(0)
  console.error('✗ Could not ask git for line endings — is this a checkout?')
  process.exit(1)
}

const candidates = []
for (const record of records) {
  const tab = record.indexOf('\t')
  if (tab === -1) continue
  const flags = record.slice(0, tab)
  const path = record.slice(tab + 1)

  const worktree = /\bw\/(\S+)/.exec(flags)?.[1]
  const attrs = /\battr\/(.*)$/.exec(flags)?.[1] ?? ''

  if (worktree !== 'crlf' && worktree !== 'mixed') continue
  if (!attrs.includes('eol=lf')) continue

  candidates.push(path)
}

/** Drop the CR of every CRLF pair, leaving a lone CR untouched. */
const toLf = (buf) => {
  const out = Buffer.allocUnsafe(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue
    out[n++] = buf[i]
  }
  return out.subarray(0, n)
}

const touched = []
for (const path of candidates) {
  try {
    const before = readFileSync(path)
    const after = toLf(before)
    if (after.length === before.length) continue
    if (!CHECK) writeFileSync(path, after)
    touched.push([path, before.length - after.length])
  } catch (error) {
    if (SOFT) continue
    throw error
  }
}

if (touched.length === 0) {
  if (!SOFT) {
    console.log(
      `Checked ${records.length} tracked file(s) — every working copy is LF.`,
    )
  }
  process.exit(0)
}

for (const [path, crs] of touched) {
  console.log(`   ${CHECK ? 'CRLF' : 'converted'}  ${path}  (${crs} CR bytes)`)
}

if (CHECK) {
  console.error(
    `\n✗ ${touched.length} file(s) have a CRLF working copy.\n` +
      `\n\`git status\` will not show this and CI cannot see it — CI checks out\n` +
      `on Linux, where these same files are LF. Repair the working tree with:\n` +
      `\n    npm run eol:fix\n`,
  )
  process.exit(1)
}

console.log(
  `\n✅ Rewrote ${touched.length} file(s) to LF.\n` +
    `\nThere is nothing to commit: git normalises CRLF on the way into the\n` +
    `index, so these blobs never differed. If \`git status\` now shows them as\n` +
    `modified, that is a stale stat cache and not a change — \`git add\` on the\n` +
    `named files clears it and stages nothing.`,
)
