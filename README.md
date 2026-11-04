# Schema Evolution Lab

A Schema Registry compatibility checker for a subject's whole version history. Avro, JSON Schema and Protobuf.

**Live:** LIVE_URL

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

## Run locally

```sh
npm install
npm run dev     # http://localhost:4313
npm test
npm run build
```

## Known limits

- JSON Schema: `dependencies` keywords and external `$ref`s aren't compared.
- Protobuf: imported types are compared by name only. Schema references between subjects aren't resolved.
- Each matrix row assumes every earlier version is registered. A real registry would refuse a rejected version, so later non-transitive checks there would run against the last accepted one.
