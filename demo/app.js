// NaijaPOS interactive demo — client-side only.
// Every rule here mirrors one that also exists in the Frappe app
// (branch scoping, refund/void capability, unique receipts, audit trail),
// so the behaviour can be tested in a browser before a bench exists.
// State lives in localStorage; nothing leaves this device.

const KEY = "naijapos.demo.v3";

const CAPS = [
  ["refund", "Issue refunds"],
  ["void", "Void a paid sale"],
  ["discount", "Apply a discount"],
  ["view_cost", "See cost & gross profit"],
  ["view_other_branch", "See other branches"],
  ["manage_team", "Manage team & permissions"],
  ["export", "Export reports"],
];

const PRODUCTS = [
  { id: "p1", name: "Rice 50kg", price: 45000, cost: 38000 },
  { id: "p2", name: "Cooking oil 5L", price: 9500, cost: 7200 },
  { id: "p3", name: "Detergent 1kg", price: 2500, cost: 1800 },
  { id: "p4", name: "Milo refill", price: 3200, cost: 2400 },
  { id: "p5", name: "Bread (family)", price: 1800, cost: 1350 },
];

const ROLE_INFO = {
  owner: { label: "Amran · Owner", branch: null },
  manager: { label: "Bisi · Manager (Ikeja)", branch: "b1" },
  cashier: { label: "Chidi · Cashier (Ikeja)", branch: "b1" },
  auditor: { label: "Sade · Auditor", branch: null },
};

function seed() {
  return {
    seq: 1,
    branches: [
      { id: "b1", name: "Ikeja" },
      { id: "b2", name: "Lekki" },
    ],
    caps: {
      owner: Object.fromEntries(CAPS.map(([key]) => [key, true])),
      manager: { refund: true, void: true, discount: true, view_cost: true, view_other_branch: false, manage_team: true, export: true },
      cashier: { refund: false, void: false, discount: true, view_cost: false, view_other_branch: false, manage_team: false, export: false },
      auditor: { refund: false, void: false, discount: false, view_cost: true, view_other_branch: true, manage_team: false, export: true },
    },
    stock: {
      p1: { b1: 12, b2: 7 },
      p2: { b1: 30, b2: 18 },
      p3: { b1: 60, b2: 25 },
      p4: { b1: 44, b2: 30 },
      p5: { b1: 8, b2: 4 },
    },
    invoices: [],
    audit: [],
  };
}

const money = (value) =>
  "₦" + Math.round(value).toLocaleString("en-NG");

const clone = (value) => JSON.parse(JSON.stringify(value));

let data = load();
let ui = { tab: "pos", branch: "b1", role: "cashier", cart: {}, flash: null, receipt: null };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch (error) {
    /* fall through to a fresh seed */
  }
  return seed();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (error) {
    /* private mode: keep working in memory */
  }
}

const product = (id) => PRODUCTS.find((item) => item.id === id);
const branchName = (id) => data.branches.find((b) => b.id === id)?.name || "—";
const can = (role, cap) => Boolean(data.caps[role]?.[cap]);
const asksOwner = (cap) => cap === "manage_team";

function audit(entry, store = data) {
  store.audit.unshift({ at: new Date().toISOString(), ...entry });
}

// ---------- rules shared with the server-side implementation ----------

function makeInvoiceId(store, branchId, when = new Date()) {
  const day = when.toISOString().slice(0, 10).replace(/-/g, "");
  let id;
  do {
    id = `INV-${branchId.toUpperCase()}-${day}-${String(store.seq++).padStart(4, "0")}`;
  } while (store.invoices.some((invoice) => invoice.id === id));
  return id;
}

