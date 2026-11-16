# Schema Evolution Lab

A Schema Registry compatibility checker for a subject's whole version history. Avro, JSON Schema and Protobuf.

**Live:** https://schema-evolution-lab.vercel.app

## The pain

Schema Registry answers a bad registration with a 409 and an error type. It checks one schema at a time, and it won't say which side breaks, what to change, or who should upgrade first. A failure under a transitive mode doesn't point you at the old version that caused it, and there's no easy way to try a change across modes without registering it.

## Features

- **Version × mode matrix** across all seven modes, plus a reader × writer grid
- **Rules modeled on the registry**: Avro's `SchemaCompatibility` checks, and the JSON Schema and Protobuf `SchemaDiff` difference types, messages and compatible-change sets, including STRICT and LENIENT for JSON Schema
- **Plain-English findings**: path, field, which side can't read which, and why, next to the registry's own error string
- **One-click fixes** that edit the new version, with undo
- **Timeline**: add, edit, reorder or delete versions, or paste, upload and drop `.avsc`, `.json` and `.proto` files
- **Structural and line diff** between any two versions
- **Upgrade order** per mode, and per transition based on what it actually allows
- **Avro simulation**: generate or edit a record, then watch the reader fill defaults, drop fields and promote types
- **Shareable URLs**: the subject is compressed into the hash, so nothing leaves the browser
- **Registry exports**: load what `GET /subjects/{subject}/versions/{version}` returns, one response or an array of them, as an ordered subject
- **How it works** at `/docs`: the rules per format, the limits, and the sources

## Run locally

```sh
npm install
npm run dev     # http://localhost:4313
npm test
npm run build
```

## Checked against the registry

The Schema Registry repository ships data files of schema pairs with the differences its diff code must report
(`diff-schema-examples.json` and `diff-combined-schema-examples.json` under each provider's test resources). On
2026-11-16 the engine was run against all of them:

| Suite | Examples | Same verdict | Same difference list and paths |
| --- | --- | --- | --- |
| JSON Schema | 139 | 139 | 139 |
| Protobuf | 54 | 50 | 47 |

The seven Protobuf examples that differ all depend on the contents of an imported file registered under another
subject. Those data files are under the Confluent Community License and are not copied into this repository; the tests
in `src/engine/conformance.test.ts` were written for this project and cover the same rules. Avro rules were re-read
against Apache Avro's `SchemaCompatibility.java`.

Real files used by the tests are listed with their sources and licences in `src/engine/fixtures/SOURCES.md`.

## Known limits

- Schema references between subjects aren't resolved. An external JSON Schema `$ref` is a parse error, and an imported Protobuf type is compared by name only.
- The registry's normalization, rule sets, metadata and `confluent:reserved` fields aren't modeled.
- Where matching `oneOf`/`anyOf`/`allOf` branches has more than one valid answer, the compatible differences listed can differ from the registry's. The verdict is the same.
- Avro logical types aren't compared (as in Avro itself), so a changed decimal scale passes.
- Each matrix row assumes every earlier version is registered. A real registry would refuse a rejected version, so later non-transitive checks there would run against the last accepted one.
- There is no direct connection to a registry: browsers can't call one without CORS and credentials, so subjects come in as files or pasted text.
