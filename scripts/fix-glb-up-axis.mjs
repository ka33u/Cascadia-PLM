// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Backfill the Z-up -> Y-up root rotation into GLBs the CAD converter wrote
 * before that rotation existed.
 *
 * STEP/IGES and the OpenCASCADE kernel are Z-up; glTF 2.0 mandates Y-up. The
 * converter used to emit `"nodes": [{"mesh": 0}]` — raw Z-up coordinates in a
 * file every consumer reads as Y-up — so parts render lying on their back, top
 * face pointing at the viewer's front. `gltf_writer.py` now emits the rotation;
 * this rewrites the files already in the vault.
 *
 * Only the JSON chunk is touched. Vertex data is left byte-for-byte alone, so
 * this is far cheaper than re-tessellating, and accessors keep the native part
 * coordinates the version-comparison overlay depends on.
 *
 * Safety: only files whose `asset.generator` is "Cascadia CAD Converter" are
 * rewritten. A correctly-authored third-party GLB sitting in the vault is left
 * alone — rotating one of those would break it. Re-running is a no-op.
 *
 *   node scripts/fix-glb-up-axis.mjs <file-or-dir>... [--dry-run]
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const GENERATOR = 'Cascadia CAD Converter'

/** Quaternion (x, y, z, w) for -90 degrees about X: model +Z -> world +Y. */
const SIN45 = 0.7071067811865476
export const Z_UP_TO_Y_UP_ROTATION = [-SIN45, 0, 0, SIN45]

export function parseGlb(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a GLB (bad magic)')
  }
  const chunks = []
  let off = 12
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (start + length > buf.length) throw new Error('truncated chunk')
    chunks.push({ type, data: buf.subarray(start, start + length) })
    off = start + length + ((4 - (length % 4)) % 4)
  }
  const jsonChunk = chunks.find((c) => c.type === CHUNK_JSON)
  if (!jsonChunk) throw new Error('no JSON chunk')
  return { chunks, json: JSON.parse(jsonChunk.data.toString('utf8')) }
}

export function serializeGlb(chunks, json) {
  const parts = chunks.map((chunk) => {
    let data =
      chunk.type === CHUNK_JSON
        ? Buffer.from(JSON.stringify(json), 'utf8')
        : chunk.data
    const pad = (4 - (data.length % 4)) % 4
    if (pad > 0) {
      // JSON pads with spaces, BIN (and anything else) with zeros.
      data = Buffer.concat([
        data,
        Buffer.alloc(pad, chunk.type === CHUNK_JSON ? 0x20 : 0x00),
      ])
    }
    const header = Buffer.alloc(8)
    header.writeUInt32LE(data.length, 0)
    header.writeUInt32LE(chunk.type, 4)
    return Buffer.concat([header, data])
  })

  const body = Buffer.concat(parts)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + body.length, 8)
  return Buffer.concat([header, body])
}

const isRotated = (node) =>
  Array.isArray(node?.rotation) &&
  node.rotation.length === 4 &&
  node.rotation.every((v, i) => Math.abs(v - Z_UP_TO_Y_UP_ROTATION[i]) < 1e-6)

/**
 * Wrap the default scene's roots in a node carrying the rotation.
 *
 * The wrapper is appended to `nodes` rather than spliced in at 0, so every
 * existing node index — and every reference to one from a skin, animation or
 * another node's children — stays valid.
 *
 * @returns 'rewritten' | 'already-correct' | 'foreign'
 */
export function addUpAxisRotation(json) {
  if (json.asset?.generator !== GENERATOR) return 'foreign'

  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene?.nodes
  if (!Array.isArray(roots) || roots.length === 0) return 'already-correct'
  if (roots.every((i) => isRotated(json.nodes?.[i]))) return 'already-correct'

  json.nodes.push({
    rotation: [...Z_UP_TO_Y_UP_ROTATION],
    children: [...roots],
  })
  scene.nodes = [json.nodes.length - 1]
  return 'rewritten'
}

function* walk(path) {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) yield* walk(join(path, entry))
  } else if (path.toLowerCase().endsWith('.glb')) {
    yield path
  }
}

/**
 * Run only as a CLI. The three functions above are exported so their own test
 * can drive them without touching a vault.
 */
function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const targets = args.filter((a) => !a.startsWith('--'))

  if (targets.length === 0) {
    console.error(
      'usage: node scripts/fix-glb-up-axis.mjs <file-or-dir>... [--dry-run]',
    )
    process.exit(2)
  }

  const tally = { rewritten: 0, 'already-correct': 0, foreign: 0, failed: 0 }

  for (const target of targets) {
    for (const file of walk(target)) {
      try {
        const buf = readFileSync(file)
        const { chunks, json } = parseGlb(buf)
        const outcome = addUpAxisRotation(json)
        tally[outcome]++
        if (outcome === 'rewritten' && !dryRun) {
          writeFileSync(file, serializeGlb(chunks, json))
        }
        if (outcome === 'foreign') {
          console.log(
            `  skipped (generator "${json.asset?.generator ?? '?'}"): ${file}`,
          )
        }
      } catch (error) {
        tally.failed++
        console.error(`  FAILED ${file}: ${error.message}`)
      }
    }
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}rewritten ${tally.rewritten}, ` +
      `already correct ${tally['already-correct']}, ` +
      `skipped (not ours) ${tally.foreign}, failed ${tally.failed}`,
  )
  process.exit(tally.failed > 0 ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
