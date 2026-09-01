type Json = Record<string, any>

export type WitnessReport = {
  accession: string
  generatedAt: string
  acquisition: {
    url: string
    sourceBytes: number
  }
  execution: {
    seedSandboxId: string
    epigenesisCommit: string
    snapshotId: string
    producerSandboxId: string
    verifierSandboxId: string
  }
  identity: {
    sourceSha256: string
    genbankArtifactSha256: string
    bioIrSha256: string
    featureStateSha256: string
    genbankReportSha256: string
    featureStateReportSha256: string
  }
  metrics: {
    records: number
    bases: number
    features: number
    segments: number
    stateUnits: number
    tensorBytes: number
  }
  checks: string[]
  records: Array<{
    id: string
    definition: string
    organism: string
    length: number
    features: Array<{
      key: string
      location: string
      start: number
      end: number
      orientation: number
    }>
  }>
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`)
  return value
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is missing`)
  return value
}

export function buildWitnessReport(input: {
  accession: string
  acquisitionUrl: string
  sourceBytes: number
  seedSandboxId: string
  epigenesisCommit: string
  snapshotId: string
  producerSandboxId: string
  verifierSandboxId: string
  compiled: Json
  featureState: Json
  genbankValidation: Json
  featureStateValidation: Json
  generatedAt?: string
}): WitnessReport {
  if (input.genbankValidation.valid !== true || input.featureStateValidation.valid !== true) {
    throw new Error("independent validation did not pass")
  }

  const summary = input.genbankValidation.summary
  const stateResult = input.featureStateValidation.result
  const records = input.compiled.bio_ir.records.map((record: Json) => ({
    id: text(record.record_id, "record id"),
    definition: text(record.definition, "record definition"),
    organism: text(record.organism?.name, "organism"),
    length: number(record.locus?.length, "record length"),
    features: record.features.map((feature: Json) => {
      const segments = feature.location.segments as Json[]
      return {
        key: text(feature.key, "feature key"),
        location: text(feature.location.text, "feature location"),
        start: Math.min(...segments.map((segment) => number(segment.start, "segment start"))),
        end: Math.max(...segments.map((segment) => number(segment.end, "segment end"))),
        orientation: segments[0]?.orientation === -1 ? -1 : 1,
      }
    }),
  }))

  return {
    accession: input.accession,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    acquisition: {
      url: input.acquisitionUrl,
      sourceBytes: input.sourceBytes,
    },
    execution: {
      seedSandboxId: input.seedSandboxId,
      epigenesisCommit: input.epigenesisCommit,
      snapshotId: input.snapshotId,
      producerSandboxId: input.producerSandboxId,
      verifierSandboxId: input.verifierSandboxId,
    },
    identity: {
      sourceSha256: text(input.genbankValidation.inputs.genbank_source_sha256, "source digest"),
      genbankArtifactSha256: text(input.compiled.artifact_sha256, "artifact digest"),
      bioIrSha256: text(input.compiled.bio_ir_sha256, "BioIR digest"),
      featureStateSha256: text(input.featureState.artifact_sha256, "feature-state digest"),
      genbankReportSha256: text(input.genbankValidation.report_sha256, "GenBank report digest"),
      featureStateReportSha256: text(input.featureStateValidation.report_sha256, "feature-state report digest"),
    },
    metrics: {
      records: number(summary.records, "record count"),
      bases: number(summary.sequence_bases, "base count"),
      features: number(summary.features, "feature count"),
      segments: number(summary.segments, "segment count"),
      stateUnits: number(stateResult.units, "state unit count"),
      tensorBytes: number(stateResult.tensor_bytes, "tensor byte count"),
    },
    checks: [...input.genbankValidation.checks, ...input.featureStateValidation.checks],
    records,
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function short(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`
}

function featureColor(key: string): string {
  let hash = 0
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return ["#7c5cff", "#21b573", "#ff7a45", "#e5484d", "#1599a5"][hash % 5]
}

function renderTrack(record: WitnessReport["records"][number]): string {
  const features = record.features.map((feature) => {
    const left = Math.max(0, Math.min(100, 100 * feature.start / record.length))
    const width = Math.max(0.5, Math.min(100 - left, 100 * (feature.end - feature.start) / record.length))
    return `<span class="feature" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${featureColor(feature.key)}" title="${escapeHtml(`${feature.key} · ${feature.location}`)}"></span>`
  }).join("")
  const rows = record.features.slice(0, 12).map((feature) => `<tr><td><i style="background:${featureColor(feature.key)}"></i>${escapeHtml(feature.key)}</td><td>${escapeHtml(feature.location)}</td><td>${feature.orientation === -1 ? "reverse" : "forward"}</td></tr>`).join("")
  return `<section class="record"><div class="record-head"><div><p class="eyebrow">${escapeHtml(record.organism)}</p><h2>${escapeHtml(record.id)}</h2></div><strong>${record.length.toLocaleString()} bp</strong></div><p class="definition">${escapeHtml(record.definition)}</p><div class="track"><span class="rail"></span>${features}</div><div class="scale"><span>1</span><span>${record.length.toLocaleString()}</span></div><table><thead><tr><th>Feature</th><th>Location</th><th>Orientation</th></tr></thead><tbody>${rows}</tbody></table>${record.features.length > 12 ? `<p class="muted">Showing 12 of ${record.features.length.toLocaleString()} features. The complete BioIR is downloadable below.</p>` : ""}</section>`
}

