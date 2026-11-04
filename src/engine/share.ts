import type { Subject } from './compat.ts'
import { MODES, type Format } from './types.ts'

async function pump(bytes: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const w = stream.writable.getWriter()
  void w.write(bytes).catch(() => {})
  void w.close().catch(() => {})
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export async function encodeSubject(s: Subject): Promise<string> {
  const body = JSON.stringify({ n: s.name, f: s.format, m: s.mode, p: s.policy, v: s.versions.map((x) => x.text) })
  return toB64(await pump(new TextEncoder().encode(body), new CompressionStream('deflate-raw')))
}

/** Hash content is untrusted input, so anything malformed comes back as null. */
export async function decodeSubject(hash: string): Promise<Subject | null> {
  try {
    const raw = await pump(fromB64(hash), new DecompressionStream('deflate-raw'))
    const o = JSON.parse(new TextDecoder().decode(raw))
    if (!Array.isArray(o.v) || !o.v.every((t: unknown) => typeof t === 'string')) return null
    if (!['AVRO', 'JSON', 'PROTOBUF'].includes(o.f) || !MODES.includes(o.m)) return null
    return {
      name: String(o.n ?? 'subject'),
      format: o.f as Format,
      mode: o.m,
      policy: o.p === 'LENIENT' ? 'LENIENT' : 'STRICT',
      versions: o.v.map((text: string, i: number) => ({ id: `s${i}`, text })),
    }
  } catch {
    return null
  }
}
