/**
 * Fault-tolerant model catalog, read-only refresh endpoint, and panel refresh tests.
 * Can run standalone (`node scripts/catalog-test.mjs`) or via `runCatalogTests(check)` in offline-test.mjs.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function runCatalogTests({
  catalogModuleUrl = '../lib/model-catalog.js',
  webRemoteModuleUrl = '../lib/web-remote.js',
  panelModuleUrl = '../client/panel.js',
  localeModuleUrl = '../client/locale.js',
  check = (label, cond, detail = '') => {
    if (!cond) throw new Error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  },
} = {}) {
  const catalogMod = await import(catalogModuleUrl)
  const webRemoteMod = await import(webRemoteModuleUrl)
  const panelMod = await import(panelModuleUrl)
  const localeMod = await import(localeModuleUrl)

  const {
    discoverCatalog,
    createCatalogStore,
    PROVIDER_ID,
    CATALOG_TTL_FULL_MS,
    CATALOG_TTL_DEGRADED_MS,
  } = catalogMod
  const { AntigravityBridgeService } = webRemoteMod
  const { createPanelController, createPanelComponent } = panelMod
  const { createTranslator } = localeMod

  const hasFaultTolerance = typeof createCatalogStore === 'function'

  // 1) Single model set_config_option failure -> remaining models returned + failed model in degraded
  {
    let sessionNewCount = 0
    const transport = {
      start() {},
      close() {},
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1 }
        if (method === 'session/new') {
          sessionNewCount += 1
          return {
            sessionId: `scratch-${sessionNewCount}`,
            configOptions: [{
              id: 'model', category: 'model', currentValue: 'model-a',
              options: [
                { value: 'model-a', name: 'Model A' },
                { value: 'model-bad', name: 'Model Bad' },
                { value: 'model-b', name: 'Model B' },
              ],
            }],
          }
        }
        if (method === 'session/set_config_option') {
          if (params.value === 'model-bad') {
            throw Object.assign(new Error('model-bad rejected'), { code: 'AGY_ACP_MODEL_UNSUPPORTED' })
          }
          return {
            configOptions: [
              { id: 'model', category: 'model', currentValue: params.value },
              { id: 'thought_level', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }] },
            ],
          }
        }
        throw new Error(`unexpected method ${method}`)
      },
    }
    let res = null
    let err = null
    try {
      res = await discoverCatalog(transport, process.cwd(), { perModelTimeoutMs: 6000 })
    } catch (e) {
      err = e
    }
    check(
      'catalog: single model set_config_option failure does not abort and records degraded',
      err === null &&
        sessionNewCount === 1 &&
        res?.entries?.length === 3 &&
        Array.isArray(res?.degraded) &&
        res.degraded.length === 1 &&
        res.degraded[0].modelId === 'model-bad' &&
        res.degraded[0].reason === 'AGY_ACP_MODEL_UNSUPPORTED',
      err ? err.message : `sessions=${sessionNewCount} degraded=${res?.degraded?.length}`,
    )
  }

  // 2) Single model probe timeout (6s) -> degraded, rest ok, whole round not aborted
  {
    const transport = {
      start() {},
      close() {},
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1 }
        if (method === 'session/new') {
          return {
            sessionId: 'scratch-1',
            configOptions: [{
              id: 'model', category: 'model', currentValue: 'fast',
              options: [{ value: 'fast', name: 'Fast' }, { value: 'slow', name: 'Slow' }, { value: 'after', name: 'After' }],
            }],
          }
        }
        if (method === 'session/set_config_option') {
          if (params.value === 'slow') {
            throw Object.assign(new Error('Request timed out after 6000ms'), { code: 'AGY_ACP_TIMEOUT' })
          }
          return {
            configOptions: [
              { id: 'model', category: 'model', currentValue: params.value },
              { id: 'thought_level', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }] },
            ],
          }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    let res = null
    let err = null
    try {
      res = await discoverCatalog(transport, process.cwd(), { perModelTimeoutMs: 6000 })
    } catch (e) {
      err = e
    }
    check(
      'catalog: per-model timeout marks degraded without aborting remaining models',
      err === null &&
        res?.degraded?.length === 1 &&
        res.degraded[0].modelId === 'slow' &&
        res.degraded[0].timedOut === true &&
        res.entries?.find((e) => e.id === 'after')?.efforts?.length === 1,
      err ? err.message : `degraded=${res?.degraded?.[0]?.modelId}`,
    )
  }

  // 3) Dead transport -> immediately aborts round and stops issuing further requests
  {
    let setOptionCalls = 0
    const transport = {
      closed: false,
      start() {},
      close() { this.closed = true },
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1 }
        if (method === 'session/new') {
          return {
            sessionId: 'scratch-1',
            configOptions: [{
              id: 'model', category: 'model', currentValue: 'm1',
              options: [{ value: 'm1' }, { value: 'm2' }, { value: 'm3' }],
            }],
          }
        }
        if (method === 'session/set_config_option') {
          setOptionCalls += 1
          this.closed = true
          throw Object.assign(new Error('transport closed'), { code: 'AGY_ACP_TRANSPORT_CLOSED' })
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    let aborted = false
    try {
      await discoverCatalog(transport, process.cwd(), { perModelTimeoutMs: 6000 })
    } catch (e) {
      aborted = e?.code === 'AGY_ACP_TRANSPORT_CLOSED'
    }
    check(
      'catalog: dead transport aborts immediately without probing m2/m3',
      aborted && setOptionCalls === 1,
      `calls=${setOptionCalls} aborted=${aborted}`,
    )
  }

  // 4, 5, 6, 7) createCatalogStore: entries=0 never writes disk, disk only fallback, TTL 300s/30s, resolveModel cooldown re-probe
  check('catalog: createCatalogStore is exported', hasFaultTolerance)
  if (hasFaultTolerance) {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cat-'))
    try {
      const cacheFile = join(dir, 'catalog.json')
      let diskWrites = 0
      let diskReads = 0
      const fsOps = {
        existsSync: (p) => existsSync(p),
        mkdirSync: () => {},
        readFileSync: (p, enc) => { diskReads += 1; return readFileSync(p, enc) },
        writeFileSync: (p, data, enc) => { diskWrites += 1; return writeFileSync(p, data, enc) },
      }
      let nowMs = 1_000_000
      let mode = 'empty'
      const store = createCatalogStore({
        cwd: dir,
        cacheFile,
        now: () => nowMs,
        fsOps,
        transportFactory: () => ({
          start() {},
          close() {},
          async request(method, params) {
            if (method === 'initialize') return { protocolVersion: 1 }
            if (method === 'session/new') {
              if (mode === 'empty') return { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', options: [] }] }
              if (mode === 'fail') throw Object.assign(new Error('down'), { code: 'AGY_ACP_EXITED' })
              const opts = mode === 'with-carbon'
                ? [{ value: 'model-a' }, { value: 'gemini-4-carbon' }]
                : [{ value: 'model-a' }, { value: 'model-degraded' }]
              return { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', currentValue: 'model-a', options: opts }] }
            }
            if (method === 'session/set_config_option') {
              if (mode === 'degraded' && params.value === 'model-degraded') {
                throw Object.assign(new Error('bad'), { code: 'AGY_ACP_MODEL_UNSUPPORTED' })
              }
              return { configOptions: [{ id: 'model', category: 'model', currentValue: params.value }] }
            }
            throw new Error(`unexpected ${method}`)
          },
        }),
      })

      // 4) entries.length === 0 never writes disk
      await assert.rejects(() => store.getCatalog())
      check('catalog: entries.length===0 never writes disk', diskWrites === 0, `writes=${diskWrites}`)

      // 5) Success path writes disk and does NOT read disk first
      mode = 'degraded'
      const degradedSnap = await store.getCatalog()
      check('catalog: success path does not read disk first', diskReads === 0 && diskWrites === 1, `reads=${diskReads} writes=${diskWrites}`)
      check('catalog: degraded TTL is 30s', CATALOG_TTL_DEGRADED_MS === 30_000 && degradedSnap.degraded.length === 1)

      // Within 29s -> cached; at 31s -> re-probes
      nowMs += 29_000
      mode = 'with-carbon'
      const stillCached = await store.getCatalog()
      check('catalog: degraded cache hits within 30s', !stillCached.entries.some((e) => e.id === 'gemini-4-carbon'))
      nowMs += 2_000
      const refreshedFull = await store.getCatalog()
      check('catalog: degraded cache expires after 30s and picks up gemini-4-carbon', refreshedFull.entries.some((e) => e.id === 'gemini-4-carbon'))

      // Full TTL = 300s
      nowMs += 299_000
      mode = 'fail'
      const fullCached = await store.getCatalog()
      check('catalog: full success cache hits within 300s', CATALOG_TTL_FULL_MS === 300_000 && fullCached.fromFallback === false)

      // Past 300s and probe fails -> falls back to disk/memory
      nowMs += 2_000
      const fallbackSnap = await store.getCatalog()
      check('catalog: failure falls back to last usable snapshot', fallbackSnap.fromFallback === true && fallbackSnap.entries.length === 2)

      // 7) resolveModel miss past cooldown triggers re-probe and finds new model
      nowMs += 31_000
      mode = 'with-carbon'
      const resolved = await store.resolveModel(PROVIDER_ID, 'gemini-4-carbon')
      check('catalog: resolveModel miss past cooldown triggers re-probe', resolved.info?.id === 'gemini-4-carbon')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 8) web-remote refreshModels is read-only, single-flight, rate-limited, and explicit on error
  {
    let probeCalls = 0
    let promptCalls = 0
    let resolveProbe
    const fakeAdapter = {
      async getCatalog({ force, allowFallback } = {}) {
        assert.equal(force, true)
        assert.equal(allowFallback, false)
        probeCalls += 1
        if (probeCalls === 1) {
          return new Promise((resolve) => { resolveProbe = resolve })
        }
        throw Object.assign(new Error('cli offline'), { code: 'AGY_ACP_SPAWN_FAILED' })
      },
    }
    const fakeBridge = {
      desktop: { capabilities: () => ({ transports: ['acp'], desktop: false, target: null, models: [], efforts: [], attachments: false, evidence: null }) },
      jobs: () => [],
    }
    const emitted = []
    const service = new AntigravityBridgeService({
      ctx: { get: () => undefined, emit: (ev, arg) => emitted.push([ev, arg]) },
      bridge: fakeBridge,
      config: { models: [], efforts: [] },
      adapter: fakeAdapter,
    })
    const hasRefresh = typeof service.refreshModels === 'function'
    check('web-remote: refreshModels method exists', hasRefresh)
    if (hasRefresh) {
      const agent = { id: 'a1', session: { id: 's1' } }
      const p1 = service.refreshModels(agent)
      const p2 = service.refreshModels(agent)
      resolveProbe({
        entries: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: [{ id: 'low', name: 'Low' }] }],
        degraded: [],
        discoveredAt: '2026-11-24T00:00:00.000Z',
        elapsedMs: 42,
      })
      const [r1, r2] = await Promise.all([p1, p2])
      check(
        'web-remote: refreshModels is single-flight and read-only',
        probeCalls === 1 && promptCalls === 0 && r1.ok === true && r2.ok === true && r1.models[0].id === 'gemini-4-carbon' && emitted.length === 1,
        `probes=${probeCalls} models=${r1.models?.map((m) => m.id).join(',')}`,
      )
      const r3 = await service.refreshModels(agent)
      check('web-remote: 1s cooldown reuses result without extra probe', probeCalls === 1 && r3.cached === true)

      // Force past cooldown to test explicit failure (no silent fallback)
      service._lastRefreshAt = 0
      const errRes = await service.refreshModels(agent)
      check('web-remote: refreshModels returns explicit code+message on failure', errRes.ok === false && errRes.code === 'AGY_ACP_SPAWN_FAILED')
    }
  }

  // 9) Panel button, disabled while refreshing, updates model list, and surfaces failure explicitly
  {
    let resolveRefresh
    let calls = 0
    const bridge = {
      available: true,
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'], models: ['model-a'], efforts: ['low'], attachments: { pathRefs: true } } }),
      refreshModels: async () => {
        calls += 1
        if (calls === 1) return new Promise((resolve) => { resolveRefresh = resolve })
        return { ok: false, code: 'AGY_ACP_EXITED', message: 'agy exited' }
      },
    }
    const ctrl = createPanelController({ bridge, sessionId: 'sess-ui-1' })
    const hasCtrlRefresh = typeof ctrl.refreshModels === 'function'
    check('panel: controller exposes refreshModels', hasCtrlRefresh)
    if (hasCtrlRefresh) {
      await ctrl.refreshCapabilities()
      const p1 = ctrl.refreshModels()
      const p2 = ctrl.refreshModels()
      check('panel: refreshingModels disables button during flight and blocks duplicate click', ctrl.getState().refreshingModels === true)
      resolveRefresh({ ok: true, models: [{ id: 'model-a' }, { id: 'gemini-4-carbon' }], discoveredAt: 'now', elapsedMs: 55, degraded: [{ modelId: 'bad', reason: 'AGY_ACP_TIMEOUT' }] })
      await Promise.all([p1, p2])
      const s1 = ctrl.getState()
      const lastSuccessAt1 = s1.modelsLastSuccessAt
      check(
        'panel: refreshModels updates models immediately with elapsedMs, degraded, and modelsLastSuccessAt',
        calls === 1 &&
          s1.refreshingModels === false &&
          s1.capabilities.models.includes('gemini-4-carbon') &&
          s1.modelsRefreshMeta.elapsedMs === 55 &&
          s1.modelsRefreshMeta.degraded.length === 1 &&
          typeof lastSuccessAt1 === 'number' &&
          lastSuccessAt1 > 0 &&
          s1.modelsStale === false,
      )
      await ctrl.refreshModels()
      const s2 = ctrl.getState()
      check(
        'panel: refreshModels failure retains models, preserves modelsLastSuccessAt, marks stale, and surfaces code',
        s2.capabilities.models.length === 2 &&
          s2.capabilities.models.includes('gemini-4-carbon') &&
          s2.modelsLastSuccessAt === lastSuccessAt1 &&
          s2.modelsStale === true &&
          s2.modelsRefreshError?.code === 'AGY_ACP_EXITED' &&
          s2.modelsRefreshError?.message === 'agy exited',
      )

      // Render check with minimal React stub: button lives in .antigravity-cli-status__actions,
      // 3-column .antigravity-bridge__row has no refresh-models button or __modelrow placeholder,
      // and status/stale/error row renders below the 3-column row.
      const { createCliSectionComponent, createCliStatusController } = panelMod
      const React = {
        createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
        useRef: (v) => ({ current: v === null ? ctrl : v }),
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
      }
      const Panel = createPanelComponent({ React, translate: createTranslator(), bridge })
      const panelTree = Panel({ sessionId: 'sess-ui-1', controller: ctrl })
      const findByProp = (node, key, val) => {
        if (!node || typeof node !== 'object') return null
        if (Array.isArray(node)) { for (const n of node) { const f = findByProp(n, key, val); if (f) return f } return null }
        if (node.props?.[key] === val) return node
        return findByProp(node.props?.children, key, val)
      }
      const rowNode = findByProp(panelTree, 'className', 'antigravity-bridge__row')
      const staleHint = findByProp(panelTree, 'data-testid', 'models-stale-hint')
      const errNode = findByProp(panelTree, 'data-testid', 'models-refresh-error')
      const btnInRow = findByProp(rowNode, 'data-action', 'refresh-models')
      const modelRowDiv = findByProp(rowNode, 'className', 'antigravity-bridge__modelrow')

      const cliCtrl = createCliStatusController({ bridge: { available: true, authStatus: async () => ({ ok: true, status: 'unknown' }), login: async () => ({ ok: true }) } })
      const CliSection = createCliSectionComponent({ React, translate: createTranslator(), controller: cliCtrl })
      const cliTree = CliSection({ bridgeAvailable: true, onRefreshModels: () => ctrl.refreshModels(), refreshingModels: ctrl.getState().refreshingModels, canRefreshModels: true })
      const actionsNode = findByProp(cliTree, 'className', 'antigravity-cli-status__actions')
      const btnInActions = findByProp(actionsNode, 'data-action', 'refresh-models')
      cliCtrl.dispose()
      check(
        'panel: refresh-models button in cli actions, 3-col modelrow clean, stale+error below row',
        btnInActions !== null && btnInRow === null && modelRowDiv === null && staleHint !== null && errNode !== null,
      )
    }
    ctrl.dispose()
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('catalog-test.mjs')) {
  await runCatalogTests()
}
