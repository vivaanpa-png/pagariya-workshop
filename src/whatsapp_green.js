/*
 * WhatsApp bot (Green API)
 *
 * A WhatsApp integration built on Green API (https://green-api.com).
 * Workers are identified by phone number — the same `phone` column already
 * used elsewhere in the app — so there is no separate "linking" step.
 *
 * SETUP: Set GREEN_API_INSTANCE_ID and GREEN_API_TOKEN in .env. On server
 * startup, setWebhook() points the Green API instance's webhookUrl at
 * POST /webhook/whatsapp-green on this server.
 *
 * LANGUAGE SELECTION: the first time a worker messages the bot, they're
 * shown a language picker (1 - English, 2 - Hindi, 3 - Marathi). Their
 * choice is saved to `workers.language`.
 *
 * ROLES: advisor, floor_supervisor, technician, electrician, denter,
 * test_driver, washer, all (acts as any role — bypasses every role check
 * below).
 *
 * Stage flow: created → assigned → in_progress → test_drive → billing_washing → done
 *   billing_washing is a parallel phase: billing (advisor) and washing
 *   (washer) happen independently; the job only reaches 'done' once both
 *   are complete. A failed test drive sends the job back to in_progress
 *   with the assigned specialist.
 *
 * Commands:
 *   assign [name]   floor_supervisor/all: assign a specialist to the newest unassigned job
 *   1               technician/electrician/denter/all: start your assigned job
 *   2               technician/electrician/denter/all: mark repair done (→ test drive)
 *                   test_driver/all: pass test drive
 *                   washer/all: mark washing done
 *                   advisor/all: mark billing done
 *   3               test_driver/all: fail test drive, send car back to its specialist
 *   delay [reason]  any worker: report delay on current job
 *   status          any worker: list all active jobs
 *
 *   A photo of a job card is OCR'd via Claude Vision and creates a job.
 */

