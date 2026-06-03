# Pagariya Auto Workshop — Accountability Workflow System

A real-time job card management dashboard for Pagariya Auto Workshop. Tracks every vehicle from intake to delivery with live stage updates, mechanic assignment, and a full audit trail.

## Stack

- **Backend** — Node.js, Express
- **Database** — SQLite (via better-sqlite3)
- **Frontend** — Vanilla JS, single-page dashboard

## Features

- Create job cards with car details, customer info, and work type
- Assign mechanics from a managed roster (add/remove via Settings)
- Progress each job through six stages: Created → Assigned → In Progress → Inspection → Washing → Done
- Real-time per-card timers counting up from job creation
- Live search by job number, car model, plate, or mechanic
- Delay tracking with categorised reasons (Waiting for Parts, Customer Approval Pending, etc.)
- Stage audit log on every job
- Auto-moves completed jobs to the Completed tab
- 15-second background polling — cards only re-render on actual data changes

## WhatsApp Integration — Coming Soon

Automated WhatsApp notifications at key stage transitions:
- Customer notified when job is assigned and when the car is ready
- Workshop manager alerted on delays

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Requires a `.env` file with `PORT` (optional, defaults to 3000).