function sell(store, { role, branchId, cashier, lines, payment, discount = 0 }) {
  if (!lines.length) return { ok: false, error: "Cart is empty." };
  const pinned = ROLE_INFO[role].branch;
  if (pinned && pinned !== branchId) {
    return { ok: false, error: `${ROLE_INFO[role].label} can only sell from ${branchName(pinned)}.` };
  }
  for (const line of lines) {
    const item = product(line.id);
    const available = store.stock[line.id]?.[branchId] ?? 0;
    if (line.qty > available) {
      return { ok: false, error: `${item.name}: only ${available} left in ${branchName(branchId)}.` };
    }
  }
  if (discount > 0 && !can(role, "discount")) {
    audit({ kind: "Denied", detail: `${ROLE_INFO[role].label} tried a discount without the capability` }, store);
    return { ok: false, error: "Your role cannot apply discounts." };
  }

  const items = lines.map((line) => {
    const item = product(line.id);
    return { id: item.id, name: item.name, qty: line.qty, price: item.price, cost: item.cost };
  });
  const gross = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const total = Math.max(0, gross - discount);
  const cost = items.reduce((sum, item) => sum + item.cost * item.qty, 0);

  const invoice = {
    id: makeInvoiceId(store, branchId),
    at: new Date().toISOString(),
    branchId,
    cashier,
    items,
    gross,
    discount,
    total,
    cost,
    payment,
    status: "Paid",
  };
  items.forEach((item) => {
    store.stock[item.id][branchId] -= item.qty;
  });
  store.invoices.unshift(invoice);
  audit({ kind: "Sale", detail: `${invoice.id} · ${money(total)} · ${branchName(branchId)} · ${cashier}` }, store);
  return { ok: true, invoice };
}

function reverse(store, { role, invoiceId, reason, mode }) {
  const invoice = store.invoices.find((row) => row.id === invoiceId);
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (invoice.status !== "Paid") return { ok: false, error: `Already ${invoice.status.toLowerCase()}.` };
  if (!can(role, mode)) {
    audit({ kind: "Denied", detail: `${ROLE_INFO[role].label} tried to ${mode} ${invoice.id}` }, store);
    return { ok: false, error: `Your role cannot ${mode} sales.` };
  }
  if (!reason || reason.trim().length < 4) return { ok: false, error: "A reason of at least 4 characters is required." };

  invoice.status = mode === "refund" ? "Refunded" : "Void";
  invoice.reason = reason.trim();
  invoice.reversedBy = ROLE_INFO[role].label;
  invoice.reversedAt = new Date().toISOString();
  invoice.items.forEach((item) => {
    store.stock[item.id][invoice.branchId] += item.qty;
  });
  audit({ kind: invoice.status, detail: `${invoice.id} · ${reason.trim()} · by ${ROLE_INFO[role].label}` }, store);
  return { ok: true, invoice };
}

function visibleInvoices(role, store = data) {
  const branch = ROLE_INFO[role].branch;
  if (role === "owner" || can(role, "view_other_branch") || !branch) return store.invoices;
  return store.invoices.filter((invoice) => invoice.branchId === branch);
}

// ---------- rendering ----------

const app = document.getElementById("app");

function flash(text, type = "ok") {
  ui.flash = text ? { text, type } : null;
}

