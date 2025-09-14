/* index.js - JSON-level hardened ZANS Task Manager
   Requirements:
     - Node 18+ (ESM imports)
     - npm install node-schedule
     - Optional: npm install simple-git  (if using SIMPLE_GIT=1)
   Env:
     DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PORT
     GITHUB_REPO (owner/repo), GITHUB_TOKEN (PAT) -> optional auto-push
     GIT_PUSH_BRANCH (default "main")
     SIMPLE_GIT=1 to use simple-git instead of shell git push
*/

import 'dotenv/config';
import { Client, GatewayIntentBits, Events, AttachmentBuilder } from 'discord.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import schedule from 'node-schedule';
import { execSync } from 'child_process';

let simpleGit;
if (process.env.SIMPLE_GIT === '1') {
  try { simpleGit = (await import('simple-git')).default(); } catch (e) { simpleGit = null; }
}

// ========== File setup ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tasksFile = path.join(__dirname, 'tasks.json');
const departmentsFile = path.join(__dirname, 'departments.json');
const managersFile = path.join(__dirname, 'managers.json');
const configFile = path.join(__dirname, 'config.json');
const backupsDir = path.join(__dirname, 'backups');

// Ensure files and backups dir exist
for (const f of [tasksFile, departmentsFile, managersFile, configFile]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '{}', 'utf8');
}
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// ========== Load JSON ==========
function readJson(filePath) {
  try {
    const s = fs.readFileSync(filePath, 'utf8') || '{}';
    return JSON.parse(s);
  } catch (e) {
    console.error(`Failed reading ${filePath}:`, e);
    return {};
  }
}

let tasks = new Map(Object.entries(readJson(tasksFile))); // userId -> [tasks]
let departments = readJson(departmentsFile);
let managers = readJson(managersFile);
let config = Object.assign({ reminders: ['24h','1h'], backupRetention: 10 }, readJson(configFile));

// ========== Helpers: atomic write, backup, push to git ==========
function atomicWrite(filePath, dataStr) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, dataStr, 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveTasks() {
  const obj = Object.fromEntries(tasks);
  atomicWrite(tasksFile, JSON.stringify(obj, null, 2));
  backupFile(tasksFile);
  maybeGitPush(['tasks.json']);
}
function saveDepartments() {
  atomicWrite(departmentsFile, JSON.stringify(departments, null, 2));
  backupFile(departmentsFile);
  maybeGitPush(['departments.json']);
}
function saveManagers() {
  atomicWrite(managersFile, JSON.stringify(managers, null, 2));
  backupFile(managersFile);
  maybeGitPush(['managers.json']);
}
function saveConfig() {
  atomicWrite(configFile, JSON.stringify(config, null, 2));
  backupFile(configFile);
  maybeGitPush(['config.json']);
}

function backupFile(filePath) {
  try {
    const base = path.basename(filePath);
    const t = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(backupsDir, `${base}.${t}.bak.json`);
    fs.copyFileSync(filePath, dest);
    // cleanup old backups
    const files = fs.readdirSync(backupsDir).filter(f => f.startsWith(base + '.'));
    const keep = config.backupRetention || 10;
    if (files.length > keep) {
      const sorted = files.sort(); // old first due to timestamp format
      const remove = sorted.slice(0, files.length - keep);
      for (const r of remove) fs.unlinkSync(path.join(backupsDir, r));
    }
  } catch (e) {
    console.error('Backup failed', e);
  }
}

function maybeGitPush(filesToAdd = []) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return; // not configured
  const branch = process.env.GIT_PUSH_BRANCH || 'main';
  const message = `Auto-update: ${filesToAdd.join(', ')} @ ${new Date().toISOString()}`;
  try {
    if (process.env.SIMPLE_GIT === '1' && simpleGit) {
      (async () => {
        await simpleGit.add(filesToAdd);
        await simpleGit.commit(message);
        // set remote with token for push
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        await simpleGit.push(remoteUrl, branch);
      })();
    } else {
      // shell git approach - assumes repo already has origin set up or we push using token-auth URL
      execSync(`git add ${filesToAdd.map(f => `"${f}"`).join(' ')}`, { stdio: 'ignore' });
      try {
        execSync(`git commit -m "${message.replace(/"/g,'\\"')}"`, { stdio: 'ignore' });
      } catch (e) {
        // commit may fail if nothing to commit - ignore
      }
      const remoteUrl = `https://${token}@github.com/${repo}.git`;
      execSync(`git push "${remoteUrl}" ${branch} --quiet`, { stdio: 'ignore' });
    }
  } catch (e) {
    console.error('Git push failed (auto-push):', e.message || e);
  }
}

