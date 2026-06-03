require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Get all active jobs
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare(`
    SELECT * FROM jobs ORDER BY created_at DESC
  `).all();
  res.json(jobs);
});

// Create a new job
app.post('/api/jobs', (req, res) => {
  const { job_number, car_number, car_model, work_type, customer_name, customer_phone } = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO jobs (job_number, car_number, car_model, work_type, customer_name, customer_phone)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job_number, car_number, car_model, work_type, customer_name, customer_phone);

    db.prepare(`
      INSERT INTO stage_logs (job_id, stage, person, action)
      VALUES (?, 'created', ?, 'Job created')
    `).run(result.lastInsertRowid, customer_name);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update job stage
app.patch('/api/jobs/:id/stage', (req, res) => {
  const { stage, person, note } = req.body;
  const { id } = req.params;
  
  db.prepare(`
    UPDATE jobs SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(stage, id);

  db.prepare(`
    INSERT INTO stage_logs (job_id, stage, person, action, note)
    VALUES (?, ?, ?, 'Stage updated', ?)
  `).run(id, stage, person, note);

  res.json({ success: true });
});

// Assign mechanic
app.patch('/api/jobs/:id/assign', (req, res) => {
  const { mechanic } = req.body;
  const { id } = req.params;

  db.prepare(`
    UPDATE jobs SET assigned_mechanic = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(mechanic, id);

  db.prepare(`
    INSERT INTO stage_logs (job_id, stage, person, action)
    VALUES (?, 'assigned', ?, 'Assigned to mechanic')
  `).run(id, mechanic);

  res.json({ success: true });
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

app.listen(PORT, () => {
  console.log(`Pagariya Workshop server running on http://localhost:${PORT}`);
});