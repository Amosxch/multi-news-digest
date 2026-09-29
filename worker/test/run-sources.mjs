// node test/run-sources.mjs 2026-08-01 2026-08-05 [sourceId]
import { SOURCES } from '../src/sources/index.js';
import { Ctx } from '../src/util.js';
const [start, end, only] = process.argv.slice(2);
for (const [domain, list] of Object.entries(SOURCES)) {
  for (const s of list) {
    if (only && s.id !== only) continue;
    const ctx = new Ctx({ budget: 100, deadlineMs: 30000 }).child(s.budget);
    const t = Date.now();
    try {
      const r = await s.fetch(ctx, start, end);
      const ds = r.items.map((x) => x.date).sort();
      console.log(`${domain}/${s.id}: ${r.items.length} items [${ds[0]}..${ds[ds.length - 1]}] req=${ctx.used} ${Date.now() - t}ms ${r.note || ''}`);
      for (const x of r.items.slice(0, 2)) console.log('   ', x.date, x.title.slice(0, 40), x.url);
    } catch (e) {
      console.log(`${domain}/${s.id}: ERROR req=${ctx.used} ${Date.now() - t}ms ${e.message}`);
    }
  }
}
