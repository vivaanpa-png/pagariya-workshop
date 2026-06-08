const cron = require('node-cron');
const db = require('./db/database');
const whatsapp = require('./whatsapp');

function getTodayStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN current_stage = 'done' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN current_stage != 'done' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE
            WHEN current_stage != 'done'
             AND estimated_duration_minutes IS NOT NULL
             AND (julianday('now') - julianday(created_at)) * 1440 > estimated_duration_minutes
            THEN 1 ELSE 0
          END) AS delayed
    FROM jobs
    WHERE date(created_at) = date('now')
  `).get();
}

function buildSummaryMessage(stats) {
  const date = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

  return `📊 Pagariya Auto — Daily Summary
${date}

✅ Completed: ${stats.completed}
🔧 In Progress: ${stats.in_progress}
⏳ Delayed: ${stats.delayed}

Total Vehicles Today: ${stats.total}

— Pagariya Auto Workshop System`;
}

function sendDailySummary() {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.error('OWNER_PHONE is not set; skipping daily summary.');
    return;
  }
  whatsapp.sendWhatsApp(ownerPhone, buildSummaryMessage(getTodayStats()));
}

// Fires daily at 7:00 PM India Standard Time
function startDailySummaryJob() {
  cron.schedule('0 19 * * *', sendDailySummary, { timezone: 'Asia/Kolkata' });
}

module.exports = { startDailySummaryJob, sendDailySummary, getTodayStats, buildSummaryMessage };
