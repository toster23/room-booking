import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

// ===== 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ SQLite И ТАБЛИЦЫ =====
const db = new DatabaseSync("booking.db");

db.exec(`
  DROP TABLE IF EXISTS bookings;
  DROP TABLE IF EXISTS schedule_slots;
  DROP TABLE IF EXISTS managers;
  DROP TABLE IF EXISTS teachers;
  DROP TABLE IF EXISTS rooms;
  DROP TABLE IF EXISTS sites;

  CREATE TABLE sites (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE rooms (
    id      INTEGER PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id),
    name    TEXT NOT NULL
  );
  CREATE TABLE teachers (
    id        INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL
  );
  CREATE TABLE managers (
    id        INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL
  );
  CREATE TABLE schedule_slots (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL REFERENCES rooms(id),
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    weekday    INTEGER NOT NULL,         
    start_time TEXT NOT NULL,            
    end_time   TEXT NOT NULL,
    title      TEXT NOT NULL
  );
  CREATE TABLE bookings (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL REFERENCES rooms(id),
    manager_id INTEGER NOT NULL REFERENCES managers(id),
    date       TEXT NOT NULL,            
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    purpose    TEXT NOT NULL
  );
`);

function add(sql: string, ...params: (string | number)[]): number {
	const result = db.prepare(sql).run(...params);
	return Number(result.lastInsertRowid);
}

// ===== 2. НАПОЛНЕНИЕ ДАННЫМИ (Филиалы, Аудитории, Штат) =====
const ledovy = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Ледовый»");
const rechitsky = add(
	"INSERT INTO sites (name) VALUES (?)",
	"Филиал «Речицкий»",
);
const aerodrom = add(
	"INSERT INTO sites (name) VALUES (?)",
	"Филиал «Старый Аэродром»",
);

const roomSetup: [number, string][] = [
	[ledovy, "Кабинет 101"],
	[ledovy, "Кабинет 102"],
	[ledovy, "Кабинет 103"],
	[rechitsky, "Кабинет 201"],
	[rechitsky, "Кабинет 202"],
	[rechitsky, "Кабинет 203"],
	[rechitsky, "Кабинет 204"],
	[rechitsky, "Кабинет 205"],
	[aerodrom, "Кабинет 301"],
	[aerodrom, "Кабинет 302"],
];
for (const [siteId, name] of roomSetup) {
	add("INSERT INTO rooms (site_id, name) VALUES (?, ?)", siteId, name);
}

// Менеджеры
const kristinaId = add(
	"INSERT INTO managers (full_name) VALUES (?)",
	"Кристина",
);
add("INSERT INTO managers (full_name) VALUES (?)", "Анастасия");
add("INSERT INTO managers (full_name) VALUES (?)", "Виктория");

// Преподаватели (Обезличено согласно Закону РБ № 99-З)
const t1 = add("INSERT INTO teachers (full_name) VALUES (?)", "Михаил А.");
const t2 = add("INSERT INTO teachers (full_name) VALUES (?)", "Наталья В.");
const t3 = add("INSERT INTO teachers (full_name) VALUES (?)", "Андрей Д.");
const t4 = add("INSERT INTO teachers (full_name) VALUES (?)", "Артём Д.");
const t5 = add("INSERT INTO teachers (full_name) VALUES (?)", "Денис Л.");
const t6 = add("INSERT INTO teachers (full_name) VALUES (?)", "Ирина О.");
const t7 = add("INSERT INTO teachers (full_name) VALUES (?)", "Людмила Р.");
const t8 = add("INSERT INTO teachers (full_name) VALUES (?)", "Полина С.");
const t9 = add("INSERT INTO teachers (full_name) VALUES (?)", "Владимир Ч.");
const t10 = add("INSERT INTO teachers (full_name) VALUES (?)", "Светлана Ч.");
const t11 = add("INSERT INTO teachers (full_name) VALUES (?)", "Дарья Я.");
const t12 = add("INSERT INTO teachers (full_name) VALUES (?)", "Антон С.");
const t13 = add("INSERT INTO teachers (full_name) VALUES (?)", "Евгений П.");

// Тестовое расписание
add(
	"INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)",
	1,
	t1,
	1,
	"16:00",
	"17:30",
	"Python, группа 1",
);
add(
	"INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)",
	4,
	t5,
	4,
	"17:00",
	"18:30",
	"Web, группа 2",
);

// ===== 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И БЕЗОПАСНОСТЬ =====
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const teacherFlags = [
	"михаил",
	"наталья",
	"андрей",
	"артём",
	"денис",
	"ирина",
	"людмила",
	"полина",
	"владимир",
	"светлана",
	"дарья",
	"антон",
	"евгений",
	"анна п.",
	"игорь с.",
];

