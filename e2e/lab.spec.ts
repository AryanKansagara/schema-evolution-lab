import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.ts'

// The registry export used by the unit tests: three JSON Schema versions of `shipments-value`, deliberately out of order (2, 1, 3).
const REGISTRY_EXPORT = fileURLToPath(new URL('../src/engine/fixtures/registry-export.json', import.meta.url))

const MODES = ['BACKWARD', 'BACKWARD_TRANSITIVE', 'FORWARD', 'FORWARD_TRANSITIVE', 'FULL', 'FULL_TRANSITIVE', 'NONE']

const summary = (page: Page) => page.locator('.summary')
const toast = (page: Page) => page.locator('.toast')
const editor = (page: Page, v: number) => page.getByLabel(`Schema text for version ${v}`)
const timelineNode = (page: Page, v: number) => page.getByRole('button', { name: new RegExp(`^Version ${v},`) })
const cell = (page: Page, v: number, mode: string) => page.getByRole('button', { name: new RegExp(`^v${v} under ${mode}:`) })
const matrixRows = (page: Page) => page.locator('table.matrix:not(.pairs) tbody tr')

/** The matrix as text: one array per row (v1 first), one entry per mode, e.g. "✕3" for a rejection with 3 incompatibilities. */
async function matrix(page: Page) {
  const rows = await matrixRows(page).all()
  return Promise.all(rows.map(async (row) => (await row.locator('td').allInnerTexts()).map((t) => t.replace(/\s+/g, ''))))
}

async function openSample(page: Page, title: string) {
  await page.goto('/app')
  await page.getByLabel('Sample').selectOption({ label: title })
  await expect(toast(page)).toContainText(`Loaded ${title}`)
}

const same = (s: string) => Array<string>(7).fill(s)

const SAMPLES = [
  {
    title: 'Orders topic',
    format: 'Avro',
    subject: 'orders-value',
    summary: 'v4 rejected under BACKWARD',
    rows: [same('–'), same('✓'), ['✓', '✓', '✕1', '✕2', '✕1', '✕2', '✓'], ['✕1', '✕3', '✕1', '✕5', '✕2', '✕8', '✓'], ['✓', '✕3', '✓', '✕5', '✓', '✕8', '✓']],
  },
  {
    title: 'User profile',
    format: 'JSON Schema',
    subject: 'user-profile-value',
    summary: 'v2, v3, v4 rejected under BACKWARD',
    rows: [same('–'), ['✕1', '✕1', '✓', '✓', '✕1', '✕1', '✓'], ['✕3', '✕7', '✓', '✓', '✕3', '✕7', '✓'], ['✕1', '✕4', '✕4', '✕6', '✕5', '✕10', '✓']],
  },
  {
    title: 'Payments',
    format: 'Protobuf',
    subject: 'payments-value',
    summary: 'v3, v4 rejected under BACKWARD',
    rows: [same('–'), same('✓'), ['✕1', '✕2', '✕1', '✕2', '✕2', '✕4', '✓'], ['✕2', '✕2', '✕1', '✕1', '✕3', '✕3', '✓']],
  },
]

