import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ========== File Setup ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tasksFile = path.join(__dirname, 'tasks.json');
const departmentsFile = path.join(__dirname, 'departments.json');
const managersFile = path.join(__dirname, 'managers.json');

// Load tasks
let tasks = new Map();
if (fs.existsSync(tasksFile)) {
  const data = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
  tasks = new Map(Object.entries(data));
}

// Load departments
let departments = {};
if (fs.existsSync(departmentsFile)) {
  departments = JSON.parse(fs.readFileSync(departmentsFile, 'utf-8'));
}

// Load managers
let managers = {};
if (fs.existsSync(managersFile)) {
  managers = JSON.parse(fs.readFileSync(managersFile, 'utf-8'));
}

// Save functions
function saveTasks() {
  fs.writeFileSync(tasksFile, JSON.stringify(Object.fromEntries(tasks), null, 2));
}
function saveDepartments() {
  fs.writeFileSync(departmentsFile, JSON.stringify(departments, null, 2));
}
function saveManagers() {
  fs.writeFileSync(managersFile, JSON.stringify(managers, null, 2));
}

// ========== Admin & Manager Check ==========
const ADMIN_IDS = []; // optional IDs, server owner auto admin

function isAdmin(userId, guild) {
  const serverOwnerId = guild?.ownerId;
  return ADMIN_IDS.includes(userId) || userId === serverOwnerId;
}

function isManager(userId) {
  return managers[userId] != null;
}

function isAdminOrManager(userId, guild) {
  return isAdmin(userId, guild) || isManager(userId);
}