export function renderReport(report: WitnessReport): string {
  const chain = [
    ["01", "Acquired", report.identity.sourceSha256, `Seed sandbox ${report.execution.seedSandboxId}`],
    ["02", "Compiled", report.identity.genbankArtifactSha256, `Epigenesis ${report.execution.epigenesisCommit.slice(0, 12)}`],
    ["03", "Replayed", report.identity.genbankReportSha256, `Independent sandbox ${report.execution.verifierSandboxId}`],
  ].map(([step, title, hash, note]) => `<article class="chain-step"><span>${step}</span><h3>${title}</h3><code>${short(hash)}</code><p>${escapeHtml(note)}</p></article>`).join("")

  const checks = report.checks.map((check) => `<li><span>✓</span>${escapeHtml(check)}</li>`).join("")
  const records = report.records.map(renderTrack).join("")
  const identities = Object.entries(report.identity).map(([name, hash]) => `<div><span>${escapeHtml(name.replaceAll(/([A-Z])/g, " $1"))}</span><code>${escapeHtml(hash)}</code></div>`).join("")

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.accession)} · Epigenesis Witness</title><style>
:root{color-scheme:light;--ink:#171717;--paper:#f4f1e8;--card:#fffdf7;--line:#d8d2c4;--green:#087a55;--violet:#6c4cff}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:56px 0 96px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;font-weight:800;margin:0 0 8px;color:#625e55}header{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;border-bottom:1px solid var(--ink);padding-bottom:28px}h1{font:800 clamp(42px,8vw,96px)/.9 ui-sans-serif,system-ui;margin:0;letter-spacing:-.07em}.verified{display:flex;gap:9px;align-items:center;background:var(--ink);color:#fff;padding:10px 14px;border-radius:99px;font-weight:700}.verified b{color:#73f2bc}.lede{font:500 clamp(17px,2vw,23px)/1.45 ui-sans-serif,system-ui;max-width:760px;margin:28px 0 40px}.metrics{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--ink);background:var(--ink);gap:1px}.metric{background:var(--card);padding:22px 18px}.metric strong{display:block;font:750 28px/1 ui-sans-serif,system-ui}.metric span{display:block;margin-top:8px;color:#6c675e;font-size:12px;text-transform:uppercase}.chain{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:48px 0}.chain-step,.record,.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px}.chain-step>span{color:var(--violet);font-weight:800}.chain-step h3{font:750 20px ui-sans-serif,system-ui;margin:26px 0 8px}.chain-step code{font-size:12px}.chain-step p{color:#6c675e;margin:9px 0 0;font-size:12px}.record{margin:20px 0}.record-head{display:flex;justify-content:space-between;gap:20px;align-items:start}.record h2{font:750 30px ui-sans-serif,system-ui;margin:0}.record-head strong{font-size:13px}.definition{font-family:ui-sans-serif,system-ui;max-width:780px;color:#555047}.track{height:72px;position:relative;margin-top:34px}.rail{position:absolute;left:0;right:0;top:34px;height:2px;background:#8d877c}.feature{position:absolute;top:23px;height:24px;min-width:3px;border:2px solid var(--card);border-radius:4px;opacity:.92}.scale{display:flex;justify-content:space-between;color:#777166;font-size:11px}table{border-collapse:collapse;width:100%;margin-top:24px;font-size:12px}th,td{text-align:left;border-top:1px solid var(--line);padding:9px 6px}th{color:#716c62;text-transform:uppercase;font-size:10px}td i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:8px}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:20px;margin-top:20px}.panel h2{font:750 23px ui-sans-serif,system-ui;margin:0 0 18px}.checks{list-style:none;padding:0;margin:0}.checks li{padding:8px 0;border-top:1px solid var(--line);font-size:12px}.checks li span{color:var(--green);font-weight:900;margin-right:9px}.identities div{padding:9px 0;border-top:1px solid var(--line)}.identities span{display:block;color:#716c62;text-transform:uppercase;font-size:10px}.identities code{display:block;overflow-wrap:anywhere;font-size:11px;margin-top:3px}.downloads{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.downloads a{color:var(--ink);text-decoration:none;border:1px solid var(--ink);border-radius:99px;padding:9px 13px;font-weight:700;font-size:12px}.downloads a:hover{background:var(--ink);color:white}.muted,footer{color:#716c62;font-size:11px}footer{margin-top:40px;border-top:1px solid var(--line);padding-top:18px;display:flex;justify-content:space-between;gap:20px}@media(max-width:760px){header{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.chain,.grid{grid-template-columns:1fr}main{padding-top:32px}.record{overflow:hidden}table{display:block;overflow:auto}footer{display:block}}
</style></head><body><main><header><div><p class="eyebrow">Epigenesis / Solari</p><h1>Genome<br>Witness</h1></div><div class="verified"><b>●</b> independently replayed</div></header><p class="lede">A public GenBank record became deterministic biological state through independent Solari machines. Every transition below is bound to exact bytes.</p><section class="metrics"><div class="metric"><strong>${report.metrics.bases.toLocaleString()}</strong><span>bases</span></div><div class="metric"><strong>${report.metrics.features.toLocaleString()}</strong><span>features</span></div><div class="metric"><strong>${report.metrics.segments.toLocaleString()}</strong><span>segments</span></div><div class="metric"><strong>${report.metrics.stateUnits.toLocaleString()}</strong><span>state units</span></div><div class="metric"><strong>${report.metrics.tensorBytes.toLocaleString()}</strong><span>tensor bytes</span></div></section><section class="chain">${chain}</section>${records}<section class="grid"><article class="panel"><h2>Replay checks</h2><ul class="checks">${checks}</ul></article><article class="panel"><h2>Content identities</h2><div class="identities">${identities}</div><div class="downloads"><a href="artifacts/source.gb">GenBank source</a><a href="artifacts/genbank.json">Compiled BioIR</a><a href="artifacts/feature-state.zip">Feature state</a><a href="artifacts/genbank-validation.json">GenBank report</a><a href="artifacts/feature-state-validation.json">State report</a><a href="proof.json">Proof JSON</a></div></article></section><footer><span>Acquired ${report.acquisition.sourceBytes.toLocaleString()} bytes from <a href="${escapeHtml(report.acquisition.url)}">NCBI</a> inside the seed sandbox</span><span>${escapeHtml(report.generatedAt)}</span></footer></main></body></html>`
}