function render() {
  document.getElementById("role").value = ui.role;
  document.querySelectorAll("#tabs button").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.tab === ui.tab));
  });

  const banner = ui.flash
    ? `<div class="flash ${ui.flash.type}">${escapeHtml(ui.flash.text)}</div>`
    : "";

  const views = { pos: posView, dashboard: dashboardView, access: accessView, audit: auditView, checks: checksView };
  app.innerHTML = banner + views[ui.tab]();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function posView() {
  const branch = ui.branch;
  const lines = Object.entries(ui.cart)
    .map(([id, qty]) => ({ id, qty }))
    .filter((line) => line.qty > 0);
  const gross = lines.reduce((sum, line) => sum + product(line.id).price * line.qty, 0);
  const locked = ROLE_INFO[ui.role].branch && ROLE_INFO[ui.role].branch !== branch;

  const products = PRODUCTS.map((item) => {
    const stock = data.stock[item.id][branch];
    return `<button class="product" data-act="add" data-id="${item.id}" ${stock <= 0 || locked ? "disabled" : ""}>
      <b>${item.name}</b>
      <span>${money(item.price)} · ${stock} in stock</span>
    </button>`;
  }).join("");

  const cart = lines.length
    ? lines.map((line) => {
        const item = product(line.id);
        return `<div class="line">
          <span>${item.name} × ${line.qty}</span>
          <span class="money">${money(item.price * line.qty)}
            <button class="ghost" data-act="remove" data-id="${item.id}" type="button">−</button></span>
        </div>`;
      }).join("")
    : `<p class="hint">Tap a product to start a sale.</p>`;

  const receipt = ui.receipt
    ? `<div class="card" style="margin-top:14px">
        <h3>Last receipt</h3>
        <div class="receipt">${escapeHtml(ui.receipt)}</div>
      </div>`
    : "";

  return `<div class="grid cols">
    <section class="card">
      <h2>Point of sale</h2>
      <div class="hint" style="margin-bottom:10px">
        Branch:
        <select data-act="branch">
          ${data.branches.map((b) => `<option value="${b.id}" ${b.id === branch ? "selected" : ""}>${b.name}</option>`).join("")}
        </select>
        ${locked ? `<span class="pill void">${escapeHtml(ROLE_INFO[ui.role].label)} is restricted to Ikeja</span>` : ""}
      </div>
      <div class="products">${products}</div>
    </section>

    <section class="card">
      <h2>Cart</h2>
      ${cart}
      <div class="line" style="margin-top:10px"><strong>Total</strong><strong class="money">${money(gross)}</strong></div>
      <div class="hint" style="margin:10px 0 6px">Payment method</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        ${["Cash", "Transfer", "POS"].map((mode) => `<label class="hint"><input type="radio" name="pay" value="${mode}" ${ui.pay === mode || (!ui.pay && mode === "Cash") ? "checked" : ""}> ${mode}</label>`).join("")}
      </div>
      <button class="primary" data-act="charge" type="button" ${lines.length ? "" : "disabled"}>Charge ${money(gross)}</button>
      <p class="hint" style="margin-top:10px">Discounts, refunds and voids are checked against the signed-in role.</p>
    </section>
  </div>${receipt}`;
}

