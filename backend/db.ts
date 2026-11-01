import { DatabaseSync } from "node:sqlite";

// ===== 1. ПОДКЛЮЧЕНИЕ К БАЗЕ И СОЗДАНИЕ ТАБЛИЦ =====
export const db = new DatabaseSync("booking.db");

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

export function add(sql: string, ...params: (string | number)[]): number {
  const result = db.prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}

// ===== 2. НАПОЛНЕНИЕ НАЧАЛЬНЫМИ ДАННЫМИ iTEEN =====

// 3 площадки в Гомеле
const ledovy = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Ледовый»");
const rechitsky = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Речицкий»");
const aerodrom = add("INSERT INTO sites (name) VALUES (?)", "Филиал «Старый Аэродром»");

// Распределение аудиторий: 3 на Ледовом, 5 на Речицком, 2 на Старом Аэродроме
const roomSetup: [number, string][] = [
  [ledovy, "Кабинет 101"], [ledovy, "Кабинет 102"], [ledovy, "Кабинет 103"],
  [rechitsky, "Кабинет 201"], [rechitsky, "Кабинет 202"], [rechitsky, "Кабинет 203"], [rechitsky, "Кабинет 204"], [rechitsky, "Кабинет 205"],
  [aerodrom, "Кабинет 301"], [aerodrom, "Кабинет 302"]
];
for (const [siteId, name] of roomSetup) {
  add("INSERT INTO rooms (site_id, name) VALUES (?, ?)", siteId, name);
}

// Учителя (Обезличенные имена)
const petrova = add("INSERT INTO teachers (full_name) VALUES (?)", "Анна П.");
const smirnov = add("INSERT INTO teachers (full_name) VALUES (?)", "Игорь С.");

// Ваши менеджеры (Сохраняем ID Кристины как дефолтный)
export const kristinaId = add("INSERT INTO managers (full_name) VALUES (?)", "Кристина");
add("INSERT INTO managers (full_name) VALUES (?)", "Анастасия");
add("INSERT INTO managers (full_name) VALUES (?)", "Виктория");

// Базовая заполненность сетки
add(`INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)`, 1, petrova, 1, "16:00", "17:30", "Python, группа 1");
add(`INSERT INTO schedule_slots (room_id, teacher_id, weekday, start_time, end_time, title) VALUES (?, ?, ?, ?, ?, ?)`, 1, smirnov, 1, "18:00", "19:30", "Web, группа 2");
