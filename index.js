import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { mysqlTable, varchar, text, int, datetime, boolean } from "drizzle-orm/mysql-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

const DB_HOST = "sql105.infinityfree.com";
const DB_USER = "if0_39567764";
const DB_PASS = "kquuBq7mlrCYaGL";
const DB_NAME = "if0_39567764_queue_app";
const DB_PORT = 3306;

const pool = mysql.createPool({
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
  createdAt: datetime("created_at").default(sql`CURRENT_TIMESTAMP`),
  startedAt: datetime("started_at"),
  expiresAt: datetime("expires_at")
});

const db = drizzle(pool);

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

class DatabaseStorage {
  async addToQueue(entry) {
    const position = await this.getNextPosition();
    const id = uuidv4();
    await db.insert(queueEntries).values({
      id,
      ...entry,
      position,
      isActive: false,
      isCompleted: false
    });
    const activeEntry = await this.getActiveEntry();
    if (!activeEntry) {
      await this.activateEntry(id);
    }
    return id;
  }

  async getActiveEntry() {
    const [entry] = await db.select().from(queueEntries)
      .where(queueEntries.isActive.equals(true).and(queueEntries.isCompleted.equals(false)));
    return entry || undefined;
  }

  async getQueueStatus() {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM queue_entries WHERE is_completed = false");
    return { totalInQueue: rows[0].total };
  }

  async getNextPosition() {
    const [rows] = await pool.query("SELECT IFNULL(MAX(position), 0) AS maxPosition FROM queue_entries");
    return (rows[0].maxPosition || 0) + 1;
  }

  async activateEntry(id) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    await db.update(queueEntries)
      .set({ isActive: true, startedAt: now, expiresAt })
      .where(queueEntries.id.equals(id));
  }

  async completeActiveEntry() {
    const activeEntry = await this.getActiveEntry();
    if (!activeEntry) return null;

    await db.update(queueEntries)
      .set({ isActive: false, isCompleted: true })
      .where(queueEntries.id.equals(activeEntry.id));

    const nextEntries = await db.select()
      .from(queueEntries)
      .where(
        queueEntries.isCompleted.equals(false).and(
          queueEntries.position.gt(activeEntry.position)
        )
      )
      .orderBy(queueEntries.position, 'asc')
      .limit(1)
      .all();

    const nextEntry = nextEntries[0];

    if (nextEntry) {
      await this.activateEntry(nextEntry.id);
      return nextEntry;
    }

    return null;
  }
}

const storage = new DatabaseStorage();

const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: "*" }));
app.use(express.json());

app.post("/api/queue/add", async (req, res) => {
  try {
    const clientIP = req.ip;
    const validatedData = insertQueueEntrySchema.parse(req.body);
    const id = await storage.addToQueue({ ...validatedData, ipAddress: clientIP });
    res.json({ message: "Te has unido a la cola exitosamente", id });
    broadcastQueueUpdate();
  } catch (error) {
    res.status(400).json({ message: "Error en el servidor", error: error.message });
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

app.post("/api/queue/rotate", async (req, res) => {
  try {
    const nextEntry = await storage.completeActiveEntry();
    if (nextEntry) {
      res.json({ message: "Turno rotado", next: nextEntry });
    } else {
      res.json({ message: "No hay más turnos" });
    }
    broadcastQueueUpdate();
  } catch (error) {
    res.status(500).json({ message: "Error en el servidor" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcastQueueUpdate() {
  storage.getActiveEntry().then(active => {
    const data = JSON.stringify({ active });
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(data);
      }
    });
  });
}

wss.on("connection", (ws) => {
  console.log("Cliente WS conectado");
  storage.getActiveEntry().then(active => {
    ws.send(JSON.stringify({ active }));
  });

  ws.on("message", (message) => {
    console.log("Mensaje recibido por WS:", message);
  });

  ws.on("close", () => {
    console.log("Cliente WS desconectado");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
