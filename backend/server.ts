import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length) process.env[k.trim()] = v.join("=").trim();
  }
}
const JWT_SECRET = process.env.JWT_SECRET || "fallback_dev_secret_change_me";

export interface AuthUser {
  id: number;
  full_name: string;
  login: string;
  role: "manager" | "teacher";
  must_change_password: number;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

const DUMMY_HASH = hashPassword("dummy_password_timing_protection");


export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(":");
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = scryptSync(password, salt, 64);
  return timingSafeEqual(keyBuffer, derivedKey);
}

export function createToken(): string {
  const raw = randomBytes(24).toString("hex");
  const sig = createHmac("sha256", JWT_SECRET).update(raw).digest("hex");
  return `${raw}.${sig}`;
}

export function isValidTokenSignature(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [raw, sig] = parts;
  const expectedSig = createHmac("sha256", JWT_SECRET).update(raw).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}


export function getAuthUser(db: DatabaseSync, req: IncomingMessage, res?: ServerResponse): AuthUser | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const row = db.prepare(`
    SELECT users.id, users.full_name, users.login, users.role, users.must_change_password,
           sessions.expires_at, sessions.rotated_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token) as (AuthUser & { expires_at: number; rotated_at: number }) | undefined;

  if (!row) return null;
  const now = Date.now();

  if (now > row.expires_at) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  export function getAuthUser(db: DatabaseSync, req: IncomingMessage, res?: ServerResponse): AuthUser | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  if (!isValidTokenSignature(token)) return null;


  if (now - row.rotated_at >= 60 * 60 * 1000 && res) {
    const newToken = createToken();
    const newExpiresAt = now + 7 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET token = ?, expires_at = ?, rotated_at = ? WHERE token = ?")
      .run(newToken, newExpiresAt, now, token);
    res.setHeader("X-New-Token", newToken);
  }

  return {
    id: row.id,
    full_name: row.full_name,
    login: row.login,
    role: row.role,
    must_change_password: row.must_change_password,
  };
}

const db = new DatabaseSync("booking.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    login TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager', 'teacher')),
    must_change_password INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    rotated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedule_slots (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    teacher_id INTEGER NOT NULL REFERENCES users(id),
    weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    title TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    purpose TEXT NOT NULL
  );
`);