function send(res: ServerResponse, status: number, data?: unknown): void {
	if (data === undefined) {
		res.writeHead(status, CORS_HEADERS);
		res.end();
		return;
	}
	res.writeHead(status, {
		...CORS_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function anonymizeName(fullName: string): string {
	const parts = fullName.trim().split(/\s+/);
	if (parts.length === 0 || parts[0] === "") return "Аноним";
	const knownManagers = ["кристина", "анастасия", "виктория"];
	const matched = knownManagers.find(m =>
		parts.some(p => p.toLowerCase() === m),
	);
	if (matched) return matched.charAt(0).toUpperCase() + matched.slice(1);

	if (parts.length >= 2) {
		const lastName = parts[0];
		const firstName = parts[1];
		return `${firstName} ${lastName.substring(0, 1)}.`;
	}
	return parts[0];
}

function getWeekday(date: string): number {
	const day = new Date(date + "T00:00:00").getDay();
	return day === 0 ? 7 : day;
}

function whyBusy(
	roomId: number,
	date: string,
	start: string,
	end: string,
): string | null {
	const lesson = db
		.prepare(
			`
    SELECT title FROM schedule_slots
    WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time
  `,
		)
		.get(roomId, getWeekday(date), start, end) as { title: string } | undefined;
	if (lesson) return `занятие «${lesson.title}»`;

	const booking = db
		.prepare(
			`
    SELECT purpose FROM bookings
    WHERE room_id = ? AND date = ? AND ? < end_time AND ? > start_time
  `,
		)
		.get(roomId, date, start, end) as { purpose: string } | undefined;
	if (booking) return `бронь «${booking.purpose}»`;

	return null;
}
// ===== 4. МАРШРУТИЗАЦИЯ HTTP-СЕРВЕРА =====
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (method === "OPTIONS") return send(res, 204);

		// Справочники: Площадки, Менеджеры и Преподаватели из БД
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
               bookings.purpose AS name, bookings.date, rooms.site_id AS siteId
        FROM bookings JOIN rooms ON rooms.id = bookings.room_id WHERE 1=1
      `;
			const params: (string | number)[] = [];
			if (date) {
				query += " AND bookings.date = ?";
				params.push(date);
			}
			if (siteId) {
				query += " AND rooms.site_id = ?";
				params.push(Number(siteId));
			}
			return send(
				res,
				200,
				db.prepare(query + " ORDER BY bookings.start_time ASC").all(...params),
			);
		}

		if (method === "POST" && path === "/api/bookings") {
			const data: any = await readJson(req).catch(() => null);
			if (!data) return send(res, 400, { error: "Некорректный JSON" });
			const { siteId, date, start, end, name } = data;
			if (!siteId || !date || !start || !end || !name)
				return send(res, 422, { error: "Все поля обязательны" });
			if (
				!DATE_RE.test(date) ||
				!TIME_RE.test(start) ||
				!TIME_RE.test(end) ||
				end <= start
			)
				return send(res, 422, { error: "Неверные данные" });

			const rooms = db
				.prepare("SELECT id FROM rooms WHERE site_id = ?")
				.all(siteId) as { id: number }[];
			let freeRoomId: number | null = null;
			let reason: string | null = null;

			for (const r of rooms) {
				reason = whyBusy(r.id, date, start, end);
				if (!reason) {
					freeRoomId = r.id;
					break;
				}
			}
			if (!freeRoomId)
				return send(res, 409, { error: `Все аудитории заняты: ${reason}` });

			add(
				"INSERT INTO bookings (room_id, manager_id, date, start_time, end_time, purpose) VALUES (?, ?, ?, ?, ?, ?)",
				freeRoomId,
				kristinaId,
				date,
				start,
				end,
				anonymizeName(name),
			);
			return send(res, 201, { success: true });
		}

		if (method === "DELETE" && path.startsWith("/api/bookings/")) {
			db.prepare("DELETE FROM bookings WHERE id = ?").run(
				Number(path.split("/").pop()),
			);
			return send(res, 204);
		}

		// === НЕДЕЛЬНОЕ РАСПИСАНИЕ ===
		if (method === "GET" && path === "/api/schedule") {
			const siteId = url.searchParams.get("siteId");
			let query = `
        SELECT schedule_slots.id, schedule_slots.start_time AS start, schedule_slots.end_time AS end, 
               schedule_slots.title AS name, schedule_slots.weekday AS day, rooms.site_id AS siteId
        FROM schedule_slots JOIN rooms ON rooms.id = schedule_slots.room_id WHERE 1=1
      `;
			const params: number[] = [];
			if (siteId) {
				query += " AND rooms.site_id = ?";
				params.push(Number(siteId));
			}
			return send(
				res,
				200,
				db
					.prepare(
						query +
							" ORDER BY schedule_slots.weekday ASC, schedule_slots.start_time ASC",
					)
					.all(...params),
			);
		}

		if (method === "POST" && path === "/api/schedule") {
			const data: any = await readJson(req).catch(() => null);
			if (!data) return send(res, 400, { error: "Некорректный JSON" });
			const { siteId, day, start, end, name } = data;
			if (!siteId || day === undefined || !start || !end || !name)
				return send(res, 422, { error: "Все поля обязательны" });

			const lowerName = name.toLowerCase().trim();
			const isTeacher = teacherFlags.some(t => lowerName.includes(t));
			if (isTeacher) {
				return send(res, 403, {
					error:
						"Запрещено! Недельное расписание могут редактировать только менеджеры",
				});
			}

			const rooms = db
				.prepare("SELECT id FROM rooms WHERE site_id = ?")
				.all(siteId) as { id: number }[];
			let freeRoomId: number | null = null;
			for (const r of rooms) {
				const busy = db
					.prepare(
						"SELECT id FROM schedule_slots WHERE room_id = ? AND weekday = ? AND ? < end_time AND ? > start_time",
					)
					.get(r.id, day, start, end);
				if (!freeRoomId && !busy) {
					freeRoomId = r.id;
					break;
				}
			}
			if (!freeRoomId)
				return send(res, 409, {
					error: "Все аудитории филиала на это время заняты",
				});

			add(
				"INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, 1, ?, ?, ?, ?)",
				freeRoomId,
				day,
				start,
				end,
				anonymizeName(name),
			);
			return send(res, 201, { success: true });
		}

		if (method === "DELETE" && path.startsWith("/api/schedule/")) {
			db.prepare("DELETE FROM schedule_slots WHERE id = ?").run(
				Number(path.split("/").pop()),
			);
			return send(res, 204);
		}
		send(res, 404, { error: "Not found" });
	} catch (err) {
		send(res, 500, { error: "Внутренняя ошибка сервера" });
	}
});


// Запуск сервера с выводом прямого адреса
server.listen(3000, () => {});
