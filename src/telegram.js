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
 * ROLES: advisor, floor_supervisor, technician, electrician, denter,
 * test_driver, washer, all (acts as any role).
 *
 * Stage flow: created → assigned → in_progress → test_drive → billing_washing → done
 *   billing_washing is a parallel phase: billing (advisor) and washing (washer)
 *   happen independently; the job only reaches 'done' once both are complete.
 *   A failed test drive sends the job back to in_progress with the assigned
 *   specialist.
 *
 * Technicians, electricians, denters and washers act via the floor kiosk
 * (see public/floor.html + the /api/jobs/:id/floor-* and /washing-done
 * endpoints in src/index.js), not via Telegram replies.
 *
 * Commands:
 *   assign [name]   floor_supervisor/all: assign a specialist to the newest unassigned job
 *   2               test_driver/all: pass test drive · advisor/all: mark billing done
 *   3               test_driver/all: fail test drive, send car back to its specialist
 *   delay [reason]  any worker: report delay on current job
 *   status          any worker: list all active jobs
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db/database');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JOBCARD_VISION_PROMPT = "You are extracting data from a Maruti Suzuki service job card. Extract these fields exactly as they appear: job_number, car_model, car_plate, customer_name, customer_phone, work_description. Return ONLY a valid JSON object with these exact keys, no other text.";

const SPECIALIST_ROLES = ['technician', 'electrician', 'denter'];
const ROLE_LABELS = {
  technician: 'Technician', electrician: 'Electrician', denter: 'Denter',
  test_driver: 'Test Driver', washer: 'Washer', advisor: 'Advisor',
  floor_supervisor: 'Floor Supervisor', all: 'All Roles',
};

