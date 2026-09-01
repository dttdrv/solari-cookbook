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
type CreateSandboxOptions = NonNullable<Parameters<SolariClient["sandboxes"]["create"]>[0]>
type Json = Record<string, any>

function accessionArgument(): string {
  const accession = process.argv[2] ?? "U49845.1"
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(accession)) {
    throw new Error("accession must contain only letters, numbers, period, underscore, or hyphen")
  }
  return accession
}

async function run(sandbox: Sandbox, command: string, args: string[], cwd?: string): Promise<string> {
  const result = await sandbox.commands.run(command, { args, cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (${result.exitCode}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function writeText(sandbox: Sandbox, path: string, contents: string): Promise<void> {
  await run(sandbox, "python3", [
    "-c",
    "import base64,pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.argv[2]))",
    path,
    Buffer.from(contents).toString("base64"),
  ])
}

async function createSandbox(client: SolariClient, options: CreateSandboxOptions): Promise<Sandbox> {
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      return await client.sandboxes.create(options)
    } catch (error) {
      if (!/too many concurrent sessions/i.test(String(error)) || attempt === 12) throw error
      if (attempt === 1) console.log("capacity waiting for the previous sandbox slot to drain")
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
  }
  throw new Error("sandbox capacity did not become available")
}

async function prepareSeed(client: SolariClient, accession: string, url: string): Promise<{
  sandbox: Sandbox
  acquisition: Json
}> {
  const sandbox = await createSandbox(client, { template: "base", cpu: 2, memMb: 4096, timeoutMs: 20 * 60_000 })
  try {
    await run(sandbox, "mkdir", ["-p", ROOT])
    await run(sandbox, "git", ["clone", "--quiet", "--filter=blob:none", EPIGENESIS_REPOSITORY, `${ROOT}/epigenesis`])
    await run(sandbox, "git", ["checkout", "--quiet", "--detach", EPIGENESIS_COMMIT], `${ROOT}/epigenesis`)
    const acquisition = JSON.parse(await run(sandbox, "python3", [
      "-c",
      [
        "import hashlib,json,pathlib,sys,urllib.request",
        "request=urllib.request.Request(sys.argv[1],headers={'User-Agent':'Epigenesis-Witness/1.0'})",
        "data=urllib.request.urlopen(request,timeout=60).read()",
        "assert data.startswith(b'LOCUS'), 'NCBI did not return GenBank bytes'",
        "pathlib.Path(sys.argv[2]).write_bytes(data)",
        "print(json.dumps({'accession':sys.argv[3],'source_bytes':len(data),'source_sha256':hashlib.sha256(data).hexdigest()}))",
      ].join(";"),
      url,
      SOURCE,
      accession,
    ]))
    return { sandbox, acquisition }
  } catch (error) {
    await sandbox.kill().catch(() => undefined)
    throw error
  }
}

async function compile(sandbox: Sandbox): Promise<Json> {
  await run(sandbox, "python3", ["-m", "brainc", "compile-genbank", SOURCE, "-o", COMPILED], `${ROOT}/epigenesis`)
  await run(sandbox, "python3", ["-m", "brainc", "compile-insdc-graph", COMPILED, "-o", STATE], `${ROOT}/epigenesis`)
  return JSON.parse(await run(sandbox, "python3", [
    "-c",
    "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); print(json.dumps({'artifact_sha256':a['artifact_sha256'],'bio_ir_sha256':a['bio_ir_sha256'],'feature_state_sha256':b['artifact_sha256']}))",
    COMPILED,
    `${STATE}/bundle.json`,
  ]))
}

async function verifierEvidence(sandbox: Sandbox): Promise<Json> {
  const genbankReport = `${ROOT}/genbank-validation.json`
  const stateReport = `${ROOT}/feature-state-validation.json`
  await run(sandbox, "python3", ["-m", "brainc.validator_insdc", SOURCE, COMPILED, "-o", genbankReport], `${ROOT}/epigenesis`)
  await run(sandbox, "python3", ["-m", "brainc.validator_insdc_graph", SOURCE, COMPILED, STATE, "-o", stateReport], `${ROOT}/epigenesis`)
  return JSON.parse(await run(sandbox, "python3", [
    "-c",
    [
      "import json,sys",
      "a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); g=json.load(open(sys.argv[3])); s=json.load(open(sys.argv[4]))",
      "records=[]",
      "exec(\"for r in a['bio_ir']['records']:\\n fs=[]\\n for f in r['features']:\\n  seg=f['location']['segments']\\n  fs.append({'key':f['key'],'location':{'text':f['location']['text'],'segments':[{'start':min(x['start'] for x in seg),'end':max(x['end'] for x in seg),'orientation':seg[0]['orientation']}]}})\\n records.append({'record_id':r['record_id'],'definition':r['definition'],'organism':r['organism'],'locus':r['locus'],'features':fs})\")",
      "print(json.dumps({'compiled':{'artifact_sha256':a['artifact_sha256'],'bio_ir_sha256':a['bio_ir_sha256'],'bio_ir':{'records':records}},'featureState':{'artifact_sha256':b['artifact_sha256']},'genbankValidation':g,'featureStateValidation':s}))",
    ].join(";"),
    COMPILED,
    `${STATE}/bundle.json`,
    genbankReport,
    stateReport,
  ]))
}

async function publish(sandbox: Sandbox, html: string, proof: string): Promise<string> {
  const site = `${ROOT}/site`
  const artifacts = `${site}/artifacts`
  await run(sandbox, "mkdir", ["-p", artifacts])
  await writeText(sandbox, `${site}/index.html`, html)
  await writeText(sandbox, `${site}/proof.json`, proof)
  await run(sandbox, "cp", [SOURCE, `${artifacts}/source.gb`])
  await run(sandbox, "cp", [COMPILED, `${artifacts}/genbank.json`])
  await run(sandbox, "cp", [`${ROOT}/genbank-validation.json`, `${artifacts}/genbank-validation.json`])
  await run(sandbox, "cp", [`${ROOT}/feature-state-validation.json`, `${artifacts}/feature-state-validation.json`])
  await run(sandbox, "sh", ["-c", `cd ${STATE} && python3 -m zipfile -c ${artifacts}/feature-state.zip *.json`])
  await run(sandbox, "sh", ["-c", `cd ${site} && nohup python3 -m http.server ${PORT} >/tmp/epigenesis-witness-http.log 2>&1 &`])

  for (let attempt = 1; attempt <= 12; attempt++) {
    const local = await sandbox.commands.run("python3", {
      args: ["-c", `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${PORT}', timeout=3).status)`],
    })
    if (local.exitCode === 0 && local.stdout.trim() === "200") break
    if (attempt === 12) throw new Error(`proof server did not start: ${local.stderr || local.stdout}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  const { url } = await sandbox.previewUrl(PORT)
  let lastResponse = "no response"
  for (let attempt = 1; attempt <= 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      const response = await fetch(url, { cache: "no-store" })
      const body = await response.text()
      if (response.ok && body.includes("Epigenesis Witness")) return url
      lastResponse = `HTTP ${response.status}: ${body.slice(0, 120).replaceAll(/\s+/g, " ")}`
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`public proof page did not become ready (${lastResponse})`)
}

async function waitForShutdown(): Promise<void> {
  console.log("Press Ctrl+C to destroy the verifier sandbox and close the proof URL.")
  await new Promise((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
}

async function settle(promise: Promise<unknown>): Promise<void> {
  await Promise.race([promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000))])
}

async function main(): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is required")
  const accession = accessionArgument()
  const acquisitionUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=${encodeURIComponent(accession)}&rettype=gb&retmode=text`
  const client = new SolariClient({ apiKey })
  const live = new Set<Sandbox>()
  let snapshotId: string | undefined

  try {
    console.log(`prepare  pinned Epigenesis environment and acquire ${accession}`)
    const seed = await prepareSeed(client, accession, acquisitionUrl)
    live.add(seed.sandbox)
    snapshotId = await seed.sandbox.snapshot(`epigenesis-witness-${Date.now()}`)
    const seedSandboxId = seed.sandbox.sandboxId
    await settle(seed.sandbox.kill())
    live.delete(seed.sandbox)

    console.log(`compile  producer fork from ${snapshotId}`)
    const producer = await createSandbox(client, { fromSnapshot: snapshotId, timeoutMs: 20 * 60_000 })
    live.add(producer)
    const producerIdentity = await compile(producer)
    const producerSandboxId = producer.sandboxId
    await settle(producer.kill())
    live.delete(producer)

    console.log("replay   independent verifier fork")
    const verifier = await createSandbox(client, { fromSnapshot: snapshotId, timeoutMs: 20 * 60_000 })
    live.add(verifier)
    const verifierIdentity = await compile(verifier)
    if (JSON.stringify(producerIdentity) !== JSON.stringify(verifierIdentity)) {
      throw new Error("producer and verifier emitted different content identities")
    }
    const evidence = await verifierEvidence(verifier)
    const report = buildWitnessReport({
      accession,
      acquisitionUrl,
      sourceBytes: seed.acquisition.source_bytes,
      seedSandboxId,
      epigenesisCommit: EPIGENESIS_COMMIT,
      snapshotId,
      producerSandboxId,
      verifierSandboxId: verifier.sandboxId,
      compiled: evidence.compiled,
      featureState: evidence.featureState,
      genbankValidation: evidence.genbankValidation,
      featureStateValidation: evidence.featureStateValidation,
    })
    const url = await publish(verifier, renderReport(report), JSON.stringify(report, null, 2))
    console.log(`proof    ${url}`)
    await waitForShutdown()
  } finally {
    await Promise.all([...live].map((sandbox) => settle(sandbox.kill())))
    if (snapshotId) await settle(client.sandboxes.deleteSnapshot(snapshotId))
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
