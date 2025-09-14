// deploy-commands.js
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const commands = [
  { name: 'task-create', description: 'Create personal task', options:[
    { name:'title', description:'Task title', type:3, required:true },
    { name:'description', description:'Task description', type:3, required:false },
    { name:'due', description:'Due (YYYY-MM-DD or ISO)', type:3, required:false }
  ]},
  { name:'task-list', description:'List your tasks (dashboard for admins/managers)' },
  { name:'task-search', description:'Search tasks by text', options:[
    { name:'q', description:'Query', type:3, required:true }
  ]},
  { name:'task-update', description:'Update task (by id or index)', options:[
    { name:'id', description:'Task id (preferred)', type:4, required:false },
    { name:'index', description:'Index (per-user or global for admins)', type:4, required:false },
    { name:'status', description:'New status', type:3, required:true, choices:[
      { name:'Pending', value:'Pending' },
      { name:'In Progress', value:'In Progress' },
      { name:'Done', value:'Done' },
      { name:'Blocked', value:'Blocked' },
      { name:'Overdue', value:'Overdue' }
    ]}
  ]},
  { name:'task-delete', description:'Delete a task (by id or index)', options:[
    { name:'id', description:'Task id', type:4, required:false },
    { name:'index', description:'Index (per-user/global)', type:4, required:false }
  ]},
  { name:'task-assign', description:'Assign a task to users or department (Admin/Manager)', options:[
    { name:'title', description:'Task title', type:3, required:true },
    { name:'description', description:'Task description', type:3, required:false },
    { name:'due', description:'Due date', type:3, required:false },
    { name:'department', description:'Department name', type:3, required:false },
    { name:'users', description:'Mention users', type:9, required:false }
  ]},
  { name:'department-add', description:'Add a department (Admin)', options:[
    { name:'name', description:'Department name', type:3, required:true },
    { name:'members', description:'Mention users', type:9, required:false }
  ]},
  { name:'department-list', description:'List departments' },
  { name:'department-add-member', description:'Add member to department (Admin)', options:[
    { name:'name', description:'Department name', type:3, required:true },
    { name:'member', description:'Mention user', type:6, required:true } // 6 = USER
  ]},
  { name:'department-remove-member', description:'Remove member from department (Admin)', options:[
    { name:'name', description:'Department name', type:3, required:true },
    { name:'member', description:'Mention user', type:6, required:true }
  ]},
  { name:'manager-add', description:'Add manager (Admin)', options:[
    { name:'users', description:'Mention users', type:9, required:true }
  ]},
  { name:'set-reminders', description:'Set reminder windows (Admin)', options:[
    { name:'value', description:'Comma-separated windows e.g. 24h,1h,30m', type:3, required:true }
  ]},
  { name:'export', description:'Export tasks (admins all, users own)', options:[
    { name:'format', description:'json/csv/html', type:3, required:true, choices:[
      { name:'json', value:'json' },
      { name:'csv', value:'csv' },
      { name:'html', value:'html' }
    ]},
    { name:'theme', description:'HTML theme default/dark', type:3, required:false, choices:[
      { name:'default', value:'default' }, { name:'dark', value:'dark' }
    ]}
  ]},
  { name:'help', description:'Show help' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('Commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();
