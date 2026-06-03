const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../workshop.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT UNIQUE NOT NULL,
    car_number TEXT NOT NULL,
    car_model TEXT,
    work_type TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    current_stage TEXT DEFAULT 'created',
    assigned_mechanic TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    stage TEXT,
    person TEXT,
    action TEXT,
    note TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS mechanics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    speciality TEXT DEFAULT '',
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL
  );
`);

const seedMechanics = ['Raju', 'Suresh', 'Ramesh', 'Vijay', 'Manoj', 'Deepak'];
const insertMechanic = db.prepare(`INSERT OR IGNORE INTO mechanics (name) VALUES (?)`);
for (const name of seedMechanics) insertMechanic.run(name);

module.exports = db;