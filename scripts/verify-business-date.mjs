import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Standalone date-boundary check; Node.js 22.13+ supplies built-in type stripping.

const source = await readFile(new URL("../app/lib/business-date.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(source);
const { japanDayStamp, dateTimeInput } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

for (const [instant, day] of [
  ["2026-11-17T14:59:59Z", "2026-11-17"],
  ["2026-11-17T15:00:00Z", "2026-11-18"],
  ["2026-12-31T15:00:00Z", "2027-01-01"],
  ["2028-02-28T15:00:00Z", "2028-02-29"],
]) {
  assert.equal(japanDayStamp(Date.parse(instant)), Date.parse(`${day}T00:00:00Z`), `Japanese business day: ${instant}`);
}
assert.equal(dateTimeInput(Date.UTC(2026, 10, 18), "13:00"), "2026-11-18T13:00");
assert.equal(dateTimeInput(Date.UTC(2026, 10, 18)), "2026-11-18T09:00");
console.log("PASS: Japanese midnight, year boundary, leap day and local datetime input.");
