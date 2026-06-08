const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const whatsapp = require('../whatsapp');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `This image is a vehicle service job card from an authorised car dealership.
Extract the following fields and return ONLY a single JSON object with exactly these keys, and no markdown formatting or commentary:

{
  "jc_no": "",
  "jc_date": "",
  "jc_time": "",
  "customer_name": "",
  "mobile": "",
  "email": "",
  "reg_no": "",
  "model": "",
  "mileage": "",
  "schedule_service": "",
  "sa_name": "",
  "mechanic_name": "",
  "observations": [],
  "estimated_labour": 0,
  "estimated_parts": 0,
  "estimated_total": 0,
  "delivery_date": "",
  "delivery_time": ""
}

"observations" should be an array of strings, one per job/observation line item.
"estimated_labour", "estimated_parts" and "estimated_total" should be numbers (no currency symbols or commas).
If a field is missing or illegible, use an empty string ("" ), an empty array ([]) for observations, or 0 for numeric fields.
Return only the JSON object, nothing else.`;

function extractJsonObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

router.post('/api/jobcard/scan', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'An image file is required (field name "image")' });
  }

  let rawResponse;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: req.file.mimetype,
              data: req.file.buffer.toString('base64'),
            },
          },
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      }],
    });
    rawResponse = message.content.map(block => block.text || '').join('');
  } catch (err) {
    return res.status(400).json({ error: 'Vision extraction failed', details: err.message });
  }

  let fields;
  try {
    fields = extractJsonObject(rawResponse);
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse extracted job card data as JSON', raw: rawResponse });
  }

  const schedule_service = fields.schedule_service || '';
  const estimated_duration_minutes = schedule_service.toUpperCase().includes('PMS80') ? 150 : 90;

  const job_number = fields.jc_no || `JC${Date.now()}`;
  const car_number = fields.reg_no || 'UNKNOWN';
  const car_model = fields.model || '';
  const work_type = schedule_service;
  const customer_name = fields.customer_name || '';
  const customer_phone = fields.mobile || '';
  const mechanic_name = (fields.mechanic_name || '').trim();
  const creator_name = (fields.sa_name || '').trim() || 'Unknown';

  try {
    const result = db.prepare(`
      INSERT INTO jobs (job_number, car_number, car_model, work_type, customer_name, customer_phone, estimated_duration_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(job_number, car_number, car_model, work_type, customer_name, customer_phone, estimated_duration_minutes);

    const jobId = result.lastInsertRowid;

    db.prepare(`
      INSERT INTO stage_logs (job_id, stage, person, action)
      VALUES (?, 'created', ?, 'Job created from scanned job card')
    `).run(jobId, creator_name);

    if (mechanic_name) {
      db.prepare(`
        UPDATE jobs SET assigned_mechanic = ?, current_stage = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(mechanic_name, jobId);

      db.prepare(`
        INSERT INTO stage_logs (job_id, stage, person, action)
        VALUES (?, 'assigned', ?, 'Assigned to mechanic from scanned job card')
      `).run(jobId, mechanic_name);
    }

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    whatsapp.notifyNextStage(job);

    res.json({ success: true, id: jobId, extracted: fields, estimated_duration_minutes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
