const { Client, GatewayIntentBits } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

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
    description: 'Add multiple products (up to 5)',
    options: [
      { 
        name: 'images', 
        description: 'Product images (up to 5)', 
        type: 11, // Attachment
        required: true
      },
      { 
        name: 'names', 
        description: 'Product names (comma separated, same order as images)', 
        type: 3, 
        required: true 
      },
      { 
        name: 'prices', 
        description: 'Product prices (comma separated, same order as images)', 
        type: 3, 
        required: true 
      },
      { 
        name: 'links', 
        description: 'Product links (comma separated, same order as images)', 
        type: 3, 
        required: true 
      }
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
    
    for (const product of products) {
      const docRef = db.collection('products').doc();
      batch.set(docRef, {
        ...product,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
      addedIds.push(docRef.id);
    }
    
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
    case 'bulk-add': {
      const imagesOption = interaction.options.get('images');
      const namesOption = interaction.options.get('names').value;
      const pricesOption = interaction.options.get('prices').value;
      const linksOption = interaction.options.get('links').value;

      // Validate inputs
      const names = namesOption.split(',').map(n => n.trim());
      const prices = pricesOption.split(',').map(p => p.trim());
      const links = linksOption.split(',').map(l => l.trim());
      
      if (names.length !== prices.length || names.length !== links.length) {
        await interaction.editReply('❌ Number of names, prices, and links must match');
        return;
      }
      
      if (names.length < 1 || names.length > 5) {
        await interaction.editReply('❌ You can only add 1-5 products at once');
        return;
      }
      
      // Create product previews
      const products = [];
      const embeds = [];
      
      for (let i = 0; i < names.length; i++) {
        products.push({
          name: names[i],
          price: prices[i],
          link: links[i]
        });
        
        embeds.push(new EmbedBuilder()
          .setTitle(`Product #${i+1}`)
          .setDescription(`**${names[i]}**\nPrice: ${prices[i]}\n[Link](${links[i]})`)
          .setImage(`attachment://preview${i}.png`)
          .setColor('#3498db')
        );
      }
      
      // Create confirmation buttons
      const confirmButton = new ButtonBuilder()
        .setCustomId('confirm_bulk_add')
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success);
        
      const cancelButton = new ButtonBuilder()
        .setCustomId('cancel_bulk_add')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger);
        
      const actionRow = new ActionRowBuilder()
        .addComponents(confirmButton, cancelButton);
      
      // Store products in interaction for later use
      interaction.bulkProducts = products;
      
      // Send preview with buttons
      await interaction.editReply({
        content: `**Preview of ${products.length} products**\nPlease confirm:`,
        embeds,
        files: [new AttachmentBuilder(imagesOption.attachment.url, { name: 'preview0.png' })],
        components: [actionRow]
      });
      break;
    }
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