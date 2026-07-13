const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Railway mounts persistent volumes at RAILWAY_VOLUME_MOUNT_PATH. If a volume
// is attached, store the DB there so it survives redeploys; otherwise fall
// back to the local file (e.g. for development).
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbPath = volumePath && fs.existsSync(volumePath)
  ? path.join(volumePath, 'workshop.db')
  : path.join(__dirname, '../../workshop.db');

const db = new Database(dbPath);

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

// Add inspector/washer assignment columns if they don't exist yet
try { db.exec(`ALTER TABLE jobs ADD COLUMN assigned_inspector TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN assigned_washer TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN estimated_duration_minutes INTEGER`); } catch {}

// Columns for the created → assigned → in_progress → test_drive → billing → washing → done pipeline.
// assigned_mechanic holds the assigned specialist's name; specialist_role records
// which specialist role (technician/electrician/denter) they were assigned as.
try { db.exec(`ALTER TABLE jobs ADD COLUMN specialist_role TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN assigned_test_driver TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN created_by TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN test_drive_note TEXT`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN billing_done INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE jobs ADD COLUMN washing_done INTEGER DEFAULT 0`); } catch {}

// Add language column to workers if it doesn't exist yet
try { db.exec(`ALTER TABLE workers ADD COLUMN language TEXT DEFAULT 'english'`); } catch {}

// Telegram bot has been removed — drop its now-unused linking column.
try { db.exec(`ALTER TABLE workers DROP COLUMN telegram_id`); } catch {}

// Instagram first-contact confirmation flow (see src/instagram_messages.js).
// confirmed: worker replied YES to the details-confirmation DM.
// needs_review: worker replied NO — an admin must correct their details via
// the dashboard (no self-edit via DM).
try { db.exec(`ALTER TABLE workers ADD COLUMN confirmed INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE workers ADD COLUMN needs_review INTEGER DEFAULT 0`); } catch {}

module.exports = db;