// ========== Concurrency lock ==========
let isSaving = false;
async function safeSave(fn) {
  // simple in-process lock
  while (isSaving) {
    await new Promise(r => setTimeout(r, 50));
  }
  isSaving = true;
  try {
    await fn();
  } finally {
    isSaving = false;
  }
}

// ========== Utilities ==========
function safeMentionableArray(entity) {
  if (!entity) return [];
  if (Array.isArray(entity)) return entity;
  return [entity];
}
function parseDue(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toISOString();
}
function getAllTasksUnique() {
  const seen = new Set();
  const out = [];
  for (const [uid, list] of tasks.entries()) {
    for (const t of list) {
      if (!seen.has(String(t.id))) { seen.add(String(t.id)); out.push({ ...t, userId: uid }); }
    }
  }
  return out;
}
function findTaskById(id) {
  for (const [uid, list] of tasks.entries()) {
    const idx = list.findIndex(t => String(t.id) === String(id));
    if (idx !== -1) return { userId: uid, index: idx, task: list[idx] };
  }
  return null;
}
function fuzzySearchTasks(query, limit = 5) {
  query = String(query || '').toLowerCase();
  const all = getAllTasksUnique();
  const scored = all.map(t => {
    const title = (t.title||'').toLowerCase();
    const desc = (t.description||'').toLowerCase();
    let score = 0;
    if (title === query) score += 100;
    if (title.includes(query)) score += 50;
    if (desc.includes(query)) score += 20;
    // small fuzzy: count matching chars
    const common = [...query].filter(ch => title.includes(ch)).length;
    score += common;
    return { t, score };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, limit).map(x => x.t);
  return scored;
}

// ========== Admin & manager checks ==========
const ADMIN_IDS = []; // optional static admin IDs

function isAdmin(userId, guild) {
  const serverOwnerId = guild?.ownerId;
  return ADMIN_IDS.includes(userId) || userId === serverOwnerId;
}
function isManager(userId) { return !!managers[userId]; }
function isAdminOrManager(userId, guild) { return isAdmin(userId, guild) || isManager(userId); }

// ========== Discord client ==========
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ========== Express health ==========
const app = express();
app.get('/', (req, res) => res.send('✅ ZANS Task Manager running'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 web server running'));

// ========== Reminder scheduler ==========
function parseWindowToMinutes(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (s.endsWith('h')) return parseFloat(s) * 60;
  if (s.endsWith('m')) return parseFloat(s);
  if (s.endsWith('d')) return parseFloat(s) * 60 * 24;
  return parseFloat(s) * 60;
}
function scheduleReminders() {
  schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const now = new Date();
      const windows = (config.reminders||['24h','1h']).map(w => ({ key:w, mins: parseWindowToMinutes(w) })).filter(x => !isNaN(x.mins));
      let changed = false;
      for (const [uid, list] of tasks.entries()) {
        for (const t of list) {
          if (!t.due) continue;
          if (t.status === 'Done') continue;
          t.remindersSent = t.remindersSent || [];
          const dueDate = new Date(t.due);
          const diffMins = (dueDate - now) / (1000*60);
          if (diffMins < 0 && !t.remindersSent.includes('overdue')) {
            t.remindersSent.push('overdue');
            const msg = `⚠️ Task "${t.title}" (ID:${t.id}) is OVERDUE (due ${t.due}). Status: ${t.status}`;
            for (const ass of t.assignedTo || []) {
              try { const u = await client.users.fetch(ass); await u.send(msg); } catch(e){/* ignore */ }
            }
            t.logs = t.logs || [];
            t.logs.push({ date: new Date().toISOString(), action: 'Overdue reminder sent' });
            changed = true;
          }
          for (const w of windows) {
            if (t.remindersSent.includes(w.key)) continue;
            if (diffMins > 0 && diffMins <= w.mins) {
              t.remindersSent.push(w.key);
              const msg = `⏰ Reminder: Task "${t.title}" (ID:${t.id}) due in ~${Math.round(diffMins)} minutes (due ${t.due}).`;
              for (const ass of t.assignedTo || []) {
                try { const u = await client.users.fetch(ass); await u.send(msg); } catch(e){/* ignore */ }
              }
              t.logs = t.logs || [];
              t.logs.push({ date: new Date().toISOString(), action: `Reminder (${w.key}) sent` });
              changed = true;
            }
          }
        }
      }
      if (changed) await safeSave(async () => saveTasks());
    } catch (err) { console.error('Reminder job error', err); }
  });
}

