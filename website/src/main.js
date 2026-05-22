import {createPublicClient, http} from 'viem'
import {gnosis} from 'viem/chains'
import {providerRegistryAbi} from './abi.js'
import {config} from './config.js'

const client = createPublicClient({
  chain: gnosis,
  transport: http(config.rpcUrl),
})

const $models = document.getElementById('models')
const $status = document.getElementById('status')
const $refresh = document.getElementById('refresh')

let bzzUsd = null

$refresh.addEventListener('click', () => load())
load()

async function load() {
  setStatus('Loading providers from chain…', null)
  $refresh.disabled = true
  try {
    if (config.registryAddress === '0x0000000000000000000000000000000000000000') {
      setStatus('Registry address not configured. Edit website/src/config.js and rebuild.', 'err')
      $models.innerHTML = ''
      return
    }
    // Fire price lookup in parallel with the chain reads; missing price just hides the USD column.
    const [providers, usd] = await Promise.all([fetchAllProviders(), fetchBzzUsd()])
    bzzUsd = usd
    const live = providers.filter(p => isLive(p))
    if (live.length === 0) {
      $models.innerHTML = ''
      setStatus(`Found ${providers.length} provider${providers.length === 1 ? '' : 's'}, none currently live.`, 'err')
      return
    }
    const enriched = await Promise.all(
      live.map(async p => ({provider: p, offerings: await fetchOfferings(p.owner)})),
    )
    const withOfferings = enriched.filter(e => e.offerings.length > 0)
    const byModel = groupByModel(withOfferings)
    renderModels(byModel)
    setStatus(
      `${withOfferings.length} live provider${withOfferings.length === 1 ? '' : 's'} ` +
        `across ${byModel.size} model${byModel.size === 1 ? '' : 's'}.`,
      'ok',
    )
  } catch (err) {
    console.error(err)
    setStatus(`Failed to load: ${err.message ?? err}`, 'err')
  } finally {
    $refresh.disabled = false
  }
}

async function fetchBzzUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=swarm-bzz&vs_currencies=usd', {
      headers: {accept: 'application/json'},
    })
    if (!r.ok) return null
    const data = await r.json()
    const usd = data?.['swarm-bzz']?.usd
    return typeof usd === 'number' && isFinite(usd) && usd > 0 ? usd : null
  } catch {
    return null
  }
}

async function fetchAllProviders() {
  const all = []
  let cursor = 0n
  for (let i = 0; i < 20; i++) {
    const [page, nextCursor] = await client.readContract({
      address: config.registryAddress,
      abi: providerRegistryAbi,
      functionName: 'listProviders',
      args: [cursor, 50n],
    })
    all.push(...page)
    if (nextCursor === cursor || page.length === 0) break
    cursor = nextCursor
  }
  return all
}

async function fetchOfferings(owner) {
  return await client.readContract({
    address: config.registryAddress,
    abi: providerRegistryAbi,
    functionName: 'getOfferings',
    args: [owner],
  })
}

function isLive(p) {
  if (!p.active) return false
  const now = Math.floor(Date.now() / 1000)
  const last = Number(p.lastHeartbeat)
  if (last === 0) return false
  return last + config.heartbeatTtlSeconds >= now
}

function groupByModel(entries) {
  const byModel = new Map()
  for (const {provider, offerings} of entries) {
    for (const o of offerings) {
      const slot = byModel.get(o.modelId) ?? {modelId: o.modelId, rows: []}
      slot.rows.push({provider, offering: o})
      byModel.set(o.modelId, slot)
    }
  }
  for (const slot of byModel.values()) {
    slot.rows.sort((a, b) => Number(combined(a.offering) - combined(b.offering)))
  }
  return byModel
}

function combined(o) {
  return o.inputPricePerMillionTokens + o.outputPricePerMillionTokens
}