test.describe('loading a subject', () => {
  for (const s of SAMPLES) {
    test(`${s.format}: ${s.title} shows the version and mode matrix`, async ({ page }) => {
      await openSample(page, s.title)
      await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(s.subject)
      await expect(page.getByRole('button', { name: s.format, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('combobox', { name: 'Compatibility' })).toHaveValue('BACKWARD')
      await expect(summary(page)).toContainText(s.summary)

      // All seven modes as columns, one row per version.
      const headers = page.locator('table.matrix:not(.pairs) thead th[title]')
      await expect(headers).toHaveCount(7)
      expect(await headers.evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(MODES)
      await expect(matrixRows(page)).toHaveCount(s.rows.length)
      expect(await matrix(page)).toEqual(s.rows)

      // The reader x writer grid has an n x n body with the diagonal left empty.
      await expect(page.locator('table.pairs tbody tr')).toHaveCount(s.rows.length)
      await expect(page.locator('table.pairs td.diag')).toHaveCount(s.rows.length)
    })
  }

  test('the JSON Schema policy selector only exists for JSON Schema', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await expect(page.getByRole('combobox', { name: 'Policy' })).toHaveCount(0)
    await page.getByLabel('Sample').selectOption({ label: 'User profile' })
    await expect(page.getByRole('combobox', { name: 'Policy' })).toHaveValue('STRICT')
    // LENIENT allows an optional property on an open content model, so v2 of the sample is accepted.
    await expect(cell(page, 2, 'BACKWARD')).toHaveAccessibleName(/rejected, 1 incompatibility/)
    await page.getByRole('combobox', { name: 'Policy' }).selectOption('LENIENT')
    await expect(cell(page, 2, 'BACKWARD')).toHaveAccessibleName('v2 under BACKWARD: accepted')
  })

  test('the landing page, docs and sample link reach the lab', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Catch the breaking schema')
    await page.getByRole('link', { name: 'Try the orders topic' }).click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('orders-value')
    await page.getByRole('link', { name: 'How it works' }).first().click()
    await expect(page).toHaveURL(/\/docs$/)
    await expect(page.locator('main')).toContainText(/Avro/)
  })
})

test.describe('a breaking change', () => {
  test('shows path, side and registry error, and a one-click fix can be undone', async ({ page }) => {
    await openSample(page, 'Orders topic')
    // The lab opens on the first rejection under the subject's mode.
    await expect(summary(page)).toContainText('v4 rejected under BACKWARD')
    const findings = page.getByRole('region', { name: 'Findings' })
    await expect(findings).toContainText('v4 under BACKWARD')
    await expect(findings).toContainText('1 incompatibility')
    const card = findings.locator('article.issue')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('heading', { level: 4 })).toHaveText('Reader needs a field the writer never wrote')
    await expect(card.locator('.chip-bad')).toHaveText('READER_FIELD_MISSING_DEFAULT_VALUE')
    // Side: v3 data read by the v4 reader. Path: where the field sits in the schema.
    await expect(card.locator('.direction')).toContainText('v3 data')
    await expect(card.locator('.direction')).toContainText('v4 reader')
    await expect(card.locator('dd').nth(0)).toHaveText('Order.channel')
    await expect(card.locator('dd').nth(1)).toContainText('/fields/7')
    await expect(card.locator('dd').nth(2)).toContainText('Consumers on v4 cannot read records produced with v3')
    // The registry's own error string is one click away.
    await card.getByText('Registry error').click()
    await expect(card.locator('pre')).toContainText('errorType:"READER_FIELD_MISSING_DEFAULT_VALUE"')
    await expect(card.locator('pre')).toContainText('description:"The field \'channel\' at path \'/fields/7\' in the new schema has no default value')

    const before = await editor(page, 4).inputValue()
    expect(before).not.toMatch(/"name": "channel",\s*"type": "string",\s*"default"/)
    await card.getByRole('button', { name: 'Apply fix to v4' }).click()

    // The fix edits v4 and every version now passes.
    await expect(toast(page)).toContainText('v4: Add "default": "" to \'channel\'')
    await expect(editor(page, 4)).toHaveValue(/"name": "channel",\s*"type": "string",\s*"default": ""/)
    await expect(summary(page)).toContainText('Every version passes BACKWARD')
    await expect(cell(page, 4, 'BACKWARD')).toHaveAccessibleName('v4 under BACKWARD: accepted')

    // Undo restores the exact previous text and the rejection.
    await toast(page).getByRole('button', { name: 'Undo' }).click()
    await expect(editor(page, 4)).toHaveValue(before)
    await expect(summary(page)).toContainText('v4 rejected under BACKWARD')
    await expect(cell(page, 4, 'BACKWARD')).toHaveAccessibleName(/rejected, 1 incompatibility/)
  })

  test('a mode that checks older versions names the pair that fails', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await cell(page, 5, 'BACKWARD_TRANSITIVE').click()
    const findings = page.getByRole('region', { name: 'Findings' })
    await expect(findings).toContainText('v5 under BACKWARD_TRANSITIVE')
    await expect(findings).toContainText('3 incompatibilities')
    // v5 only fails against the older versions v1 to v3; the direct predecessor is fine.
    const directions = (await findings.locator('article.issue .direction').allInnerTexts()).map((d) => d.replace(/\s+/g, ' ').trim())
    expect(directions.sort()).toEqual(['v1 data → read by v5 reader', 'v2 data → read by v5 reader', 'v3 data → read by v5 reader'])
  })

  test('the Protobuf and JSON Schema fixes work the same way', async ({ page }) => {
    await openSample(page, 'User profile')
    await expect(summary(page)).toContainText('v2, v3, v4 rejected under BACKWARD')
    await page.getByRole('button', { name: 'Apply fix to v2' }).click()
    await expect(cell(page, 2, 'BACKWARD')).toHaveAccessibleName('v2 under BACKWARD: accepted')
    await toast(page).getByRole('button', { name: 'Undo' }).click()
    await expect(cell(page, 2, 'BACKWARD')).toHaveAccessibleName(/rejected/)

    await openSample(page, 'Payments')
    await cell(page, 3, 'BACKWARD').click()
    await page.getByRole('button', { name: /^Apply fix to v3/ }).click()
    await expect(cell(page, 3, 'BACKWARD')).toHaveAccessibleName('v3 under BACKWARD: accepted')
  })
})

