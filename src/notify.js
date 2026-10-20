// Optional push notifications via ntfy (https://ntfy.sh), on with NOTIFY=1. Install the ntfy app and subscribe to the topic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { writeNotification } from './db.js';
import { log } from './log.js';

const topicFile = path.join(config.dataDir, 'ntfy.json');

// Topic name is the only secret on public ntfy.sh, so generate an unguessable one.
export function ntfyTopic() {
  if (config.ev.ntfyTopic) return config.ev.ntfyTopic;
  try { return JSON.parse(fs.readFileSync(topicFile, 'utf8')).topic; } catch {}
  const topic = `enphase-ev-${crypto.randomBytes(9).toString('hex')}`;
  fs.writeFileSync(topicFile, JSON.stringify({ topic }, null, 2));
  return topic;
}

export function ntfyUrl() {
  return `${config.ev.ntfyServer.replace(/\/$/, '')}/${ntfyTopic()}`;
}

export async function notify({ kind, title, body, amps, priority = 3, tags = [] }) {
  const ts = Math.floor(Date.now() / 1000);
  // Pushes off: keep the message in the dashboard log only, and count it as delivered.
  if (!config.ev.notify) {
    writeNotification({ ts, kind, title, body, amps, sent: true, error: 'push off' });
    return true;
  }
  let sent = false, error = null;
  // Laptop Wi-Fi drops briefly after waking; retry a few times before giving up.
  for (let attempt = 0; attempt < 4 && !sent; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 5000));
    try {
      const res = await fetch(ntfyUrl(), {
        method: 'POST',
        // ntfy headers must be ASCII; emoji go through Tags.
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: String(priority), Tags: tags.join(',') },
        body,
      });
      sent = res.ok;
      error = res.ok ? null : `ntfy ${res.status}`;
    } catch (e) {
      error = (e.cause && e.cause.code) || e.message;
    }
  }
  writeNotification({ ts, kind, title, body, amps, sent, error });
  log.info('notify', `${kind}: ${title}${error ? ` (FAILED: ${error})` : ''}`);
  return sent;
}
