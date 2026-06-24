/*
 * Telegram Bot
 *
 * SETUP: Set TELEGRAM_BOT_TOKEN in .env to your bot's token (from @BotFather).
 * The bot connects via long polling (suitable for development), so no public
 * webhook URL is required.
 *
 * Workers must already exist in the `workers` table (e.g. added via the
 * dashboard's POST /api/workers) and then have their Telegram account linked
 * via POST /api/workers/telegram, which sets `telegram_id` by matching name
 * (and optionally role). Linking resets `language` to null so the worker is
 * walked through language selection the next time they message the bot.
 *
 * LANGUAGE SELECTION: the first time a linked-but-unconfigured worker messages
 * the bot, they're shown a language picker (1 - English, 2 - Hindi, 3 -
 * Marathi). Their choice is saved to `workers.language` and every later
 * message to them is rendered from MESSAGES[language].
 *
 * Stage flow: created → assigned → inprogress → qc → wash → done
 *   failed_qc loops back: mechanic sends "2" → qc again
 *
 * Commands:
 *   assign [name]   supervisor/all: assign mechanic to newest unassigned job
 *   1               mechanic/inspector/washer/all: acknowledge/start active job
 *   2               mechanic/inspector/washer/all: advance to next stage
 *   3               inspector/all: fail inspection, send back to mechanic
 *   delay [reason]  any worker: report delay on current job
 *   status          any worker: list all active jobs
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db/database');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JOBCARD_VISION_PROMPT = "You are extracting data from a Maruti Suzuki service job card. Extract these fields exactly as they appear: job_number, car_model, car_plate, customer_name, customer_phone, work_description. Return ONLY a valid JSON object with these exact keys, no other text.";

const MESSAGES = {
  english: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    job_assigned_mechanic: "🔧 New Job Assigned\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nReply 1 when you start work.\nReply 2 when you are done.",
    job_started: "✅ Got it. Timer started for #{JOB_NUMBER}.\nReply 2 when the job is complete.",
    ready_inspection: "🔍 Ready for Inspection\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nMechanic: {MECHANIC_NAME}\nTime taken: {ELAPSED_TIME}\n\nReply 1 to start inspection.\nReply 2 if car passes.\nReply 3 if car fails.",
    inspection_failed_mechanic: "❌ Inspection Failed\n#{JOB_NUMBER} — {CAR_MODEL} needs more work.\nNote: {NOTE}\n\nPlease fix and reply 2 when ready for re-inspection.",
    ready_washing: "🚿 Ready for Washing\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nPassed inspection ✓\n\nReply 1 when you start.\nReply 2 when washing is complete.",
    job_complete: "✅ Job Complete\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nCar is ready for pickup. Please notify the customer.\nTotal time: {TOTAL_TIME}",
    status: "📋 Active Jobs ({COUNT})\n\n{JOB_LIST}\n\nDelayed: {DELAYED_COUNT}\nCompleted today: {COMPLETED_COUNT}",
    unknown_command: "❓ Command not recognized.\n\nAvailable commands:\n1 — Start your assigned job\n2 — Mark done / advance to next stage\n3 — Fail inspection (inspectors only)\nassign [name] — Assign mechanic to latest job\ndelay [reason] — Report a delay\nstatus — View all active jobs",
    language_set: "✅ Language set! You can now use the bot.",
    commands_list: "Available commands:\n1 — Start your assigned job\n2 — Mark done / advance to next stage\n3 — Fail inspection (inspectors only)\nassign [name] — Assign mechanic to latest job\ndelay [reason] — Report a delay\nstatus — View all active jobs",
    not_registered: "You are not registered in the system. Contact your supervisor.",
    assigned_success: "✅ Job #{JOB_NUMBER} assigned to {MECHANIC_NAME}. They have been notified.",
    delay_logged: "⚠️ Delay logged for #{JOB_NUMBER}.\nReason: {REASON}",
    no_active_job: "You have no active job assigned to you.",
    job_card_created: "✅ Job card created!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nWork: {WORK_TYPE}",
    new_job_supervisor: "🆕 New job card scanned\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nReply \"assign [mechanic name]\" to assign.",
    extraction_failed: "⚠️ Could not read the job card clearly. Please retake the photo with better lighting and make sure all fields are visible."
  },
  hindi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    job_assigned_mechanic: "🔧 नया काम मिला है\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम शुरू करने पर 1 लिखें।\nकाम पूरा होने पर 2 लिखें।",
    job_started: "✅ ठीक है। #{JOB_NUMBER} का टाइमर शुरू हो गया।\nकाम पूरा होने पर 2 लिखें।",
    ready_inspection: "🔍 इंस्पेक्शन के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nमैकेनिक: {MECHANIC_NAME}\nलगा समय: {ELAPSED_TIME}\n\nइंस्पेक्शन शुरू करने पर 1 लिखें।\nपास होने पर 2 लिखें।\nफेल होने पर 3 लिखें।",
    inspection_failed_mechanic: "❌ इंस्पेक्शन फेल\n#{JOB_NUMBER} — {CAR_MODEL} को और काम चाहिए।\nनोट: {NOTE}\n\nठीक करके 2 लिखें जब दोबारा इंस्पेक्शन के लिए तैयार हो।",
    ready_washing: "🚿 धुलाई के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nइंस्पेक्शन पास ✓\n\nशुरू करने पर 1 लिखें।\nपूरा होने पर 2 लिखें।",
    job_complete: "✅ काम पूरा हो गया\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nगाड़ी लेने के लिए तैयार है। कृपया ग्राहक को सूचित करें।\nकुल समय: {TOTAL_TIME}",
    status: "📋 चालू काम ({COUNT})\n\n{JOB_LIST}\n\nदेरी: {DELAYED_COUNT}\nआज पूरे हुए: {COMPLETED_COUNT}",
    unknown_command: "❓ यह कमांड नहीं पहचानी।\n\nउपलब्ध कमांड:\n1 — काम शुरू करें\n2 — अगले चरण में भेजें\n3 — इंस्पेक्शन फेल करें\nassign [नाम] — मैकेनिक को काम दें\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें",
    language_set: "✅ भाषा सेट हो गई! अब आप बॉट का उपयोग कर सकते हैं।",
    commands_list: "उपलब्ध कमांड:\n1 — काम शुरू करें\n2 — अगले चरण में भेजें\n3 — इंस्पेक्शन फेल करें\nassign [नाम] — मैकेनिक को काम दें\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें",
    not_registered: "आप सिस्टम में रजिस्टर नहीं हैं। अपने सुपरवाइज़र से संपर्क करें।",
    assigned_success: "✅ काम #{JOB_NUMBER} {MECHANIC_NAME} को दे दिया गया। उन्हें सूचित कर दिया गया है।",
    delay_logged: "⚠️ #{JOB_NUMBER} की देरी दर्ज हो गई।\nकारण: {REASON}",
    no_active_job: "आपको कोई सक्रिय काम नहीं सौंपा गया है।",
    job_card_created: "✅ जॉब कार्ड बन गया!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    new_job_supervisor: "🆕 नया जॉब कार्ड स्कैन हुआ\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nमैकेनिक असाइन करने के लिए \"assign [नाम]\" लिखें।",
    extraction_failed: "⚠️ जॉब कार्ड साफ़ नहीं पढ़ा जा सका। कृपया बेहतर रोशनी में फिर से फोटो लें और सुनिश्चित करें कि सभी जानकारी दिख रही हो।"
  },
  marathi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    job_assigned_mechanic: "🔧 नवीन काम मिळाले आहे\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम सुरू केल्यावर 1 लिहा.\nकाम पूर्ण झाल्यावर 2 लिहा.",
    job_started: "✅ ठीक आहे. #{JOB_NUMBER} चा टायमर सुरू झाला.\nकाम पूर्ण झाल्यावर 2 लिहा.",
    ready_inspection: "🔍 तपासणीसाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nमेकॅनिक: {MECHANIC_NAME}\nलागलेला वेळ: {ELAPSED_TIME}\n\nतपासणी सुरू केल्यावर 1 लिहा.\nपास झाल्यावर 2 लिहा.\nफेल झाल्यावर 3 लिहा.",
    inspection_failed_mechanic: "❌ तपासणी अयशस्वी\n#{JOB_NUMBER} — {CAR_MODEL} ला अजून काम हवे आहे.\nनोंद: {NOTE}\n\nदुरुस्त करून पुन्हा तपासणीसाठी तयार झाल्यावर 2 लिहा.",
    ready_washing: "🚿 धुण्यासाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nतपासणी पास ✓\n\nसुरू केल्यावर 1 लिहा.\nपूर्ण झाल्यावर 2 लिहा.",
    job_complete: "✅ काम पूर्ण झाले\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nगाडी घेण्यासाठी तयार आहे. कृपया ग्राहकाला कळवा.\nएकूण वेळ: {TOTAL_TIME}",
    status: "📋 सध्याची कामे ({COUNT})\n\n{JOB_LIST}\n\nउशीर: {DELAYED_COUNT}\nआज पूर्ण: {COMPLETED_COUNT}",
    unknown_command: "❓ हे कमांड ओळखले नाही.\n\nउपलब्ध कमांड:\n1 — काम सुरू करा\n2 — पुढच्या टप्प्यावर पाठवा\n3 — तपासणी अयशस्वी करा\nassign [नाव] — मेकॅनिकला काम द्या\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा",
    language_set: "✅ भाषा सेट झाली! आता तुम्ही बॉट वापरू शकता.",
    commands_list: "उपलब्ध कमांड:\n1 — काम सुरू करा\n2 — पुढच्या टप्प्यावर पाठवा\n3 — तपासणी अयशस्वी करा\nassign [नाव] — मेकॅनिकला काम द्या\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा",
    not_registered: "तुम्ही सिस्टममध्ये नोंदणीकृत नाही. तुमच्या सुपरवायझरशी संपर्क साधा.",
    assigned_success: "✅ काम #{JOB_NUMBER} {MECHANIC_NAME} ला दिले गेले. त्यांना कळवले गेले आहे.",
    delay_logged: "⚠️ #{JOB_NUMBER} चा उशीर नोंदवला गेला.\nकारण: {REASON}",
    no_active_job: "तुम्हाला कोणतेही सक्रिय काम दिलेले नाही.",
    job_card_created: "✅ जॉब कार्ड तयार झाले!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    new_job_supervisor: "🆕 नवीन जॉब कार्ड स्कॅन झाले\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nमेकॅनिक नियुक्त करण्यासाठी \"assign [नाव]\" लिहा.",
    extraction_failed: "⚠️ जॉब कार्ड स्पष्ट वाचता आले नाही. कृपया चांगल्या प्रकाशात पुन्हा फोटो घ्या आणि सर्व माहिती दिसत आहे याची खात्री करा."
  }
};

// Resolves a free-text reply during language selection to one of the
// supported language keys, or null if it doesn't match anything.
function resolveLanguageChoice(body) {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === '1' || lower === 'english') return 'english';
  if (trimmed === '2' || lower === 'hindi' || trimmed === 'हिंदी') return 'hindi';
  if (trimmed === '3' || lower === 'marathi' || trimmed === 'मराठी') return 'marathi';
  return null;
}

const router = express.Router();
router.use(express.json());

// node-telegram-bot-api is published as ESM-only; load it dynamically from
// this CommonJS module rather than pulling in the older, vulnerable CJS release.
let bot;
const botReady = import('node-telegram-bot-api').then(({ default: TelegramBot }) => {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on('message', onMessage);
  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
  return bot;
});

function sendTelegram(chatId, text) {
  return botReady
    .then(() => bot.sendMessage(chatId, text))
    .catch(err => console.error(`Telegram send error to ${chatId}:`, err.message));
}

// Fills {PLACEHOLDER} tokens in a MESSAGES template with the given values.
function render(template, vars = {}) {
  return template.replace(/\{([A-Z_]+)\}/g, (_, key) => (vars[key] ?? ''));
}

// A worker's language column may be unset (mid-selection) or hold a value not in MESSAGES; default to English.
function languageOf(worker) {
  return worker?.language && MESSAGES[worker.language] ? worker.language : 'english';
}

function sendToWorker(worker, key, vars) {
  sendTelegram(worker.telegram_id, render(MESSAGES[languageOf(worker)][key], vars));
}

function formatDuration(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// SQLite's CURRENT_TIMESTAMP is UTC; parse it as such for an accurate duration.
function minutesSince(sqliteTimestamp) {
  const then = new Date(sqliteTimestamp.replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - then) / 60000;
}

// Returns all worker rows registered to this Telegram user ID.
function getWorkersByTelegramId(telegramId) {
  return db.prepare('SELECT * FROM workers WHERE telegram_id = ?').all(String(telegramId));
}

// Returns the worker entry that can act as the given role:
// prefers an exact role match, falls back to an 'all' entry, otherwise null.
function getWorkerAs(workers, role) {
  return workers.find(w => w.role === role)
      || workers.find(w => w.role === 'all')
      || null;
}

function jobVars(job, extra = {}) {
  return {
    JOB_NUMBER: job.job_number,
    CAR_MODEL: job.car_model || '',
    CAR_PLATE: job.car_number,
    WORK_TYPE: job.work_type || '',
    ...extra,
  };
}

function notifyNextStage(job, prevJob = null) {
  const { current_stage: stage, id } = job;

  if (stage === 'assigned') {
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('mechanic', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get(job.assigned_mechanic);
    if (mechanic) sendToWorker(mechanic, 'job_assigned_mechanic', jobVars(job));

  } else if (stage === 'qc') {
    const inspector = db.prepare(
      `SELECT * FROM workers WHERE role IN ('inspector', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get();
    if (inspector) {
      db.prepare(`UPDATE jobs SET assigned_inspector = ? WHERE id = ?`).run(inspector.name, id);
      const elapsed = prevJob ? formatDuration(minutesSince(prevJob.updated_at)) : '—';
      sendToWorker(inspector, 'ready_inspection', jobVars(job, { MECHANIC_NAME: job.assigned_mechanic || '', ELAPSED_TIME: elapsed }));
    }

  } else if (stage === 'failed_qc') {
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('mechanic', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get(job.assigned_mechanic);
    if (mechanic) sendToWorker(mechanic, 'inspection_failed_mechanic', jobVars(job, { NOTE: 'Failed inspection' }));

  } else if (stage === 'wash') {
    const washer = db.prepare(
      `SELECT * FROM workers WHERE role IN ('washer', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get();
    if (washer) {
      db.prepare(`UPDATE jobs SET assigned_washer = ? WHERE id = ?`).run(washer.name, id);
      sendToWorker(washer, 'ready_washing', jobVars(job));
    }

  } else if (stage === 'done') {
    const totalTime = formatDuration(minutesSince(job.created_at));
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all') AND telegram_id IS NOT NULL`).all();
    for (const s of supervisors) {
      sendToWorker(s, 'job_complete', jobVars(job, {
        CUSTOMER_NAME: job.customer_name || '',
        CUSTOMER_PHONE: job.customer_phone || '',
        TOTAL_TIME: totalTime,
      }));
    }
  }
}

function advanceJobStage(jobId, stage, personName, note = null) {
  const prevJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  db.prepare(`UPDATE jobs SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Stage updated via Telegram', ?)`).run(jobId, stage, personName, note);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  notifyNextStage(job, prevJob);
  return job;
}

function setLanguage(telegramId, language) {
  db.prepare('UPDATE workers SET language = ? WHERE telegram_id = ?').run(language, String(telegramId));
}

// Extracts a job card photo via Claude Vision, creates the job, and notifies
// the sender + supervisors. Restricted to jobcard_creator/supervisor/all roles.
async function handleJobCardPhoto(msg, workers, chatId) {
  const M = MESSAGES[languageOf(workers[0])];
  const creator = getWorkerAs(workers, 'jobcard_creator') || getWorkerAs(workers, 'supervisor');
  if (!creator) {
    sendTelegram(chatId, M.unknown_command);
    return;
  }

  try {
    const photo = msg.photo[msg.photo.length - 1];
    await botReady;
    const fileLink = await bot.getFileLink(photo.file_id);
    const res = await fetch(fileLink);
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: JOBCARD_VISION_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }],
      }],
    });

    const raw = response.content.map(block => block.text || '').join('');
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const fields = JSON.parse(cleaned);

    const job_number = (fields.job_number || '').trim() || `JOB${Date.now()}`;
    const car_plate = (fields.car_plate || '').trim() || 'UNKNOWN';
    const car_model = (fields.car_model || '').trim();
    const work_description = (fields.work_description || '').trim();
    const customer_name = (fields.customer_name || '').trim();
    const customer_phone = (fields.customer_phone || '').trim();

    const result = db.prepare(`
      INSERT INTO jobs (job_number, car_number, car_model, work_type, customer_name, customer_phone, current_stage)
      VALUES (?, ?, ?, ?, ?, ?, 'created')
    `).run(job_number, car_plate, car_model, work_description, customer_name, customer_phone);

    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'created', ?, 'Created via Telegram photo')`).run(result.lastInsertRowid, creator.name);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    const vars = jobVars(job, { CUSTOMER_NAME: customer_name, CUSTOMER_PHONE: customer_phone });

    sendTelegram(chatId, render(M.job_card_created, vars));

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all') AND telegram_id IS NOT NULL`).all();
    for (const s of supervisors) {
      sendToWorker(s, 'new_job_supervisor', jobVars(job));
    }
  } catch (err) {
    console.error('Job card extraction failed:', err.message);
    sendTelegram(chatId, M.extraction_failed);
  }
}

function onMessage(msg) {
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const body = (msg.text || msg.caption || '').trim();

  const workers = getWorkersByTelegramId(telegramId);
  if (!workers.length) {
    if (body) sendTelegram(chatId, MESSAGES.english.not_registered);
    return;
  }

  // ── Language selection (gates everything else until resolved) ───────────────
  if (!workers[0].language) {
    const choice = resolveLanguageChoice(body);
    if (choice) {
      setLanguage(telegramId, choice);
      sendTelegram(chatId, MESSAGES[choice].language_set);
      sendTelegram(chatId, MESSAGES[choice].commands_list);
    } else {
      sendTelegram(chatId, MESSAGES.english.welcome);
    }
    return;
  }

  // ── Photo → extract job card via Claude Vision ──────────────────────────────
  if (msg.photo && msg.photo.length) {
    handleJobCardPhoto(msg, workers, chatId).catch(err => console.error('Job card photo handling failed:', err.message));
    return;
  }

  if (!body) return;

  const lang = languageOf(workers[0]);
  const M = MESSAGES[lang];
  const lower = body.toLowerCase();

  // ── assign [name] → supervisor assigns mechanic to newest unassigned job ────
  if (lower.startsWith('assign ')) {
    const asSupervisor = getWorkerAs(workers, 'supervisor');
    if (!asSupervisor) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const nameInput = body.slice(7).trim();

    // Case-insensitive partial match; include 'all'-role workers as eligible mechanics
    const mechanic = db.prepare(
      `SELECT * FROM workers WHERE role IN ('mechanic', 'all') AND name LIKE ? LIMIT 1`
    ).get(`%${nameInput}%`);

    if (!mechanic) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'created' OR assigned_mechanic IS NULL ORDER BY created_at DESC LIMIT 1`).get();
    if (!job) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    db.prepare(`UPDATE jobs SET assigned_mechanic = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(mechanic.name, job.id);
    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'assigned', ?, 'Assigned via Telegram')`).run(job.id, asSupervisor.name);

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id);
    notifyNextStage(updated);
    sendTelegram(chatId, render(M.assigned_success, { JOB_NUMBER: job.job_number, MECHANIC_NAME: mechanic.name }));
    return;
  }

  // ── 1 → start / acknowledge active job ──────────────────────────────────────
  if (body === '1') {
    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

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
      sendTelegram(chatId, M.no_active_job);
      return;
    }

    if (activeAs === 'mechanic') {
      advanceJobStage(job.id, 'inprogress', activeWorker.name);
    } else {
      // Inspector/washer "1" is an acknowledgment — log it, stage stays the same
      db.prepare(
        `INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, ?, ?, 'Started via Telegram')`
      ).run(job.id, job.current_stage, activeWorker.name);
    }
    sendTelegram(chatId, render(M.job_started, { JOB_NUMBER: job.job_number }));
    return;
  }

  // ── 2 → advance job to next stage, notify next person ───────────────────────
  if (body === '2') {
    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

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
      sendTelegram(chatId, M.no_active_job);
      return;
    }

    advanceJobStage(job.id, nextStage, activeWorker.name);
    return;
  }

  // ── 3 → inspector fails inspection ──────────────────────────────────────────
  if (body === '3') {
    const asInspector = getWorkerAs(workers, 'inspector');
    if (!asInspector) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(
      `SELECT * FROM jobs WHERE assigned_inspector = ? AND current_stage = 'qc' ORDER BY updated_at DESC LIMIT 1`
    ).get(asInspector.name);

    if (!job) {
      sendTelegram(chatId, M.no_active_job);
      return;
    }

    advanceJobStage(job.id, 'failed_qc', asInspector.name, 'Failed inspection');
    return;
  }

  // ── delay [reason] → log delay, notify supervisor ───────────────────────────
  if (lower.startsWith('delay ')) {
    const reason = body.slice(6).trim();

    const asMechanic  = getWorkerAs(workers, 'mechanic');
    const asInspector = getWorkerAs(workers, 'inspector');
    const asWasher    = getWorkerAs(workers, 'washer');

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
      sendTelegram(chatId, M.no_active_job);
      return;
    }

    db.prepare(
      `INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Delay reported via Telegram', ?)`
    ).run(job.id, job.current_stage, activeWorker.name, `DELAY: ${reason}`);

    const delayMsg = render(M.delay_logged, { JOB_NUMBER: job.job_number, REASON: reason });
    sendTelegram(chatId, delayMsg);

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('supervisor', 'all') AND telegram_id IS NOT NULL`).all();
    for (const s of supervisors) {
      sendToWorker(s, 'delay_logged', { JOB_NUMBER: job.job_number, REASON: reason });
    }
    return;
  }

  // ── status → list active jobs ────────────────────────────────────────────────
  if (lower === 'status') {
    const activeJobs = db.prepare(
      `SELECT * FROM jobs WHERE current_stage != 'done' ORDER BY created_at DESC LIMIT 20`
    ).all();

    const jobList = activeJobs.length
      ? activeJobs.map(j => `#${j.job_number} | ${j.car_number} | ${j.current_stage}${j.assigned_mechanic ? ` | ${j.assigned_mechanic}` : ''}`).join('\n')
      : '—';

    const delayedCount = db.prepare(`
      SELECT COUNT(DISTINCT job_id) AS n FROM stage_logs
      WHERE note LIKE 'DELAY:%' AND job_id IN (SELECT id FROM jobs WHERE current_stage != 'done')
    `).get().n;

    const completedToday = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs WHERE current_stage = 'done' AND date(updated_at) = date('now')
    `).get().n;

    sendTelegram(chatId, render(M.status, {
      COUNT: activeJobs.length,
      JOB_LIST: jobList,
      DELAYED_COUNT: delayedCount,
      COMPLETED_COUNT: completedToday,
    }));
    return;
  }

  // ── Unknown command → help ───────────────────────────────────────────────────
  sendTelegram(chatId, M.unknown_command);
}

// ── Link a worker's Telegram ID by name ────────────────────────────────────────
// The worker must already exist in the `workers` table (e.g. added via
// POST /api/workers). Linking resets `language` to null so language selection
// runs again on their next message.
router.post('/api/workers/telegram', (req, res) => {
  const { name, telegram_id, role } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id is required' });

  const where = role?.trim() ? 'name = ? AND role = ?' : 'name = ?';
  const params = role?.trim() ? [name.trim(), role.trim()] : [name.trim()];

  const result = db.prepare(`UPDATE workers SET telegram_id = ?, language = NULL WHERE ${where}`).run(String(telegram_id), ...params);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Worker not found. Add them first via POST /api/workers.' });
  }

  res.json({ success: true, telegram_id: String(telegram_id), updated: result.changes });
});

module.exports = router;
module.exports.notifyNextStage = notifyNextStage;
module.exports.sendTelegram = sendTelegram;
