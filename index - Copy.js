const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { Pool } = require('pg');

// 1. Environment Validation
console.log('Starting bot...');
console.log('Environment variables:');
console.log(`- DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? 'SET' : 'MISSING'}`);
console.log(`- DATABASE_URL: ${process.env.DATABASE_URL ? 'SET' : 'MISSING'}`);
console.log(`- ADMIN_ROLE_ID: ${process.env.ADMIN_ROLE_ID ? 'SET' : 'MISSING'}`);

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('FATAL: DISCORD_BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

if (process.env.DISCORD_BOT_TOKEN.length < 59 || process.env.DISCORD_BOT_TOKEN.length > 72) {
  console.error('FATAL: Token length invalid. Should be 59-72 characters. Actual length:', process.env.DISCORD_BOT_TOKEN.length);
  process.exit(1);
}

// 2. Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
    ca: process.env.DB_CA_CERT ? Buffer.from(process.env.DB_CA_CERT, 'base64').toString() : undefined
  }
});

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ] 
});

// 3. Command Registration
const commands = [
  {
    name: 'add',
    description: 'Add a new product',
    options: [
      {
        name: 'image',
        description: 'Imgur URL',
        type: 3,
        required: true
      },
      {
        name: 'name',
        description: 'Product name',
        type: 3,
        required: true
      },
      {
        name: 'price',
        description: 'Product price ($XX.XX)',
        type: 3,
        required: true
      },
      {
        name: 'link',
        description: 'Product link',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'remove',
    description: 'Remove a product',
    options: [
      {
        name: 'id',
        description: 'Product ID',
        type: 3,
        required: true
      }
    ]
  },
  {
    name: 'bulk-add',
    description: 'Add multiple products (JSON format)',
    options: [
      {
        name: 'data',
        description: 'Product data array',
        type: 3,
        required: true
      }
    ]
  }
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

// 4. Database Operations
async function addProduct(image, name, price, link) {
  try {
    const res = await pool.query(
      'INSERT INTO products (image, name, price, link) VALUES ($1, $2, $3, $4) RETURNING *',
      [image, name, price, link]
    );
    return res.rows[0];
  } catch (error) {
    console.error('Database error in addProduct:', error);
    throw new Error('Failed to add product');
  }
}

// ... other database functions ...

// 5. Command Handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  // ... command handling logic ...
});

// 6. Startup Sequence
client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}!`);
  
  try {
    // Register commands
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
    
    // Initialize database
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        image TEXT NOT NULL,
        name TEXT NOT NULL,
        price TEXT NOT NULL,
        link TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Startup error:', error);
    process.exit(1);
  }
});

// 7. Token Handling with Debugging
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('🔐 Login process started'))
  .catch(error => {
    console.error('🔥 FATAL LOGIN ERROR:', error);
    console.log('Token details:');
    console.log(`- Type: ${typeof process.env.DISCORD_BOT_TOKEN}`);
    console.log(`- Length: ${process.env.DISCORD_BOT_TOKEN?.length}`);
    console.log(`- First 5 chars: ${process.env.DISCORD_BOT_TOKEN?.substring(0, 5)}`);
    console.log(`- Last 5 chars: ${process.env.DISCORD_BOT_TOKEN?.slice(-5)}`);
    process.exit(1);
  });