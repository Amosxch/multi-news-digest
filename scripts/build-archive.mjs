// One-off / resumable archive builder: node scripts/build-archive.mjs --start 2026-01-01 --end 2026-09-29 [--size 4] [--limit 10] [--conc 5] [--raw ../archive-raw]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, chunks, fetchChunk, readJson, writeJson, todayCst, sleep } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const start = args.start || '2026-01-01';
const end = args.end || todayCst();
const size = Number(args.size || 4);
const limit = Number(args.limit || 10);
const conc = Number(args.conc || 5);
const raw = path.resolve(args.raw || '/workspace/archive-raw');
fs.mkdirSync(raw, { recursive: true });

const jobs = [];
for (const [s, e] of chunks(start, end, size)) for (const d of DOMAINS) jobs.push({ d, s, e, file: path.join(raw, `${d}_${s}_${e}.json`) });
const todo = jobs.filter((j) => !(readJson(j.file) && readJson(j.file).ok !== undefined && !args.force));
console.log(`chunks total=${jobs.length} todo=${todo.length} conc=${conc}`);
let done = 0;
async function worker() {
  while (todo.length) {
    const j = todo.shift();
    const t0 = Date.now();
    const r = await fetchChunk(j.d, j.s, j.e, { limit, log: (m) => console.log(m) });
    writeJson(j.file, { domain: j.d, start: j.s, end: j.e, fetched_at: new Date().toISOString(), ...r });
    done++;
    console.log(`[${done}/${jobs.length}] ${j.d} ${j.s}..${j.e} items=${r.items.length} ok=${r.ok} attempts=${r.attempts} ${(Date.now() - t0) / 1000}s ${r.error || ''}`);
    await sleep(300);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
console.log('DONE');
