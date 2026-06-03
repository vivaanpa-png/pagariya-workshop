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
 *   jobcard_creator | supervisor | mechanic | inspector | washer
 *
 * Stage flow: created → assigned → inprogress → qc → wash → done
 *   failed_qc loops back: mechanic sends "1" → inprogress → "2" → qc again
 *
 * Commands:
 *   [photo + caption]   jobcard_creator/supervisor: create job
 *                       Caption format: JOB001 KA01AB1234 Toyota_Fortuner Oil_Change
 *   assign [name]       supervisor: assign mechanic to newest unassigned job
 *   1                   mechanic: start their assigned job
 *   2                   mechanic/inspector/washer: advance to next stage
 *   3                   inspector: fail QC, send back to mechanic
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

function getWorkerByPhone(rawFrom) {
  const phone = rawFrom.replace('whatsapp:', '');
  return db.prepare('SELECT * FROM workers WHERE phone = ?').get(phone);
}

function notifyNextStage(job) {
  const { current_stage: stage, job_number, car_number, car_model, work_type, assigned_mechanic } = job;

  if (stage === 'created') {
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role = 'supervisor'`).all();
    for (const s of supervisors) {
      sendWhatsApp(s.phone, `New job: ${job_number} | ${car_number} | ${car_model || ''} | ${work_type || ''}\nReply "assign [mechanic name]" to assign.`);
    }
  } else if (stage === 'assigned') {
    const mechanic = db.prepare(`SELECT * FROM workers WHERE name = ? AND role = 'mechanic'`).get(assigned_mechanic);
    if (mechanic) {
      sendWhatsApp(mechanic.phone, `Job assigned to you: ${job_number} | ${car_number} | ${car_model || ''}\nWork: ${work_type || ''}\nReply "1" to start, "2" when done.`);
    }
  } else if (stage === 'failed_qc') {
    const mechanic = db.prepare(`SELECT * FROM workers WHERE name = ? AND role = 'mechanic'`).get(assigned_mechanic);
    if (mechanic) {
      sendWhatsApp(mechanic.phone, `Job ${job_number} (${car_number}) failed QC inspection. Please fix it.\nReply "1" to start working on it again.`);
    }
  } else if (stage === 'qc') {
    const inspectors = db.prepare(`SELECT * FROM workers WHERE role = 'inspector'`).all();
    for (const i of inspectors) {
      sendWhatsApp(i.phone, `Job ready for QC: ${job_number} | ${car_number}\nReply "2" to pass, "3" to fail.`);
    }
  } else if (stage === 'wash') {
    const washers = db.prepare(`SELECT * FROM workers WHERE role = 'washer'`).all();
    for (const w of washers) {
      sendWhatsApp(w.phone, `Job ready for wash: ${job_number} | ${car_number}\nReply "2" when done.`);
    }
  } else if (stage === 'done') {
    const notify = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'jobcard_creator')`).all();
    for (const n of notify) {
      sendWhatsApp(n.phone, `Job completed: ${job_number} | ${car_number} | ${car_model || ''}`);
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

  const worker = getWorkerByPhone(from);
  if (!worker) {
    twiml.message('You are not registered in the system. Contact your supervisor.');
    return res.type('text/xml').send(twiml.toString());
  }

  const lower = body.toLowerCase();

  // Photo with caption → create job
  if (numMedia > 0 && (mediaType.startsWith('image/') || mediaType === 'application/octet-stream')) {
    if (worker.role !== 'jobcard_creator' && worker.role !== 'supervisor') {
      twiml.message('Only job card creators can create jobs via photo.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Caption format: JOB001 KA01AB1234 Toyota_Fortuner Oil_Change
    // Underscores in model/work_type are converted to spaces
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

      db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'created', ?, 'Created via WhatsApp photo')`).run(result.lastInsertRowid, worker.name);

      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
      notifyNextStage(job);
      twiml.message(`Job created: ${job_number} | ${car_number} | ${car_model} | ${work_type}`);
    } catch (err) {
      twiml.message(`Failed to create job: ${err.message}`);
    }

    return res.type('text/xml').send(twiml.toString());
  }

  // assign [mechanic name]
  if (lower.startsWith('assign ')) {
    if (worker.role !== 'supervisor') {
      twiml.message('Only supervisors can assign mechanics.');
      return res.type('text/xml').send(twiml.toString());
    }

    const mechanicName = body.slice(7).trim();
    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'created' ORDER BY created_at DESC LIMIT 1`).get();

    if (!job) {
      twiml.message('No unassigned jobs found.');
      return res.type('text/xml').send(twiml.toString());
    }

    db.prepare(`UPDATE jobs SET assigned_mechanic = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(mechanicName, job.id);
    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'assigned', ?, 'Assigned via WhatsApp')`).run(job.id, worker.name);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    notifyNextStage(updated);
    twiml.message(`Job ${job.job_number} assigned to ${mechanicName}.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // 1 → start job (mechanic)
  if (body === '1') {
    if (worker.role !== 'mechanic') {
      twiml.message('Only mechanics can start jobs.');
      return res.type('text/xml').send(twiml.toString());
    }

    const job = db.prepare(`
      SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage IN ('assigned', 'failed_qc')
      ORDER BY updated_at DESC LIMIT 1
    `).get(worker.name);

    if (!job) {
      twiml.message('No assigned job found for you.');
      return res.type('text/xml').send(twiml.toString());
    }

    advanceJobStage(job.id, 'inprogress', worker.name);
    twiml.message(`Job ${job.job_number} marked as in progress.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // 2 → done / advance to next stage
  if (body === '2') {
    let job = null;
    let nextStage = null;

    if (worker.role === 'mechanic') {
      job = db.prepare(`SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage = 'inprogress' ORDER BY updated_at DESC LIMIT 1`).get(worker.name);
      nextStage = 'qc';
    } else if (worker.role === 'inspector') {
      job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`).get();
      nextStage = 'wash';
    } else if (worker.role === 'washer') {
      job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'wash' ORDER BY updated_at DESC LIMIT 1`).get();
      nextStage = 'done';
    } else {
      twiml.message('Command "2" is not available for your role.');
      return res.type('text/xml').send(twiml.toString());
    }

    if (!job) {
      twiml.message('No active job found in the current stage for you.');
      return res.type('text/xml').send(twiml.toString());
    }

    advanceJobStage(job.id, nextStage, worker.name);
    twiml.message(`Job ${job.job_number} moved to ${nextStage}.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // 3 → fail QC inspection
  if (body === '3') {
    if (worker.role !== 'inspector') {
      twiml.message('Only inspectors can fail inspection.');
      return res.type('text/xml').send(twiml.toString());
    }

    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`).get();

    if (!job) {
      twiml.message('No job in QC stage found.');
      return res.type('text/xml').send(twiml.toString());
    }

    advanceJobStage(job.id, 'failed_qc', worker.name, 'Failed QC inspection');
    twiml.message(`Job ${job.job_number} failed QC. Mechanic notified.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // delay [reason]
  if (lower.startsWith('delay ')) {
    const reason = body.slice(6).trim();

    let job = null;
    if (worker.role === 'mechanic') {
      job = db.prepare(`SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage IN ('assigned', 'inprogress', 'failed_qc') ORDER BY updated_at DESC LIMIT 1`).get(worker.name);
    } else if (worker.role === 'inspector') {
      job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`).get();
    } else if (worker.role === 'washer') {
      job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'wash' ORDER BY updated_at DESC LIMIT 1`).get();
    } else {
      twiml.message('Delay command is not available for your role.');
      return res.type('text/xml').send(twiml.toString());
    }

    if (!job) {
      twiml.message('No active job found for you.');
      return res.type('text/xml').send(twiml.toString());
    }

    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Delay reported via WhatsApp', ?)`).run(job.id, job.current_stage, worker.name, `DELAY: ${reason}`);

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role = 'supervisor'`).all();
    for (const s of supervisors) {
      sendWhatsApp(s.phone, `DELAY on Job ${job.job_number} (${job.car_number}) by ${worker.name}:\n${reason}`);
    }

    twiml.message(`Delay reported for Job ${job.job_number}. Supervisor notified.`);
    return res.type('text/xml').send(twiml.toString());
  }

  // status → list active jobs
  if (lower === 'status') {
    const activeJobs = db.prepare(`
      SELECT * FROM jobs WHERE current_stage != 'done' ORDER BY created_at DESC LIMIT 20
    `).all();

    if (activeJobs.length === 0) {
      twiml.message('No active jobs right now.');
      return res.type('text/xml').send(twiml.toString());
    }

    const lines = activeJobs.map(j =>
      `${j.job_number} | ${j.car_number} | ${j.current_stage}${j.assigned_mechanic ? ` | ${j.assigned_mechanic}` : ''}`
    );
    twiml.message(`Active Jobs (${activeJobs.length}):\n${lines.join('\n')}`);
    return res.type('text/xml').send(twiml.toString());
  }

  // Unknown command → help
  twiml.message(
    'Commands:\n' +
    '  [photo + caption] – create job\n' +
    '  assign [name] – assign mechanic\n' +
    '  1 – start your job\n' +
    '  2 – mark done / next stage\n' +
    '  3 – fail QC inspection\n' +
    '  delay [reason] – report delay\n' +
    '  status – list active jobs'
  );
  return res.type('text/xml').send(twiml.toString());
});

module.exports = router;