function add(sql: string, ...params: (string | number)[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

const sitesCount = db.prepare("SELECT COUNT(*) as count FROM sites").get() as { count: number };
if (sitesCount.count === 0) {
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

  const defaultPass = hashPassword("123456");
  add("INSERT INTO users (full_name, login, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)", "Кристина", "kristina", defaultPass, "manager");
  add("INSERT INTO users (full_name, login, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)", "Анастасия", "anastasia", defaultPass, "manager");
  add("INSERT INTO users (full_name, login, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)", "Виктория", "viktoria", defaultPass, "manager");

  const teachers: [string, string][] = [
    ["Михаил.А", "mikhail"], ["Наталья.В", "natalia"], ["Андрей.Д", "andrey"],
    ["Артем.Д", "artem"], ["Денис.Л", "denis"], ["Ирина.О", "irina"],
    ["Людмила.Р", "lyudmila"], ["Полина.С", "polina"], ["Владимир.Ч", "vladimir"],
    ["Светлана.Ч", "svetlana_ch"], ["Дарья.Я", "daria"], ["Антон.С", "anton"],
    ["Евгений.П", "evgeniy"], ["Светлана.М", "svetlana_m"]
  ];
  const teacherIds: number[] = [];
  for (const [fullName, login] of teachers) {
    teacherIds.push(add("INSERT INTO users (full_name, login, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)", fullName, login, defaultPass, "teacher"));
  }

  add("INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)", 1, teacherIds[0], 1, "16:00", "17:30", "Python, группа 1 (Михаил.А)");
  add("INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)", 4, teacherIds[4], 4, "17:00", "18:30", "Web, группа 2 (Денис.Л)");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-New-Token",
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

function sanitizeTitle(text: string): string {
  const clean = text.trim();
  const fioMatch = clean.match(/^([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)\s+([А-ЯЁ][а-яё]+)$/);
  if (fioMatch) {
    return `${fioMatch[2]}.${fioMatch[1][0]}`;
  }
  return clean;
}

function getWeekday(date: string): number {
  const day = new Date(date + "T00:00:00").getDay();
  return day === 0 ? 7 : day;
}

function whyBusy(roomId: number, date: string, start: string, end: string): string | null {
  const lesson = db.prepare(
    "SELECT title FROM schedule_slots WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time"
  ).get(roomId, getWeekday(date), start, end) as { title: string } | undefined;
  if (lesson) return `занятие «${lesson.title}»`;

  const booking = db.prepare(
    "SELECT purpose FROM bookings WHERE room_id = ? AND date = ? AND ? < end_time AND ? > start_time"
  ).get(roomId, date, start, end) as { purpose: string } | undefined;
  if (booking) return `бронь «${booking.purpose}»`;

  return null;
}

const loginAttempts = new Map<string, { count: number; blockUntil: number }>();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") return send(res, 204);

        if (method === "POST" && path === "/api/login") {
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
      const rec = loginAttempts.get(ip);
      if (rec && Date.now() < rec.blockUntil) {
        const sec = Math.ceil((rec.blockUntil - Date.now()) / 1000);
        return send(res, 429, { error: `Слишком много попыток входа. Повторите через ${sec} сек.` });
      }
      if (rec && Date.now() >= rec.blockUntil && rec.count >= 5) {
        loginAttempts.delete(ip);
      }

      const data: any = await readJson(req).catch(() => null);
      if (!data?.login || !data?.password) return send(res, 400, { error: "Введите логин и пароль" });

      const user = db.prepare("SELECT * FROM users WHERE login = ?").get(data.login.toLowerCase().trim()) as any;
      const hashToCheck = user ? user.password_hash : DUMMY_HASH;
      const isPasswordValid = verifyPassword(data.password, hashToCheck);

      if (!user || !isPasswordValid) {
        const current = loginAttempts.get(ip) || { count: 0, blockUntil: 0 };
        current.count += 1;
        if (current.count >= 5) current.blockUntil = Date.now() + 5 * 60 * 1000;
        loginAttempts.set(ip, current);
        return send(res, 401, { error: "Неверный логин или пароль" });
      }

      loginAttempts.delete(ip);
      const token = createToken();
      const now = Date.now();
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
      add("INSERT INTO sessions (token, user_id, expires_at, rotated_at) VALUES (?, ?, ?, ?)", token, user.id, expiresAt, now);

      return send(res, 200, {
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          login: user.login,
          role: user.role,
          mustChangePassword: Boolean(user.must_change_password),
        },
      });
    }

      const data: any = await readJson(req).catch(() => null);
      if (!data?.login || !data?.password) return send(res, 400, { error: "Введите логин и пароль" });

      const user = db.prepare("SELECT * FROM users WHERE login = ?").get(data.login.toLowerCase().trim()) as any;
      if (!user || !verifyPassword(data.password, user.password_hash)) {
        const current = loginAttempts.get(ip) || { count: 0, blockUntil: 0 };
        current.count += 1;
        if (current.count >= 5) current.blockUntil = Date.now() + 5 * 60 * 1000;
        loginAttempts.set(ip, current);
        return send(res, 401, { error: "Неверный логин или пароль" });
      }

      loginAttempts.delete(ip);
      const token = createToken();
      const now = Date.now();
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
      add("INSERT INTO sessions (token, user_id, expires_at, rotated_at) VALUES (?, ?, ?, ?)", token, user.id, expiresAt, now);

      return send(res, 200, {
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          login: user.login,
          role: user.role,
          mustChangePassword: Boolean(user.must_change_password),
        },
      });
    }

    if (method === "GET" && path === "/api/me") {
      const user = getAuthUser(db, req, res);
      if (!user) return send(res, 401, { error: "Не авторизован" });
      return send(res, 200, {
        id: user.id,
        fullName: user.full_name,
        login: user.login,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
      });
    }

    if (method === "POST" && path === "/api/change-password") {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });

      const data: any = await readJson(req).catch(() => null);
      const newPassword = String(data?.newPassword ?? "").trim();
      if (newPassword.length < 8 || !/[a-zA-Zа-яА-ЯёЁ]/.test(newPassword) || !/\d/.test(newPassword)) {
        return send(res, 422, { error: "Пароль должен быть от 8 символов и содержать буквы и цифры" });
      }
      if (newPassword === "123456" || newPassword === "12345678") {
        return send(res, 422, { error: "Придумайте более надёжный пароль, отличный от стандартного" });
      }

      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
        .run(hashPassword(newPassword), authUser.id);
      return send(res, 200, { success: true });
    }

    if (method === "POST" && path === "/api/logout") {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        db.prepare("DELETE FROM sessions WHERE token = ?").run(authHeader.slice(7));
      }
      return send(res, 204);
    }

    // === УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ И РОЛЯМИ (ТОЛЬКО МЕНЕДЖЕР) ===
    if (method === "GET" && path === "/api/users") {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });
      if (authUser.role !== "manager") return send(res, 403, { error: "Менять роли могут только менеджеры" });

      const users = db.prepare("SELECT id, full_name AS fullName, login, role FROM users ORDER BY role ASC, full_name ASC").all();
      return send(res, 200, users);
    }

    if (method === "POST" && path === "/api/users") {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });
      if (authUser.role !== "manager") return send(res, 403, { error: "Создавать пользователей могут только менеджеры" });

      const data: any = await readJson(req).catch(() => null);
      const fullName = sanitizeTitle(String(data?.fullName ?? ""));
      const login = String(data?.login ?? "").toLowerCase().trim();
      const password = String(data?.password ?? "").trim() || "123456";
      const role = data?.role === "manager" ? "manager" : "teacher";

      if (!fullName || !login) return send(res, 422, { error: "Укажите имя и логин" });
      if (db.prepare("SELECT id FROM users WHERE login = ?").get(login)) {
        return send(res, 409, { error: "Пользователь с таким логином уже существует" });
      }

      const id = add(
        "INSERT INTO users (full_name, login, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)",
        fullName, login, hashPassword(password), role
      );
      return send(res, 201, { id, fullName, login, role });
    }

    if (method === "PATCH" && path.startsWith("/api/users/") && path.endsWith("/role")) {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });
      if (authUser.role !== "manager") return send(res, 403, { error: "Менять роли могут только менеджеры" });

      const targetId = Number(path.split("/")[3]);
      if (targetId === authUser.id) return send(res, 400, { error: "Нельзя изменить роль самому себе" });

      const data: any = await readJson(req).catch(() => null);
      const newRole = data?.role === "manager" ? "manager" : data?.role === "teacher" ? "teacher" : null;
      if (!newRole) return send(res, 422, { error: "Некорректная роль" });

      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(newRole, targetId);
      return send(res, 200, { success: true });
    }
    // === ПРОСМОТР КАБИНЕТОВ И БРОНЕЙ (ДОСТУПНО ВСЕМ, ВКЛЮЧАЯ ГОСТЯ) ===
    if (method === "GET" && path === "/api/sites") {
      return send(res, 200, db.prepare("SELECT * FROM sites").all());
    }

    if (method === "GET" && path === "/api/rooms") {
      return send(res, 200, db.prepare("SELECT * FROM rooms ORDER BY id ASC").all());
    }

    if (method === "GET" && path === "/api/bookings") {
      const date = url.searchParams.get("date");
      const siteId = url.searchParams.get("siteId");
      let query = "SELECT bookings.id, bookings.user_id AS userId, bookings.start_time AS start, bookings.end_time AS end, bookings.purpose AS name, bookings.date, rooms.site_id AS siteId, rooms.name AS roomName FROM bookings JOIN rooms ON rooms.id = bookings.room_id WHERE 1=1";
      const params: (string | number)[] = [];
      if (date) { query += " AND bookings.date = ?"; params.push(date); }
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY bookings.date ASC, bookings.start_time ASC").all(...params));
    }

    // === СОЗДАНИЕ И УДАЛЕНИЕ БРОНЕЙ ===
    if (method === "POST" && path === "/api/bookings") {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Войдите в систему, чтобы создать бронь" });

      const data: any = await readJson(req).catch(() => null);
      if (!data) return send(res, 400, { error: "Некорректный JSON" });
      const { siteId, roomId, date, start, end, name } = data;
      if (!siteId || !date || !start || !end || !name) return send(res, 422, { error: "Все поля обязательны" });
      if (!DATE_RE.test(date) || !TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) return send(res, 422, { error: "Неверный формат даты или времени" });

      const rooms = roomId
        ? (db.prepare("SELECT id FROM rooms WHERE id = ? AND site_id = ?").all(Number(roomId), Number(siteId)) as { id: number }[])
        : (db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(Number(siteId)) as { id: number }[]);

      let freeRoomId: number | null = null;
      let reason: string | null = null;
      for (const r of rooms) {
        reason = whyBusy(r.id, date, start, end);
        if (!reason) { freeRoomId = r.id; break; }
      }
      if (!freeRoomId) return send(res, 409, { error: roomId ? `Выбранный кабинет занят: ${reason}` : `Все аудитории заняты: ${reason}` });

      add(
        "INSERT INTO bookings (room_id, user_id, date, start_time, end_time, purpose) VALUES (?, ?, ?, ?, ?, ?)",
        freeRoomId, authUser.id, date, start, end, sanitizeTitle(name)
      );
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/bookings/")) {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });

      const id = Number(path.split("/").pop());
      const row = db.prepare("SELECT user_id FROM bookings WHERE id = ?").get(id) as { user_id: number } | undefined;
      if (!row) return send(res, 404, { error: "Бронь не найдена" });
      if (authUser.role !== "manager" && row.user_id !== authUser.id) {
        return send(res, 403, { error: "Запрещено! Вы можете отменить только свою бронь" });
      }

      db.prepare("DELETE FROM bookings WHERE id = ?").run(id);
      return send(res, 204);
    }

    // === НЕДЕЛЬНОЕ РАСПИСАНИЕ ===
    if (method === "GET" && path === "/api/schedule") {
      const siteId = url.searchParams.get("siteId");
      let query = "SELECT schedule_slots.id, schedule_slots.start_time AS start, schedule_slots.end_time AS end, schedule_slots.title AS name, schedule_slots.weekday AS day, rooms.site_id AS siteId, rooms.name AS roomName FROM schedule_slots JOIN rooms ON rooms.id = schedule_slots.room_id WHERE 1=1";
      const params: number[] = [];
      if (siteId) { query += " AND rooms.site_id = ?"; params.push(Number(siteId)); }
      return send(res, 200, db.prepare(query + " ORDER BY schedule_slots.weekday ASC, schedule_slots.start_time ASC").all(...params));
    }

    if (method === "POST" && path === "/api/schedule") {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });
      if (authUser.role !== "manager") return send(res, 403, { error: "Запрещено! Только менеджер меняет сетку" });

      const data: any = await readJson(req).catch(() => null);
      if (!data) return send(res, 400, { error: "Некорректный JSON" });
      const { siteId, roomId, day, start, end, name } = data;
      if (!siteId || day === undefined || !start || !end || !name) return send(res, 422, { error: "Все поля обязательны" });
      if (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) return send(res, 422, { error: "Неверное время" });

      const rooms = roomId
        ? (db.prepare("SELECT id FROM rooms WHERE id = ? AND site_id = ?").all(Number(roomId), Number(siteId)) as { id: number }[])
        : (db.prepare("SELECT id FROM rooms WHERE site_id = ?").all(Number(siteId)) as { id: number }[]);

      let freeRoomId: number | null = null;
      for (const r of rooms) {
        const busy = db.prepare("SELECT id FROM schedule_slots WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time").get(r.id, day, start, end);
        if (!busy) { freeRoomId = r.id; break; }
      }
      if (!freeRoomId) return send(res, 409, { error: roomId ? "Выбранный кабинет на это время занят" : "Все аудитории филиала заняты" });

      add(
        "INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)",
        freeRoomId, authUser.id, day, start, end, sanitizeTitle(name)
      );
      return send(res, 201, { success: true });
    }

    if (method === "DELETE" && path.startsWith("/api/schedule/")) {
      const authUser = getAuthUser(db, req, res);
      if (!authUser) return send(res, 401, { error: "Требуется авторизация" });
      if (authUser.role !== "manager") return send(res, 403, { error: "Запрещено! Только менеджер удаляет из сетки" });

      db.prepare("DELETE FROM schedule_slots WHERE id = ?").run(Number(path.split("/").pop()));
      return send(res, 204);
    }

    // Отдача фронтенда с сервера
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      let html: string | null = null;
      for (const p of [join(process.cwd(), "frontend", "index.html"), join(process.cwd(), "..", "frontend", "index.html")]) {
        try { html = readFileSync(p, "utf-8"); break; } catch {}
      }
      if (!html) return send(res, 404, { error: "Файл index.html не найден" });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: "Внутренняя ошибка сервера" });
  }
});

server.listen(3000, () => {
  console.log("🚀 Бэкенд iTeen Academy запущен: http://171.22.30.57:3000");
});
