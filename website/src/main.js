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
    const providers = await fetchAllProviders()
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
    <th>Input / 1M</th>
    <th>Output / 1M</th>
    <th>SLA</th>
    <th>Stake</th>
    <th>Success</th>
  </tr></thead>`)
  rows.push('<tbody>')
  for (const slot of sorted) {
    const cheapest = slot.rows[0].offering
    rows.push(`<tr class="model-head">
      <td class="mono">${escape(slot.modelId)}</td>
      <td><span class="pill providers">${slot.rows.length}</span></td>
      <td>${formatXBZZ(cheapest.inputPricePerMillionTokens)}</td>
      <td>${formatXBZZ(cheapest.outputPricePerMillionTokens)}</td>
      <td>${escape(Number(cheapest.maxLatencySeconds))}s</td>
      <td class="muted">cheapest &darr;</td>
      <td></td>
    </tr>`)
    for (const {provider, offering} of slot.rows) {
      const successRate =
        provider.totalJobs === 0
          ? '—'
          : `${Math.round((Number(provider.successfulJobs) * 100) / Number(provider.totalJobs))}% (${provider.successfulJobs}/${provider.totalJobs})`
      rows.push(`<tr class="provider-row">
        <td class="mono">${shortAddr(provider.owner)}</td>
        <td></td>
        <td>${formatXBZZ(offering.inputPricePerMillionTokens)}</td>
        <td>${formatXBZZ(offering.outputPricePerMillionTokens)}</td>
        <td>${escape(Number(offering.maxLatencySeconds))}s</td>
        <td>${formatXBZZ(provider.stake)}</td>
        <td>${escape(successRate)}</td>
      </tr>`)
    }
  }
  rows.push('</tbody>')
  $models.innerHTML = `<table class="models">${rows.join('')}</table>`
}

function formatXBZZ(weiBig) {
  const wei = typeof weiBig === 'bigint' ? weiBig : BigInt(weiBig)
  const whole = wei / 10n ** 18n
  const frac = wei % 10n ** 18n
  if (frac === 0n) return `${whole}`
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
  const trimmed = fracStr.slice(0, 6)
  return `${whole}.${trimmed}`
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