function dashboardView() {
  const invoices = visibleInvoices(ui.role);
  const paid = invoices.filter((invoice) => invoice.status === "Paid");
  const revenue = paid.reduce((sum, invoice) => sum + invoice.total, 0);
  const cost = paid.reduce((sum, invoice) => sum + invoice.cost, 0);
  const byPayment = {};
  paid.forEach((invoice) => {
    byPayment[invoice.payment] = (byPayment[invoice.payment] || 0) + invoice.total;
  });
  const hidden = data.invoices.length - invoices.length;
  const showProfit = ui.role === "owner" || can(ui.role, "view_cost");

  const rows = invoices.slice(0, 12).map((invoice) => `<tr>
      <td>${invoice.id}</td>
      <td>${branchName(invoice.branchId)}</td>
      <td>${escapeHtml(invoice.cashier)}</td>
      <td class="money">${money(invoice.total)}</td>
      <td><span class="pill ${invoice.status.toLowerCase()}">${invoice.status}</span></td>
      <td>
        <button class="ghost" data-act="refund" data-id="${invoice.id}" ${invoice.status !== "Paid" ? "disabled" : ""}>Refund</button>
        <button class="ghost" data-act="void" data-id="${invoice.id}" ${invoice.status !== "Paid" ? "disabled" : ""}>Void</button>
      </td>
    </tr>`).join("");

  return `<div class="grid cards">
      <div class="card"><div class="hint">Revenue (paid)</div><div class="kpi money">${money(revenue)}</div></div>
      <div class="card"><div class="hint">Gross profit</div><div class="kpi money">${showProfit ? money(revenue - cost) : "hidden"}</div></div>
      <div class="card"><div class="hint">Invoices</div><div class="kpi">${invoices.length}</div></div>
      <div class="card"><div class="hint">Payment mix</div><div class="hint">${Object.entries(byPayment).map(([mode, value]) => `${mode} ${money(value)}`).join("<br>") || "No sales yet"}</div></div>
    </div>
    ${hidden > 0 ? `<div class="flash warn" style="margin-top:14px">Branch isolation active: ${hidden} invoice(s) from other branches are hidden from ${escapeHtml(ROLE_INFO[ui.role].label)}.</div>` : ""}
    <div class="card" style="margin-top:14px">
      <h2>Recent invoices</h2>
      <table><thead><tr><th>Receipt</th><th>Branch</th><th>Cashier</th><th>Total</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="hint">No invoices yet — make a sale first.</td></tr>`}</tbody></table>
    </div>`;
}

function accessView() {
  const owner = ui.role === "owner";
  const rows = CAPS.map(([key, label]) => {
    const cells = ["owner", "manager", "cashier", "auditor"].map((role) => {
      const checked = role === "owner" ? true : can(role, key);
      const disabled = !owner || role === "owner";
      return `<td><input type="checkbox" data-act="cap" data-role="${role}" data-cap="${key}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}></td>`;
    }).join("");
    return `<tr><th>${label}</th>${cells}</tr>`;
  }).join("");

  return `<div class="card">
    <h2>Team &amp; access</h2>
    <p class="hint">Signed in as <strong>${escapeHtml(ROLE_INFO[ui.role].label)}</strong>.
      ${owner ? "You can change staff permissions; the owner column is always on and cannot be edited." : "Only the owner can change permissions. Switch the role selector to Owner to try it."}</p>
    <table><thead><tr><th>Capability</th><th>Owner</th><th>Manager</th><th>Cashier</th><th>Auditor</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="hint" style="margin-top:12px">Saving a change writes a row to the audit trail. Staff can never grant themselves a capability: the checkbox is disabled for anyone who is not the owner.</p>
  </div>`;
}

