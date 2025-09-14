/* index.js - Fully Upgraded ZANS Task Manager
   Features:
   - Task creation, assignment (users & departments)
   - Department & manager management
   - Reminders with Discord DM
   - Export (JSON, CSV, HTML)
   - Auto-backup and optional GitHub push
   - Atomic writes & concurrency safe
   - Shows usernames/tags instead of IDs
   - Configurable via config.json
   Requirements:
   - Node 18+ (ESM)
   - npm install discord.js node-schedule simple-git
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
  try { simpleGit = (await import('simple-git')).default(); } catch(e){ simpleGit=null; }
}

// ===== File setup =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tasksFile = path.join(__dirname, 'tasks.json');
const departmentsFile = path.join(__dirname, 'departments.json');
const managersFile = path.join(__dirname, 'managers.json');
const configFile = path.join(__dirname, 'config.json');
const backupsDir = path.join(__dirname, 'backups');

for (const f of [tasksFile, departmentsFile, managersFile, configFile]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '{}', 'utf8');
}
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// ===== Load JSON =====
function readJson(filePath){
  try { return JSON.parse(fs.readFileSync(filePath,'utf8')||'{}'); }
  catch(e){ console.error(`Failed reading ${filePath}:`, e); return {}; }
}

let tasks = new Map(Object.entries(readJson(tasksFile)));
let departments = readJson(departmentsFile);
let managers = readJson(managersFile);
let config = Object.assign({ reminders: ['24h','1h'], backupRetention: 10 }, readJson(configFile));

// ===== Helpers: atomic write, backup, git push =====
function atomicWrite(filePath, dataStr){
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, dataStr, 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveTasks() { atomicWrite(tasksFile, JSON.stringify(Object.fromEntries(tasks), null,2)); backupFile(tasksFile); maybeGitPush(['tasks.json']); }
function saveDepartments(){ atomicWrite(departmentsFile, JSON.stringify(departments,null,2)); backupFile(departmentsFile); maybeGitPush(['departments.json']); }
function saveManagers(){ atomicWrite(managersFile, JSON.stringify(managers,null,2)); backupFile(managersFile); maybeGitPush(['managers.json']); }
function saveConfig(){ atomicWrite(configFile, JSON.stringify(config,null,2)); backupFile(configFile); maybeGitPush(['config.json']); }

function backupFile(filePath){
  try{
    const base = path.basename(filePath);
    const t = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(backupsDir, `${base}.${t}.bak.json`);
    fs.copyFileSync(filePath, dest);
    const files = fs.readdirSync(backupsDir).filter(f=>f.startsWith(base+'.'));
    const keep = config.backupRetention||10;
    if(files.length>keep){
      const remove = files.sort().slice(0, files.length-keep);
      for(const r of remove) fs.unlinkSync(path.join(backupsDir,r));
    }
  } catch(e){ console.error('Backup failed', e); }
}

function maybeGitPush(files=[]){
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if(!repo || !token) return;
  const branch = process.env.GIT_PUSH_BRANCH||'main';
  const message = `Auto-update: ${files.join(', ')} @ ${new Date().toISOString()}`;
  try{
    if(process.env.SIMPLE_GIT==='1' && simpleGit){
      (async ()=>{
        await simpleGit.add(files);
        await simpleGit.commit(message);
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        await simpleGit.push(remoteUrl, branch);
      })();
    } else {
      execSync(`git add ${files.map(f=>`"${f}"`).join(' ')}`, {stdio:'ignore'});
      try{ execSync(`git commit -m "${message.replace(/"/g,'\\"')}"`,{stdio:'ignore'});}catch{}
      const remoteUrl = `https://${token}@github.com/${repo}.git`;
      execSync(`git push "${remoteUrl}" ${branch} --quiet`,{stdio:'ignore'});
    }
  }catch(e){ console.error('Git push failed', e.message||e); }
}

// ===== Concurrency lock =====
let isSaving=false;
async function safeSave(fn){
  while(isSaving) await new Promise(r=>setTimeout(r,50));
  isSaving=true;
  try{ await fn(); } finally{ isSaving=false; }
}

// ===== Utilities =====
function safeMentionableArray(entity){ if(!entity) return []; return Array.isArray(entity)?entity:[entity]; }
function parseDue(dateStr){ if(!dateStr) return null; const d=new Date(dateStr); return isNaN(d)?null:d.toISOString(); }
function getAllTasksUnique(){
  const seen=new Set(), out=[];
  for(const [uid,list] of tasks.entries()){
    for(const t of list){ if(!seen.has(String(t.id))){ seen.add(String(t.id)); out.push({...t,userId:uid}); } }
  }
  return out;
}
function findTaskById(id){
  for(const [uid,list] of tasks.entries()){
    const idx=list.findIndex(t=>String(t.id)===String(id));
    if(idx!==-1) return {userId:uid,index:idx,task:list[idx]};
  }
  return null;
}
function fuzzySearchTasks(query, limit=5){
  query=String(query||'').toLowerCase();
  const all=getAllTasksUnique();
  const scored=all.map(t=>{
    const title=(t.title||'').toLowerCase();
    const desc=(t.description||'').toLowerCase();
    let score=0;
    if(title===query) score+=100;
    if(title.includes(query)) score+=50;
    if(desc.includes(query)) score+=20;
    const common=[...query].filter(ch=>title.includes(ch)).length;
    score+=common;
    return {t,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.t);
  return scored;
}

// ===== Admin & Manager checks =====
const ADMIN_IDS = []; // optional static admin IDs
function isAdmin(userId, guild){ return ADMIN_IDS.includes(userId) || userId===guild?.ownerId; }
function isManager(userId){ return !!managers[userId]; }
function isAdminOrManager(userId,guild){ return isAdmin(userId,guild) || isManager(userId); }

// ===== Discord client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== Express health =====
const app = express();
app.get('/',(req,res)=>res.send('✅ ZANS Task Manager running'));
app.listen(process.env.PORT||3000,()=>console.log('🌐 web server running'));

// ===== Reminder scheduler =====
function parseWindowToMinutes(s){
  if(!s) return null;
  s=String(s).trim().toLowerCase();
  if(s.endsWith('h')) return parseFloat(s)*60;
  if(s.endsWith('m')) return parseFloat(s);
  if(s.endsWith('d')) return parseFloat(s)*60*24;
  return parseFloat(s)*60;
}
function scheduleReminders(){
  schedule.scheduleJob('*/5 * * * *', async ()=>{
    try{
      const now=new Date();
      const windows=(config.reminders||['24h','1h']).map(w=>({key:w,mins:parseWindowToMinutes(w)})).filter(x=>!isNaN(x.mins));
      let changed=false;
      for(const [uid,list] of tasks.entries()){
        for(const t of list){
          if(!t.due || t.status==='Done') continue;
          t.remindersSent=t.remindersSent||[];
          const dueDate=new Date(t.due);
          const diffMins=(dueDate-now)/(1000*60);

          if(diffMins<0 && !t.remindersSent.includes('overdue')){
            t.remindersSent.push('overdue');
            const msg=`⚠️ Task "${t.title}" is OVERDUE (due ${t.due}). Status: ${t.status}`;
            for(const ass of t.assignedTo||[]){
              try{ const u=await client.users.fetch(ass); await u.send(msg); }catch{}
            }
            t.logs=t.logs||[];
            t.logs.push({date:new Date().toISOString(),action:'Overdue reminder sent'});
            changed=true;
          }

          for(const w of windows){
            if(t.remindersSent.includes(w.key)) continue;
            if(diffMins>0 && diffMins<=w.mins){
              t.remindersSent.push(w.key);
              const msg=`⏰ Reminder: Task "${t.title}" due in ~${Math.round(diffMins)} minutes (due ${t.due}).`;
              for(const ass of t.assignedTo||[]){
                try{ const u=await client.users.fetch(ass); await u.send(msg); }catch{}
              }
              t.logs=t.logs||[];
              t.logs.push({date:new Date().toISOString(),action:`Reminder (${w.key}) sent`});
              changed=true;
            }
          }
        }
      }
      if(changed) await safeSave(async ()=>saveTasks());
    } catch(err){ console.error('Reminder job error', err); }
  });
}

