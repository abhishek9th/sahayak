// Detect catalogue changes, create notifications, send push. Safe to run on a schedule.
//   node backend/scripts/runNotificationJob.mjs            run for real
//   node backend/scripts/runNotificationJob.mjs --dry      detect only, write nothing
//   node backend/scripts/runNotificationJob.mjs --force    allow a large "added" batch to announce
// Equivalent HTTP trigger: POST /api/notifications/admin/run  with header x-cron-secret: $CRON_SECRET
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getSupabaseAdmin } from '../services/supabaseAdmin.js';
import { run } from '../services/notificationService.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
const result = await run(getSupabaseAdmin(), { dryRun: process.argv.includes('--dry'), force: process.argv.includes('--force') });
console.log(JSON.stringify(result, null, 2));
