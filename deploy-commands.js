import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const commands = [
  {
    name: 'task-create',
    description: 'Create a personal task',
    options: [
      { name: 'title', description: 'Task title', type: 3, required: true },
      { name: 'description', description: 'Task description', type: 3, required: false },
      { name: 'due', description: 'Due date', type: 3, required: false }
    ]
  },
  { name: 'task-list', description: 'List your tasks' },
  {
    name: 'task-update',
    description: 'Update task status',
    options: [
      { name: 'index', description: 'Task number', type: 4, required: true },
      {
        name: 'status',
        description: 'New status',
        type: 3,
        required: true,
        choices: [
          { name: 'Pending', value: 'Pending' },
          { name: 'In Progress', value: 'In Progress' },
          { name: 'Done', value: 'Done' },
          { name: 'Blocked', value: 'Blocked' }
        ]
      }
    ]
  },
  {
    name: 'task-delete',
    description: 'Delete a task',
    options: [{ name: 'index', description: 'Task number', type: 4, required: true }]
  },
  {
    name: 'department-add',
    description: 'Add a new department (Admin only)',
    options: [
      { name: 'name', description: 'Department name', type: 3, required: true },
      { name: 'members', description: 'Mention users', type: 9, required: false }
    ]
  },
  { name: 'department-list', description: 'List all departments' },
  {
    name: 'task-assign',
    description: 'Assign a task to users or a department (Admin/Manager only)',
    options: [
      { name: 'title', description: 'Task title', type: 3, required: true },
      { name: 'description', description: 'Task description', type: 3, required: false },
      { name: 'due', description: 'Due date', type: 3, required: false },
      { name: 'department', description: 'Department name', type: 3, required: false },
      { name: 'users', description: 'Mention users', type: 9, required: false }
    ]
  },
  {
    name: 'manager-add',
    description: 'Add manager role to users (Admin only)',
    options: [{ name: 'users', description: 'Mention users', type: 9, required: true }]
  },
  { name: 'help', description: 'Show guide for users/admins/managers' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('📡 Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }
})();
