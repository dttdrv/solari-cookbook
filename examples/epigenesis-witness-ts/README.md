# Epigenesis Witness (TypeScript)

Turn one public NCBI accession into a shareable, independently replayed genome
provenance capsule.

The example uses Solari snapshots and sandboxes for an independently replayed
evidence chain:

1. A seed sandbox pins Epigenesis, retrieves the exact GenBank response bytes
   from NCBI, then becomes a snapshot.
2. A producer sandbox boots from that snapshot and compiles the bytes into
   content-addressed GenBank BioIR and feature state.
3. A separate verifier sandbox boots from the same snapshot, recompiles the
   source, requires byte-identical artifact identities, independently replays
   both contracts, and serves the public evidence page.

The compiler and validators are from
[`dttdrv/epigenesis`](https://github.com/dttdrv/epigenesis). The demo pins an
exact commit, and the Epigenesis runtime has no third-party dependencies.

## Run

```bash
cd examples/epigenesis-witness-ts
npm install
export SOLARI_API_KEY=slr_live_...
npm start -- U49845.1
```

Open the printed `proof` URL. The page includes the source, compiled artifact,
feature-state bundle, both sealed validation reports, and the acquisition
metadata. Press `Ctrl+C` to destroy the verifier sandbox and close the preview.

Only public NCBI accessions are accepted. This example intentionally has no
upload path for personal or private sequence data.

## Verify the local report code

```bash
npm test
npm run typecheck
```

Source: [`index.ts`](index.ts) and [`report.ts`](report.ts)
