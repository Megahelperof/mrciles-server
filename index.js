const { Client, GatewayIntentBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

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
      { 
        name: 'attachment', 
        description: 'Image attachment', 
        type: 11, // Attachment type
        required: true 
      },
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
async function addProduct(attachment, name, price, link) {
  try {
    // Download image from Discord
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
    
    // Convert to base64
    const buffer = await response.buffer();
    const base64Image = buffer.toString('base64');
    
    // Create image metadata object
    const imageData = {
      data: base64Image,
      contentType: attachment.contentType,
      name: attachment.name
    };

    const docRef = await db.collection('products').add({
      image: imageData,  // Store metadata object
      name,
      price,
      link,
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return docRef.id;
  } catch (error) {
    console.error('Image processing error:', error);
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
        const attachment = options.getAttachment('attachment');
        const name = options.getString('name');
        const price = options.getString('price');
        const link = options.getString('link');
        
        // Validate attachment
        if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) {
          await interaction.editReply('❌ Please attach a valid image file');
          return;
        }
        
        // Check image size (max 1MB)
        if (attachment.size > 1024 * 1024) {
          await interaction.editReply('❌ Image too large (max 1MB)');
          return;
        }

        const productId = await addProduct(attachment, name, price, link);
        await interaction.editReply(`✅ Added product: "${name}" (ID: ${productId})`);
        break;
      }
      // ... keep other cases the same ...
    }
  } catch (error) {
    // ... error handling ...
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