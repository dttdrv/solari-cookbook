import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

import { buildWitnessReport, renderReport } from "./report.js"

const EPIGENESIS_REPOSITORY = "https://github.com/dttdrv/epigenesis.git"
const EPIGENESIS_COMMIT = "e92e6453ba53e85ad0d1670cce731dfeb08a8725"
const ROOT = "/tmp/epigenesis-witness"
const SOURCE = `${ROOT}/source.gb`
const COMPILED = `${ROOT}/genbank.json`
const STATE = `${ROOT}/feature-state`
const PORT = 3000

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

function requireArgument(): string {
  const accession = process.argv[2] ?? "U49845.1"
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(accession)) {
    throw new Error("accession must contain only letters, numbers, period, underscore, or hyphen")
  }
  return accession
}

async function run(
  sandbox: Sandbox,
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await sandbox.commands.run(command, { args, cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (${result.exitCode}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function acquire(
  browserClient: Solari,
  accession: string,
): Promise<{ bytes: Buffer; replay: Buffer; sessionId: string; url: string }> {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=${encodeURIComponent(accession)}&rettype=gb&retmode=text`
  const browser = await browserClient.launch({ recording: true })
  const sessionId = browser.id
  let bytes: Buffer
  try {
    const page = await browser.newPage()
    const response = await page.goto(url, { waitUntil: "domcontentloaded" })
    if (!response?.ok()) throw new Error(`NCBI returned HTTP ${response?.status() ?? "unknown"}`)
    bytes = await response.body()
    if (!bytes.subarray(0, 5).equals(Buffer.from("LOCUS"))) {
      throw new Error(`NCBI did not return a GenBank record for ${accession}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  } finally {
    await browser.close()
  }

  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    try {
      const replay = Buffer.from(await browserClient.sessions.downloadReplay(sessionId))
      return { bytes, replay, sessionId, url }
    } catch (error: any) {
      if (error?.status !== 404 || attempt === 12) throw error
    }
  }
  throw new Error("browser replay was not uploaded")
}

async function prepareSeed(client: SolariClient, source: Buffer): Promise<Sandbox> {
  const sandbox = await client.sandboxes.create({
    template: "base",
    cpu: 2,
    memMb: 4096,
    timeoutMs: 20 * 60_000,
  })
  try {
    await sandbox.connect()
    await run(sandbox, "mkdir", ["-p", ROOT])
    await run(sandbox, "git", ["clone", "--quiet", "--filter=blob:none", EPIGENESIS_REPOSITORY, `${ROOT}/epigenesis`])
    await run(sandbox, "git", ["checkout", "--quiet", "--detach", EPIGENESIS_COMMIT], `${ROOT}/epigenesis`)
    await sandbox.files.write(SOURCE, source)
    return sandbox
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}

async function compileInProducer(sandbox: Sandbox): Promise<{
  compiled: Record<string, any>
  featureState: Record<string, any>
  stateFiles: Map<string, string>
}> {
  await run(sandbox, "python3", ["-m", "brainc", "compile-genbank", SOURCE, "-o", COMPILED], `${ROOT}/epigenesis`)
  await run(sandbox, "python3", ["-m", "brainc", "compile-insdc-graph", COMPILED, "-o", STATE], `${ROOT}/epigenesis`)
  const stateFiles = new Map<string, string>()
  for (const entry of await sandbox.files.list(STATE)) {
    if (entry.name.endsWith(".json")) {
      stateFiles.set(entry.name, await sandbox.files.readText(`${STATE}/${entry.name}`))
    }
  }
  if (stateFiles.size !== 10) throw new Error(`expected 10 feature-state files, received ${stateFiles.size}`)
  return {
    compiled: JSON.parse(await sandbox.files.readText(COMPILED)),
    featureState: JSON.parse(stateFiles.get("bundle.json")!),
    stateFiles,
  }
}

async function verifyAndPublish(
  sandbox: Sandbox,
  source: Buffer,
  replay: Buffer,
  compiled: Record<string, any>,
  stateFiles: Map<string, string>,
  context: {
    accession: string
    acquisitionUrl: string
    browserSessionId: string
    snapshotId: string
    producerSandboxId: string
  },
): Promise<string> {
  await run(sandbox, "mkdir", ["-p", STATE, `${ROOT}/site/artifacts`])
  await sandbox.files.write(SOURCE, source)
  await sandbox.files.write(COMPILED, JSON.stringify(compiled))
  for (const [name, contents] of stateFiles) await sandbox.files.write(`${STATE}/${name}`, contents)

  const genbankReportPath = `${ROOT}/genbank-validation.json`
  const stateReportPath = `${ROOT}/feature-state-validation.json`
  await run(sandbox, "python3", ["-m", "brainc.validator_insdc", SOURCE, COMPILED, "-o", genbankReportPath], `${ROOT}/epigenesis`)
  await run(sandbox, "python3", ["-m", "brainc.validator_insdc_graph", SOURCE, COMPILED, STATE, "-o", stateReportPath], `${ROOT}/epigenesis`)

  const genbankValidation = JSON.parse(await sandbox.files.readText(genbankReportPath))
  const featureStateValidation = JSON.parse(await sandbox.files.readText(stateReportPath))
  const featureState = JSON.parse(stateFiles.get("bundle.json")!)
  const report = buildWitnessReport({
    accession: context.accession,
    acquisitionUrl: context.acquisitionUrl,
    browserSessionId: context.browserSessionId,
    replayBytes: replay.length,
    epigenesisCommit: EPIGENESIS_COMMIT,
    snapshotId: context.snapshotId,
    producerSandboxId: context.producerSandboxId,
    verifierSandboxId: sandbox.sandboxId,
    compiled,
    featureState,
    genbankValidation,
    featureStateValidation,
  })

  const artifacts = `${ROOT}/site/artifacts`
  await sandbox.files.write(`${ROOT}/site/index.html`, renderReport(report))
  await sandbox.files.write(`${ROOT}/site/proof.json`, JSON.stringify(report, null, 2))
  await sandbox.files.write(`${artifacts}/source.gb`, source)
  await sandbox.files.write(`${artifacts}/genbank.json`, JSON.stringify(compiled))
  await sandbox.files.write(`${artifacts}/genbank-validation.json`, JSON.stringify(genbankValidation, null, 2))
  await sandbox.files.write(`${artifacts}/feature-state-validation.json`, JSON.stringify(featureStateValidation, null, 2))
  await sandbox.files.write(`${artifacts}/acquisition.ndjson`, replay)
  await run(sandbox, "sh", ["-c", `cd ${STATE} && python3 -m zipfile -c ${artifacts}/feature-state.zip *.json`])
  await run(sandbox, "sh", ["-c", `cd ${ROOT}/site && nohup python3 -m http.server ${PORT} >/tmp/epigenesis-witness-http.log 2>&1 &`])

  const { url } = await sandbox.previewUrl(PORT)
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const response = await fetch(url)
    if (response.ok && (await response.text()).includes("Genome Witness")) return url
    if (attempt === 12) throw new Error("public proof page did not become ready")
  }
  throw new Error("public proof page did not become ready")
}

async function waitForShutdown(): Promise<void> {
  console.log("Press Ctrl+C to destroy the verifier sandbox and close the proof URL.")
  await new Promise((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
}

async function main(): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is required")
  const accession = requireArgument()
  const browserClient = new Solari({ apiKey })
  const client = new SolariClient({ apiKey })
  const live = new Set<Sandbox>()
  let snapshotId: string | undefined

  try {
    console.log(`acquire  ${accession} from NCBI in a recorded browser`)
    const acquisition = await acquire(browserClient, accession)
    console.log(`prepare  Epigenesis ${EPIGENESIS_COMMIT.slice(0, 12)}`)
    const seed = await prepareSeed(client, acquisition.bytes)
    live.add(seed)
    snapshotId = await seed.snapshot(`epigenesis-witness-${Date.now()}`)
    await seed.kill()
    live.delete(seed)

    console.log(`compile  producer fork from ${snapshotId}`)
    const producer = await client.sandboxes.create({ fromSnapshot: snapshotId, timeoutMs: 20 * 60_000 })
    live.add(producer)
    await producer.connect()
    const output = await compileInProducer(producer)
    const producerSandboxId = producer.sandboxId
    await producer.kill()
    live.delete(producer)

    console.log("replay   independent verifier fork")
    const verifier = await client.sandboxes.create({ fromSnapshot: snapshotId, timeoutMs: 20 * 60_000 })
    live.add(verifier)
    await verifier.connect()
    const url = await verifyAndPublish(
      verifier,
      acquisition.bytes,
      acquisition.replay,
      output.compiled,
      output.stateFiles,
      {
        accession,
        acquisitionUrl: acquisition.url,
        browserSessionId: acquisition.sessionId,
        snapshotId,
        producerSandboxId,
      },
    )
    console.log(`proof    ${url}`)
    await waitForShutdown()
  } finally {
    await browserClient.close().catch(() => undefined)
    await Promise.all([...live].map((sandbox) => sandbox.kill().catch(() => undefined)))
    if (snapshotId) await client.sandboxes.deleteSnapshot(snapshotId).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
