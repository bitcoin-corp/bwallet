// b / owner moderation for the feed queue: list | approve <id…> | reject <id…>
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const f = path.join(dir, 'queue.json');
const q = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
const [cmd = 'list', ...ids] = process.argv.slice(2);
if (cmd === 'list') {
  for (const i of Object.values(q).filter((i) => i.status === 'pending')) console.log(i.id, `@${i.author}`, i.url, '|', i.text.replace(/\s+/g, ' ').slice(0, 120));
} else if (cmd === 'approve' || cmd === 'reject') {
  for (const id of ids) { if (!q[id]) { console.error('no such item', id); continue; } q[id].status = cmd === 'approve' ? 'approved' : 'rejected'; q[id].moderated_at = new Date().toISOString(); console.log(cmd, id); }
  fs.writeFileSync(f, JSON.stringify(q, null, 2));
} else { console.error('usage: moderate.mjs list | approve <id…> | reject <id…>'); process.exit(2); }
