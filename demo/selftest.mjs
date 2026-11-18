// Headless test for the interactive demo — no browser, no Frappe, no install.
//
//   node demo/selftest.mjs
//
// It stubs just enough of the DOM to import demo/app.js, then exercises the
// same rules the Python suite asserts against a real bench: overselling,
// refund capability, stock restoration, reasons, unique receipts, branch
// isolation, and that every tab renders without throwing.

import assert from "node:assert/strict";

const element = () => ({
  innerHTML: "",
  value: "",
  checked: false,
  dataset: {},
  setAttribute() {},
  addEventListener() {},
});

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
  getElementById: () => element(),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
};
globalThis.window = { prompt: () => "customer request" };

await import(new URL("./app.js", import.meta.url));
const demo = globalThis.window.naijaposDemo;
assert.ok(demo, "demo/app.js did not expose window.naijaposDemo");

const results = demo.runChecks();
for (const row of results) {
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
}
assert.equal(results.filter((row) => !row.pass).length, 0, "self-checks failed");

// A real sale, then a refund by the owner.
const store = demo.seed();
const sale = demo.sell(store, {
  role: "owner",
  branchId: "b2",
  cashier: "Amran",
  lines: [{ id: "p1", qty: 2 }],
  payment: "Transfer",
});
assert.ok(sale.ok, sale.error);
assert.ok(sale.invoice.id.startsWith("INV-B2-"), sale.invoice.id);
assert.equal(store.stock.p1.b2, 5);

const refund = demo.reverse(store, {
  role: "owner",
  invoiceId: sale.invoice.id,
  reason: "wrong size",
  mode: "refund",
});
assert.ok(refund.ok, refund.error);
assert.equal(store.stock.p1.b2, 7);

// A cashier is refused, and the refusal lands in the audit trail.
const second = demo.sell(store, {
  role: "cashier",
  branchId: "b1",
  cashier: "Chidi",
  lines: [{ id: "p3", qty: 1 }],
  payment: "Cash",
});
assert.ok(second.ok, second.error);
const denied = demo.reverse(store, {
  role: "cashier",
  invoiceId: second.invoice.id,
  reason: "customer request",
  mode: "refund",
});
assert.equal(denied.ok, false);
assert.ok(store.audit.some((row) => row.kind === "Denied"));

// Every tab renders without throwing.
for (const tab of ["pos", "dashboard", "access", "audit", "checks"]) demo.show(tab);

console.log("ALL DEMO LOGIC TESTS PASSED");