test.describe('the timeline', () => {
  test('imports a registry export, then reorders, adds and deletes versions', async ({ page }) => {
    await page.goto('/app')
    await page.locator('input[type=file]').setInputFiles(REGISTRY_EXPORT)
    await expect(toast(page)).toContainText('Loaded 3 versions of shipments-value from the registry export')
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('shipments-value')
    await expect(page.getByRole('button', { name: 'JSON Schema', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(3)
    // The export lists versions 2, 1, 3; the lab orders them by registry version, so v1 is the DHL/UPS-only schema.
    await timelineNode(page, 1).click()
    await expect(editor(page, 1)).toHaveValue(/"DHL",\s*"UPS"\s*\]/)
    await expect(editor(page, 1)).not.toHaveValue(/FEDEX/)
    await timelineNode(page, 2).click()
    await expect(editor(page, 2)).toHaveValue(/FEDEX/)
    await timelineNode(page, 3).click()
    await expect(editor(page, 3)).toHaveValue(/"weight_kg",?/)
    await expect(summary(page)).toContainText('v3 rejected under BACKWARD')

    // Reorder: moving v3 earlier makes it v2 and the old v2 the new v3.
    const v3Text = await editor(page, 3).inputValue()
    await page.getByRole('button', { name: 'Move v3 earlier' }).click()
    await expect(editor(page, 2)).toHaveValue(v3Text)
    await expect(timelineNode(page, 2)).toHaveAttribute('aria-current', 'true')
    await timelineNode(page, 3).click()
    await expect(editor(page, 3)).toHaveValue(/FEDEX/)
    // The keyboard does the same: Alt plus an arrow moves the selected version.
    await timelineNode(page, 3).focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(timelineNode(page, 2)).toHaveAttribute('aria-current', 'true')
    await expect(editor(page, 2)).toHaveValue(/FEDEX/)

    // Add starts from a copy of the latest version, which is trivially compatible with it.
    await timelineNode(page, 3).click()
    const last = await editor(page, 3).inputValue()
    await page.getByRole('button', { name: 'Add a version, starting from the latest' }).click()
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(4)
    await expect(timelineNode(page, 4)).toHaveAttribute('aria-current', 'true')
    await expect(editor(page, 4)).toHaveValue(last)
    // An identical copy adds no difference against its predecessor.
    await expect(cell(page, 4, 'BACKWARD')).toHaveAccessibleName('v4 under BACKWARD: accepted')

    // Delete removes the version, and Undo from the toast puts it back in place.
    const v1Text = await (async () => {
      await timelineNode(page, 1).click()
      return editor(page, 1).inputValue()
    })()
    await page.getByRole('button', { name: 'Delete v1' }).click()
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(3)
    await expect(toast(page)).toContainText('Deleted v1')
    await toast(page).getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(4)
    await timelineNode(page, 1).click()
    await expect(editor(page, 1)).toHaveValue(v1Text)
  })

  test('the last remaining version cannot be deleted', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Protobuf', exact: true }).click()
    await expect(toast(page)).toContainText('Switched to PROTOBUF')
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Delete v1' })).toBeDisabled()
  })

  test('a file in another format starts a new subject; Undo returns to the old one', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await page.locator('input[type=file]').setInputFiles({ name: 'event.proto', mimeType: 'text/plain', buffer: Buffer.from('syntax = "proto3";\n\nmessage Event {\n  string id = 1;\n}\n') })
    await expect(toast(page)).toContainText('event.proto is PROTOBUF')
    await expect(page.getByRole('button', { name: 'Protobuf', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(1)
    await toast(page).getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(5)
  })
})

test.describe('Avro simulation', () => {
  test('fills a default and promotes a type', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await page.getByRole('tab', { name: 'Simulate' }).click()
    const notes = page.locator('.sim-notes li')

    // v4 data read by the v5 reader: `region` is new with a default.
    await page.getByLabel('Writer').selectOption({ label: 'v4' })
    await page.getByLabel('Reader').selectOption({ label: 'v5' })
    await expect(page.getByText('Written with v4 (editable)')).toBeVisible()
    await expect(notes.filter({ hasText: 'default filled' })).toContainText('Order.region')
    await expect(notes.filter({ hasText: 'default filled' })).toContainText('not in writer, filled with default "eu-west-1"')
    await expect(page.locator('pre.record')).toContainText('"region": "eu-west-1"')
    await expect(page.locator('#sim-record')).not.toHaveValue(/region/)

    // v2 data read by the v3 reader: `quantity` is int in v2 and long in v3.
    await page.getByLabel('Writer').selectOption({ label: 'v2' })
    await page.getByLabel('Reader').selectOption({ label: 'v3' })
    await expect(notes.filter({ hasText: 'promoted' })).toContainText('Order.quantity')
    await expect(notes.filter({ hasText: 'promoted' })).toContainText('int promoted to long')

    // A field the reader dropped is reported as dropped: v3 data read by v4 loses `currency`.
    await page.getByLabel('Writer').selectOption({ label: 'v3' })
    await page.getByLabel('Reader').selectOption({ label: 'v4' })
    await expect(notes.filter({ hasText: 'dropped' })).toContainText('currency')
  })

  test('a record the reader cannot resolve is a decoding failure, never a quiet success', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await page.getByRole('tab', { name: 'Simulate' }).click()
    // v3 data (quantity is long) read by the v2 reader (quantity is int) is not resolvable.
    await page.getByLabel('Writer').selectOption({ label: 'v3' })
    await page.getByLabel('Reader').selectOption({ label: 'v2' })
    await expect(page.locator('.sim-fail')).toContainText('AvroTypeException')
    await expect(page.locator('pre.record')).toHaveCount(0)
    // Editing the record into something that is not JSON is reported, not ignored.
    await page.locator('#sim-record').fill('{ "order_id": ')
    await expect(page.locator('.err.small')).toBeVisible()
  })

  test('only Avro is simulated', async ({ page }) => {
    await openSample(page, 'Payments')
    await page.getByRole('tab', { name: 'Simulate' }).click()
    await expect(page.locator('#tabpanel')).toContainText('Protobuf decodes by tag')
    await expect(page.locator('#sim-record')).toHaveCount(0)
  })
})

test.describe('share links', () => {
  test('a share URL restores the subject in a new browser context', async ({ page, newPage }) => {
    await openSample(page, 'Orders topic')
    await page.getByLabel('Subject', { exact: true }).fill('e2e-share-subject')
    await page.getByRole('button', { name: 'Apply fix to v4' }).click()
    await page.getByRole('combobox', { name: 'Compatibility' }).selectOption('FULL_TRANSITIVE')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(toast(page)).toContainText('Share link copied')
    const url = await page.evaluate(() => navigator.clipboard.readText())
    expect(url).toMatch(/\/app#s=[\w-]+$/)
    expect(page.url()).toBe(url)
    const edited = await editor(page, 4).inputValue()

    // A fresh context has no localStorage, so everything it shows came from the URL.
    const other = await newPage()
    await other.goto(url)
    await expect(toast(other)).toContainText('Loaded shared subject e2e-share-subject')
    await expect(other.getByLabel('Subject', { exact: true })).toHaveValue('e2e-share-subject')
    await expect(other.getByRole('combobox', { name: 'Compatibility' })).toHaveValue('FULL_TRANSITIVE')
    await expect(other.getByRole('button', { name: 'Avro', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(other.locator('.timeline li.tl:not(.add)')).toHaveCount(5)
    await timelineNode(other, 4).click()
    await expect(editor(other, 4)).toHaveValue(edited)
    expect(await matrix(other)).toEqual(await matrix(page))
    // The original page was not changed by the new context.
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('e2e-share-subject')
  })

  test('a damaged share link is reported and nothing is loaded from it', async ({ page }) => {
    for (const hash of ['#s=!!!notbase64!!!', '#s=AAAA', '#s=eyJ2IjoxfQ']) {
      await page.goto('/app')
      await page.evaluate((h) => (location.hash = h), hash)
      await expect(toast(page)).toContainText('That share link is damaged')
      await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('orders-value')
    }
  })
})

test.describe('unparsable versions', () => {
  const BROKEN = [
    { label: 'truncated text', fill: (text: string) => text.slice(0, Math.floor(text.length / 2)) },
    { label: 'empty text', fill: () => '' },
    { label: 'whitespace only', fill: () => '  \n  ' },
    { label: 'not a schema at all', fill: () => 'this is not a schema' },
  ]
  for (const s of SAMPLES) {
    for (const b of BROKEN) {
      test(`${s.format}, v2 as ${b.label}, is never shown as compatible`, async ({ page }) => {
        await openSample(page, s.title)
        await timelineNode(page, 2).click()
        await editor(page, 2).fill(b.fill(await editor(page, 2).inputValue()))

        await expect(page.locator('.editor-status.err')).toContainText('Does not parse')
        await expect(summary(page)).toContainText('1 version does not parse')
        await expect(summary(page)).toHaveClass(/warn/)
        await expect(timelineNode(page, 2)).toHaveAccessibleName(/does not parse under BACKWARD/)

        // The broken version itself is "does not parse" in every mode.
        for (const mode of MODES) await expect(cell(page, 2, mode)).toHaveAccessibleName(`v2 under ${mode}: does not parse`)
        // Its successor is checked against it under every mode that compares them, so it cannot be accepted either.
        for (const mode of MODES.filter((m) => m !== 'NONE')) await expect(cell(page, 3, mode)).toHaveAccessibleName(new RegExp(`^v3 under ${mode}: does not parse`))
        // Only NONE, which checks nothing, accepts v3.
        await expect(cell(page, 3, 'NONE')).toHaveAccessibleName('v3 under NONE: accepted')

        // The explanation asks for a fix instead of declaring compatibility.
        await cell(page, 2, 'BACKWARD').click()
        const findings = page.getByRole('region', { name: 'Findings' })
        await expect(findings.locator('.tag.warn')).toHaveText('does not parse')
        await expect(findings).toContainText('Fix the parse error in the editor first.')
        await expect(findings.locator('.tag.ok')).toHaveCount(0)
        // The reader x writer grid does not claim v2 can read or be read by anything either.
        await expect(page.locator('table.pairs').getByRole('button', { name: /^v2 \/ v\d: a schema does not parse|^v\d \/ v2: a schema does not parse/ })).toHaveCount(2 * (s.rows.length - 1))
        await expect(page.locator('table.pairs').getByRole('button', { name: /^v2 reading v\d data: compatible|^v\d reading v2 data: compatible/ })).toHaveCount(0)
      })
    }
  }

  test('repairing the text brings the verdicts back', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await timelineNode(page, 2).click()
    const good = await editor(page, 2).inputValue()
    await editor(page, 2).fill('{ "type": "record"')
    await expect(summary(page)).toContainText('1 version does not parse')
    await editor(page, 2).fill(good)
    await expect(summary(page)).toContainText('v4 rejected under BACKWARD')
    expect(await matrix(page)).toEqual(SAMPLES[0].rows)
  })

  test('the diff and upgrade panels do not claim anything about an unparsable version', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await timelineNode(page, 2).click()
    await editor(page, 2).fill('{')
    await page.getByRole('tab', { name: 'Diff' }).click()
    await expect(page.locator('#tabpanel')).toContainText('does not parse, so only the text diff is available')
    await page.getByRole('tab', { name: 'Upgrade order' }).click()
    await expect(page.locator('.steps li').first()).toContainText('Does not parse.')
    await page.getByRole('tab', { name: 'Simulate' }).click()
    await expect(page.locator('#tabpanel')).toContainText('Both versions must parse before a record can be resolved.')
  })
})

test.describe('persistence', () => {
  test('edits survive a reload', async ({ page }) => {
    await openSample(page, 'Orders topic')
    await page.getByLabel('Subject', { exact: true }).fill('persisted-subject')
    await page.getByRole('combobox', { name: 'Compatibility' }).selectOption('FULL')
    await timelineNode(page, 1).click()
    const text = (await editor(page, 1).inputValue()).replace('"order_id"', '"order_ref"')
    await editor(page, 1).fill(text)
    // Saving is debounced; wait for the write rather than sleeping.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('schemaEvolutionLab') ?? '')).toContain('order_ref')

    await page.reload()
    await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('persisted-subject')
    await expect(page.getByRole('combobox', { name: 'Compatibility' })).toHaveValue('FULL')
    await expect(page.locator('.timeline li.tl:not(.add)')).toHaveCount(5)
    await timelineNode(page, 1).click()
    await expect(editor(page, 1)).toHaveValue(text)
  })

  test('the theme survives a reload', async ({ page }) => {
    await page.goto('/app')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-theme-mode', 'light')
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect(html).toHaveAttribute('data-theme-mode', 'dark')
    await page.reload()
    await expect(html).toHaveAttribute('data-theme-mode', 'dark')
  })

  test('damaged saved state falls back to a sample instead of breaking the lab', async ({ page }) => {
    await page.goto('/app')
    for (const bad of ['not json', '{"versions":[]}', '{"versions":[{"id":"a","text":"x"}],"mode":"SOMETIMES","format":"AVRO"}', 'null']) {
      await page.evaluate((v) => localStorage.setItem('schemaEvolutionLab', v), bad)
      await page.reload()
      await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('orders-value')
      await expect(summary(page)).toContainText('v4 rejected under BACKWARD')
    }
  })
})

test('the pages load without network access and without uncaught errors', async ({ page, watched }) => {
  for (const path of ['/', '/docs', '/app', '/app?sample=users', '/no-such-page']) {
    await page.goto(path)
    await expect(page.locator('body')).not.toBeEmpty()
    await expect(page.locator('#root > *').first()).toBeVisible()
  }
  // Web fonts are the only thing the pages ask for; the fixture blocked them and fails on any other host.
  expect(watched.blocked.length).toBeGreaterThan(0)
})

test.describe('wrong-typed JSON Schema keywords (issue #2)', () => {
  const MUTATIONS: { label: string; mutate: (doc: any) => void }[] = [
    { label: 'properties: 5', mutate: (d) => { d.properties = 5 } },
    { label: 'properties.id: 5', mutate: (d) => { d.properties.id = 5 } },
    { label: 'properties.id: null', mutate: (d) => { d.properties.id = null } },
    { label: 'required: 5', mutate: (d) => { d.required = 5 } },
  ]

  for (const m of MUTATIONS) {
    test(`User profile v2 with ${m.label} shows a parse error and keeps the page alive`, async ({ page }) => {
      await openSample(page, 'User profile')
      await timelineNode(page, 2).click()
      const good = await editor(page, 2).inputValue()
      const doc = JSON.parse(good)
      m.mutate(doc)
      await editor(page, 2).fill(JSON.stringify(doc, null, 2))

      await expect(page.locator('#root > *').first()).toBeVisible()
      await expect(page.locator('.editor-status.err')).toContainText('Does not parse')
      await expect(summary(page)).toContainText('1 version does not parse')
      for (const mode of MODES) await expect(cell(page, 2, mode)).toHaveAccessibleName(`v2 under ${mode}: does not parse`)

      // Repairing recovers cleanly.
      await editor(page, 2).fill(good)
      await expect(summary(page)).toContainText('v2, v3, v4 rejected under BACKWARD')
    })
  }

  test('a shared link carrying a wrong-typed JSON Schema fails closed instead of blanking the page', async ({ page, newPage }) => {
    await openSample(page, 'User profile')
    await timelineNode(page, 2).click()
    const doc = JSON.parse(await editor(page, 2).inputValue())
    doc.properties = 5
    await editor(page, 2).fill(JSON.stringify(doc, null, 2))
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(toast(page)).toContainText('Share link copied')
    const url = await page.evaluate(() => navigator.clipboard.readText())

    const other = await newPage()
    await other.goto(url)
    await expect(other.locator('#root > *').first()).toBeVisible()
    await expect(summary(other)).toContainText('1 version does not parse')
    await timelineNode(other, 2).click()
    await expect(other.locator('.editor-status.err')).toContainText('Does not parse')
  })
})
