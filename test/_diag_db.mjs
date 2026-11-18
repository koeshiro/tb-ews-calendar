// Read-only diagnostic: inspect TB calendar storage DB (copy).
// Usage: node test/_diag_db.mjs <path-to-local.sqlite>
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: node test/_diag_db.mjs <path-to-local.sqlite>");
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const cols = db.prepare("PRAGMA table_info(cal_events)").all();
console.log("cal_events columns:", cols.map(c => c.name).join(", "));

const cnt = db.prepare("SELECT cal_id, COUNT(*) AS n FROM cal_events GROUP BY cal_id").all();
console.log("\nevent counts by cal_id:", JSON.stringify(cnt));

function prToDate(pt) {
  if (!pt) return String(pt);
  return new Date(pt / 1000 - 11644473600000).toISOString();
}

const noDates = db
  .prepare("SELECT COUNT(*) AS n FROM cal_events WHERE event_start IS NULL")
  .get();
console.log("events with NULL event_start:", noDates.n);

const range = db
  .prepare("SELECT MIN(event_start) AS mn, MAX(event_end) AS mx FROM cal_events")
  .get();
console.log("date range:", prToDate(range.mn), "->", prToDate(range.mx));

const sample = db
  .prepare("SELECT id, cal_id, event_start, event_end, title, flags FROM cal_events LIMIT 8")
  .all();
console.log("\nsample events:");
for (const s of sample) {
  console.log(" ", JSON.stringify({ ...s, event_start: prToDate(s.event_start), event_end: prToDate(s.event_end) }));
}

// events inside the Nov 2026 view range (approx: 2026-11-01..2026-12-31)
const nov = db
  .prepare(
    `SELECT COUNT(*) AS n FROM cal_events
     WHERE event_end >= ? AND event_start <= ?`
  )
  .all(
    BigInt(Date.UTC(2026, 10, 1) + 11644473600000) * 1000n,
    BigInt(Date.UTC(2026, 11, 31) + 11644473600000) * 1000n
  );
console.log("\nevents overlapping Nov-Dec 2026:", JSON.stringify(nov));

const meta = db.prepare("SELECT key FROM cal_metadata ORDER BY key LIMIT 10").all();
const metaTotal = db.prepare("SELECT COUNT(*) AS n FROM cal_metadata").get().n;
console.log("\ncal_metadata:", metaTotal, "rows; sample keys:", meta.map(m => m.key).join(" | "));
db.close();