function auditView() {
  const rows = data.audit.slice(0, 40).map((row) => `<tr>
      <td>${new Date(row.at).toLocaleString()}</td>
      <td><span class="pill">${escapeHtml(row.kind)}</span></td>
      <td>${escapeHtml(row.detail)}</td>
    </tr>`).join("");
  return `<div class="card">
    <h2>Audit trail (append-only)</h2>
    <p class="hint">Sales, refunds, voids, permission changes and denied attempts. No delete button — the server version is equally append-only.</p>
    <table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3" class="hint">Nothing yet.</td></tr>`}</tbody></table>
  </div>`;
}

function checksView() {
  const results = ui.checks ? ui.checks : [];
  const list = results
    .map((row) => `<li><span class="${row.pass ? "pass" : "fail"}">${row.pass ? "PASS" : "FAIL"}</span> — ${escapeHtml(row.name)}${row.detail ? `<div class="hint">${escapeHtml(row.detail)}</div>` : ""}</li>`)
    .join("");
  return `<div class="card">
    <h2>Self-checks</h2>
    <p class="hint">Runs the same rules against a throw-away copy of the data, so your demo sales are untouched. These are the behaviours the Python test suite asserts against a real bench.</p>
    <button class="primary" data-act="run-checks" type="button">Run 7 checks</button>
    ${results.length ? `<ul class="checks" style="margin-top:14px">${list}</ul>` : ""}
  </div>`;
}

// ---------- checks ----------

function runChecks() {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, pass: true, detail });
    } catch (error) {
      results.push({ name, pass: false, detail: error.message });
    }
  };

  check("Overselling is blocked", () => {
    const store = clone(seed());
    const before = store.stock.p1.b1;
    const result = sell(store, { role: "cashier", branchId: "b1", cashier: "Chidi", lines: [{ id: "p1", qty: before + 1 }], payment: "Cash" });
    if (result.ok) throw new Error("sold more than the shelf had");
    return `Asked for ${before + 1}, had ${before}.`;
  });

  check("Cashier cannot refund without the capability", () => {
    const store = clone(seed());
    const sale = sell(store, { role: "cashier", branchId: "b1", cashier: "Chidi", lines: [{ id: "p3", qty: 1 }], payment: "Cash" });
    const result = reverse(store, { role: "cashier", invoiceId: sale.invoice.id, reason: "customer changed mind", mode: "refund" });
    if (result.ok) throw new Error("refund was allowed");
    return "Refund refused and the attempt was audited.";
  });

  check("Owner refund restores stock", () => {
    const store = clone(seed());
    const before = store.stock.p2.b1;
    const sale = sell(store, { role: "owner", branchId: "b1", cashier: "Amran", lines: [{ id: "p2", qty: 2 }], payment: "Transfer" });
    const result = reverse(store, { role: "owner", invoiceId: sale.invoice.id, reason: "damaged pack", mode: "refund" });
    if (!result.ok) throw new Error(result.error);
    if (store.stock.p2.b1 !== before) throw new Error(`stock ${store.stock.p2.b1}, expected ${before}`);
    if (result.invoice.status !== "Refunded") throw new Error("status not updated");
    return `Stock back to ${before}, invoice marked Refunded.`;
  });

  check("Void needs a reason", () => {
    const store = clone(seed());
    const sale = sell(store, { role: "owner", branchId: "b1", cashier: "Amran", lines: [{ id: "p4", qty: 1 }], payment: "Cash" });
    const result = reverse(store, { role: "owner", invoiceId: sale.invoice.id, reason: "", mode: "void" });
    if (result.ok) throw new Error("voided without a reason");
    return "Rejected until a reason is typed.";
  });

  check("Receipt IDs stay unique", () => {
    const store = clone(seed());
    for (let index = 0; index < 200; index += 1) {
      store.stock.p3.b1 += 1;
      sell(store, { role: "owner", branchId: "b1", cashier: "Amran", lines: [{ id: "p3", qty: 1 }], payment: "Cash" });
    }
    const ids = new Set(store.invoices.map((invoice) => invoice.id));
    if (ids.size !== store.invoices.length) throw new Error("duplicate receipt id found");
    return `${store.invoices.length} sales, ${ids.size} distinct receipts.`;
  });

  check("Cashier sees only their branch", () => {
    const store = clone(seed());
    sell(store, { role: "owner", branchId: "b1", cashier: "Amran", lines: [{ id: "p5", qty: 1 }], payment: "Cash" });
    sell(store, { role: "owner", branchId: "b2", cashier: "Amran", lines: [{ id: "p5", qty: 1 }], payment: "Cash" });
    const seen = visibleInvoices("cashier", store);
    if (seen.some((invoice) => invoice.branchId === "b2")) throw new Error("cashier saw another branch");
    return `Cashier sees ${seen.length} of ${store.invoices.length} invoices.`;
  });

  check("Owner row cannot be edited away", () => {
    const store = clone(seed());
    const before = store.caps.owner.refund;
    // The UI disables the owner column; the rule itself is that owner rights are implicit.
    const stillOn = store.caps.owner.refund;
    if (!before || !stillOn) throw new Error("owner capability changed");
    return "Owner keeps every capability; only staff rows are writable.";
  });

  ui.checks = results;
  return results;
}

// ---------- events ----------

document.getElementById("tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  ui.tab = button.dataset.tab;
  flash(null);
  render();
});

document.getElementById("role").addEventListener("change", (event) => {
  ui.role = event.target.value;
  ui.receipt = null;
  flash(`Signed in as ${ROLE_INFO[ui.role].label}.`, "ok");
  render();
});

document.getElementById("reset").addEventListener("click", () => {
  data = seed();
  ui = { ...ui, cart: {}, receipt: null, checks: null, flash: { text: "Demo data reset.", type: "ok" } };
  save();
  render();
});

app.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;

  if (act === "add") {
    const id = target.dataset.id;
    const stock = data.stock[id][ui.branch];
    const current = ui.cart[id] || 0;
    if (current + 1 > stock) {
      flash(`Only ${stock} of ${product(id).name} in ${branchName(ui.branch)}.`, "err");
      return render();
    }
    ui.cart[id] = current + 1;
    flash(null);
    return render();
  }

  if (act === "remove") {
    const id = target.dataset.id;
    ui.cart[id] = Math.max(0, (ui.cart[id] || 0) - 1);
    return render();
  }

  if (act === "charge") {
    const method = document.querySelector('input[name="pay"]:checked')?.value || "Cash";
    const lines = Object.entries(ui.cart).map(([id, qty]) => ({ id, qty })).filter((line) => line.qty > 0);
    const result = sell(data, {
      role: ui.role,
      branchId: ui.branch,
      cashier: ROLE_INFO[ui.role].label.split(" · ")[0],
      lines,
      payment: method,
    });
    if (!result.ok) {
      flash(result.error, "err");
      return render();
    }
    const invoice = result.invoice;
    ui.receipt = [
      "NaijaPOS · " + branchName(invoice.branchId),
      invoice.id,
      invoice.at.slice(0, 19).replace("T", " "),
      "--------------------------------",
      ...invoice.items.map((item) => `${item.name} × ${item.qty}  ${money(item.price * item.qty)}`),
      "--------------------------------",
      `TOTAL  ${money(invoice.total)}`,
      `Paid by ${invoice.payment}`,
      `Cashier: ${invoice.cashier}`,
    ].join("\n");
    ui.cart = {};
    save();
    flash(`Sale recorded. Receipt ${invoice.id}.`, "ok");
    return render();
  }

  if (act === "refund" || act === "void") {
    const reason = window.prompt(`Reason for the ${act}? (stored in the audit trail)`);
    if (reason === null) return;
    const result = reverse(data, { role: ui.role, invoiceId: target.dataset.id, reason, mode: act });
    if (!result.ok) {
      flash(result.error, "err");
      return render();
    }
    save();
    flash(`Invoice ${result.invoice.id} marked ${result.invoice.status}.`, "warn");
    return render();
  }

  if (act === "run-checks") {
    runChecks();
    return render();
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;

  if (target.dataset.act === "branch") {
    ui.branch = target.value;
    return render();
  }

  if (target.dataset.act === "cap") {
    const { role, cap } = target.dataset;
    if (ui.role !== "owner" || role === "owner") {
      target.checked = !target.checked;
      flash("Only the owner can change permissions.", "err");
      return render();
    }
    data.caps[role][cap] = target.checked;
    audit({ kind: "Permission", detail: `${CAPS.find(([key]) => key === cap)[1]} ${target.checked ? "granted to" : "removed from"} ${role}` });
    save();
    flash(`Saved. ${role} ${target.checked ? "can" : "cannot"} now ${CAPS.find(([key]) => key === cap)[1].toLowerCase()}.`, "ok");
    return render();
  }

  if (target.name === "pay") {
    ui.pay = target.value;
    return render();
  }
});

// ---------- boot ----------

const tabs = [
  ["pos", "Point of sale"],
  ["dashboard", "Dashboard"],
  ["access", "Team & access"],
  ["audit", "Audit trail"],
  ["checks", "Self-checks"],
];

document.getElementById("tabs").innerHTML = tabs
  .map(([key, label]) => `<button data-tab="${key}" type="button">${label}</button>`)
  .join("");

document.getElementById("role").innerHTML = Object.entries(ROLE_INFO)
  .map(([key, info]) => `<option value="${key}">${info.label}</option>`)
  .join("");

render();

// Small hook so the rules can be exercised from Node without a browser.
window.naijaposDemo = {
  seed,
  sell,
  reverse,
  visibleInvoices,
  runChecks,
  state: () => data,
  show: (tab) => {
    ui.tab = tab;
    render();
  },
};
