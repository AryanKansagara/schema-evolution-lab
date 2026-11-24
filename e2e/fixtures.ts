import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

// Hosts the app tries to reach (web fonts). They are blocked, never fetched: tests must not depend on the network.
const EXPECTED_BLOCKED = ['fonts.googleapis.com', 'fonts.gstatic.com']

interface Watch {
  blocked: string[]
  pageErrors: Error[]
}

// Blocks every request that is not for the local preview server and records uncaught page errors for the context.
async function watch(context: BrowserContext, into: Watch) {
  await context.route(/^(?!https?:\/\/127\.0\.0\.1[:/]).*/, (route) => {
    const url = route.request().url()
    // data: and blob: URLs are not network requests.
    if (/^(data|blob):/.test(url)) return route.continue()
    into.blocked.push(new URL(url).host)
    return route.abort('blockedbyclient')
  })
  context.on('weberror', (e) => into.pageErrors.push(e.error()))
}

export const test = base.extend<{ watched: Watch; newPage: () => Promise<Page> }>({
  watched: [async ({ context }, use) => {
    const w: Watch = { blocked: [], pageErrors: [] }
    await watch(context, w)
    await use(w)
    // After the test: nothing threw, and nothing outside the known font hosts was requested.
    expect(w.pageErrors, 'uncaught page errors').toEqual([])
    expect(w.blocked.filter((h) => !EXPECTED_BLOCKED.includes(h)), 'unexpected external requests').toEqual([])
  }, { auto: true }],

  // A page in a brand-new browser context (no storage shared with `page`), under the same rules.
  newPage: async ({ browser, watched }, use) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
      contexts.push(context)
      await watch(context, watched)
      return context.newPage()
    })
    await Promise.all(contexts.map((c) => c.close()))
  },
})

export { expect }