const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db/database');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INSTANCE_ID = process.env.GREEN_API_INSTANCE_ID;
const API_TOKEN = process.env.GREEN_API_TOKEN;
const BASE_URL = `https://api.greenapi.com/waInstance${INSTANCE_ID}`;

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
    commands_list: "Available commands:\nassign [name] — Assign a specialist to the newest unassigned job (floor supervisor)\n1 — Start your assigned job (technician/electrician/denter)\n2 — Mark your part done: advance repair (specialist) / pass test drive (test driver) / mark washing done (washer) / mark billing done (advisor)\n3 — Fail test drive, send car back to specialist (test driver)\ndelay [reason] — Report a delay\nstatus — View all active jobs",
    unknown_command: "❓ Command not recognized.\n\nAvailable commands:\nassign [name] — Assign a specialist to the newest unassigned job (floor supervisor)\n1 — Start your assigned job (technician/electrician/denter)\n2 — Mark your part done: advance repair (specialist) / pass test drive (test driver) / mark washing done (washer) / mark billing done (advisor)\n3 — Fail test drive, send car back to specialist (test driver)\ndelay [reason] — Report a delay\nstatus — View all active jobs",
    not_registered: "You are not registered in the system. Contact your supervisor.",
    no_active_job: "You have no active job assigned to you.",
    status: "📋 Active Jobs ({COUNT})\n\n{JOB_LIST}\n\nDelayed: {DELAYED_COUNT}\nCompleted today: {COMPLETED_COUNT}",
    delay_logged: "⚠️ Delay logged for #{JOB_NUMBER}.\nReason: {REASON}",
    job_card_created: "✅ Job card created!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nWork: {WORK_TYPE}",
    extraction_failed: "⚠️ Could not read the job card clearly. Please retake the photo with better lighting and make sure all fields are visible.",
    new_job_floor_supervisor: "🆕 New Job Card\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nReply \"assign [specialist name]\" to assign a technician, electrician or denter.",
    assigned_success: "✅ Job #{JOB_NUMBER} assigned to {SPECIALIST_NAME} ({SPECIALIST_ROLE}). They have been notified.",
    job_assigned_specialist: "🔧 New Job Assigned\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nWork: {WORK_TYPE}\n\nReply 1 when you start work.\nReply 2 when the repair is done.",
    ready_test_drive: "🚗 Ready for Test Drive\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nSpecialist: {SPECIALIST_NAME}\nTime taken: {ELAPSED_TIME}\n\nReply 2 if the car passes.\nReply 3 if the car fails.",
    test_drive_failed_specialist: "❌ Test Drive Failed\n#{JOB_NUMBER} — {CAR_MODEL} needs more work.\nNote: {NOTE}\n\nPlease fix the issue and reply 2 again when ready for re-test.",
    test_drive_failed_supervisor: "⚠️ Test Drive Failed\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) failed the test drive and was sent back to {SPECIALIST_NAME}.\nNote: {NOTE}",
    ready_billing: "🧾 Ready for Billing\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nPassed test drive ✓\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nReply 2 when billing is complete.",
    ready_washing: "🚿 Ready for Washing\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nPassed test drive ✓\n\nReply 1 when you start.\nReply 2 when washing is complete.",
    billing_marked_done: "✅ Billing marked complete for #{JOB_NUMBER}.",
    washing_marked_done: "✅ Washing marked complete for #{JOB_NUMBER}.",
    job_complete: "✅ Job Complete\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nCustomer: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nBilling and washing are both done — car is ready for pickup. Please notify the customer.\nTotal time: {TOTAL_TIME}",
  },
  hindi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    language_set: "✅ भाषा सेट हो गई! अब आप बॉट का उपयोग कर सकते हैं।",
    commands_list: "उपलब्ध कमांड:\nassign [नाम] — नए काम के लिए स्पेशलिस्ट असाइन करें (फ्लोर सुपरवाइज़र)\n1 — अपना असाइन किया काम शुरू करें (टेक्नीशियन/इलेक्ट्रीशियन/डेंटर)\n2 — अपना हिस्सा पूरा मार्क करें: मरम्मत आगे बढ़ाएं (स्पेशलिस्ट) / टेस्ट ड्राइव पास (टेस्ट ड्राइवर) / धुलाई पूरी (वॉशर) / बिलिंग पूरी (एडवाइज़र)\n3 — टेस्ट ड्राइव फेल, गाड़ी वापस स्पेशलिस्ट को भेजें (टेस्ट ड्राइवर)\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें",
    unknown_command: "❓ यह कमांड नहीं पहचानी।\n\nउपलब्ध कमांड:\nassign [नाम] — नए काम के लिए स्पेशलिस्ट असाइन करें (फ्लोर सुपरवाइज़र)\n1 — अपना असाइन किया काम शुरू करें (टेक्नीशियन/इलेक्ट्रीशियन/डेंटर)\n2 — अपना हिस्सा पूरा मार्क करें: मरम्मत आगे बढ़ाएं / टेस्ट ड्राइव पास / धुलाई पूरी / बिलिंग पूरी\n3 — टेस्ट ड्राइव फेल\ndelay [कारण] — देरी रिपोर्ट करें\nstatus — सभी चालू काम देखें",
    not_registered: "आप सिस्टम में रजिस्टर नहीं हैं। अपने सुपरवाइज़र से संपर्क करें।",
    no_active_job: "आपको कोई सक्रिय काम नहीं सौंपा गया है।",
    status: "📋 चालू काम ({COUNT})\n\n{JOB_LIST}\n\nदेरी: {DELAYED_COUNT}\nआज पूरे हुए: {COMPLETED_COUNT}",
    delay_logged: "⚠️ #{JOB_NUMBER} की देरी दर्ज हो गई।\nकारण: {REASON}",
    job_card_created: "✅ जॉब कार्ड बन गया!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    extraction_failed: "⚠️ जॉब कार्ड साफ़ नहीं पढ़ा जा सका। कृपया बेहतर रोशनी में फिर से फोटो लें और सुनिश्चित करें कि सभी जानकारी दिख रही हो।",
    new_job_floor_supervisor: "🆕 नया जॉब कार्ड\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nस्पेशलिस्ट असाइन करने के लिए \"assign [नाम]\" लिखें।",
    assigned_success: "✅ काम #{JOB_NUMBER} {SPECIALIST_NAME} ({SPECIALIST_ROLE}) को दे दिया गया। उन्हें सूचित कर दिया गया है।",
    job_assigned_specialist: "🔧 नया काम मिला है\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम शुरू करने पर 1 लिखें।\nमरम्मत पूरी होने पर 2 लिखें।",
    ready_test_drive: "🚗 टेस्ट ड्राइव के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nस्पेशलिस्ट: {SPECIALIST_NAME}\nलगा समय: {ELAPSED_TIME}\n\nपास होने पर 2 लिखें।\nफेल होने पर 3 लिखें।",
    test_drive_failed_specialist: "❌ टेस्ट ड्राइव फेल\n#{JOB_NUMBER} — {CAR_MODEL} को और काम चाहिए।\nनोट: {NOTE}\n\nकृपया ठीक करें और तैयार होने पर दोबारा 2 लिखें।",
    test_drive_failed_supervisor: "⚠️ टेस्ट ड्राइव फेल\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) टेस्ट ड्राइव में फेल हो गया और {SPECIALIST_NAME} को वापस भेजा गया।\nनोट: {NOTE}",
    ready_billing: "🧾 बिलिंग के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव पास ✓\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग पूरी होने पर 2 लिखें।",
    ready_washing: "🚿 धुलाई के लिए तैयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव पास ✓\n\nशुरू करने पर 1 लिखें।\nपूरा होने पर 2 लिखें।",
    billing_marked_done: "✅ #{JOB_NUMBER} की बिलिंग पूरी दर्ज हो गई।",
    washing_marked_done: "✅ #{JOB_NUMBER} की धुलाई पूरी दर्ज हो गई।",
    job_complete: "✅ काम पूरा हो गया\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग और धुलाई दोनों पूरी हो गई — गाड़ी लेने के लिए तैयार है। कृपया ग्राहक को सूचित करें।\nकुल समय: {TOTAL_TIME}",
  },
  marathi: {
    welcome: "Welcome to Pagariya Auto Workshop 🏭\n\nPlease select your language:\n1 - English\n2 - हिंदी (Hindi)\n3 - मराठी (Marathi)",
    language_set: "✅ भाषा सेट झाली! आता तुम्ही बॉट वापरू शकता.",
    commands_list: "उपलब्ध कमांड:\nassign [नाव] — नवीन कामासाठी स्पेशालिस्ट नियुक्त करा (फ्लोर सुपरवायझर)\n1 — तुमचे नियुक्त केलेले काम सुरू करा (टेक्निशियन/इलेक्ट्रिशियन/डेंटर)\n2 — तुमचा भाग पूर्ण मार्क करा: दुरुस्ती पुढे न्या (स्पेशालिस्ट) / टेस्ट ड्राइव्ह पास (टेस्ट ड्रायव्हर) / धुलाई पूर्ण (वॉशर) / बिलिंग पूर्ण (अ‍ॅडव्हायझर)\n3 — टेस्ट ड्राइव्ह फेल, गाडी स्पेशालिस्टकडे परत पाठवा (टेस्ट ड्रायव्हर)\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा",
    unknown_command: "❓ हे कमांड ओळखले नाही.\n\nउपलब्ध कमांड:\nassign [नाव] — नवीन कामासाठी स्पेशालिस्ट नियुक्त करा (फ्लोर सुपरवायझर)\n1 — तुमचे नियुक्त केलेले काम सुरू करा\n2 — तुमचा भाग पूर्ण मार्क करा\n3 — टेस्ट ड्राइव्ह फेल\ndelay [कारण] — उशीर नोंदवा\nstatus — सर्व चालू कामे पाहा",
    not_registered: "तुम्ही सिस्टममध्ये नोंदणीकृत नाही. तुमच्या सुपरवायझरशी संपर्क साधा.",
    no_active_job: "तुम्हाला कोणतेही सक्रिय काम दिलेले नाही.",
    status: "📋 सध्याची कामे ({COUNT})\n\n{JOB_LIST}\n\nउशीर: {DELAYED_COUNT}\nआज पूर्ण: {COMPLETED_COUNT}",
    delay_logged: "⚠️ #{JOB_NUMBER} चा उशीर नोंदवला गेला.\nकारण: {REASON}",
    job_card_created: "✅ जॉब कार्ड तयार झाले!\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\nकाम: {WORK_TYPE}",
    extraction_failed: "⚠️ जॉब कार्ड स्पष्ट वाचता आले नाही. कृपया चांगल्या प्रकाशात पुन्हा फोटो घ्या आणि सर्व माहिती दिसत आहे याची खात्री करा.",
    new_job_floor_supervisor: "🆕 नवीन जॉब कार्ड\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nस्पेशालिस्ट नियुक्त करण्यासाठी \"assign [नाव]\" लिहा.",
    assigned_success: "✅ काम #{JOB_NUMBER} {SPECIALIST_NAME} ({SPECIALIST_ROLE}) ला दिले गेले. त्यांना कळवले गेले आहे.",
    job_assigned_specialist: "🔧 नवीन काम मिळाले आहे\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nकाम: {WORK_TYPE}\n\nकाम सुरू केल्यावर 1 लिहा.\nदुरुस्ती पूर्ण झाल्यावर 2 लिहा.",
    ready_test_drive: "🚗 टेस्ट ड्राइव्हसाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nस्पेशालिस्ट: {SPECIALIST_NAME}\nलागलेला वेळ: {ELAPSED_TIME}\n\nपास झाल्यावर 2 लिहा.\nफेल झाल्यावर 3 लिहा.",
    test_drive_failed_specialist: "❌ टेस्ट ड्राइव्ह फेल\n#{JOB_NUMBER} — {CAR_MODEL} ला अजून काम हवे आहे.\nनोंद: {NOTE}\n\nकृपया दुरुस्त करा आणि तयार झाल्यावर पुन्हा 2 लिहा.",
    test_drive_failed_supervisor: "⚠️ टेस्ट ड्राइव्ह फेल\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE}) टेस्ट ड्राइव्हमध्ये फेल झाले आणि {SPECIALIST_NAME} कडे परत पाठवले.\nनोंद: {NOTE}",
    ready_billing: "🧾 बिलिंगसाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव्ह पास ✓\nग्राहक: {CUSTOMER_NAME} — {CUSTOMER_PHONE}\n\nबिलिंग पूर्ण झाल्यावर 2 लिहा.",
    ready_washing: "🚿 धुण्यासाठी तयार\n#{JOB_NUMBER} — {CAR_MODEL} ({CAR_PLATE})\nटेस्ट ड्राइव्ह पास ✓\n\nसुरू केल्यावर 1 लिहा.\nपूर्ण झाल्यावर 2 लिहा.",
    billing_marked_done: "✅ #{JOB_NUMBER} चे बिलिंग पूर्ण नोंदवले गेले.",
    washing_marked_done: "✅ #{JOB_NUMBER} चे धुलाई पूर्ण नोंदवले गेले.",
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

// Sends a WhatsApp message via Green API. Accepts either a full chatId
// ("919876543210@c.us") or a raw phone number in any format (with or
// without a leading +, spaces, dashes) — non-digits are stripped before
// appending "@c.us".
async function sendMessage(chatId, message) {
  const phone = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@c.us`;
  if (!INSTANCE_ID || !API_TOKEN) {
    console.error('Green API not configured (GREEN_API_INSTANCE_ID/GREEN_API_TOKEN missing) — cannot send WhatsApp message.');
    return;
  }
  try {
    await axios.post(`${BASE_URL}/sendMessage/${API_TOKEN}`, {
      chatId: phone,
      message: message
    });
  } catch (err) {
    console.error(`Green API send error to ${chatId}:`, err.response?.data || err.message);
  }
}

// Points the Green API instance's webhook at this server. Safe to call on
// every startup — it's idempotent (just overwrites the setting).
async function setWebhook() {
  if (!INSTANCE_ID || !API_TOKEN) {
    console.log('Green API not configured (GREEN_API_INSTANCE_ID/GREEN_API_TOKEN missing) — skipping webhook setup.');
    return;
  }
  try {
    await axios.post(`${BASE_URL}/setSettings/${API_TOKEN}`, {
      webhookUrl: 'https://pagariya-workshop-production.up.railway.app/webhook/whatsapp-green'
    });
    console.log('Green API webhook set');
  } catch (err) {
    console.error('Failed to configure Green API webhook:', err.response?.data || err.message);
  }
}

// Fills {PLACEHOLDER} tokens in a MESSAGES template with the given values.
function render(template, vars = {}) {
  return template.replace(/\{([A-Z_]+)\}/g, (_, key) => (vars[key] ?? ''));
}

// A worker's language column may be unset (mid-selection) or hold a value not in MESSAGES; default to English.
function languageOf(worker) {
  return worker?.language && MESSAGES[worker.language] ? worker.language : 'english';
}

function sendToWorkerWA(worker, key, vars) {
  sendMessage(worker.phone, render(MESSAGES[languageOf(worker)][key], vars));
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

// Strips everything but digits and keeps the last 10 — enough to match an
// Indian mobile number regardless of +91 / 0 / spacing / dash variations.
function normalizeLast10(raw) {
  return String(raw || '').replace(/\D/g, '').slice(-10);
}

// Returns all worker rows whose phone matches the given phone, by
// last-10-digit comparison (a phone may have multiple rows — different roles).
function getWorkersByPhone(phone) {
  const last10 = normalizeLast10(phone);
  if (!last10) return [];
  return db.prepare(`SELECT * FROM workers WHERE phone IS NOT NULL`).all()
    .filter(w => normalizeLast10(w.phone) === last10);
}

function setLanguage(workers, language) {
  const ids = workers.map(w => w.id);
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE workers SET language = ? WHERE id IN (${placeholders})`).run(language, ...ids);
}