// ========== Discord Client ==========
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ========== Express Server ==========
const app = express();
app.get('/', (req, res) => res.send('✅ ZANS Task Manager is running'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server running'));

// ========== Interaction Handler ==========
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, user } = interaction;

  // ---------------- Task Create (Self) ----------------
  if (commandName === 'task-create') {
    const title = options.getString('title');
    const description = options.getString('description') || 'No description';
    const due = options.getString('due') || 'No deadline';

    const task = {
      id: Date.now(),
      title,
      description,
      due,
      status: 'Pending',
      createdBy: user.username,
      assignedTo: [user.id],
      department: null,
      logs: [{ date: new Date().toISOString(), action: 'Task created' }],
      notified: false
    };

    if (!tasks.has(user.id)) tasks.set(user.id, []);
    tasks.get(user.id).push(task);
    saveTasks();

    await interaction.reply(`✅ Task created for yourself:\n**${title}** (Due: ${due})`);
  }

  // ---------------- Task List ----------------
  if (commandName === 'task-list') {
    let userTasks = [];
    if (isAdminOrManager(user.id, interaction.guild)) {
      // Admins and managers see all tasks
      for (let [uid, tList] of tasks) {
        userTasks.push(...tList.map(t => ({ ...t, userId: uid })));
      }
    } else {
      userTasks = tasks.get(user.id) || [];
    }

    if (userTasks.length === 0) {
      await interaction.reply("📭 No tasks found.");
      return;
    }

    const list = userTasks
      .map((t, i) => {
        const lastLog = t.logs.length ? t.logs[t.logs.length - 1].action : "No updates";
        return `**${i + 1}. ${t.title}**\n   Status: ${t.status}\n   Due: ${t.due}\n   Dept: ${t.department || 'None'}\n   Last Log: ${lastLog}`;
      })
      .join('\n\n');

    await interaction.reply(`📋 Tasks:\n${list}`);
  }

  // ---------------- Task Update ----------------
  if (commandName === 'task-update') {
    const index = options.getInteger('index');
    const status = options.getString('status');

    let userTasks = tasks.get(user.id) || [];
    if (!isAdminOrManager(user.id, interaction.guild)) {
      if (index < 1 || index > userTasks.length) {
        await interaction.reply("⚠️ Invalid task index.");
        return;
      }
      userTasks[index - 1].status = status;
      userTasks[index - 1].logs.push({ date: new Date().toISOString(), action: `Status updated to ${status} by ${user.username}` });
    } else {
      // Admin/Manager can update any task using global index
      let allTasks = [];
      for (let [uid, tList] of tasks) {
        allTasks.push(...tList.map(t => ({ ...t, userId: uid })));
      }
      if (index < 1 || index > allTasks.length) {
        await interaction.reply("⚠️ Invalid task index.");
        return;
      }
      const task = allTasks[index - 1];
      task.status = status;
      task.logs.push({ date: new Date().toISOString(), action: `Status updated to ${status} by ${user.username}` });

      // Update original task
      const userTaskList = tasks.get(task.userId);
      const idxInUser = userTaskList.findIndex(t => t.id === task.id);
      userTaskList[idxInUser] = task;
    }

    saveTasks();
    await interaction.reply(`🔄 Task updated to **${status}**`);
  }

  // ---------------- Task Delete ----------------
  if (commandName === 'task-delete') {
    const index = options.getInteger('index');
    let userTasks = tasks.get(user.id) || [];
    if (!isAdminOrManager(user.id, interaction.guild)) {
      if (index < 1 || index > userTasks.length) {
        await interaction.reply("⚠️ Invalid task index.");
        return;
      }
      const removed = userTasks.splice(index - 1, 1);
      saveTasks();
      await interaction.reply(`🗑️ Deleted task: **${removed[0].title}**`);
    } else {
      let allTasks = [];
      for (let [uid, tList] of tasks) {
        allTasks.push(...tList.map(t => ({ ...t, userId: uid })));
      }
      if (index < 1 || index > allTasks.length) {
        await interaction.reply("⚠️ Invalid task index.");
        return;
      }
      const task = allTasks[index - 1];
      const userTaskList = tasks.get(task.userId);
      const idxInUser = userTaskList.findIndex(t => t.id === task.id);
      const removed = userTaskList.splice(idxInUser, 1);
      saveTasks();
      await interaction.reply(`🗑️ Deleted task: **${removed[0].title}**`);
    }
  }

  // ---------------- Department Add ----------------
  if (commandName === 'department-add') {
    if (!isAdmin(user.id, interaction.guild)) return interaction.reply("❌ Only admins can do this.");
    const name = options.getString('name');
    let memberMentions = options.getMentionable('members');
if (!memberMentions) memberMentions = [];
else if (!Array.isArray(memberMentions)) memberMentions = [memberMentions];
const memberIds = memberMentions.map(m => m.id);


    departments[name] = memberIds;
    saveDepartments();
    await interaction.reply(`✅ Department **${name}** added with members: ${memberIds.join(', ')}`);
  }

  // ---------------- Department List ----------------
  if (commandName === 'department-list') {
    const list = Object.entries(departments)
      .map(([dept, members]) => `**${dept}**: ${members.join(', ') || 'No members'}`)
      .join('\n');
    await interaction.reply(`📋 Departments:\n${list || 'No departments added.'}`);
  }

  // ---------------- Task Assign ----------------
  if (commandName === 'task-assign') {
    if (!isAdminOrManager(user.id, interaction.guild)) return interaction.reply("❌ Only admins/managers can assign tasks.");
    const title = options.getString('title');
    const description = options.getString('description') || 'No description';
    const due = options.getString('due') || 'No deadline';
    const department = options.getString('department') || null;
    let users = options.getMentionable('users');
if (!users) users = [];
else if (!Array.isArray(users)) users = [users];
const userIds = users.map(u => u.id);


    let assignedIds = [...users];
    if (department && departments[department]) assignedIds.push(...departments[department]);
    assignedIds = [...new Set(assignedIds)];

    if (assignedIds.length === 0) return interaction.reply("⚠️ No users to assign this task to.");

    const task = {
      id: Date.now(),
      title,
      description,
      due,
      status: 'Pending',
      createdBy: user.username,
      assignedTo: assignedIds,
      department: department,
      logs: [{ date: new Date().toISOString(), action: `Task assigned by ${user.username}` }],
      notified: false
    };

    assignedIds.forEach(uid => {
      if (!tasks.has(uid)) tasks.set(uid, []);
      tasks.get(uid).push(task);
    });

    saveTasks();
    await interaction.reply(`✅ Task **${title}** assigned to ${assignedIds.join(', ')}${department ? ` in ${department}` : ''}`);
  }

  // ---------------- Manager Add ----------------
  if (commandName === 'manager-add') {
    if (!isAdmin(user.id, interaction.guild)) return interaction.reply("❌ Only admins can do this.");
    const userMentions = options.getMentionable('users') || [];
    userMentions.forEach(u => {
      managers[u.id] = true;
    });
    saveManagers();
    await interaction.reply(`✅ Added managers: ${userMentions.map(u => u.username).join(', ')}`);
  }

  // ---------------- Help Command ----------------
  if (commandName === 'help') {
    if (isAdminOrManager(user.id, interaction.guild)) {
      await interaction.reply(`📌 **Admin/Manager Commands Guide**
- /task-create → Create personal task
- /task-assign → Assign task to users or departments
- /task-list → View all tasks
- /task-update → Update task status
- /task-delete → Delete task
- /department-add → Add department
- /department-list → List departments
- /manager-add → Add manager`);
    } else {
      await interaction.reply(`📌 **User Commands Guide**
- /task-create → Create your personal task
- /task-list → View your tasks
- /task-update → Update your task status (Pending / In Progress / Done / Blocked)
- /task-delete → Delete your task`);
    }
  }
});

// ========== Login ==========
client.login(process.env.DISCORD_TOKEN);
