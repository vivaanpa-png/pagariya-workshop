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
`);

module.exports = db;