import type { PatchOp } from './types.ts'

export const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')
const unesc = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~')

export function getAt(doc: unknown, ptr: string): unknown {
  let cur: any = doc
  for (const k of split(ptr)) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

function split(ptr: string) {
  return ptr.replace(/^#/, '').split('/').slice(1).map(unesc)
}

function parentOf(doc: unknown, ptr: string): [any, string] {
  const keys = split(ptr)
  const last = keys.pop()!
  let cur: any = doc
  for (const k of keys) cur = cur[k]
  return [cur, last]
}

/** Apply ops to a JSON schema text (re-pretty-printed) or raw text edits (proto). */
export function applyPatch(text: string, ops: PatchOp[]): string {
  const textOps = ops.filter((o) => o.op === 'text') as Extract<PatchOp, { op: 'text' }>[]
  if (textOps.length) {
    let out = text
    for (const o of [...textOps].sort((a, b) => b.start - a.start)) out = out.slice(0, o.start) + o.value + out.slice(o.end)
    return out
  }
  let doc: any = JSON.parse(text)
  for (const o of ops) {
    if (o.op === 'text') continue
    if (o.ptr === '' || o.ptr === '#') {
      if (o.op === 'set') doc = structuredClone(o.value)
      continue
    }
    const [parent, key] = parentOf(doc, o.ptr)
    if (o.op === 'set') parent[key] = structuredClone(o.value)
    else if (o.op === 'remove') Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key]
    else {
      const arr = parent[key]
      arr.splice(Math.min(o.index, arr.length), 0, structuredClone(o.value))
    }
  }
  return JSON.stringify(doc, null, 2)
}
