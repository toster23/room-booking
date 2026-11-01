import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { db, add, kristinaId } from "./db.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d|2[0-3]):[0-5]\d$/;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res: ServerResponse, status: number, data?: unknown): void {
  if (data === undefined) { res.writeHead(status, CORS_HEADERS); res.end(); return; }
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

// Обезличивание ФИО согласно Закону РБ № 99-З
function anonymizeName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return "Аноним";
  const knownManagers = ["кристина", "анастасия", "виктория"];
  const matched = knownManagers.find(m => parts.some(p => p.toLowerCase() === m));
  if (matched) return matched.charAt(0).toUpperCase() + matched.slice(1);
  if (parts.length >= 2) {
    return `${parts[1]} ${parts[0].substring(0, 1)}.`;
  }
  return parts[0];
}

function getWeekday(date: string): number {
  const day = new Date(date + "T00:00:00").getDay();
  return day === 0 ? 7 : day;
}

function whyBusy(roomId: number, date: string, start: string, end: string): string | null {
  const lesson = db.prepare(`
    SELECT title FROM schedule_slots
    WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time
  `).get(roomId, getWeekday(date), start, end) as { title: string } | undefined;
  if (lesson) return `занятие «${lesson.title}»`;

  const booking = db.prepare(`
    SELECT purpose FROM bookings
    WHERE room_id = ? AND date = ? AND ? < end_time AND ? > start_time
  `).get(roomId, date, start, end) as { purpose: string } | undefined;
  if (booking) return `бронь «${booking.purpose}»`;

  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") return send(res, 204);

    if (method === "GET" && path === "/api/sites") {
      return send(res, 200, db.prepare("SELECT * FROM sites").all());
    }

    if (method === "GET" && path === "/api/bookings") {
      const date = url.searchParams.get("date");
      const siteId = url.searchParams.get("siteId");
      let query = `
        SELECT bookings.id, bookings.start_time AS start, bookings.end_time AS end, 
               bookings.purpose AS name, bookings.date, rooms.site_id AS siteId
        FROM bookings JOIN rooms ON rooms.id = bookings.room_id WHERE 1=1
      `;
      const params: (string | number)[] = [];
      if (date) { query += " AND bookings.date = ?"; params.push(date); }
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY bookings.start_time ASC").all(...params));
    }

    if (method === "POST" && path === "/api/bookings") {
      const data: any = await readJson(req).catch(() => null);
      if (!data) return send(res, 400, { error: "Некорректный JSON" });
      const { siteId, date, start, end, name } = data;
      if (!siteId || !date || !start || !end || !name) return send(res, 422, { error: "Все поля обязательны" });
      if (!DATE_RE.test(date) || !TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) return send(res, 422, { error: "Неверные данные" });

      const rooms = db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(siteId) as { id: number }[];
      let freeRoomId: number | null = null;
      let reason: string | null = null;

      for (const r of rooms) {
        reason = whyBusy(r.id, date, start, end);
        if (!reason) { freeRoomId = r.id; break; }
      }
      if (!freeRoomId) return send(res, 409, { error: `Все аудитории заняты: ${reason}` });

      add(`INSERT INTO bookings (room_id, manager_id, date, start_time, end_time, purpose) VALUES (?, ?, ?, ?, ?, ?)`, 
          freeRoomId, kristinaId, date, start, end, anonymizeName(name));
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/bookings/")) {
      db.prepare("DELETE FROM bookings WHERE id = ?").run(Number(path.split("/").pop()));
      return send(res, 204);
    }

    if (method === "GET" && path === "/api/schedule") {
      const siteId = url.searchParams.get("siteId");
      let query = `SELECT schedule_slots.id, schedule_slots.start_time AS start, schedule_slots.end_time AS end, 
                   schedule_slots.title AS name, schedule_slots.weekday AS day, rooms.site_id AS siteId
                   FROM schedule_slots JOIN rooms ON rooms.id = schedule_slots.room_id WHERE 1=1`;
      const params: number[] = [];
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY schedule_slots.weekday ASC, schedule_slots.start_time ASC").all(...params));
    }

    if (method === "POST" && path === "/api/schedule") {
      const data: any = await readJson(req).catch(() => null);
      if (!data) return send(res, 400, { error: "Некорректный JSON" });
      const { siteId, day, start, end, name } = data;
      if (!siteId || day === undefined || !start || !end || !name) return send(res, 422, { error: "Все поля обязательны" });

      const rooms = db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(siteId) as { id: number }[];
      let freeRoomId: number | null = null;
      for (const r of rooms) {
        const busy = db.prepare(`SELECT id FROM schedule_slots WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time`).get(r.id, day, start, end);
        if (!busy) { freeRoomId = r.id; break; }
      }
      if (!freeRoomId) return send(res, 409, { error: "Все аудитории филиала на это время заняты" });

      add(`INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, 1, ?, ?, ?, ?)`,
          freeRoomId, day, start, end, anonymizeName(name));
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/schedule/")) {
      db.prepare("DELETE FROM schedule_slots WHERE id = ?").run(Number(path.split("/").pop()));
      return send(res, 204);
    }
    send(res, 404, { error: "Not found" });
  } catch (err) { send(res, 500, { error: "Внутренняя ошибка" }); }
});

server.listen(3000, () => {
	console.log("==================================================");
	console.log("🚀 Бэкенд iTeen Academy успешно запущен!");
	console.log("🔗 Ссылка для проверки: http://171.22.30");
	console.log("==================================================");
});

