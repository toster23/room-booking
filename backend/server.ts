import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("booking.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS managers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS schedule_slots (
    id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id),
    teacher_id INTEGER NOT NULL REFERENCES teachers(id), weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL, end_time TEXT NOT NULL, title TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id),
    manager_id INTEGER NOT NULL REFERENCES managers(id), date TEXT NOT NULL,
    start_time TEXT NOT NULL, end_time TEXT NOT NULL, purpose TEXT NOT NULL
  );
`);

function add(sql: string, ...params: (string | number)[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

// Первичное наполнение БД (только если база пустая)
const siteCount = (db.prepare("SELECT COUNT(*) as c FROM sites").get() as { c: number }).c;
if (siteCount === 0) {
  const ledovy = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Ледовый»");
  const rechitsky = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Речицкий»");
  const aerodrom = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Старый Аэродром»");

  const roomSetup: [number, string][] = [
    [ledovy, "Кабинет 101"], [ledovy, "Кабинет 102"], [ledovy, "Кабинет 103"],
    [rechitsky, "Кабинет 201"], [rechitsky, "Кабинет 202"], [rechitsky, "Кабинет 203"], [rechitsky, "Кабинет 204"], [rechitsky, "Кабинет 205"],
    [aerodrom, "Кабинет 301"], [aerodrom, "Кабинет 302"]
  ];
  for (const [siteId, name] of roomSetup) {
    add("INSERT INTO rooms (site_id, name) VALUES (?, ?)", siteId, name);
  }

  add("INSERT INTO managers (full_name) VALUES (?)", "Кристина");
  add("INSERT INTO managers (full_name) VALUES (?)", "Анастасия");
  add("INSERT INTO managers (full_name) VALUES (?)", "Виктория");

  // Обезличенный список преподавателей строго в формате Имя.Б (Закон РБ № 99-З)
  const teachersList = [
    "Михаил.А", "Наталья.В", "Андрей.Д", "Артем.Д",
    "Денис.Л", "Ирина.О", "Людмила.Р", "Полина.С",
    "Владимир.Ч", "Светлана.Ч", "Дарья.Я", "Антон.С",
    "Евгений.П", "Светлана.М"
  ];
  for (const t of teachersList) {
    add("INSERT INTO teachers (full_name) VALUES (?)", t);
  }

  add("INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)", 1, 1, 1, "16:00", "17:30", "Python, группа 1 (Михаил.А)");
  add("INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)", 4, 5, 4, "17:00", "18:30", "Web, группа 2 (Денис.Л)");
}

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

// Защита от случайного ввода полного ФИО: Иванов Иван Иванович -> Иван.И
function sanitizeTitle(text: string): string {
  const clean = text.trim();
  const fioMatch = clean.match(/^([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)$/);
  if (fioMatch) {
    return `${fioMatch}.${fioMatch}`;
  }
  return clean;
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
    if (method === "GET" && path === "/api/managers") {
      return send(res, 200, db.prepare("SELECT * FROM managers").all());
    }
    if (method === "GET" && path === "/api/teachers") {
      return send(res, 200, db.prepare("SELECT * FROM teachers").all());
    }

    // === РАЗОВЫЕ БРОНИ ===
    if (method === "GET" && path === "/api/bookings") {
      const date = url.searchParams.get("date");
      const siteId = url.searchParams.get("siteId");
      let query = `
        SELECT bookings.id, bookings.start_time AS start, bookings.end_time AS end,
               bookings.purpose AS name, bookings.date, rooms.site_id AS siteId, rooms.name AS roomName
        FROM bookings JOIN rooms ON rooms.id = bookings.room_id WHERE 1=1
      `;
      const params: (string | number)[] = [];
      if (date) { query += " AND bookings.date = ?"; params.push(date); }
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY bookings.date ASC, bookings.start_time ASC").all(...params));
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

      add(
        "INSERT INTO bookings (room_id, manager_id, date, start_time, end_time, purpose) VALUES (?, 1, ?, ?, ?, ?)",
        freeRoomId, date, start, end, sanitizeTitle(name)
      );
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/bookings/")) {
      db.prepare("DELETE FROM bookings WHERE id = ?").run(Number(path.split("/").pop()));
      return send(res, 204);
    }

    // === НЕДЕЛЬНОЕ РАСПИСАНИЕ ===
    if (method === "GET" && path === "/api/schedule") {
      const siteId = url.searchParams.get("siteId");
      let query = `
        SELECT schedule_slots.id, schedule_slots.start_time AS start, schedule_slots.end_time AS end,
               schedule_slots.title AS name, schedule_slots.weekday AS day, rooms.site_id AS siteId, rooms.name AS roomName
        FROM schedule_slots JOIN rooms ON rooms.id = schedule_slots.room_id WHERE 1=1
      `;
      const params: number[] = [];
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY schedule_slots.weekday ASC, schedule_slots.start_time ASC").all(...params));
    }

    if (method === "POST" && path === "/api/schedule") {
      const data: any = await readJson(req).catch(() => null);
      if (!data) return send(res, 400, { error: "Некорректный JSON" });
      const { siteId, day, start, end, name, role } = data;
      if (!siteId || day === undefined || !start || !end || !name) return send(res, 422, { error: "Все поля обязательны" });

      if (role === "teacher") {
        return send(res, 403, { error: "Запрещено! Недельное расписание могут редактировать только менеджеры" });
      }

      const rooms = db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(siteId) as { id: number }[];
      let freeRoomId: number | null = null;
      for (const r of rooms) {
        const busy = db.prepare("SELECT id FROM schedule_slots WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time").get(r.id, day, start, end);
        if (!busy) { freeRoomId = r.id; break; }
      }
      if (!freeRoomId) return send(res, 409, { error: "Все аудитории филиала на это время заняты" });

      add(
        "INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, 1, ?, ?, ?, ?)",
        freeRoomId, day, start, end, sanitizeTitle(name)
      );
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/schedule/")) {
      db.prepare("DELETE FROM schedule_slots WHERE id = ?").run(Number(path.split("/").pop()));
      return send(res, 204);
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: "Внутренняя ошибка сервера" });
  }
});

server.listen(3000, () => {
  console.log("🚀 Бэкенд iTeen Academy запущен: http://171.22.30");
});
