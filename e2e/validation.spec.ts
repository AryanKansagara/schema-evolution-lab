import { test, expect } from './fixtures.ts'

test.describe('Confluent Schema Registry parser validation and warnings', () => {
  test('JSON Schema refuses wrong-typed keywords inside the editor without blanking the UI', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'JSON Schema', exact: true }).click()
    await page.getByRole('button', { name: /Add a version/ }).click()
    const dismiss = page.getByRole('button', { name: 'Dismiss' })
    if (await dismiss.isVisible()) await dismiss.click()

    const editor = page.getByLabel('Schema text for version 2')
    await editor.fill(JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: 'id',
      additionalProperties: false,
    }, null, 2))

    await expect(page.locator('.editor-status.err')).toContainText('Does not parse')
    await expect(page.locator('.summary')).toContainText('does not parse')
    await expect(page.getByRole('button', { name: /v2 under BACKWARD: does not parse/ })).toBeVisible()
  })

  test('JSON Schema warns on negative minLength while keeping compatibility verdicts', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'JSON Schema', exact: true }).click()
    const editor = page.getByLabel('Schema text for version 1')
    await editor.fill(JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string', minLength: -1 } },
      required: ['id'],
      additionalProperties: false,
    }, null, 2))

    await expect(page.locator('.editor-status.warn')).toContainText('negative (-1)')
    await expect(page.locator('.editor-status.err')).toHaveCount(0)
  })

  test('Protobuf warns on tag 0 and non-zero proto3 enum start while analyzing compatibility', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Protobuf', exact: true }).click()
    await page.getByRole('button', { name: /Add a version/ }).click()
    const dismiss = page.getByRole('button', { name: 'Dismiss' })
    if (await dismiss.isVisible()) await dismiss.click()

    const editor = page.getByLabel('Schema text for version 2')
    await editor.fill([
      'syntax = "proto3";',
      '',
      'package example.v1;',
      '',
      'enum Status { ACTIVE = 1; }',
      '',
      'message Event {',
      '  string id = 1;',
      '  string bad_tag = 0;',
      '}',
      '',
    ].join('\n'))

    await expect(page.locator('.editor-status.warn')).toContainText('proto3 requires 0')
    await expect(page.locator('.editor-status.warn')).toContainText('invalid/reserved tag 0')
    await expect(page.getByRole('button', { name: 'v2 under BACKWARD: accepted' })).toBeVisible()
  })

  test('Avro refuses mismatched field default and warns on union non-first-branch default', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'JSON Schema', exact: true }).click()
    await page.getByRole('button', { name: 'Avro', exact: true }).click()
    const editor = page.getByLabel('Schema text for version 1')

    await editor.fill(JSON.stringify({
      type: 'record',
      name: 'Event',
      namespace: 'com.example',
      fields: [{ name: 'id', type: 'string', default: 123 }],
    }, null, 2))
    await expect(page.locator('.editor-status.err')).toContainText('Does not parse')

    await editor.fill(JSON.stringify({
      type: 'record',
      name: 'Event',
      namespace: 'com.example',
      fields: [{ name: 'id', type: ['null', 'string'], default: 'abc' }],
    }, null, 2))
    await expect(page.locator('.editor-status.warn')).toContainText('FIRST branch')
  })
})
