/* deploy-commands.js
   Run: node deploy-commands.js
   Env: DISCORD_TOKEN, CLIENT_ID, GUILD_ID
*/

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('task-create')
    .setDescription('Create a new task')
    .addStringOption(opt => opt.setName('title').setDescription('Task title').setRequired(true))
    .addStringOption(opt => opt.setName('description').setDescription('Task description'))
    .addStringOption(opt => opt.setName('due').setDescription('Due date/time (ISO or YYYY-MM-DDTHH:MM)')),

  new SlashCommandBuilder()
    .setName('task-list')
    .setDescription('List your tasks'),

  new SlashCommandBuilder()
    .setName('task-search')
    .setDescription('Search tasks')
    .addStringOption(opt => opt.setName('q').setDescription('Search query').setRequired(true)),

  new SlashCommandBuilder()
    .setName('task-update')
    .setDescription('Update task status')
    .addIntegerOption(opt => opt.setName('id').setDescription('Task ID'))
    .addIntegerOption(opt => opt.setName('index').setDescription('Task index in your list'))
    .addStringOption(opt => opt.setName('status').setDescription('New status').setRequired(true)),

  new SlashCommandBuilder()
    .setName('task-delete')
    .setDescription('Delete a task')
    .addIntegerOption(opt => opt.setName('id').setDescription('Task ID'))
    .addIntegerOption(opt => opt.setName('index').setDescription('Task index in your list')),

  new SlashCommandBuilder()
    .setName('task-assign')
    .setDescription('Assign task to users or department')
    .addStringOption(opt => opt.setName('title').setDescription('Task title').setRequired(true))
    .addStringOption(opt => opt.setName('description').setDescription('Task description'))
    .addStringOption(opt => opt.setName('due').setDescription('Due date/time'))
    .addStringOption(opt => opt.setName('department').setDescription('Department name'))
    .addMentionableOption(opt => opt.setName('users').setDescription('Mention users to assign')),

  new SlashCommandBuilder()
    .setName('department-add')
    .setDescription('Add a department')
    .addStringOption(opt => opt.setName('name').setDescription('Department name').setRequired(true))
    .addMentionableOption(opt => opt.setName('members').setDescription('Initial members')),

  new SlashCommandBuilder()
    .setName('department-list')
    .setDescription('List all departments'),

  new SlashCommandBuilder()
    .setName('manager-add')
    .setDescription('Add manager(s)')
    .addMentionableOption(opt => opt.setName('users').setDescription('Users to make managers')),

  new SlashCommandBuilder()
    .setName('set-reminders')
    .setDescription('Set reminder windows (comma-separated, e.g., 24h,1h,30m)')
    .addStringOption(opt => opt.setName('value').setDescription('Reminder windows').setRequired(true)),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export tasks')
    .addStringOption(opt => opt.setName('format').setDescription('json, csv, html'))
    .addStringOption(opt => opt.setName('theme').setDescription('default or dark')),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help message'),
    
  new SlashCommandBuilder()
  .setName('task-add-assignee')
  .setDescription('Add users or a department to an existing task (Admin/Manager)')
  .addIntegerOption(opt => opt.setName('id').setDescription('Task ID').setRequired(true))
  .addStringOption(opt => opt.setName('department').setDescription('Department name'))
  .addMentionableOption(opt => opt.setName('users').setDescription('Mention users to add')),

new SlashCommandBuilder()
  .setName('task-remove-assignee')
  .setDescription('Remove users from an existing task (Admin/Manager)')
  .addIntegerOption(opt => opt.setName('id').setDescription('Task ID').setRequired(true))
  .addMentionableOption(opt => opt.setName('users').setDescription('Mention users to remove')),
  
   
].map(cmd=>cmd.toJSON());

const rest = new REST({ version:'10' }).setToken(process.env.DISCORD_TOKEN);

(async ()=>{
  try{
    console.log('🚀 Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Successfully reloaded application (/) commands.');
  } catch(err){
    console.error(err);
  }
})();
