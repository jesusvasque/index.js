import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { mysqlTable, varchar, text, int, datetime, boolean } from "drizzle-orm/mysql-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =======================
// CONFIGURACIÓN MYSQL INFINITYFREE
// =======================
// Sustituye estos valores con los que te da InfinityFree en el panel
const DB_HOST = "sql105.infinityfree.com"; // ejemplo: sql103.epizy.com
const DB_USER = "if0_39567764";
const DB_PASS = "kquuBq7mlrCYaGL";
const DB_NAME = "if0_39567764_queue_app";
const DB_PORT = 3306; // por lo general es 3306 en InfinityFree

const pool = await mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 5,
});

const queueEntries = mysqlTable("queue_entries", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: text("name").notNull(),
  referralCode: text("referral_code").notNull(),
  ipAddress: varchar("ip_address", { length: 45 }).notNull(),
  isActive: boolean("is_active").default(false),
  isCompleted: boolean("is_completed").default(false),
  position: int("position").notNull(),
  createdAt: datetime("created_at").default(new Date()),
  startedAt: datetime("started_at"),
  expiresAt: datetime("expires_at")
});

const db = drizzle(pool, { schema: { queueEntries } });

// Esquema validación
const insertQueueEntrySchema = createInsertSchema(queueEntries).pick({
  name: true,
  referralCode: true
}).extend({
  name: z.string().min(2).max(50),
  referralCode: z.string().refine((code) => {
    if (code.includes("temu.to") || code.includes("temu.com")) return true;
    const codePattern = /^[A-Za-z0-9]{5,10}$/;
    return codePattern.test(code);
  }, "Debe ser un código alfanumérico de 5-10 caracteres o un link de Temu válido")
});

// Clase para manejo de cola
class DatabaseStorage {
  async addToQueue(entry) {
    const position = await this.getNextPosition();
    await db.insert(queueEntries).values({
      ...entry,
      position,
      isActive: false,
      isCompleted: false
    });
    const activeEntry = await this.getActiveEntry();
    if (!activeEntry) {
      await this.activateEntry(entry.id);
    }
  }

  async getActiveEntry() {
    const [entry] = await db.select().from(queueEntries)
      .where(queueEntries.isActive.eq(true).and(queueEntries.isCompleted.eq(false)));
    return entry || undefined;
  }

  async getQueueStatus() {
    const [total] = await db.execute("SELECT COUNT(*) AS total FROM queue_entries WHERE is_completed = false");
    const totalInQueue = total[0].total;
    return { totalInQueue };
  }

  async getNextPosition() {
    const [result] = await db.execute("SELECT IFNULL(MAX(position), 0) AS maxPosition FROM queue_entries");
    return (result[0].maxPosition || 0) + 1;
  }

  async activateEntry(id) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    await db.update(queueEntries)
      .set({ isActive: true, startedAt: now, expiresAt })
      .where(queueEntries.id.eq(id));
  }
}

const storage = new DatabaseStorage();

// =======================
// SERVIDOR EXPRESS + WS
// =======================
const app = express();
app.use(express.json());

app.post("/api/queue/add", async (req, res) => {
  try {
    const clientIP = req.ip;
    const validatedData = insertQueueEntrySchema.parse(req.body);
    await storage.addToQueue({ ...validatedData, ipAddress: clientIP });
    res.json({ message: "Te has unido a la cola exitosamente" });
  } catch (error) {
    res.status(500).json({ message: "Error en el servidor", error: error.message });
  }
});

app.get("/api/queue/status", async (req, res) => {
  try {
    const status = await storage.getQueueStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ message: "Error en el servidor" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

server.listen(3000, () => {
  console.log("Servidor conectado a MySQL InfinityFree en puerto 3000");
});