const MESSAGES = {
  english: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    language_set: "✅ Language set! You can now use the bot.",
    commands_list: "Available commands:\nassign [name] — Assign a specialist to the newest unassigned job (floor supervisor)\n2 — Pass test drive (test driver) / mark billing done (advisor)\n3 — Fail test drive, send car back to specialist (test driver)\ndelay [reason] — Report a delay\nstatus — View all active jobs\n\nTechnicians, electricians, denters & washers: use the floor kiosk to start and mark jobs done.",
    unknown_command: "❓ Command not recognized.\n\nAvailable commands:\nassign [name] — Assign a specialist to the newest unassigned job (floor supervisor)\n2 — Pass test drive (test driver) / mark billing done (advisor)\n3 — Fail test drive, send car back to specialist (test driver)\ndelay [reason] — Report a delay\nstatus — View all active jobs",
    not_registered: "You are not registered in the system. Contact your supervisor.",
    no_active_job: "You have no active job assigned to you.",
    status: "📋 Active Jobs ({COUNT})\n\n{JOB_LIST}\n\nDelayed: {DELAYED_COUNT}\nCompleted today: {COMPLETED_COUNT}",
    delay_logged: "⚠️ Delay logged for #{JOB_NUMBER}.\nReason: {REASON}",
    job_card_created: "✅ Job card created!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nWork: {WORK_TYPE}",
    extraction_failed: "⚠️ Could not read the job card clearly. Please retake the photo with better lighting and make sure all fields are visible.",
    new_job_floor_supervisor: "🆕 New Job Card\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nReply \"assign [specialist name]\" to assign a technician, electrician or denter.",
    assigned_success: "✅ Job #{JOB_NUMBER} assigned to {SPECIALIST_NAME} ({SPECIALIST_ROLE}). They have been notified.",
    job_assigned_specialist: "🔧 New Job Assigned\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nUse the floor kiosk to start the job, and mark it done when finished.",
    ready_test_drive: "🚗 Ready for Test Drive\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nSpecialist: {SPECIALIST_NAME}\nTime taken: {ELAPSED_TIME}\n\nReply 2 if the car passes.\nReply 3 if the car fails.",
    test_drive_failed_specialist: "❌ Test Drive Failed\n#{JOB_NUMBER} — {CAR_MODEL} needs more work.\nNote: {NOTE}\n\nPlease fix the issue and mark the job done again on the floor kiosk when ready for re-test.",
    test_drive_failed_supervisor: "⚠️ Test Drive Failed\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) failed the test drive and was sent back to {SPECIALIST_NAME}.\nNote: {NOTE}",
    ready_billing: "🧾 Ready for Billing\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nPassed test drive ✓\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nReply 2 when billing is complete.",
    ready_washing: "🚿 Ready for Washing\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nPassed test drive ✓\n\nUse the floor kiosk to start washing, and mark it done when finished.",
    billing_marked_done: "✅ Billing marked complete for #{JOB_NUMBER}.",
    job_complete: "✅ Job Complete\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nBilling and washing are both done — car is ready for pickup. Please notify the customer.\nTotal time: {TOTAL_TIME}",
  },
  hindi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    language_set: "✅ भाषा सेट हो गई! अब आप बॉट का उपयोग कर सकते हैं।",
    commands_list: "उपलब्ध कमांड:\nassign [नाम] — नए काम के लिए स्पेशलिस्ट असाइन करें (फ्लोर सुपरवाइज़र)\n2 — टेस्ट ड्राइव पास (टेस्ट ड्राइवर) / बिलिंग पूरी (एडवाइज़र)\n3 — टेस्ट ड्राइव फेल, गाड़ी वापस स्पेशलिस्ट को भेजें (टेस्ट ड्राइवर)\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें\n\nटेक्नीशियन, इलेक्ट्रीशियन, डेंटर और वॉशर: काम शुरू/पूरा करने के लिए फ्लोर कियोस्क का उपयोग करें।",
    unknown_command: "❓ यह कमांड नहीं पहचानी।\n\nउपलब्ध कमांड:\nassign [नाम] — नए काम के लिए स्पेशलिस्ट असाइन करें (फ्लोर सुपरवाइज़र)\n2 — टेस्ट ड्राइव पास (टेस्ट ड्राइवर) / बिलिंग पूरी (एडवाइज़र)\n3 — टेस्ट ड्राइव फेल, गाड़ी वापस स्पेशलिस्ट को भेजें (टेस्ट ड्राइवर)\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें",
    not_registered: "आप सिस्टम में रजिस्टर नहीं हैं। अपने सुपरवाइज़र से संपर्क करें।",
    no_active_job: "आपको कोई सक्रिय काम नहीं सौंपा गया है।",
    status: "📋 चालू काम ({COUNT})\n\n{JOB_LIST}\n\nदेरी: {DELAYED_COUNT}\nआज पूरे हुए: {COMPLETED_COUNT}",
    delay_logged: "⚠️ #{JOB_NUMBER} की देरी दर्ज हो गई।\nकारण: {REASON}",
    job_card_created: "✅ जॉब कार्ड बन गया!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    extraction_failed: "⚠️ जॉब कार्ड साफ़ नहीं पढ़ा जा सका। कृपया बेहतर रोशनी में फिर से फोटो लें और सुनिश्चित करें कि सभी जानकारी दिख रही हो।",
    new_job_floor_supervisor: "🆕 नया जॉब कार्ड\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nस्पेशलिस्ट असाइन करने के लिए \"assign [नाम]\" लिखें।",
    assigned_success: "✅ काम #{JOB_NUMBER} {SPECIALIST_NAME} ({SPECIALIST_ROLE}) को दे दिया गया। उन्हें सूचित कर दिया गया है।",
    job_assigned_specialist: "🔧 नया काम मिला है\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम शुरू करने और पूरा होने पर मार्क करने के लिए फ्लोर कियोस्क का उपयोग करें।",
    ready_test_drive: "🚗 टेस्ट ड्राइव के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nस्पेशलिस्ट: {SPECIALIST_NAME}\nलगा समय: {ELAPSED_TIME}\n\nपास होने पर 2 लिखें।\nफेल होने पर 3 लिखें।",
    test_drive_failed_specialist: "❌ टेस्ट ड्राइव फेल\n#{JOB_NUMBER} — {CAR_MODEL} को और काम चाहिए।\nनोट: {NOTE}\n\nकृपया ठीक करें और तैयार होने पर फ्लोर कियोस्क पर दोबारा डन मार्क करें।",
    test_drive_failed_supervisor: "⚠️ टेस्ट ड्राइव फेल\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) टेस्ट ड्राइव में फेल हो गया और {SPECIALIST_NAME} को वापस भेजा गया।\nनोट: {NOTE}",
    ready_billing: "🧾 बिलिंग के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव पास ✓\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग पूरी होने पर 2 लिखें।",
    ready_washing: "🚿 धुलाई के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव पास ✓\n\nशुरू करने और पूरा होने पर मार्क करने के लिए फ्लोर कियोस्क का उपयोग करें।",
    billing_marked_done: "✅ #{JOB_NUMBER} की बिलिंग पूरी दर्ज हो गई।",
    job_complete: "✅ काम पूरा हो गया\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग और धुलाई दोनों पूरी हो गई — गाड़ी लेने के लिए तैयार है। कृपया ग्राहक को सूचित करें।\nकुल समय: {TOTAL_TIME}",
  },
  marathi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    language_set: "✅ भाषा सेट झाली! आता तुम्ही बॉट वापरू शकता.",
    commands_list: "उपलब्ध कमांड:\nassign [नाव] — नवीन कामासाठी स्पेशालिस्ट नियुक्त करा (फ्लोर सुपरवायझर)\n2 — टेस्ट ड्राइव्ह पास (टेस्ट ड्रायव्हर) / बिलिंग पूर्ण (अ‍ॅडव्हायझर)\n3 — टेस्ट ड्राइव्ह फेल, गाडी स्पेशालिस्टकडे परत पाठवा (टेस्ट ड्रायव्हर)\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा\n\nटेक्निशियन, इलेक्ट्रिशियन, डेंटर आणि वॉशर: काम सुरू/पूर्ण करण्यासाठी फ्लोर किऑस्क वापरा.",
    unknown_command: "❓ हे कमांड ओळखले नाही.\n\nउपलब्ध कमांड:\nassign [नाव] — नवीन कामासाठी स्पेशालिस्ट नियुक्त करा (फ्लोर सुपरवायझर)\n2 — टेस्ट ड्राइव्ह पास (टेस्ट ड्रायव्हर) / बिलिंग पूर्ण (अ‍ॅडव्हायझर)\n3 — टेस्ट ड्राइव्ह फेल, गाडी स्पेशालिस्टकडे परत पाठवा (टेस्ट ड्रायव्हर)\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा",
    not_registered: "तुम्ही सिस्टममध्ये नोंदणीकृत नाही. तुमच्या सुपरवायझरशी संपर्क साधा.",
    no_active_job: "तुम्हाला कोणतेही सक्रिय काम दिलेले नाही.",
    status: "📋 सध्याची कामे ({COUNT})\n\n{JOB_LIST}\n\nउशीर: {DELAYED_COUNT}\nआज पूर्ण: {COMPLETED_COUNT}",
    delay_logged: "⚠️ #{JOB_NUMBER} चा उशीर नोंदवला गेला.\nकारण: {REASON}",
    job_card_created: "✅ जॉब कार्ड तयार झाले!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    extraction_failed: "⚠️ जॉब कार्ड स्पष्ट वाचता आले नाही. कृपया चांगल्या प्रकाशात पुन्हा फोटो घ्या आणि सर्व माहिती दिसत आहे याची खात्री करा.",
    new_job_floor_supervisor: "🆕 नवीन जॉब कार्ड\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nस्पेशालिस्ट नियुक्त करण्यासाठी \"assign [नाव]\" लिहा.",
    assigned_success: "✅ काम #{JOB_NUMBER} {SPECIALIST_NAME} ({SPECIALIST_ROLE}) ला दिले गेले. त्यांना कळवले गेले आहे.",
    job_assigned_specialist: "🔧 नवीन काम मिळाले आहे\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम सुरू करण्यासाठी आणि पूर्ण झाल्यावर मार्क करण्यासाठी फ्लोर किऑस्क वापरा.",
    ready_test_drive: "🚗 टेस्ट ड्राइव्हसाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nस्पेशालिस्ट: {SPECIALIST_NAME}\nलागलेला वेळ: {ELAPSED_TIME}\n\nपास झाल्यावर 2 लिहा.\nफेल झाल्यावर 3 लिहा.",
    test_drive_failed_specialist: "❌ टेस्ट ड्राइव्ह फेल\n#{JOB_NUMBER} — {CAR_MODEL} ला अजून काम हवे आहे.\nनोंद: {NOTE}\n\nकृपया दुरुस्त करा आणि तयार झाल्यावर फ्लोर किऑस्कवर पुन्हा डन मार्क करा.",
    test_drive_failed_supervisor: "⚠️ टेस्ट ड्राइव्ह फेल\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) टेस्ट ड्राइव्हमध्ये फेल झाले आणि {SPECIALIST_NAME} कडे परत पाठवले.\nनोंद: {NOTE}",
    ready_billing: "🧾 बिलिंगसाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव्ह पास ✓\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग पूर्ण झाल्यावर 2 लिहा.",
    ready_washing: "🚿 धुण्यासाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव्ह पास ✓\n\nसुरू करण्यासाठी आणि पूर्ण झाल्यावर मार्क करण्यासाठी फ्लोर किऑस्क वापरा.",
    billing_marked_done: "✅ #{JOB_NUMBER} चे बिलिंग पूर्ण नोंदवले गेले.",
    job_complete: "✅ काम पूर्ण झाले\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग आणि धुलाई दोन्ही पूर्ण झाले — गाडी घेण्यासाठी तयार आहे. कृपया ग्राहकाला कळवा.\nएकूण वेळ: {TOTAL_TIME}",
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

