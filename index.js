const { Client, GatewayIntentBits } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { Pool } = require('pg');

// Add this at the top of bot.js
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('FATAL: DISCORD_BOT_TOKEN environment variable is not set!');
  process.exit(1);
}

if (process.env.DISCORD_BOT_TOKEN.length < 50) {
  console.error('FATAL: Invalid token length! Check your environment variable');
  process.exit(1);
}

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages
]});

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a new product')
    .addStringOption(option => 
      option.setName('image')
        .setDescription('Imgur URL')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('name')
        .setDescription('Product name')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('price')
        .setDescription('Product price ($XX.XX)')
        .setRequired(true))
    .addStringOption(option => 
      option.setName('link')
        .setDescription('Product link')
        .setRequired(true))
    .toJSON(),
  
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a product')
    .addStringOption(option => 
      option.setName('id')
        .setDescription('Product ID')
        .setRequired(true))
    .toJSON(),
  
  new SlashCommandBuilder()
    .setName('bulk-add')
    .setDescription('Add multiple products (JSON format)')
    .addStringOption(option => 
      option.setName('data')
        .setDescription('Product data array')
        .setRequired(true))
    .toJSON()
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

// Database functions
async function addProduct(image, name, price, link) {
  const res = await pool.query(
    'INSERT INTO products (image, name, price, link) VALUES ($1, $2, $3, $4) RETURNING *',
    [image, name, price, link]
  );
  return res.rows[0];
}

async function removeProduct(id) {
  await pool.query('DELETE FROM products WHERE id = $1', [id]);
  return true;
}

async function bulkAddProducts(products) {
  const values = products.map(p => 
    `('${p.image.replace(/'/g, "''")}', '${p.name.replace(/'/g, "''")}', '${p.price}', '${p.link}')`
  ).join(',');
  
  const query = `
    INSERT INTO products (image, name, price, link)
    VALUES ${values}
    RETURNING id
  `;
  
  const res = await pool.query(query);
  return res.rowCount;
}

// Command handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  // Check admin role
  if (!interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
    return interaction.reply({ content: '❌ You do not have permission to use this command', ephemeral: true });
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    
    switch (interaction.commandName) {
      case 'add':
        const image = interaction.options.getString('image');
        const name = interaction.options.getString('name');
        const price = interaction.options.getString('price');
        const link = interaction.options.getString('link');
        
        if (!image.startsWith('https://i.imgur.com/')) {
          return interaction.editReply('❌ Only Imgur URLs are allowed (https://i.imgur.com/...)');
        }
        
        const product = await addProduct(image, name, price, link);
        interaction.editReply(`✅ Product added! ID: ${product.id}`);
        break;
        
      case 'remove':
        const id = interaction.options.getString('id');
        await removeProduct(id);
        interaction.editReply(`✅ Product ${id} removed`);
        break;
        
      case 'bulk-add':
        try {
          const data = interaction.options.getString('data');
          const products = JSON.parse(data);
          
          // Validate products
          if (!Array.isArray(products)) throw new Error('Invalid format');
          for (const p of products) {
            if (!p.image || !p.name || !p.link) throw new Error('Missing fields');
            if (!p.image.startsWith('https://i.imgur.com/')) {
              throw new Error('Invalid image URL: ' + p.image);
            }
          }
          
          const count = await bulkAddProducts(products);
          interaction.editReply(`✅ Added ${count} products successfully!`);
        } catch (e) {
          interaction.editReply(`❌ Error: ${e.message}\nUse format: \`[{ "image": "...", "name": "...", "price": "...", "link": "..." }]\``);
        }
        break;
    }
  } catch (error) {
    console.error(error);
    interaction.editReply('❌ Server error: ' + error.message);
  }
});

// Start bot
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Register commands
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Commands registered!');
  } catch (error) {
    console.error('Command registration failed:', error);
  }
  
  // Create products table if not exists
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
});

client.login(process.env.DISCORD_BOT_TOKEN);