// Returns the worker entry that can act as any of the given roles: prefers
// an exact match on one of `roles`, otherwise falls back to a worker whose
// role is 'all' (which can act as — and bypasses the role check for — every
// command in this file), otherwise null.
function getWorkerAs(workers, ...roles) {
  return workers.find(w => roles.includes(w.role))
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

// Central notification dispatcher — sends the relevant WhatsApp message(s)
// for whatever stage `job` is now in.
function notifyNextStage(job, prevJob = null) {
  const { current_stage: stage, id } = job;

  if (stage === 'created') {
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND phone IS NOT NULL`).all();
    for (const s of supervisors) sendToWorkerWA(s, 'new_job_floor_supervisor', jobVars(job));

  } else if (stage === 'assigned') {
    const specialist = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('technician', 'electrician', 'denter', 'all') AND phone IS NOT NULL LIMIT 1`
    ).get(job.assigned_mechanic);
    if (specialist) sendToWorkerWA(specialist, 'job_assigned_specialist', jobVars(job));

  } else if (stage === 'test_drive') {
    const testDriver = db.prepare(
      `SELECT * FROM workers WHERE role IN ('test_driver', 'all') AND phone IS NOT NULL LIMIT 1`
    ).get();
    if (testDriver) {
      db.prepare(`UPDATE jobs SET assigned_test_driver = ? WHERE id = ?`).run(testDriver.name, id);
      const elapsed = prevJob ? formatDuration(minutesSince(prevJob.updated_at)) : '—';
      sendToWorkerWA(testDriver, 'ready_test_drive', jobVars(job, { SPECIALIST_NAME: job.assigned_mechanic || '', ELAPSED_TIME: elapsed }));
    }

  } else if (stage === 'billing_washing') {
    const advisor = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('advisor', 'all') AND phone IS NOT NULL LIMIT 1`
    ).get(job.created_by);
    if (advisor) {
      sendToWorkerWA(advisor, 'ready_billing', jobVars(job, {
        CUSTOMER_NAME: job.customer_name || '',
        CUSTOMER_PHONE: job.customer_phone || '',
      }));
    }

    const washers = db.prepare(`SELECT * FROM workers WHERE role IN ('washer', 'all') AND phone IS NOT NULL`).all();
    for (const w of washers) sendToWorkerWA(w, 'ready_washing', jobVars(job));

  } else if (stage === 'done') {
    const totalTime = formatDuration(minutesSince(job.created_at));
    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND phone IS NOT NULL`).all();
    const advisor = db.prepare(
      `SELECT * FROM workers WHERE name = ? AND role IN ('advisor', 'all') AND phone IS NOT NULL LIMIT 1`
    ).get(job.created_by);

    const recipients = advisor ? [...supervisors, advisor] : supervisors;
    for (const r of recipients) {
      sendToWorkerWA(r, 'job_complete', jobVars(job, {
        CUSTOMER_NAME: job.customer_name || '',
        CUSTOMER_PHONE: job.customer_phone || '',
        TOTAL_TIME: totalTime,
      }));
    }
  }
}

