require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db/database');
const whatsapp = require('./whatsapp');
const telegram = require('./telegram');
const jobcard = require('./routes/jobcard');
const { startDailySummaryJob } = require('./dailySummary');
const { startOvertimeAlertsJob } = require('./overtimeAlerts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Public kiosk view for the wall-mounted floor tablet — no login required.
app.get('/floor', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/floor.html'));
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(whatsapp);
app.use(telegram);
app.use(jobcard);

// Get all active jobs
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare(`
    SELECT * FROM jobs ORDER BY created_at DESC
  `).all();
  res.json(jobs);
});

// Create a new job. created_by is the advisor's name — required so they can
// later be matched and notified when the job's test drive passes / completes.
app.post('/api/jobs', (req, res) => {
  const { job_number, car_number, car_model, work_type, customer_name, customer_phone, created_by } = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO jobs (job_number, car_number, car_model, work_type, customer_name, customer_phone, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(job_number, car_number, car_model, work_type, customer_name, customer_phone, created_by || null);

    db.prepare(`
      INSERT INTO stage_logs (job_id, stage, person, action)
      VALUES (?, 'created', ?, 'Job created')
    `).run(result.lastInsertRowid, created_by || customer_name);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    telegram.notifyNextStage(job);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update job stage — generic admin override (dashboard stage dropdown,
// "mark delayed"). Always fires the same notification dispatcher used by the
// Telegram bot, so a manual override still reaches the right person.
app.patch('/api/jobs/:id/stage', (req, res) => {
  const { stage, person, note } = req.body;
  const { id } = req.params;
  const prevJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

  db.prepare(`
    UPDATE jobs SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(stage, id);

  db.prepare(`
    INSERT INTO stage_logs (job_id, stage, person, action, note)
    VALUES (?, ?, ?, 'Stage updated', ?)
  `).run(id, stage, person, note);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  telegram.notifyNextStage(job, prevJob);

  res.json({ success: true });
});

// Floor supervisor assigns a technician/electrician/denter to a job.
app.patch('/api/jobs/:id/assign', (req, res) => {
  const { name, role, person } = req.body;
  const { id } = req.params;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!telegram.SPECIALIST_ROLES.includes(role) && role !== 'all') {
    return res.status(400).json({ error: `role must be one of: ${telegram.SPECIALIST_ROLES.join(', ')}, all` });
  }

  const job = telegram.assignSpecialist(id, { name: name.trim(), role }, person || 'Dashboard');
  res.json({ success: true, job });
});

// Floor kiosk: specialist starts their assigned job.
app.patch('/api/jobs/:id/floor-start', (req, res) => {
  const job = telegram.advanceJobStage(req.params.id, 'in_progress', 'Floor Kiosk', 'Started from floor kiosk');
  res.json({ success: true, job });
});

// Floor kiosk: specialist marks repair work done — sends the job to test drive.
app.patch('/api/jobs/:id/floor-done', (req, res) => {
  const job = telegram.advanceJobStage(req.params.id, 'test_drive', 'Floor Kiosk', 'Repair marked done from floor kiosk');
  res.json({ success: true, job });
});

// Test driver records a pass/fail result via the dashboard (mirrors the
// Telegram 2/3 replies).
app.patch('/api/jobs/:id/test-drive', (req, res) => {
  const { result, note, person } = req.body;
  const { id } = req.params;
  const testDriverName = person || 'Dashboard';

  const job = result === 'pass'
    ? telegram.passTestDrive(id, testDriverName)
    : telegram.failTestDrive(id, testDriverName, note);

  res.json({ success: true, job });
});

// Advisor marks billing complete for a job.
app.patch('/api/jobs/:id/billing-done', (req, res) => {
  const job = telegram.markBillingDone(req.params.id, req.body.person || 'Dashboard');
  res.json({ success: true, job });
});

// Floor kiosk: washer marks washing complete for a job.
app.patch('/api/jobs/:id/washing-done', (req, res) => {
  const job = telegram.markWashingDone(req.params.id, req.body.person || 'Floor Kiosk');
  res.json({ success: true, job });
});

// Get stage log for a job
app.get('/api/jobs/:id/logs', (req, res) => {
  const logs = db.prepare(`
    SELECT * FROM stage_logs WHERE job_id = ? ORDER BY timestamp ASC
  `).all(req.params.id);
  res.json(logs);
});

// Get active mechanics
app.get('/api/mechanics', (req, res) => {
  const mechanics = db.prepare(`SELECT * FROM mechanics WHERE active = 1 ORDER BY name ASC`).all();
  res.json(mechanics);
});

// Add a mechanic
app.post('/api/mechanics', (req, res) => {
  const { name, speciality } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = db.prepare(`INSERT INTO mechanics (name, speciality) VALUES (?, ?)`).run(name.trim(), speciality?.trim() || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a mechanic (soft delete)
app.delete('/api/mechanics/:id', (req, res) => {
  db.prepare(`UPDATE mechanics SET active = 0 WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// Get all workers
app.get('/api/workers', (req, res) => {
  const workers = db.prepare(`SELECT * FROM workers ORDER BY name ASC`).all();
  res.json(workers);
});

// Add a worker
app.post('/api/workers', (req, res) => {
  const { phone, name, role } = req.body;
  if (!phone?.trim()) return res.status(400).json({ error: 'Phone is required' });
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!role?.trim()) return res.status(400).json({ error: 'Role is required' });
  try {
    const result = db.prepare(`INSERT INTO workers (phone, name, role) VALUES (?, ?, ?)`).run(phone.trim(), name.trim(), role.trim());
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a worker
app.delete('/api/workers/:id', (req, res) => {
  db.prepare(`DELETE FROM workers WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// Delete a job (hard delete)
app.delete('/api/jobs/:id', (req, res) => {
  db.prepare(`DELETE FROM stage_logs WHERE job_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM jobs WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ── Stats ────────────────────────────────────────────────

// Jobs completed per day (and average job duration per day) for the last 7 days,
// plus a "today" summary (completed / avg / fastest job duration in minutes).
app.get('/api/stats/daily', (req, res) => {
  const rows = db.prepare(`
    SELECT
      date(updated_at) AS day,
      COUNT(*) AS completed,
      AVG((julianday(updated_at) - julianday(created_at)) * 1440) AS avg_minutes
    FROM jobs
    WHERE current_stage = 'done' AND date(updated_at) >= date('now', '-6 days')
    GROUP BY date(updated_at)
  `).all();
  const byDay = Object.fromEntries(rows.map(r => [r.day, r]));

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = db.prepare(`SELECT date('now', ?) AS d`).get(`-${i} days`).d;
    const row = byDay[date];
    days.push({
      date,
      completed: row ? row.completed : 0,
      avg_minutes: row ? row.avg_minutes : null,
    });
  }

  const today = db.prepare(`
    SELECT
      COUNT(*) AS completed,
      AVG((julianday(updated_at) - julianday(created_at)) * 1440) AS avg_minutes,
      MIN((julianday(updated_at) - julianday(created_at)) * 1440) AS fastest_minutes
    FROM jobs
    WHERE current_stage = 'done' AND date(updated_at) = date('now')
  `).get();

  res.json({ today, days });
});

// This week vs last week — total jobs created, with % change.
app.get('/api/stats/weekly', (req, res) => {
  const thisWeek = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE date(created_at) >= date('now', '-6 days')
  `).get().n;

  const lastWeek = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE date(created_at) >= date('now', '-13 days') AND date(created_at) < date('now', '-6 days')
  `).get().n;

  const percent_change = lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null;

  res.json({ this_week: thisWeek, last_week: lastWeek, percent_change });
});

// Top job-card creators, ranked by number of job cards created.
app.get('/api/stats/leaderboard/creators', (req, res) => {
  const rows = db.prepare(`
    SELECT person AS name, COUNT(*) AS count
    FROM stage_logs
    WHERE stage = 'created' AND person IS NOT NULL AND TRIM(person) != ''
    GROUP BY person
    ORDER BY count DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// Top mechanics, ranked by jobs completed, with average time per job.
app.get('/api/stats/leaderboard/mechanics', (req, res) => {
  const rows = db.prepare(`
    SELECT
      assigned_mechanic AS name,
      COUNT(*) AS completed,
      AVG((julianday(updated_at) - julianday(created_at)) * 1440) AS avg_minutes
    FROM jobs
    WHERE current_stage = 'done' AND assigned_mechanic IS NOT NULL AND TRIM(assigned_mechanic) != ''
    GROUP BY assigned_mechanic
    ORDER BY completed DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// Breakdown of delay reasons into parts / customer / mechanic / other buckets,
// based on the note recorded when a job is marked delayed.
app.get('/api/stats/delays', (req, res) => {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN note LIKE '%part%'     THEN 1 ELSE 0 END) AS parts,
      SUM(CASE WHEN note LIKE '%customer%' THEN 1 ELSE 0 END) AS customer,
      SUM(CASE WHEN note LIKE '%mechanic%' THEN 1 ELSE 0 END) AS mechanic,
      SUM(CASE WHEN note NOT LIKE '%part%' AND note NOT LIKE '%customer%' AND note NOT LIKE '%mechanic%'
               THEN 1 ELSE 0 END) AS other
    FROM stage_logs
    WHERE stage = 'delayed' AND note IS NOT NULL AND TRIM(note) != ''
  `).get();

  res.json({
    parts: row.parts || 0,
    customer: row.customer || 0,
    mechanic: row.mechanic || 0,
    other: row.other || 0,
  });
});

// Full database export, for backing up data before a redeploy.
app.post('/api/backup', (req, res) => {
  const backup = {
    exported_at: new Date().toISOString(),
    jobs: db.prepare(`SELECT * FROM jobs`).all(),
    stage_logs: db.prepare(`SELECT * FROM stage_logs`).all(),
    mechanics: db.prepare(`SELECT * FROM mechanics`).all(),
    workers: db.prepare(`SELECT * FROM workers`).all(),
  };
  res.json(backup);
});

app.listen(PORT, () => {
  console.log(`Pagariya Workshop server running on http://localhost:${PORT}`);
  startDailySummaryJob();
  startOvertimeAlertsJob();
});