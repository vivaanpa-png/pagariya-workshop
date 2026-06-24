const cron = require('node-cron');
const db = require('./db/database');
const telegram = require('./telegram');

const STAGE_LABELS = {
  created: 'Created', assigned: 'Assigned', inprogress: 'In Progress',
  inspection: 'Inspection', qc: 'Inspection', washing: 'Washing', wash: 'Washing',
  failed_qc: 'Failed QC', delayed: 'Delayed',
};

const OVERTIME_MINUTES = 90;

// SQLite's CURRENT_TIMESTAMP is UTC; parse it as such for an accurate duration.
function minutesSince(sqliteTimestamp) {
  const then = new Date(sqliteTimestamp.replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - then) / 60000;
}

function formatDuration(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function checkOvertimeJobs() {
  const overtimeJobs = db.prepare(`SELECT * FROM jobs WHERE current_stage != 'done'`).all()
    .filter(job => minutesSince(job.updated_at) > OVERTIME_MINUTES);

  if (!overtimeJobs.length) return;

  const recipients = db.prepare(
    `SELECT * FROM workers WHERE role IN ('supervisor', 'all') AND telegram_id IS NOT NULL`
  ).all();
  if (!recipients.length) return;

  for (const job of overtimeJobs) {
    const stageLabel = STAGE_LABELS[job.current_stage] || job.current_stage;
    const elapsed = formatDuration(minutesSince(job.updated_at));
    const message = `⏰ Overtime alert — Job #${job.job_number} ${job.car_model || ''} has been in ${stageLabel} for ${elapsed}. Mechanic: ${job.assigned_mechanic || 'Unassigned'}. Please check.`;
    for (const worker of recipients) {
      telegram.sendTelegram(worker.telegram_id, message);
    }
  }
}

// Fires every 15 minutes
function startOvertimeAlertsJob() {
  cron.schedule('*/15 * * * *', checkOvertimeJobs);
}

module.exports = { startOvertimeAlertsJob, checkOvertimeJobs };