// Central notification dispatcher — sends the relevant Telegram message(s)
// for whatever stage `job` is now in. Shared by the Telegram command handlers
// below and by the REST API in src/index.js (dashboard + floor kiosk), so a
// stage change always notifies the right person regardless of which channel
// triggered it.
function notifyNextStage(job, prevJob = null) {
  const { current_stage: stage, id } = job;

  if (stage === 'created') {
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND telegram_id IS NOT NULL`).all();
    for (const s of supervisors) sendToWorker(s, 'new_job_floor_supervisor', jobVars(job));

  } else if (stage === 'assigned') {
    const specialist = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('technician', 'electrician', 'denter', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get(job.assigned_mechanic);
    if (specialist) sendToWorker(specialist, 'job_assigned_specialist', jobVars(job));

  } else if (stage === 'test_drive') {
    const testDriver = db.prepare(
      `SELECT * FROM workers WHERE role IN ('test_driver', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get();
    if (testDriver) {
      db.prepare(`UPDATE jobs SET assigned_test_driver = ? WHERE id = ?`).run(testDriver.name, id);
      const elapsed = prevJob ? formatDuration(minutesSince(prevJob.updated_at)) : '—';
      sendToWorker(testDriver, 'ready_test_drive', jobVars(job, { SPECIALIST_NAME: job.assigned_mechanic || '', ELAPSED_TIME: elapsed }));
    }

  } else if (stage === 'billing_washing') {
    const advisor = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('advisor', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get(job.created_by);
    if (advisor) {
      sendToWorker(advisor, 'ready_billing', jobVars(job, {
        CUSTOMER_NAME: job.customer_name || '',
        CUSTOMER_PHONE: job.customer_phone || '',
      }));
    }

    const washers = db.prepare(`SELECT * FROM workers WHERE role IN ('washer', 'all') AND telegram_id IS NOT NULL`).all();
    for (const w of washers) sendToWorker(w, 'ready_washing', jobVars(job));

  } else if (stage === 'done') {
    const totalTime = formatDuration(minutesSince(job.created_at));
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND telegram_id IS NOT NULL`).all();
    const advisor = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('advisor', 'all') AND telegram_id IS NOT NULL LIMIT 1`
    ).get(job.created_by);

    const recipients = advisor ? [...supervisors, advisor] : supervisors;
    for (const r of recipients) {
      sendToWorker(r, 'job_complete', jobVars(job, {
        CUSTOMER_NAME: job.customer_name || '',
        CUSTOMER_PHONE: job.customer_phone || '',
        TOTAL_TIME: totalTime,
      }));
    }
  }
}

// Generic stage transition: updates the job, logs it, and notifies whoever's
// next. Used for created→assigned, assigned→in_progress (floor kiosk start),
// in_progress→test_drive (floor kiosk done), and manual/admin overrides.
function advanceJobStage(jobId, stage, personName, note = null) {
  const prevJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  db.prepare(`UPDATE jobs SET current_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stage, jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Stage updated', ?)`).run(jobId, stage, personName, note);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  notifyNextStage(job, prevJob);
  return job;
}

// Floor supervisor assigns a technician/electrician/denter to a newly created job.
function assignSpecialist(jobId, specialistWorker, byPersonName) {
  const prevJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  db.prepare(`
    UPDATE jobs SET assigned_mechanic = ?, specialist_role = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(specialistWorker.name, specialistWorker.role, jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'assigned', ?, 'Assigned to specialist')`).run(jobId, byPersonName);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  notifyNextStage(job, prevJob);
  return job;
}

// Test drive passed: kicks off billing (advisor) and washing (washer) in parallel.
function passTestDrive(jobId, testDriverName) {
  const prevJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  db.prepare(`
    UPDATE jobs SET current_stage = 'billing_washing', billing_done = 0, washing_done = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'billing_washing', ?, 'Passed test drive')`).run(jobId, testDriverName);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  notifyNextStage(job, prevJob);
  return job;
}

// Test drive failed: sends the car back to its specialist with a failure
// note, and alerts the floor supervisor.
function failTestDrive(jobId, testDriverName, note) {
  const failureNote = note || 'Failed test drive';
  db.prepare(`
    UPDATE jobs SET current_stage = 'in_progress', test_drive_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(failureNote, jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, 'in_progress', ?, 'Failed test drive', ?)`).run(jobId, testDriverName, failureNote);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

  const specialist = db.prepare(
    `SELECT * FROM workers WHERE name = ? AND telegram_id IS NOT NULL LIMIT 1`
  ).get(job.assigned_mechanic);
  if (specialist) sendToWorker(specialist, 'test_drive_failed_specialist', jobVars(job, { NOTE: failureNote }));

  const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND telegram_id IS NOT NULL`).all();
  for (const s of supervisors) {
    sendToWorker(s, 'test_drive_failed_supervisor', jobVars(job, { SPECIALIST_NAME: job.assigned_mechanic || '', NOTE: failureNote }));
  }
  return job;
}

// Marks a job's billing as complete (advisor) — see markWashingDone for the
// other half of the parallel billing_washing phase.
function markBillingDone(jobId, personName) {
  db.prepare(`UPDATE jobs SET billing_done = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'billing_washing', ?, 'Billing marked done')`).run(jobId, personName);
  return maybeCompleteJob(jobId, personName);
}

// Marks a job's washing as complete (washer, via floor kiosk).
function markWashingDone(jobId, personName) {
  db.prepare(`UPDATE jobs SET washing_done = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'billing_washing', ?, 'Washing marked done')`).run(jobId, personName);
  return maybeCompleteJob(jobId, personName);
}

// Once both billing and washing are done, the job moves to 'done'.
function maybeCompleteJob(jobId, personName) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (job.billing_done && job.washing_done) {
    return advanceJobStage(jobId, 'done', personName);
  }
  return job;
}

function setLanguage(telegramId, language) {
  db.prepare('UPDATE workers SET language = ? WHERE telegram_id = ?').run(language, String(telegramId));
}

// Extracts a job card photo via Claude Vision, creates the job, and notifies
// the sender + floor supervisors. Restricted to advisor/floor_supervisor/all roles.
async function handleJobCardPhoto(msg, workers, chatId) {
  const M = MESSAGES[languageOf(workers[0])];
  const creator = getWorkerAs(workers, 'advisor') || getWorkerAs(workers, 'floor_supervisor');
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
      INSERT INTO jobs (job_number, car_number, car_model, work_type, customer_name, customer_phone, created_by, current_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created')
    `).run(job_number, car_plate, car_model, work_description, customer_name, customer_phone, creator.name);

    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'created', ?, 'Created via Telegram photo')`).run(result.lastInsertRowid, creator.name);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    const vars = jobVars(job, { CUSTOMER_NAME: customer_name, CUSTOMER_PHONE: customer_phone });

    sendTelegram(chatId, render(M.job_card_created, vars));
    notifyNextStage(job);
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

  // ── assign [name] → floor supervisor assigns a specialist to newest job ─────
  if (lower.startsWith('assign ')) {
    const asSupervisor = getWorkerAs(workers, 'floor_supervisor');
    if (!asSupervisor) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const nameInput = body.slice(7).trim();

    // Case-insensitive partial match; include 'all'-role workers as eligible specialists
    const specialist = db.prepare(
      `SELECT * FROM workers WHERE role IN ('technician', 'electrician', 'denter', 'all') AND name LIKE ? LIMIT 1`
    ).get(`%${nameInput}%`);

    if (!specialist) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'created' OR assigned_mechanic IS NULL ORDER BY created_at DESC LIMIT 1`).get();
    if (!job) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    assignSpecialist(job.id, specialist, asSupervisor.name);
    sendTelegram(chatId, render(M.assigned_success, {
      JOB_NUMBER: job.job_number,
      SPECIALIST_NAME: specialist.name,
      SPECIALIST_ROLE: ROLE_LABELS[specialist.role] || specialist.role,
    }));
    return;
  }

  // ── 2 → test driver passes test drive, or advisor marks billing done ────────
  if (body === '2') {
    const asTestDriver = getWorkerAs(workers, 'test_driver');
    if (asTestDriver) {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE assigned_test_driver = ? AND current_stage = 'test_drive' ORDER BY updated_at DESC LIMIT 1`
      ).get(asTestDriver.name);
      if (job) {
        passTestDrive(job.id, asTestDriver.name);
        return;
      }
    }

    const asAdvisor = getWorkerAs(workers, 'advisor');
    if (asAdvisor) {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE created_by = ? AND current_stage = 'billing_washing' AND (billing_done IS NULL OR billing_done = 0) ORDER BY updated_at DESC LIMIT 1`
      ).get(asAdvisor.name);
      if (job) {
        markBillingDone(job.id, asAdvisor.name);
        sendTelegram(chatId, render(M.billing_marked_done, { JOB_NUMBER: job.job_number }));
        return;
      }
    }

    sendTelegram(chatId, M.no_active_job);
    return;
  }

  // ── 3 → test driver fails test drive, sends car back to specialist ──────────
  if (body === '3') {
    const asTestDriver = getWorkerAs(workers, 'test_driver');
    if (!asTestDriver) {
      sendTelegram(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(
      `SELECT * FROM jobs WHERE assigned_test_driver = ? AND current_stage = 'test_drive' ORDER BY updated_at DESC LIMIT 1`
    ).get(asTestDriver.name);

    if (!job) {
      sendTelegram(chatId, M.no_active_job);
      return;
    }

    failTestDrive(job.id, asTestDriver.name, 'Failed test drive');
    return;
  }

  // ── delay [reason] → log delay, notify floor supervisor ─────────────────────
  if (lower.startsWith('delay ')) {
    const reason = body.slice(6).trim();

    const asSpecialist = SPECIALIST_ROLES.map(r => getWorkerAs(workers, r)).find(Boolean);
    const asTestDriver  = getWorkerAs(workers, 'test_driver');
    const asWasher      = getWorkerAs(workers, 'washer');
    const asAdvisor     = getWorkerAs(workers, 'advisor');

    let job = null, activeWorker = null;

    if (asSpecialist) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage IN ('assigned', 'in_progress') ORDER BY updated_at DESC LIMIT 1`
      ).get(asSpecialist.name);
      if (j) { job = j; activeWorker = asSpecialist; }
    }
    if (!job && asTestDriver) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE assigned_test_driver = ? AND current_stage = 'test_drive' ORDER BY updated_at DESC LIMIT 1`
      ).get(asTestDriver.name);
      if (j) { job = j; activeWorker = asTestDriver; }
    }
    if (!job && asWasher) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE current_stage = 'billing_washing' AND (washing_done IS NULL OR washing_done = 0) ORDER BY updated_at DESC LIMIT 1`
      ).get();
      if (j) { job = j; activeWorker = asWasher; }
    }
    if (!job && asAdvisor) {
      const j = db.prepare(
        `SELECT * FROM jobs WHERE created_by = ? AND current_stage = 'billing_washing' AND (billing_done IS NULL OR billing_done = 0) ORDER BY updated_at DESC LIMIT 1`
      ).get(asAdvisor.name);
      if (j) { job = j; activeWorker = asAdvisor; }
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

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND telegram_id IS NOT NULL`).all();
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
module.exports.SPECIALIST_ROLES = SPECIALIST_ROLES;
module.exports.notifyNextStage = notifyNextStage;
module.exports.sendTelegram = sendTelegram;
module.exports.advanceJobStage = advanceJobStage;
module.exports.assignSpecialist = assignSpecialist;
module.exports.passTestDrive = passTestDrive;
module.exports.failTestDrive = failTestDrive;
module.exports.markBillingDone = markBillingDone;
module.exports.markWashingDone = markWashingDone;
