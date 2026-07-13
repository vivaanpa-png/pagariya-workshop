/*
 * Instagram first-contact confirmation flow — message text only.
 *
 * NOT YET WIRED UP. There is no Instagram bot/webhook in this codebase —
 * building one requires a Meta App + a connected Instagram professional
 * account + an access token, none of which exist yet. This file just holds
 * the agreed message text and the DB columns (workers.confirmed,
 * workers.needs_review — see src/db/database.js) so the flow is ready to
 * wire up once that infrastructure is in place.
 *
 * IMPORTANT — pre-deploy blocker found when this was scoped: Instagram's
 * Messaging API (Meta Graph API) does NOT allow a business account to send
 * the first message in a conversation. Unlike WhatsApp Business API (which
 * allows approved template messages to cold-start a chat), Instagram has no
 * equivalent — the 24-hour messaging window only opens after the *user*
 * sends something first. Message tags (HUMAN_AGENT, CONFIRMED_EVENT_UPDATE,
 * POST_PURCHASE_UPDATE, ACCOUNT_UPDATE) only extend an already-open window;
 * none of them can initiate one. So the "admin-triggered bulk send on
 * deploy" trigger described in the original spec is not achievable — the
 * only compliant trigger is reactive: wait for the worker to DM the bot
 * first (e.g. "Hi"), then reply with this confirmation prompt.
 *
 * That also means there's no phone-number-based sender matching like
 * src/whatsapp_green.js uses — Instagram DMs only expose an opaque
 * per-app user ID (IGSID), not a phone number — so a worker's first inbound
 * DM will need to be linked to their `workers` row (e.g. an admin "link
 * Instagram" step) before the {name}/{mobile}/{position} placeholders below
 * can be filled in.
 *
 * Branch logic (to implement once wired up):
 *   Reply YES            → workers.confirmed = 1, send CONFIRMATION_ACK
 *   Reply NO              → workers.confirmed = 0, workers.needs_review = 1,
 *                           send CONFIRMATION_REJECTED. No self-edit of
 *                           name/mobile/position via DM — corrections go
 *                           through the admin dashboard only.
 *   Anything else          → re-send CONFIRMATION_PROMPT once, then go
 *                           silent (track a "prompt already re-sent" flag
 *                           per worker so it doesn't loop forever).
 */

// {name} / {mobile} / {position} are template placeholders — fill them via
// a render() helper like src/whatsapp_green.js's before sending.
const CONFIRMATION_PROMPT = `Namaste! Main Pagariya Auto Workshop ka digital tracking system hoon.

Aapki details confirm karni hain:
Naam: {name}
Mobile: {mobile}
Position: {position}

Sahi hai kya? Reply karo YES ya NO.

---

Hi! I'm the Pagariya Auto Workshop tracking bot.

Please confirm your details:
Name: {name}
Mobile: {mobile}
Position: {position}

Is this correct? Reply YES or NO.`;

const CONFIRMATION_ACK = "Great, aap register ho gaye / You're registered.";

const CONFIRMATION_REJECTED = "GM/manager se baat karo apni details update karne ke liye / Please contact your manager to update your details.";

module.exports = { CONFIRMATION_PROMPT, CONFIRMATION_ACK, CONFIRMATION_REJECTED };