function renderModels(byModel) {
  if (byModel.size === 0) {
    $models.innerHTML = ''
    return
  }
  const sorted = [...byModel.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))
  const rows = []
  rows.push(`<thead><tr>
    <th>Model / provider</th>
    <th>Providers</th>
    <th>1M Input Token</th>
    <th>1M Output Token</th>
    <th>SLA</th>
    <th>Stake</th>
    <th>Success</th>
  </tr></thead>`)
  rows.push('<tbody>')
  for (const slot of sorted) {
    const cheapest = slot.rows[0].offering
    const modelKey = `m-${slot.modelId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    rows.push(`<tr class="model-head" data-toggle="${escape(modelKey)}" aria-expanded="false">
      <td class="mono"><span class="caret">&rsaquo;</span> ${escape(slot.modelId)}</td>
      <td><span class="pill providers">${slot.rows.length}</span></td>
      <td>${formatPrice(cheapest.inputPricePerMillionTokens)}</td>
      <td>${formatPrice(cheapest.outputPricePerMillionTokens)}</td>
      <td>${escape(Number(cheapest.maxLatencySeconds))}s</td>
      <td class="muted">cheapest &darr;</td>
      <td></td>
    </tr>`)
    for (const {provider, offering} of slot.rows) {
      const successRate =
        provider.totalJobs === 0
          ? '—'
          : `${Math.round((Number(provider.successfulJobs) * 100) / Number(provider.totalJobs))}% (${provider.successfulJobs}/${provider.totalJobs})`
      rows.push(`<tr class="provider-row" data-group="${escape(modelKey)}" hidden>
        <td class="mono">${shortAddr(provider.owner)}</td>
        <td></td>
        <td>${formatPrice(offering.inputPricePerMillionTokens)}</td>
        <td>${formatPrice(offering.outputPricePerMillionTokens)}</td>
        <td>${escape(Number(offering.maxLatencySeconds))}s</td>
        <td>${formatXBZZ(provider.stake)} BZZ</td>
        <td>${escape(successRate)}</td>
      </tr>`)
    }
  }
  rows.push('</tbody>')
  $models.innerHTML = `<table class="models">${rows.join('')}</table>`
  wireToggles()
}

function wireToggles() {
  for (const head of $models.querySelectorAll('tr.model-head[data-toggle]')) {
    head.addEventListener('click', () => {
      const key = head.getAttribute('data-toggle')
      const expanded = head.getAttribute('aria-expanded') === 'true'
      head.setAttribute('aria-expanded', expanded ? 'false' : 'true')
      for (const row of $models.querySelectorAll(`tr.provider-row[data-group="${CSS.escape(key)}"]`)) {
        row.hidden = expanded
      }
    })
  }
}

// xBZZ on Gnosis has 16 decimals (1 BZZ = 10^16 PLUR), NOT 18.
const BZZ_SCALE = 10n ** 16n

function formatXBZZ(plurBig) {
  const plur = typeof plurBig === 'bigint' ? plurBig : BigInt(plurBig)
  const whole = plur / BZZ_SCALE
  const frac = plur % BZZ_SCALE
  if (frac === 0n) return `${whole}`
  const fracStr = frac.toString().padStart(16, '0').replace(/0+$/, '')
  return `${whole}.${fracStr.slice(0, 6)}`
}

function formatPrice(plurBig) {
  const plur = typeof plurBig === 'bigint' ? plurBig : BigInt(plurBig)
  const bzz = `${formatXBZZ(plur)} BZZ`
  if (bzzUsd == null) return `<span class="price-bzz">${escape(bzz)}</span>`
  // Down at human magnitudes Number precision is fine.
  const usdNum = (Number(plur) / 1e16) * bzzUsd
  return `<span class="price-bzz">${escape(bzz)}</span><span class="price-sep"> | </span><span class="price-usd">${escape(formatUsd(usdNum))}</span>`
}

function formatUsd(n) {
  if (!isFinite(n)) return '— USD'
  if (n >= 1) return `${n.toFixed(4)} USD`
  if (n >= 0.0001) return `${n.toFixed(6)} USD`
  return `${n.toExponential(2)} USD`
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function escape(v) {
  return String(v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
}

function setStatus(text, level) {
  $status.textContent = text
  $status.className = 'status' + (level ? ' ' + level : ' muted')
}