// ========== Exports helpers ==========
function tasksToJSON(allTasks) { return JSON.stringify(allTasks, null, 2); }
function tasksToCSV(allTasks) {
  const rows = [['id','title','description','due','status','createdBy','assignedTo','department','lastLog']];
  for (const t of allTasks) {
    const lastLog = (t.logs && t.logs.length) ? t.logs[t.logs.length-1].action.replace(/\n/g,' ') : '';
    rows.push([
      t.id,
      `"${String(t.title).replace(/"/g,'""')}"`,
      `"${String(t.description||'').replace(/"/g,'""')}"`,
      t.due||'',
      t.status||'',
      t.createdBy||'',
      (t.assignedTo||[]).join(';'),
      t.department||'',
      `"${lastLog.replace(/"/g,'""')}"`
    ]);
  }
  return rows.map(r => r.join(',')).join('\n');
}
function tasksToHTML(allTasks, theme='default') {
  const cssDefault = `body{font-family:Arial;padding:12px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f4f4f4}`;
  const cssDark = `body{font-family:Arial;padding:12px;background:#111;color:#eee}table{border-collapse:collapse;width:100%}th,td{border:1px solid #444;padding:8px}th{background:#222}`;
  const css = theme === 'dark' ? cssDark : cssDefault;
  const rows = allTasks.map(t => {
    const lastLog = (t.logs && t.logs.length) ? t.logs[t.logs.length-1].action : '';
    return `<tr><td>${t.id}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.description||'')}</td><td>${t.due||''}</td><td>${t.status||''}</td><td>${t.createdBy||''}</td><td>${(t.assignedTo||[]).join(', ')}</td><td>${t.department||''}</td><td>${escapeHtml(lastLog)}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tasks Export</title><style>${css}</style></head><body><h1>Tasks Export</h1><table><thead><tr><th>ID</th><th>Title</th><th>Description</th><th>Due</th><th>Status</th><th>Created By</th><th>Assigned To</th><th>Department</th><th>Last Log</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ========== On ready ==========
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // mark overdue tasks
  const now = new Date();
  let changed = false;
  for (const [uid, list] of tasks.entries()) {
    for (const t of list) {
      if (t.due && (!t.status || t.status !== 'Done')) {
        const dueDate = new Date(t.due);
        if (dueDate < now && t.status !== 'Overdue') {
          t.status = 'Overdue';
          t.logs = t.logs || [];
          t.logs.push({ date: new Date().toISOString(), action: 'Auto-marked overdue on startup' });
          changed = true;
        }
      }
    }
  }
  if (changed) await safeSave(async () => saveTasks());
  // start reminders
  scheduleReminders();
});

// ========== InteractionCreate handler ==========
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, user } = interaction;

    // --- /task-create
    if (commandName === 'task-create') {
      const title = options.getString('title');
      const description = options.getString('description') || '';
      const due = parseDue(options.getString('due'));
      const id = Date.now();
      const task = { id, title, description, due, status:'Pending', createdBy: user.username, assignedTo: [user.id], department:null, logs:[{date:new Date().toISOString(), action:'Created'}], remindersSent:[] };
      if (!tasks.has(user.id)) tasks.set(user.id, []);
      tasks.get(user.id).push(task);
      await safeSave(async () => saveTasks());
      await interaction.reply({ content: `✅ Task created: **${title}** (ID: ${id})`, ephemeral: true });
      return;
    }

    // --- /task-list
    if (commandName === 'task-list') {
      let list = [];
      if (isAdminOrManager(user.id, interaction.guild)) {
        list = getAllTasksUnique();
      } else {
        list = (tasks.get(user.id) || []).map(t => ({ ...t, userId: user.id }));
      }
      if (!list.length) { await interaction.reply({ content:'📭 No tasks found', ephemeral:true }); return; }
      const lines = list.map((t,i) => {
        const lastLog = (t.logs && t.logs.length) ? t.logs[t.logs.length-1].action : 'No updates';
        return `**${i+1}. ${t.title}** (ID:${t.id}) — ${t.status} — due:${t.due||'none'}\nAssigned: ${(t.assignedTo||[]).join(', ')}\nLast: ${lastLog}`;
      }).join('\n\n');
      await interaction.reply({ content: `📋 Tasks:\n${lines}`, ephemeral:true });
      return;
    }

    // --- /task-search q
    if (commandName === 'task-search') {
      const q = options.getString('q');
      const matches = fuzzySearchTasks(q, 5);
      if (!matches.length) { await interaction.reply({ content:'No matches found', ephemeral:true }); return; }
      const lines = matches.map((t,i) => `**${i+1}. ${t.title}** (ID:${t.id}) — ${t.status} — due:${t.due||'none'} — assigned:${(t.assignedTo||[]).join(', ')}`).join('\n\n');
      await interaction.reply({ content: `Search results for "${q}":\n\n${lines}\n\nUse /task-update id:ID ... or /task-delete id:ID`, ephemeral:true });
      return;
    }

    // --- /task-update (id or index)
    if (commandName === 'task-update') {
      const id = options.getInteger('id');
      const index = options.getInteger('index');
      const status = options.getString('status');
      let found = null;
      if (id) found = findTaskById(id);
      else if (isAdminOrManager(user.id, interaction.guild) && index) {
        const all = getAllTasksUnique();
        if (index < 1 || index > all.length) { await interaction.reply({ content:'Invalid global index', ephemeral:true}); return; }
        found = findTaskById(all[index-1].id);
      } else {
        const ulist = tasks.get(user.id) || [];
        if (!index || index < 1 || index > ulist.length) { await interaction.reply({ content:'Invalid index', ephemeral:true}); return; }
        found = { userId: user.id, index: index-1, task: ulist[index-1] };
      }
      if (!found) { await interaction.reply({ content:'Task not found', ephemeral:true}); return; }
      if (!isAdminOrManager(user.id, interaction.guild) && !(found.task.assignedTo||[]).includes(user.id)) {
        await interaction.reply({ content:'❌ You are not assigned to this task', ephemeral:true }); return;
      }
      // validate status
      const valid = ['Pending','In Progress','Done','Blocked','Overdue'];
      if (!valid.includes(status)) { await interaction.reply({ content:`Invalid status. Allowed: ${valid.join(', ')}`, ephemeral:true }); return; }
      found.task.status = status;
      found.task.logs = found.task.logs || [];
      found.task.logs.push({ date: new Date().toISOString(), action: `Status set to ${status} by ${user.username}` });
      // write back
      const arr = tasks.get(found.userId);
      arr[found.index] = found.task;
      await safeSave(async () => saveTasks());
      await interaction.reply({ content:`🔄 Task updated: ${found.task.title} (ID:${found.task.id}) -> ${status}`, ephemeral:true });
      return;
    }

    // --- /task-delete
    if (commandName === 'task-delete') {
      const id = options.getInteger('id');
      const index = options.getInteger('index');
      let found = null;
      if (id) found = findTaskById(id);
      else if (isAdminOrManager(user.id, interaction.guild) && index) {
        const all = getAllTasksUnique();
        if (index < 1 || index > all.length) { await interaction.reply({ content:'Invalid global index', ephemeral:true}); return; }
        found = findTaskById(all[index-1].id);
      } else {
        const ulist = tasks.get(user.id) || [];
        if (!index || index < 1 || index > ulist.length) { await interaction.reply({ content:'Invalid index', ephemeral:true}); return; }
        found = { userId: user.id, index: index-1, task: ulist[index-1] };
      }
      if (!found) { await interaction.reply({ content:'Task not found', ephemeral:true}); return; }
      if (!isAdminOrManager(user.id, interaction.guild) && !(found.task.assignedTo||[]).includes(user.id)) {
        await interaction.reply({ content:'❌ You are not assigned to this task', ephemeral:true }); return;
      }
      const list = tasks.get(found.userId);
      const removed = list.splice(found.index, 1);
      await safeSave(async () => saveTasks());
      await interaction.reply({ content:`🗑️ Deleted: ${removed[0].title} (ID:${removed[0].id})`, ephemeral:true });
      return;
    }

    // --- /task-assign (create assign to multiple) - admin/managers
    if (commandName === 'task-assign') {
      if (!isAdminOrManager(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins/managers', ephemeral:true }); return; }
      const title = options.getString('title');
      const description = options.getString('description') || '';
      const due = parseDue(options.getString('due'));
      const department = options.getString('department') || null;
      const users = safeMentionableArray(options.getMentionable('users'));
      const userIds = users.map(u => u.id);
      let assigned = [...userIds];
      if (department && departments[department]) assigned.push(...departments[department]);
      assigned = [...new Set(assigned)];
      if (!assigned.length) { await interaction.reply({ content:'⚠️ No users to assign', ephemeral:true }); return; }
      const id = Date.now();
      const task = { id, title, description, due, status:'Pending', createdBy: user.username, assignedTo: assigned, department, logs:[{date:new Date().toISOString(), action:`Assigned by ${user.username}`}], remindersSent:[] };
      for (const uid of assigned) {
        if (!tasks.has(uid)) tasks.set(uid, []);
        tasks.get(uid).push(task);
      }
      await safeSave(async () => saveTasks());
      await interaction.reply({ content:`✅ Task assigned: ${title} (ID:${id}) to ${assigned.join(', ')}`, ephemeral:true });
      return;
    }

    // --- /task-assign-edit - add/remove assignees (we reuse task-assign with special flags not implemented as option here; we provide /task-update-assignees optionally via separate command)
    // For now we provide simple manager add/remove via two small commands: /task-add-assignee and /task-remove-assignee (not registered here; deploy-commands file later includes /task-assign with existing options). For brevity we'll handle via task-update-assignees name if implemented in deploy-commands.

    // --- /department-add
    if (commandName === 'department-add') {
      if (!isAdmin(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins', ephemeral:true }); return; }
      const name = options.getString('name');
      const members = safeMentionableArray(options.getMentionable('members'));
      const ids = members.map(m => m.id);
      departments[name] = ids;
      await safeSave(async () => saveDepartments());
      await interaction.reply({ content:`✅ Department ${name} added (${ids.join(', ') || 'no members'})`, ephemeral:true });
      return;
    }

    // --- /department-list
    if (commandName === 'department-list') {
      const out = Object.entries(departments).map(([d,m]) => `**${d}**: ${m.join(', ') || 'No members'}`).join('\n') || 'No departments';
      await interaction.reply({ content:`📋 Departments:\n${out}`, ephemeral:true });
      return;
    }

    // --- /department-add-member
    if (commandName === 'department-add-member') {
      if (!isAdmin(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins', ephemeral:true }); return; }
      const name = options.getString('name');
      const member = options.getMentionable('member');
      if (!departments[name]) departments[name] = [];
      if (!departments[name].includes(member.id)) departments[name].push(member.id);
      await safeSave(async () => saveDepartments());
      await interaction.reply({ content:`✅ Added ${member.username} to ${name}`, ephemeral:true });
      return;
    }

    // --- /department-remove-member
    if (commandName === 'department-remove-member') {
      if (!isAdmin(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins', ephemeral:true }); return; }
      const name = options.getString('name');
      const member = options.getMentionable('member');
      if (!departments[name]) { await interaction.reply({ content:'Dept not found', ephemeral:true }); return; }
      departments[name] = departments[name].filter(id => id !== member.id);
      await safeSave(async () => saveDepartments());
      await interaction.reply({ content:`✅ Removed ${member.username} from ${name}`, ephemeral:true });
      return;
    }

    // --- /manager-add
    if (commandName === 'manager-add') {
      if (!isAdmin(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins', ephemeral:true }); return; }
      const users = safeMentionableArray(options.getMentionable('users'));
      users.forEach(u => { managers[u.id] = true; });
      await safeSave(async () => saveManagers());
      await interaction.reply({ content:`✅ Managers added: ${users.map(u=>u.username).join(', ')}`, ephemeral:true });
      return;
    }

    // --- /set-reminders
    if (commandName === 'set-reminders') {
      if (!isAdmin(user.id, interaction.guild)) { await interaction.reply({ content:'❌ Only admins', ephemeral:true }); return; }
      const value = options.getString('value') || '';
      config.reminders = value.split(',').map(s=>s.trim()).filter(Boolean);
      await safeSave(async () => saveConfig());
      await interaction.reply({ content:`✅ Reminder windows set: ${config.reminders.join(', ')}`, ephemeral:true });
      return;
    }

    // --- /export
    if (commandName === 'export') {
      const format = options.getString('format') || 'json';
      const theme = options.getString('theme') || 'default';
      let all = [];
      if (isAdminOrManager(user.id, interaction.guild)) all = getAllTasksUnique();
      else all = (tasks.get(user.id) || []).map(t => ({ ...t }));

      if (!all.length) { await interaction.reply({ content:'No tasks to export', ephemeral:true}); return; }

      try {
        let buffer, name;
        if (format === 'json') { buffer = Buffer.from(tasksToJSON(all), 'utf8'); name = `tasks-${Date.now()}.json`; }
        else if (format === 'csv') { buffer = Buffer.from(tasksToCSV(all),'utf8'); name = `tasks-${Date.now()}.csv`; }
        else { buffer = Buffer.from(tasksToHTML(all, theme),'utf8'); name = `tasks-${Date.now()}.html`; }
        // DM first
        try {
          await user.send({ content:`Your export (${format})`, files: [ new AttachmentBuilder(buffer, { name }) ] });
          await interaction.reply({ content:'✅ Sent export to your DMs', ephemeral:true });
        } catch (dmErr) {
          // fallback to channel
          await interaction.reply({ content:'🔁 Could not DM; uploading here', files: [ new AttachmentBuilder(buffer, { name }) ] });
        }
      } catch (err) {
        console.error('Export failed', err);
        await interaction.reply({ content:'❌ Export failed', ephemeral:true });
      }
      return;
    }

    // --- /help
    if (commandName === 'help') {
      if (isAdminOrManager(user.id, interaction.guild)) {
        await interaction.reply({ content:
`Admin/Manager Help:
- /task-create title description due
- /task-assign title users department due
- /task-list
- /task-search q
- /task-update id | index status
- /task-delete id | index
- /department-add name members
- /department-add-member name member
- /department-remove-member name member
- /manager-add users
- /set-reminders value (e.g. 24h,1h,30m)
- /export format theme
`, ephemeral:true});
      } else {
        await interaction.reply({ content:
`User Help:
- /task-create
- /task-list
- /task-search q
- /task-update id | index status
- /task-delete id | index
- /department-list
- /export json|csv|html
`, ephemeral:true});
      }
      return;
    }

  } catch (err) {
    console.error('Interaction handler error', err);
    try { if (interaction && interaction.replied === false) await interaction.reply({ content:'❌ Error occurred', ephemeral:true }); } catch(e){}
  }
});

// ========== Login ==========
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not set');
  process.exit(1);
}
console.log('Token length (for debug):', process.env.DISCORD_TOKEN.length);
client.login(process.env.DISCORD_TOKEN);