// Generic stage transition: updates the job, logs it, and notifies whoever's next.
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
    `SELECT * FROM workers WHERE name = ? AND phone IS NOT NULL LIMIT 1`
  ).get(job.assigned_mechanic);
  if (specialist) sendToWorkerWA(specialist, 'test_drive_failed_specialist', jobVars(job, { NOTE: failureNote }));

  const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND phone IS NOT NULL`).all();
  for (const s of supervisors) {
    sendToWorkerWA(s, 'test_drive_failed_supervisor', jobVars(job, { SPECIALIST_NAME: job.assigned_mechanic || '', NOTE: failureNote }));
  }
  return job;
}

// Marks a job's billing as complete (advisor).
function markBillingDone(jobId, personName) {
  db.prepare(`UPDATE jobs SET billing_done = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(jobId);
  db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'billing_washing', ?, 'Billing marked done')`).run(jobId, personName);
  return maybeCompleteJob(jobId, personName);
}

// Marks a job's washing as complete (washer).
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

// Extracts a job card photo via Claude Vision, creates the job, and notifies
// the sender + floor supervisors. Restricted to advisor/floor_supervisor/all roles.
async function handleJobCardPhoto(imageUrl, workers, chatId) {
  const M = MESSAGES[languageOf(workers[0])];
  const creator = getWorkerAs(workers, 'advisor', 'floor_supervisor');
  if (!creator) {
    sendMessage(chatId, M.unknown_command);
    return;
  }

  try {
    const downloadRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(downloadRes.data).toString('base64');

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

    db.prepare(`INSERT INTO stage_logs (job_id, stage, person, action) VALUES (?, 'created', ?, 'Created via WhatsApp photo')`).run(result.lastInsertRowid, creator.name);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
    const vars = jobVars(job, { CUSTOMER_NAME: customer_name, CUSTOMER_PHONE: customer_phone });

    sendMessage(chatId, render(M.job_card_created, vars));
    notifyNextStage(job);
  } catch (err) {
    console.error('WhatsApp job card extraction failed:', err.message);
    sendMessage(chatId, M.extraction_failed);
  }
}

// Processes one inbound message. `phone` is "+<digits>" (e.g. "+919970053033"),
// extracted from the webhook sender by the route handler below.
async function processMessage({ phone, text, hasImage, imageUrl }) {
  const chatId = phone;
  const bodyText = (text || '').trim();

  const workers = getWorkersByPhone(phone);
  if (!workers.length) {
    if (bodyText) sendMessage(chatId, MESSAGES.english.not_registered);
    return;
  }

  // ── Language selection (gates everything else until resolved) ───────────────
  if (!workers[0].language) {
    const choice = resolveLanguageChoice(bodyText);
    if (choice) {
      setLanguage(workers, choice);
      sendMessage(chatId, MESSAGES[choice].language_set);
      sendMessage(chatId, MESSAGES[choice].commands_list);
    } else {
      sendMessage(chatId, MESSAGES.english.welcome);
    }
    return;
  }

  // ── Photo → extract job card via Claude Vision ──────────────────────────────
  if (hasImage && imageUrl) {
    handleJobCardPhoto(imageUrl, workers, chatId).catch(err => console.error('WhatsApp job card photo handling failed:', err.message));
    return;
  }

  if (!bodyText) return;

  const lang = languageOf(workers[0]);
  const M = MESSAGES[lang];
  const lower = bodyText.toLowerCase();

  // ── assign [name] → floor supervisor assigns a specialist to newest job ─────
  if (lower.startsWith('assign ')) {
    const asSupervisor = getWorkerAs(workers, 'floor_supervisor');
    if (!asSupervisor) {
      sendMessage(chatId, M.unknown_command);
      return;
    }

    const nameInput = bodyText.slice(7).trim();

    const specialist = db.prepare(
      `SELECT * FROM workers WHERE role IN ('technician', 'electrician', 'denter', 'all') AND name LIKE ? LIMIT 1`
    ).get(`%${nameInput}%`);

    if (!specialist) {
      sendMessage(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(`SELECT * FROM jobs WHERE current_stage = 'created' OR assigned_mechanic IS NULL ORDER BY created_at DESC LIMIT 1`).get();
    if (!job) {
      sendMessage(chatId, M.unknown_command);
      return;
    }

    assignSpecialist(job.id, specialist, asSupervisor.name);
    sendMessage(chatId, render(M.assigned_success, {
      JOB_NUMBER: job.job_number,
      SPECIALIST_NAME: specialist.name,
      SPECIALIST_ROLE: ROLE_LABELS[specialist.role] || specialist.role,
    }));
    return;
  }

  // ── 1 → technician/electrician/denter starts their assigned job ─────────────
  if (bodyText === '1') {
    const asSpecialist = getWorkerAs(workers, ...SPECIALIST_ROLES);
    if (asSpecialist) {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage = 'assigned' ORDER BY updated_at DESC LIMIT 1`
      ).get(asSpecialist.name);
      if (job) {
        advanceJobStage(job.id, 'in_progress', asSpecialist.name, 'Started via WhatsApp');
        return;
      }
    }
    sendMessage(chatId, M.no_active_job);
    return;
  }

  // ── 2 → mark your part done (specialist/test driver/washer/advisor) ─────────
  if (bodyText === '2') {
    const asSpecialist = getWorkerAs(workers, ...SPECIALIST_ROLES);
    if (asSpecialist) {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE assigned_mechanic = ? AND current_stage = 'in_progress' ORDER BY updated_at DESC LIMIT 1`
      ).get(asSpecialist.name);
      if (job) {
        advanceJobStage(job.id, 'test_drive', asSpecialist.name, 'Repair marked done via WhatsApp');
        return;
      }
    }

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

    const asWasher = getWorkerAs(workers, 'washer');
    if (asWasher) {
      const job = db.prepare(
        `SELECT * FROM jobs WHERE current_stage = 'billing_washing' AND (washing_done IS NULL OR washing_done = 0) ORDER BY updated_at DESC LIMIT 1`
      ).get();
      if (job) {
        markWashingDone(job.id, asWasher.name);
        sendMessage(chatId, render(M.washing_marked_done, { JOB_NUMBER: job.job_number }));
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
        sendMessage(chatId, render(M.billing_marked_done, { JOB_NUMBER: job.job_number }));
        return;
      }
    }

    sendMessage(chatId, M.no_active_job);
    return;
  }

  // ── 3 → test driver fails test drive, sends car back to specialist ──────────
  if (bodyText === '3') {
    const asTestDriver = getWorkerAs(workers, 'test_driver');
    if (!asTestDriver) {
      sendMessage(chatId, M.unknown_command);
      return;
    }

    const job = db.prepare(
      `SELECT * FROM jobs WHERE assigned_test_driver = ? AND current_stage = 'test_drive' ORDER BY updated_at DESC LIMIT 1`
    ).get(asTestDriver.name);

    if (!job) {
      sendMessage(chatId, M.no_active_job);
      return;
    }

    failTestDrive(job.id, asTestDriver.name, 'Failed test drive');
    return;
  }

  // ── delay [reason] → log delay, notify floor supervisor ─────────────────────
  if (lower.startsWith('delay ')) {
    const reason = bodyText.slice(6).trim();

    const asSpecialist = getWorkerAs(workers, ...SPECIALIST_ROLES);
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
      sendMessage(chatId, M.no_active_job);
      return;
    }

    db.prepare(
      `INSERT INTO stage_logs (job_id, stage, person, action, note) VALUES (?, ?, ?, 'Delay reported via WhatsApp', ?)`
    ).run(job.id, job.current_stage, activeWorker.name, `DELAY: ${reason}`);

    const delayMsg = render(M.delay_logged, { JOB_NUMBER: job.job_number, REASON: reason });
    sendMessage(chatId, delayMsg);

    const supervisors = db.prepare(`SELECT * FROM workers WHERE role IN ('floor_supervisor', 'all') AND phone IS NOT NULL`).all();
    for (const s of supervisors) {
      sendToWorkerWA(s, 'delay_logged', { JOB_NUMBER: job.job_number, REASON: reason });
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

    sendMessage(chatId, render(M.status, {
      COUNT: activeJobs.length,
      JOB_LIST: jobList,
      DELAYED_COUNT: delayedCount,
      COMPLETED_COUNT: completedToday,
    }));
    return;
  }

  // ── Unknown command → help ───────────────────────────────────────────────────
  sendMessage(chatId, M.unknown_command);
}

// ── Webhook receiver ─────────────────────────────────────────────────────────
router.post('/webhook/whatsapp-green', async (req, res) => {
  res.sendStatus(200); // always respond 200 first
  const body = req.body;
  if (!body || body.typeWebhook !== 'incomingMessageReceived') return;
  const sender = body.senderData?.sender; // format: "919970053033@c.us"
  if (!sender) return;
  const phone = '+' + sender.replace('@c.us', '');
  const text = body.messageData?.textMessageData?.textMessage?.trim() || '';
  const hasImage = body.messageData?.typeMessage === 'imageMessage';
  // Green API puts the download URL (and caption) under fileMessageData for
  // image messages, not under an "imageMessage" key.
  const imageUrl = body.messageData?.fileMessageData?.downloadUrl || null;
  console.log('Message received - hasImage:', hasImage, 'typeMessage:', body.messageData?.typeMessage, 'imageUrl:', imageUrl);
  if (hasImage && !imageUrl) {
    console.log('Full messageData:', JSON.stringify(body.messageData, null, 2));
  }
  // process the message, looking up the worker by phone
  processMessage({ phone, text, hasImage, imageUrl }).catch(err => console.error('Green API webhook handling failed:', err.message));
});

module.exports = router;
module.exports.SPECIALIST_ROLES = SPECIALIST_ROLES;
module.exports.sendMessage = sendMessage;
module.exports.setWebhook = setWebhook;
module.exports.notifyNextStage = notifyNextStage;
module.exports.advanceJobStage = advanceJobStage;
module.exports.assignSpecialist = assignSpecialist;
module.exports.passTestDrive = passTestDrive;
module.exports.failTestDrive = failTestDrive;
module.exports.markBillingDone = markBillingDone;
module.exports.markWashingDone = markWashingDone;
