const { Client, GatewayIntentBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');

// 1. Environment Validation
console.log('Starting bot...');
console.log('Environment variables:');
console.log(`- DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? 'SET' : 'MISSING'}`);
console.log(`- FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING'}`);
console.log(`- ADMIN_ROLE_ID: ${process.env.ADMIN_ROLE_ID ? 'SET' : 'MISSING'}`);

// Validate critical variables
const missingVars = [];
if (!process.env.DISCORD_BOT_TOKEN) missingVars.push('DISCORD_BOT_TOKEN');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) missingVars.push('FIREBASE_SERVICE_ACCOUNT');
if (!process.env.ADMIN_ROLE_ID) missingVars.push('ADMIN_ROLE_ID');

if (missingVars.length > 0) {
  console.error(`❌ FATAL: Missing environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Initialize Firebase
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf-8')
    );
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log('🔥 Firebase initialized successfully');
  } catch (error) {
    console.error('❌ FATAL: Firebase initialization failed:', error);
    process.exit(1);
  }
}

const db = admin.firestore();
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ] 
});

// 2. Command Registration
const commands = [
  {
    name: 'add',
    description: 'Add a new product',
    options: [
      { name: 'image', description: 'Imgur URL', type: 3, required: true },
      { name: 'name', description: 'Product name', type: 3, required: true },
      { name: 'price', description: 'Product price ($XX.XX)', type: 3, required: true },
      { name: 'link', description: 'Product link', type: 3, required: true }
    ]
  },
  {
    name: 'remove',
    description: 'Remove a product',
    options: [
      { name: 'id', description: 'Product ID', type: 3, required: true }
    ]
  },
  {
    name: 'bulk-add',
    description: 'Add multiple products (JSON format)',
    options: [
      { name: 'data', description: 'Product data array', type: 3, required: true }
    ]
  }
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

// 3. Firestore Database Operations
async function addProduct(image, name, price, link) {
  try {
    const docRef = await db.collection('products').add({
      image,
      name,
      price,
      link,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    return docRef.id;
  } catch (error) {
    console.error('Firestore error:', error);
    throw new Error('Failed to add product');
  }
}

async function removeProduct(id) {
  try {
    await db.collection('products').doc(id).delete();
    return true;
  } catch (error) {
    console.error('Firestore error:', error);
    throw new Error('Failed to remove product');
  }
}

async function bulkAddProducts(products) {
  try {
    const batch = db.batch();
    const addedIds = [];
    
    products.forEach(product => {
      const docRef = db.collection('products').doc();
      batch.set(docRef, {
        ...product,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
      addedIds.push(docRef.id);
    });
    
    await batch.commit();
    return addedIds;
  } catch (error) {
    console.error('Firestore error:', error);
    throw new Error('Failed to add products in bulk');
  }
}

// 4. Command Handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  const { commandName, options, member } = interaction;
  
  // Admin check
  if (!member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
    return interaction.reply({ 
      content: '⛔ You need admin privileges to use this command', 
      ephemeral: true 
    });
  }

  // DEFER THE REPLY IMMEDIATELY
  await interaction.deferReply({ ephemeral: true });

  try {
    switch (commandName) {
      case 'add': {
        const image = options.getString('image');
        const name = options.getString('name');
        const price = options.getString('price');
        const link = options.getString('link');
        
        const productId = await addProduct(image, name, price, link);
        // USE editReply INSTEAD OF reply
        await interaction.editReply(`✅ Added product: "${name}" (ID: ${productId})`);
        break;
      }
        
      case 'remove': {
        const id = options.getString('id');
        await removeProduct(id);
        // USE editReply INSTEAD OF reply
        await interaction.editReply(`✅ Removed product ID: ${id}`);
        break;
      }
        
      case 'bulk-add': {
        const data = options.getString('data');
        let products;
        
        try {
          products = JSON.parse(data);
          if (!Array.isArray(products)) throw new Error('Not an array');
        } catch (e) {
          // USE editReply FOR ERRORS TOO
          await interaction.editReply('❌ Invalid JSON format. Expected array of products');
          return;
        }
        
        const ids = await bulkAddProducts(products);
        // USE editReply INSTEAD OF reply
        await interaction.editReply(`✅ Added ${ids.length} products`);
        break;
      }
    }
  } catch (error) {
    console.error(`Command error: ${commandName}`, error);
    // USE editReply FOR ERROR RESPONSES
    await interaction.editReply(`❌ Error: ${error.message}`);
  }
});

// 5. Startup Sequence
client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}!`);
  
  try {
    // Register commands
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }
});

// 6. Login with error handling
client.login(process.env.DISCORD_BOT_TOKEN)
  .catch(error => {
    console.error('🔥 FATAL LOGIN ERROR:', error);
    console.log('Token length:', process.env.DISCORD_BOT_TOKEN?.length);
    console.log('First 5 chars:', process.env.DISCORD_BOT_TOKEN?.substring(0, 5));
    process.exit(1);
  });