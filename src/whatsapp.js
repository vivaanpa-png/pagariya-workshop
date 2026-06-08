/*
 * WhatsApp Bot via Twilio
 *
 * SETUP: In the Twilio Console, set the webhook URL for your WhatsApp sandbox
 * (or your WhatsApp-enabled number) to:
 *
 *   [your-server-url]/webhook/whatsapp
 *
 * Method: HTTP POST
 * e.g. https://abc123.ngrok.io/webhook/whatsapp  (for local dev with ngrok)
 *
 * Workers must be registered in the `workers` table with their WhatsApp phone
 * number (E.164 format, e.g. +919876543210), name, and one of these roles:
 *   jobcard_creator | supervisor | mechanic | inspector | washer | all
 *
 * A phone number may have multiple rows in the workers table (different roles).
 * Role "all" acts in every stage. When multiple roles exist for one phone,
 * the system picks the entry whose role matches the current job stage.
 *
 * Stage flow: created → assigned → inprogress → qc → wash → done
 *   failed_qc loops back: mechanic sends "2" → qc again
 *
 * Commands:
 *   [photo + caption]   jobcard_creator/supervisor/all: create job
 *                       Caption format: JOB001 KA01AB1234 Toyota_Fortuner Oil_Change
 *   assign [name]       supervisor/all: assign mechanic to newest unassigned job
 *   1                   mechanic/inspector/washer/all: acknowledge/start active job
 *   2                   mechanic/inspector/washer/all: advance to next stage
 *   3                   inspector/all: fail inspection, send back to mechanic
 *   delay [reason]      any worker: report delay on current job
 *   status              any worker: list all active jobs
 */

const express = require('express');
const twilio = require('twilio');
const db = require('./db/database');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. 'whatsapp:+14155238886'

function sendWhatsApp(to, body) {
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  return client.messages
    .create({ from: FROM_NUMBER, to: toFormatted, body })
    .catch(err => console.error(`WhatsApp send error to ${toFormatted}:`, err.message));
}

// Returns all worker rows registered to this phone number.
function getWorkersByPhone(rawFrom) {
  const phone = rawFrom.replace('whatsapp:', '');
  return db.prepare('SELECT * FROM workers WHERE phone = ?').all(phone);
}

// Returns the worker entry that can act as the given role:
// prefers an exact role match, falls back to an 'all' entry, otherwise null.
function getWorkerAs(workers, role) {
  return workers.find(w => w.role === role)
      || workers.find(w => w.role === 'all')
      || null;
}

// Returns a short label like "KA01AB1234 Toyota Fortuner"
function carLabel(job) {
  return job.car_model ? `${job.car_number} ${job.car_model}` : job.car_number;
}

function notifyNextStage(job) {
  const { current_stage: stage, id, job_number } = job;
  const label = carLabel(job);

  if (stage === 'created') {
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all')`).all();
    for (const s of supervisors) {
      sendWhatsApp(s.phone,
        `New job created: #${job_number} | ${label} | ${job.work_type || ''}\nReply "assign [mechanic name]" to assign.`
      );
    }

  } else if (stage === 'assigned') {
    // Mechanic may be registered as 'mechanic' or 'all'
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('mechanic', 'all') LIMIT 1`
    ).get(job.assigned_mechanic);
    if (mechanic) {
      sendWhatsApp(mechanic.phone,
        `Job assigned to you: #${job_number} | ${label}\nWork: ${job.work_type || ''}\nReply 1 to start, 2 when done.`
      );
    }

  } else if (stage === 'qc') {
    const inspector = db.prepare(
      `SELECT * FROM workers WHERE role IN ('inspector', 'all') LIMIT 1`
    ).get();
    if (inspector) {
      db.prepare(`UPDATE jobs SET assigned_inspector = ? WHERE id = ?`).run(inspector.name, id);
      sendWhatsApp(inspector.phone,
        `🔍 Job #${job_number} ${label} is ready for inspection.\nReply 1 to start, 2 to pass, 3 to fail.`
      );
    }

  } else if (stage === 'failed_qc') {
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('mechanic', 'all') LIMIT 1`
    ).get(job.assigned_mechanic);
    if (mechanic) {
      sendWhatsApp(mechanic.phone,
        `❌ Job #${job_number} ${label} failed inspection. Please fix and reply 2 when done again.`
      );
    }

  } else if (stage === 'wash') {
    const washer = db.prepare(
      `SELECT * FROM workers WHERE role IN ('washer', 'all') LIMIT 1`
    ).get();
    if (washer) {
      db.prepare(`UPDATE jobs SET assigned_washer = ? WHERE id = ?`).run(washer.name, id);
      sendWhatsApp(washer.phone,
        `🚿 Job #${job_number} ${label} passed inspection. Ready for washing.\nReply 1 to start, 2 when done.`
      );
    }

  } else if (stage === 'done') {
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all')`).all();
    for (const s of supervisors) {
      sendWhatsApp(s.phone,
        `✅ Job #${job_number} ${label} is complete and ready for customer pickup.`
      );
    }
  }
}