// ===== Exports helpers =====
function tasksToJSON(allTasks){ return JSON.stringify(allTasks,null,2); }
function tasksToCSV(allTasks){
  const rows=[['id','title','description','due','status','createdBy','assignedTo','department','lastLog']];
  for(const t of allTasks){
    const lastLog=(t.logs && t.logs.length)?t.logs[t.logs.length-1].action.replace(/\n/g,' '):'';
    rows.push([t.id, `"${String(t.title).replace(/"/g,'""')}"`, `"${String(t.description||'').replace(/"/g,'""')}"`, t.due||'', t.status||'', t.createdBy||'', (t.assignedTo||[]).join(';'), t.department||'', `"${lastLog.replace(/"/g,'""')}"`]);
  }
  return rows.map(r=>r.join(',')).join('\n');
}
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function tasksToHTML(allTasks,theme='default'){
  const cssDefault=`body{font-family:Arial;padding:12px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f4f4f4}`;
  const cssDark=`body{font-family:Arial;padding:12px;background:#111;color:#eee}table{border-collapse:collapse;width:100%}th,td{border:1px solid #444;padding:8px}th{background:#222}`;
  const css=theme==='dark'?cssDark:cssDefault;
  const rows=allTasks.map(t=>{
    const lastLog=(t.logs && t.logs.length)?t.logs[t.logs.length-1].action:'';
    return `<tr><td>${t.id}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.description||'')}</td><td>${t.due||''}</td><td>${t.status||''}</td><td>${t.createdBy||''}</td><td>${(t.assignedTo||[]).join(', ')}</td><td>${t.department||''}</td><td>${escapeHtml(lastLog)}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tasks Export</title><style>${css}</style></head><body><h1>Tasks Export</h1><table><thead><tr><th>ID</th><th>Title</th><th>Description</th><th>Due</th><th>Status</th><th>Created By</th><th>Assigned To</th><th>Department</th><th>Last Log</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

// ===== On ready =====
client.once(Events.ClientReady, async ()=>{
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const now=new Date();
  let changed=false;
  for(const [uid,list] of tasks.entries()){
    for(const t of list){
      if(t.due && t.status!=='Done'){
        const dueDate=new Date(t.due);
        if(dueDate<now && t.status!=='Overdue'){
          t.status='Overdue';
          t.logs=t.logs||[];
          t.logs.push({date:new Date().toISOString(),action:'Auto-marked overdue on startup'});
          changed=true;
        }
      }
    }
  }
  if(changed) await safeSave(async ()=>saveTasks());
  scheduleReminders();
});

// ===== LOGIN =====
if(!process.env.DISCORD_TOKEN){ console.error('DISCORD_TOKEN not set'); process.exit(1); }
client.login(process.env.DISCORD_TOKEN);
// ===== InteractionCreate handler =====
client.on(Events.InteractionCreate, async (interaction)=>{
  try{
    if(!interaction.isChatInputCommand()) return;
    const { commandName, options, user, guild } = interaction;

    // --- /task-create
    if(commandName==='task-create'){
      const title = options.getString('title');
      const description = options.getString('description')||'';
      const due = parseDue(options.getString('due'));
      const id = Date.now();
      const task = {
        id, title, description, due, status:'Pending', createdBy:user.username,
        assignedTo:[user.id], department:null,
        logs:[{date:new Date().toISOString(), action:'Created'}],
        remindersSent:[]
      };
      if(!tasks.has(user.id)) tasks.set(user.id, []);
      tasks.get(user.id).push(task);
      await safeSave(async()=>saveTasks());
      await interaction.reply({content:`✅ Task created: **${title}** (ID: ${id}) assigned to **${user.username}**`, ephemeral:true});
      return;
    }

    // --- /task-list
    if(commandName==='task-list'){
      let list=[];
      if(isAdminOrManager(user.id,guild)) list=getAllTasksUnique();
      else list=(tasks.get(user.id)||[]).map(t=>({...t,userId:user.id}));
      if(!list.length){ await interaction.reply({content:'📭 No tasks found', ephemeral:true}); return; }
      const lines = await Promise.all(list.map(async(t,i)=>{
        const assignees = await Promise.all((t.assignedTo||[]).map(async uid=>{
          try{ const u=await client.users.fetch(uid); return u.username; }catch{return uid;} 
        }));
        const dept = t.department || '-';
        const lastLog = (t.logs && t.logs.length) ? t.logs[t.logs.length-1].action : 'No updates';
        return `**${i+1}. ${t.title}** (ID:${t.id}) — ${t.status} — due:${t.due||'none'}\nAssigned: ${assignees.join(', ')}\nDepartment: ${dept}\nLast: ${lastLog}`;
      }));
      await interaction.reply({content:`📋 Tasks:\n${lines.join('\n\n')}`, ephemeral:true});
      return;
    }

    // --- /task-search
    if(commandName==='task-search'){
      const q = options.getString('q');
      const matches = fuzzySearchTasks(q,5);
      if(!matches.length){ await interaction.reply({content:'No matches found', ephemeral:true}); return; }
      const lines = await Promise.all(matches.map(async(t,i)=>{
        const assignees = await Promise.all((t.assignedTo||[]).map(async uid=>{
          try{ const u=await client.users.fetch(uid); return u.username; }catch{return uid;}
        }));
        return `**${i+1}. ${t.title}** (ID:${t.id}) — ${t.status} — due:${t.due||'none'} — assigned: ${assignees.join(', ')}`;
      }));
      await interaction.reply({content:`Search results for "${q}":\n\n${lines.join('\n\n')}\n\nUse /task-update or /task-delete`, ephemeral:true});
      return;
    }

    // --- /task-update
    if(commandName==='task-update'){
      const id = options.getInteger('id');
      const index = options.getInteger('index');
      const status = options.getString('status');
      let found = id ? findTaskById(id) : null;
      if(!found && index && isAdminOrManager(user.id,guild)){
        const all = getAllTasksUnique();
        if(index<1 || index>all.length){ await interaction.reply({content:'Invalid global index', ephemeral:true}); return; }
        found = findTaskById(all[index-1].id);
      } else if(!found){
        const ulist = tasks.get(user.id)||[];
        if(!index || index<1 || index>ulist.length){ await interaction.reply({content:'Invalid index', ephemeral:true}); return; }
        found = { userId:user.id, index:index-1, task:ulist[index-1] };
      }
      if(!found){ await interaction.reply({content:'Task not found', ephemeral:true}); return; }
      if(!isAdminOrManager(user.id,guild) && !(found.task.assignedTo||[]).includes(user.id)){
        await interaction.reply({content:'❌ You are not assigned to this task', ephemeral:true}); return;
      }
      const valid=['Pending','In Progress','Done','Blocked','Overdue'];
      if(!valid.includes(status)){ await interaction.reply({content:`Invalid status. Allowed: ${valid.join(', ')}`, ephemeral:true}); return; }
      found.task.status = status;
      found.task.logs = found.task.logs||[];
      found.task.logs.push({date:new Date().toISOString(), action:`Status set to ${status} by ${user.username}`});
      tasks.get(found.userId)[found.index] = found.task;
      await safeSave(async()=>saveTasks());
      await interaction.reply({content:`🔄 Task updated: ${found.task.title} -> ${status}`, ephemeral:true});
      return;
    }

    // --- /task-delete
    if(commandName==='task-delete'){
      const id = options.getInteger('id');
      const index = options.getInteger('index');
      let found = id ? findTaskById(id) : null;
      if(!found && index && isAdminOrManager(user.id,guild)){
        const all = getAllTasksUnique();
        if(index<1 || index>all.length){ await interaction.reply({content:'Invalid global index', ephemeral:true}); return; }
        found = findTaskById(all[index-1].id);
      } else if(!found){
        const ulist = tasks.get(user.id)||[];
        if(!index || index<1 || index>ulist.length){ await interaction.reply({content:'Invalid index', ephemeral:true}); return; }
        found = { userId:user.id, index:index-1, task:ulist[index-1] };
      }
      if(!found){ await interaction.reply({content:'Task not found', ephemeral:true}); return; }
      if(!isAdminOrManager(user.id,guild) && !(found.task.assignedTo||[]).includes(user.id)){
        await interaction.reply({content:'❌ You are not assigned to this task', ephemeral:true}); return;
      }
      const list = tasks.get(found.userId);
      const removed = list.splice(found.index,1);
      await safeSave(async()=>saveTasks());
      await interaction.reply({content:`🗑️ Deleted: ${removed[0].title}`, ephemeral:true});
      return;
    }

    // --- /task-assign
    if(commandName==='task-assign'){
      if(!isAdminOrManager(user.id,guild)){ await interaction.reply({content:'❌ Only admins/managers', ephemeral:true}); return; }
      const title = options.getString('title');
      const description = options.getString('description')||'';
      const due = parseDue(options.getString('due'));
      const department = options.getString('department')||null;
      const users = safeMentionableArray(options.getMentionable('users'));
      let assigned = users.map(u=>u.id);
      let deptTag=null;
      if(department && departments[department]){
        assigned.push(...departments[department]);
        deptTag=department;
      }
      assigned = [...new Set(assigned)];
      if(!assigned.length){ await interaction.reply({content:'⚠️ No users to assign', ephemeral:true}); return; }
      const id = Date.now();
      const task = { id, title, description, due, status:'Pending', createdBy:user.username, assignedTo:assigned, department:deptTag, logs:[{date:new Date().toISOString(), action:`Assigned by ${user.username}`}], remindersSent:[] };
      for(const uid of assigned){
        if(!tasks.has(uid)) tasks.set(uid,[]);
        tasks.get(uid).push(task);
      }
      const assigneeNames = await Promise.all(assigned.map(async uid=>{ try{ const u=await client.users.fetch(uid); return u.username; }catch{return uid;} }));
      await safeSave(async()=>saveTasks());
      await interaction.reply({content:`✅ Task assigned: ${title} (ID:${id}) to ${assigneeNames.join(', ')}${deptTag?` (Dept: ${deptTag})`:''}`, ephemeral:true});
      return;
    }

    // --- /task-add-assignee
if (commandName === 'task-add-assignee') {
  if (!isAdminOrManager(user.id, interaction.guild)) {
    await interaction.reply({ content:'❌ Only admins/managers', ephemeral:true });
    return;
  }
  const taskId = options.getInteger('id');
  const department = options.getString('department');
  const users = safeMentionableArray(options.getMentionable('users'));
  const taskInfo = findTaskById(taskId);
  if (!taskInfo) { await interaction.reply({ content:'Task not found', ephemeral:true }); return; }
  
  const toAdd = [...users.map(u=>u.id)];
  if (department && departments[department]) toAdd.push(...departments[department]);
  toAdd.forEach(uid => {
    if (!taskInfo.task.assignedTo.includes(uid)) taskInfo.task.assignedTo.push(uid);
    if (!tasks.has(uid)) tasks.set(uid, []);
    tasks.get(uid).push(taskInfo.task);
  });
  taskInfo.task.logs.push({ date: new Date().toISOString(), action: `Assignees added by ${user.username}` });
  await safeSave(async ()=>saveTasks());
  await interaction.reply({ content:`✅ Added assignees: ${toAdd.map(id => `<@${id}>`).join(', ')}`, ephemeral:true });
  return;
}

// --- /task-remove-assignee
if (commandName === 'task-remove-assignee') {
  if (!isAdminOrManager(user.id, interaction.guild)) {
    await interaction.reply({ content:'❌ Only admins/managers', ephemeral:true });
    return;
  }
  const taskId = options.getInteger('id');
  const users = safeMentionableArray(options.getMentionable('users'));
  const taskInfo = findTaskById(taskId);
  if (!taskInfo) { await interaction.reply({ content:'Task not found', ephemeral:true }); return; }

  users.forEach(u => {
    taskInfo.task.assignedTo = taskInfo.task.assignedTo.filter(id => id !== u.id);
    const userTasks = tasks.get(u.id) || [];
    const idx = userTasks.findIndex(t => t.id === taskInfo.task.id);
    if (idx !== -1) userTasks.splice(idx, 1);
  });
  taskInfo.task.logs.push({ date: new Date().toISOString(), action: `Assignees removed by ${user.username}` });
  await safeSave(async ()=>saveTasks());
  await interaction.reply({ content:`✅ Removed assignees: ${users.map(u=>u.username).join(', ')}`, ephemeral:true });
  return;
}


    // --- /department-add
    if(commandName==='department-add'){
      if(!isAdmin(user.id,guild)){ await interaction.reply({content:'❌ Only admins', ephemeral:true}); return; }
      const name = options.getString('name');
      const members = safeMentionableArray(options.getMentionable('members'));
      const ids = members.map(m=>m.id);
      departments[name] = ids;
      await safeSave(async()=>saveDepartments());
      await interaction.reply({content:`✅ Department ${name} added (${ids.join(', ')||'no members'})`, ephemeral:true});
      return;
    }

    // --- /department-list
    if(commandName==='department-list'){
      const out = Object.entries(departments).map(([d,m])=>`**${d}**: ${m.join(', ')||'No members'}`).join('\n')||'No departments';
      await interaction.reply({content:`📋 Departments:\n${out}`, ephemeral:true});
      return;
    }

    // --- /manager-add
    if(commandName==='manager-add'){
      if(!isAdmin(user.id,guild)){ await interaction.reply({content:'❌ Only admins', ephemeral:true}); return; }
      const users = safeMentionableArray(options.getMentionable('users'));
      users.forEach(u=>{ managers[u.id]=true; });
      await safeSave(async()=>saveManagers());
      await interaction.reply({content:`✅ Managers added: ${users.map(u=>u.username).join(', ')}`, ephemeral:true});
      return;
    }

    // --- /set-reminders
    if(commandName==='set-reminders'){
      if(!isAdmin(user.id,guild)){ await interaction.reply({content:'❌ Only admins', ephemeral:true}); return; }
      const value = options.getString('value')||'';
      config.reminders=value.split(',').map(s=>s.trim()).filter(Boolean);
      await safeSave(async()=>saveConfig());
      await interaction.reply({content:`✅ Reminder windows set: ${config.reminders.join(', ')}`, ephemeral:true});
      return;
    }

    // --- /export
    if(commandName==='export'){
      const format = options.getString('format')||'json';
      const theme = options.getString('theme')||'default';
      let all=[];
      if(isAdminOrManager(user.id,guild)) all=getAllTasksUnique();
      else all=(tasks.get(user.id)||[]).map(t=>({...t}));

      if(!all.length){ await interaction.reply({content:'No tasks to export', ephemeral:true}); return; }

      try{
        let buffer,name;
        if(format==='json'){ buffer=Buffer.from(tasksToJSON(all),'utf8'); name=`tasks-${Date.now()}.json`; }
        else if(format==='csv'){ buffer=Buffer.from(tasksToCSV(all),'utf8'); name=`tasks-${Date.now()}.csv`; }
        else { buffer=Buffer.from(tasksToHTML(all,theme),'utf8'); name=`tasks-${Date.now()}.html`; }
        const attach = new AttachmentBuilder(buffer,{name});
        await interaction.reply({content:`📤 Export (${format})`, files:[attach], ephemeral:true});
      } catch(err){ await interaction.reply({content:'Export failed', ephemeral:true}); console.error(err); }
      return;
    }

    // --- /help
    if(commandName==='help'){
      const msg=`🛠️ Commands:
/task-create title description due
/task-list
/task-search q
/task-update id|index status
/task-delete id|index
/task-assign title description due department users
/department-add name members
/department-list
/manager-add users
/set-reminders value1,value2
/export format(json|csv|html) theme(default|dark)
`;
      await interaction.reply({content:msg, ephemeral:true});
      return;
    }

  } catch(err){ console.error('Interaction error:', err); if(interaction.replied||interaction.deferred){ interaction.followUp({content:'❌ Error occurred', ephemeral:true}); } else { interaction.reply({content:'❌ Error occurred', ephemeral:true}); } }
});
