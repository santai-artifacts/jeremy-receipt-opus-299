import { Hono } from "hono";
import Database from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

// --- Database setup ---------------------------------------------------------
const dbPath = process.env.DATABASE_URL || "./data/app.db";
try {
  mkdirSync(dirname(dbPath), { recursive: true });
} catch {
  /* directory already exists */
}

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS bills (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL DEFAULT 'Untitled receipt',
    tax_amount REAL NOT NULL DEFAULT 0,
    tip_mode   TEXT NOT NULL DEFAULT 'percent',   -- 'percent' | 'amount'
    tip_value  REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS people (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '#6366f1'
  );

  CREATE TABLE IF NOT EXISTS items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id  INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    price    REAL NOT NULL DEFAULT 0,   -- unit price
    quantity REAL NOT NULL DEFAULT 1,
    pos      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS assignments (
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    shares    REAL NOT NULL DEFAULT 1,
    PRIMARY KEY (item_id, person_id)
  );
`);

// --- Helpers ----------------------------------------------------------------
function loadBill(id: number) {
  const bill = db.query("SELECT * FROM bills WHERE id = ?").get(id) as any;
  if (!bill) return null;
  bill.people = db
    .query("SELECT * FROM people WHERE bill_id = ? ORDER BY id")
    .all(id);
  bill.items = db
    .query("SELECT * FROM items WHERE bill_id = ? ORDER BY pos, id")
    .all(id);
  const itemIds = bill.items.map((i: any) => i.id);
  bill.assignments = itemIds.length
    ? db
        .query(
          `SELECT * FROM assignments WHERE item_id IN (${itemIds
            .map(() => "?")
            .join(",")})`
        )
        .all(...itemIds)
    : [];
  return bill;
}

const PALETTE = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
  "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#0ea5e9",
];

// --- API --------------------------------------------------------------------
const app = new Hono();
const api = new Hono();

api.get("/bills", (c) => {
  const rows = db
    .query("SELECT id, name, created_at FROM bills ORDER BY created_at DESC, id DESC")
    .all();
  return c.json(rows);
});

api.post("/bills", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "Untitled receipt").toString().slice(0, 120);
  const info = db.query("INSERT INTO bills (name) VALUES (?)").run(name);
  return c.json(loadBill(Number(info.lastInsertRowid)));
});

api.get("/bills/:id", (c) => {
  const bill = loadBill(Number(c.req.param("id")));
  return bill ? c.json(bill) : c.json({ error: "not found" }, 404);
});

api.patch("/bills/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const cur = db.query("SELECT * FROM bills WHERE id = ?").get(id) as any;
  if (!cur) return c.json({ error: "not found" }, 404);
  const name = body.name ?? cur.name;
  const tax = body.tax_amount ?? cur.tax_amount;
  const tipMode = body.tip_mode ?? cur.tip_mode;
  const tipValue = body.tip_value ?? cur.tip_value;
  db.query(
    "UPDATE bills SET name = ?, tax_amount = ?, tip_mode = ?, tip_value = ? WHERE id = ?"
  ).run(name, tax, tipMode, tipValue, id);
  return c.json(loadBill(id));
});

api.delete("/bills/:id", (c) => {
  db.query("DELETE FROM bills WHERE id = ?").run(Number(c.req.param("id")));
  return c.json({ ok: true });
});

api.post("/bills/:id/people", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "Guest").toString().slice(0, 60);
  const count = (db.query("SELECT COUNT(*) n FROM people WHERE bill_id = ?").get(id) as any).n;
  const color = PALETTE[count % PALETTE.length];
  const info = db
    .query("INSERT INTO people (bill_id, name, color) VALUES (?, ?, ?)")
    .run(id, name, color);
  return c.json(loadBill(id));
});

api.patch("/people/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const p = db.query("SELECT * FROM people WHERE id = ?").get(id) as any;
  if (!p) return c.json({ error: "not found" }, 404);
  db.query("UPDATE people SET name = ? WHERE id = ?").run(
    (body.name ?? p.name).toString().slice(0, 60),
    id
  );
  return c.json(loadBill(p.bill_id));
});

api.delete("/people/:id", (c) => {
  const id = Number(c.req.param("id"));
  const p = db.query("SELECT bill_id FROM people WHERE id = ?").get(id) as any;
  db.query("DELETE FROM people WHERE id = ?").run(id);
  return c.json(p ? loadBill(p.bill_id) : { ok: true });
});

api.post("/bills/:id/items", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || "Item").toString().slice(0, 120);
  const price = Number(body.price) || 0;
  const quantity = Number(body.quantity) || 1;
  const pos = (db.query("SELECT COALESCE(MAX(pos), 0) m FROM items WHERE bill_id = ?").get(id) as any).m + 1;
  db.query(
    "INSERT INTO items (bill_id, name, price, quantity, pos) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, price, quantity, pos);
  return c.json(loadBill(id));
});

api.patch("/items/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const it = db.query("SELECT * FROM items WHERE id = ?").get(id) as any;
  if (!it) return c.json({ error: "not found" }, 404);
  db.query(
    "UPDATE items SET name = ?, price = ?, quantity = ? WHERE id = ?"
  ).run(
    (body.name ?? it.name).toString().slice(0, 120),
    body.price != null ? Number(body.price) : it.price,
    body.quantity != null ? Number(body.quantity) : it.quantity,
    id
  );
  return c.json(loadBill(it.bill_id));
});

api.delete("/items/:id", (c) => {
  const id = Number(c.req.param("id"));
  const it = db.query("SELECT bill_id FROM items WHERE id = ?").get(id) as any;
  db.query("DELETE FROM items WHERE id = ?").run(id);
  return c.json(it ? loadBill(it.bill_id) : { ok: true });
});

// Upsert / remove an assignment
api.put("/assignments", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const itemId = Number(body.item_id);
  const personId = Number(body.person_id);
  const shares = Number(body.shares);
  const it = db.query("SELECT bill_id FROM items WHERE id = ?").get(itemId) as any;
  if (!it) return c.json({ error: "not found" }, 404);
  if (!shares || shares <= 0) {
    db.query("DELETE FROM assignments WHERE item_id = ? AND person_id = ?").run(itemId, personId);
  } else {
    db.query(
      `INSERT INTO assignments (item_id, person_id, shares) VALUES (?, ?, ?)
       ON CONFLICT(item_id, person_id) DO UPDATE SET shares = excluded.shares`
    ).run(itemId, personId, shares);
  }
  return c.json(loadBill(it.bill_id));
});

app.route("/api", api);

// --- Static frontend --------------------------------------------------------
app.get("/", () => new Response(Bun.file("./public/index.html")));
app.get("/index.html", () => new Response(Bun.file("./public/index.html")));

export default { port: process.env.PORT || 3000, fetch: app.fetch };