function advanceJobStage(jobId, stage, personName, note = null) {
  db.prepare(`UPDATE jobs SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Stage updated via WhatsApp', ?)`).run(jobId, stage, personName, note);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  notifyNextStage(job);
  return job;
}

router.post('/webhook/whatsapp', (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '');
  console.log('Incoming from:', from);
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const mediaType = req.body.MediaContentType0 || '';

  const twiml = new twilio.twiml.MessagingResponse();

  const workers = getWorkersByPhone(from);
  if (!workers.length) {
    twiml.message('You are not registered in the system. Contact your supervisor.');
    return res.type('text/xml').send(twiml.toString());
  }

  const lower = body.toLowerCase();

  // ── Photo with caption → create job ─────────────────────────────────────────
  if (numMedia > 0 && (mediaType.startsWith('image/') || mediaType === 'application/octet-stream')) {
    const creator = getWorkerAs(workers, 'jobcard_creator') || getWorkerAs(workers, 'supervisor');
    if (!creator) {
      twiml.message('Only job card creators can create jobs via photo.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Caption format: JOB001 KA01AB1234 Toyota_Fortuner Oil_Change
    const parts = body.trim().split(/\s+/);
    const job_number = parts[0] || `JOB${Date.now()}`;
    const car_number = parts[1] || 'UNKNOWN';
    const car_model = (parts[2] || '').replace(/_/g, ' ');
    const work_type = (parts[3] || '').replace(/_/g, ' ');

    try {
      const result = db.prepare(`
        INSERT INTO jobs (job_number, car_number, car_model, work_type, current_stage)
        VALUES (?, ?, ?, ?, 'created')
      `).run(job_number, car_number, car_model, work_type);

      db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'created', ?, 'Created via WhatsApp photo')`).run(result.lastInsertRowid, creator.name);

      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
      notifyNextStage(job);
      twiml.message(`Job created: #${job_number} | ${car_number} | ${car_model} | ${work_type}`);
    } catch (err) {
      twiml.message(`Failed to create job: ${err.message}`);
    }

    return res.type('text/xml').send(twiml.toString());
  }

  // ── assign [name] → supervisor assigns mechanic to newest unassigned job ────
  if (lower.startsWith('assign ')) {
    const asSupervisor = getWorkerAs(workers, 'supervisor');
    if (!asSupervisor) {
      twiml.message('Only supervisors can assign mechanics.');
      return res.type('text/xml').send(twiml.toString());
    }

    const nameInput = body.slice(7).trim();

    // Case-insensitive partial match; include 'all'-role workers as eligible mechanics
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE role IN ('mechanic', 'all') AND name LIKE ? LIMIT 1`
    ).get(`%${nameInput}%`);

    if (!mechanic) {
      twiml.message(`No mechanic found matching "${nameInput}". Check the name and try again.`);
      return res.type('text/xml').send(twiml.toString());
    }

    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'created' ORDER BY created_at DESC LIMIT 1`).get();
    if (!job) {
      twiml.message('No unassigned jobs found.');
      return res.type('text/xml').send(twiml.toString());
    }

    db.prepare(`UPDATE jobs SET assigned_mechanic = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(mechanic.name, job.id);
    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'assigned', ?, 'Assigned via WhatsApp')`).run(job.id, asSupervisor.name);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    notifyNextStage(updated);
    twiml.message(`Job #${job.job_number} assigned to ${mechanic.name}. They've been notified.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── 1 → start / acknowledge active job ──────────────────────────────────────
  if (body === '1') {
    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

    if (!asMechanic && !asInspector && !asWasher) {
      twiml.message('Command "1" is not available for your role.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Find the first active job across all applicable roles, mechanic-first
    let job = null, activeAs = null, activeWorker = null;

    if (asMechanic) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage IN ('assigned', 'failed_qc') ORDER BY updated_at DESC LIMIT 1`
      ).get(asMechanic.name);
      if (j) { job = j; activeAs = 'mechanic'; activeWorker = asMechanic; }
    }
    if (!job && asInspector) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_inspector = ? AND current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`
      ).get(asInspector.name);
      if (j) { job = j; activeAs = 'inspector'; activeWorker = asInspector; }
    }
    if (!job && asWasher) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_washer = ? AND current_stage = 'wash' ORDER BY updated_at DESC LIMIT 1`
      ).get(asWasher.name);
      if (j) { job = j; activeAs = 'washer'; activeWorker = asWasher; }
    }

    if (!job) {
      twiml.message('No active job assigned to you.');
      return res.type('text/xml').send(twiml.toString());
    }

    if (activeAs === 'mechanic') {
      advanceJobStage(job.id, 'inprogress', activeWorker.name);
      twiml.message(`Job #${job.job_number} marked as in progress. Reply 2 when done.`);
    } else {
      // Inspector/washer "1" is an acknowledgment — log it, stage stays the same
      db.prepare(
        `INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, ?, ?, 'Started via WhatsApp')`
      ).run(job.id, job.current_stage, activeWorker.name);
      const extra = activeAs === 'inspector' ? ', 3 to fail' : '';
      twiml.message(`Got it! You're now working on Job #${job.job_number} (${job.car_number}). Reply 2 when done${extra}.`);
    }

    return res.type('text/xml').send(twiml.toString());
  }

  // ── 2 → advance job to next stage, notify next person ───────────────────────
  if (body === '2') {
    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

    if (!asMechanic && !asInspector && !asWasher) {
      twiml.message('Command "2" is not available for your role.');
      return res.type('text/xml').send(twiml.toString());
    }

    let job = null, nextStage = null, activeWorker = null;

    if (asMechanic) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage = 'inprogress' ORDER BY updated_at DESC LIMIT 1`
      ).get(asMechanic.name);
      if (j) { job = j; nextStage = 'qc'; activeWorker = asMechanic; }
    }
    if (!job && asInspector) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_inspector = ? AND current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`
      ).get(asInspector.name);
      if (j) { job = j; nextStage = 'wash'; activeWorker = asInspector; }
    }
    if (!job && asWasher) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_washer = ? AND current_stage = 'wash' ORDER BY updated_at DESC LIMIT 1`
      ).get(asWasher.name);
      if (j) { job = j; nextStage = 'done'; activeWorker = asWasher; }
    }

    if (!job) {
      twiml.message('No active job found for you in the current stage.');
      return res.type('text/xml').send(twiml.toString());
    }

    advanceJobStage(job.id, nextStage, activeWorker.name);
    const stageLabels = { qc: 'inspection', wash: 'washing', done: 'complete' };
    twiml.message(`Job #${job.job_number} moved to ${stageLabels[nextStage] || nextStage}. Next person has been notified.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── 3 → inspector fails inspection ──────────────────────────────────────────
  if (body === '3') {
    const asInspector = getWorkerAs(workers, 'inspector');
    if (!asInspector) {
      twiml.message('Only inspectors can fail inspection.');
      return res.type('text/xml').send(twiml.toString());
    }

    const job = db.prepare(
      `SELECT * FROM jobs WHERE assigned_inspector = ? AND current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`
    ).get(asInspector.name);

    if (!job) {
      twiml.message('No inspection job assigned to you.');
      return res.type('text/xml').send(twiml.toString());
    }

    advanceJobStage(job.id, 'failed_qc', asInspector.name, 'Failed inspection');
    twiml.message(`Job #${job.job_number} failed inspection. Mechanic has been notified to fix and resubmit.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── delay [reason] → log delay, notify supervisor ───────────────────────────
  if (lower.startsWith('delay ')) {
    const reason = body.slice(6).trim();

    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

    if (!asMechanic && !asInspector && !asWasher) {
      twiml.message('Delay command is not available for your role.');
      return res.type('text/xml').send(twiml.toString());
    }

    let job = null, activeWorker = null;

    if (asMechanic) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage IN ('assigned', 'inprogress', 'failed_qc') ORDER BY updated_at DESC LIMIT 1`
      ).get(asMechanic.name);
      if (j) { job = j; activeWorker = asMechanic; }
    }
    if (!job && asInspector) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_inspector = ? AND current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`
      ).get(asInspector.name);
      if (j) { job = j; activeWorker = asInspector; }
    }
    if (!job && asWasher) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_washer = ? AND current_stage = 'wash' ORDER BY updated_at DESC LIMIT 1`
      ).get(asWasher.name);
      if (j) { job = j; activeWorker = asWasher; }
    }

    if (!job) {
      twiml.message('No active job found for you.');
      return res.type('text/xml').send(twiml.toString());
    }

    db.prepare(
      `INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Delay reported via WhatsApp', ?)`
    ).run(job.id, job.current_stage, activeWorker.name, `DELAY: ${reason}`);

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all')`).all();
    for (const s of supervisors) {
      sendWhatsApp(s.phone, `⚠️ DELAY on Job #${job.job_number} (${job.car_number}) by ${activeWorker.name}:\n${reason}`);
    }

    twiml.message(`Delay reported for Job #${job.job_number}. Supervisor notified.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── status → list active jobs ────────────────────────────────────────────────
  if (lower === 'status') {
    const activeJobs = db.prepare(
      `SELECT * FROM jobs WHERE current_stage != 'done' ORDER BY created_at DESC LIMIT 20`
    ).all();

    if (activeJobs.length === 0) {
      twiml.message('No active jobs right now.');
      return res.type('text/xml').send(twiml.toString());
    }

    const lines = activeJobs.map(j =>
      `#${j.job_number} | ${j.car_number} | ${j.current_stage}${j.assigned_mechanic ? ` | ${j.assigned_mechanic}` : ''}`
    );
    twiml.message(`Active Jobs (${activeJobs.length}):\n${lines.join('\n')}`);
    return res.type('text/xml').send(twiml.toString());
  }

  // ── Unknown command → help ───────────────────────────────────────────────────
  twiml.message(
    'Commands:\n' +
    '  [photo + caption] – create job\n' +
    '  assign [name] – assign mechanic (supervisor only)\n' +
    '  1 – start your assigned job\n' +
    '  2 – mark done / advance to next stage\n' +
    '  3 – fail inspection (inspector only)\n' +
    '  delay [reason] – report a delay\n' +
    '  status – list active jobs'
  );
  return res.type('text/xml').send(twiml.toString());
});

module.exports = router;
module.exports.notifyNextStage = notifyNextStage;
module.exports.sendWhatsApp = sendWhatsApp;
