const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials } = require('discord.js');
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// 1. Environment Validation
console.log('Starting bot...');
console.log('Environment variables:');
console.log(`- DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? 'SET' : 'MISSING'}`);
console.log(`- FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING'}`);
console.log(`- ADMIN_ROLE_ID: ${process.env.ADMIN_ROLE_ID ? 'SET' : 'MISSING'}`);
console.log(`- DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? 'SET' : 'MISSING'}`);
console.log(`- DISCORD_GUILD_ID: ${process.env.DISCORD_GUILD_ID ? 'SET' : 'MISSING'}`);

// Validate critical variables
const missingVars = [];
if (!process.env.DISCORD_BOT_TOKEN) missingVars.push('DISCORD_BOT_TOKEN');
if (!process.env.FIREBASE_SERVICE_ACCOUNT) missingVars.push('FIREBASE_SERVICE_ACCOUNT');
if (!process.env.ADMIN_ROLE_ID) missingVars.push('ADMIN_ROLE_ID');
if (!process.env.DISCORD_CLIENT_ID) missingVars.push('DISCORD_CLIENT_ID');
if (!process.env.DISCORD_GUILD_ID) missingVars.push('DISCORD_GUILD_ID');

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
const PRODUCTS_FILE = "./products.json";

// Load products from file or initialize empty array
let products = [];
try {
  if (fs.existsSync(PRODUCTS_FILE)) {
    products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
  } else {
    fs.writeFileSync(PRODUCTS_FILE, "[]");
  }
} catch (err) {
  console.error("Error loading products:", err);
}

// Save products to file
function saveProducts() {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

// Generate unique ID (1-100)
function generateProductId() {
  const usedIds = new Set(products.map(p => p.id));
  for (let id = 1; id <= 100; id++) {
    if (!usedIds.has(id)) return id;
  }
  return null;
}

// Firestore Database Operations
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

// Web Scraping Functions - UPDATED FOR PLAYWRIGHT
async function playwrightCheck(site) {
  let browser;
  try {
    // Dynamically import Playwright only when needed
    const { chromium } = require('playwright');
    
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 30000
    });
    
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for selectors to appear
    await page.waitForSelector(site.priceSelector, { timeout: 10000 }).catch(() => {});
    await page.waitForSelector(site.stockSelector, { timeout: 10000 }).catch(() => {});

    const price = await page.$eval(site.priceSelector, el => el.textContent.trim()).catch(() => "N/A");
    const stock = await page.$eval(site.stockSelector, el => el.textContent.trim()).catch(() => "N/A");

    await browser.close();
    return { price, stock };
  } catch (error) {
    if (browser) await browser.close();
    console.error(`Playwright error for ${site.url}:`, error.message);
    throw error;
  }
}

async function axiosFallback(site) {
  try {
    const res = await axios.get(site.url, { 
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    const $ = cheerio.load(res.data);

    const price = $(site.priceSelector).first().text().trim() || "N/A";
    const stock = $(site.stockSelector).first().text().trim() || "N/A";

    return { price, stock };
  } catch (err) {
    console.error(`Axios fallback error for ${site.url}:`, err.message);
    throw new Error("Fallback axios error: " + err.message);
  }
}

async function checkSites() {
  const results = [];

  for (const site of products) {
    try {
      let result;
      try {
        // First try Playwright
        result = await playwrightCheck(site);
      } catch (playwrightErr) {
        console.warn(`Playwright failed for ${site.name}: ${playwrightErr.message}`);
        // Fallback to Axios if Playwright fails
        result = await axiosFallback(site);
      }

      results.push({
        id: site.id,
        name: site.name,
        url: site.url,
        price: result.price,
        stock: result.stock,
        checkText: site.checkText || "",
      });
    } catch (err) {
      results.push({
        id: site.id,
        name: site.name,
        url: site.url,
        error: err.message,
      });
    }
  }
  return results;
}

function chunkArray(arr, size) {
  const chunked = [];
  for (let i = 0; i < arr.length; i += size) {
    chunked.push(arr.slice(i, i + size));
  }
  return chunked;
}

function createPageEmbed(pageItems, pageIndex, totalPages) {
  const lines = pageItems.map((site) => {
    if (site.error) return `[${site.id}] 🚫 **${site.name}** - Error: ${site.error}\n${site.url}`;
    const isOut = site.stock.toLowerCase().includes(site.checkText.toLowerCase());
    const emoji = isOut ? "🔴" : "🟢";
    return `[${site.id}] ${emoji} **${site.name}**\nPrice: \`${site.price}\`\nStock: \`${site.stock}\`\n${site.url}`;
  });

  return {
    content: `📊 **Product Status Summary (Page ${pageIndex + 1}/${totalPages})**\n\n${lines.join("\n\n")}`,
  };
}

function createNavigationButtons(pageIndex, totalPages) {
  if (totalPages <= 3) {
    return new ActionRowBuilder().addComponents(
      ...Array(totalPages)
        .fill()
        .map((_, i) =>
          new ButtonBuilder()
            .setCustomId(`page_${i}`)
            .setLabel(`${i + 1}`)
            .setStyle(i === pageIndex ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
    );
  } else {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("select_page")
        .setPlaceholder(`Select Page (1-${totalPages})`)
        .addOptions(
          Array(totalPages)
            .fill()
            .map((_, i) => ({
              label: `Page ${i + 1}`,
              description: `View page ${i + 1} of product status`,
              value: `${i}`,
            }))
        )
    );
  }
}

// Discord Client Setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Command Definitions
const commands = [
  // Firestore Commands (Product Management)
  {
    name: 'product-add',
    description: 'Add a new product to Firestore',
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
    name: 'product-remove',
    description: 'Remove a product from Firestore',
    options: [
      { name: 'id', description: 'Product ID', type: 3, required: true }
    ]
  },
  {
    name: 'product-bulk-add',
    description: 'Add multiple products to Firestore (up to 5)',
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
  },
  
  // Web Scraping Commands (Product Monitoring)
  {
    name: 'update',
    description: 'Check for product updates'
  },
  {
    name: 'invalid',
    description: 'Show invalid/dead links'
  },
  {
    name: 'prices',
    description: 'Show prices with a limit',
    options: [
      { 
        name: 'amount', 
        description: 'Amount of items to show', 
        type: 4, // Integer
        required: true 
      }
    ]
  },
  {
    name: 'add',
    description: 'Add a new product to monitor',
    options: [
      { 
        name: 'name', 
        description: 'Product name', 
        type: 3, // String
        required: true 
      },
      { 
        name: 'url', 
        description: 'Product URL', 
        type: 3, // String
        required: true 
      }
    ]
  },
  {
    name: 'remove',
    description: 'Remove a monitored product by ID',
    options: [
      { 
        name: 'id', 
        description: 'Product ID (1-100)', 
        type: 4, // Integer
        required: true 
      }
    ]
  },
  {
    name: 'bulk',
    description: 'Bulk update monitored products from JSON file',
    options: [
      { 
        name: 'file', 
        description: 'JSON file with products', 
        type: 11, // Attachment
        required: true 
      }
    ]
  }
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

// Track processed interactions to prevent double-processing
const processedInteractions = new Set();

// Interaction Handling
client.on('interactionCreate', async interaction => {
  // Only handle the specific interaction types we care about
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) {
    return;
  }

  // Prevent processing the same interaction twice
  if (processedInteractions.has(interaction.id)) {
    console.log(`Skipping already processed interaction: ${interaction.id}`);
    return;
  }
  
  // Add to processed set immediately
  processedInteractions.add(interaction.id);

  // Clean up old interaction IDs (keep only last 100)
  if (processedInteractions.size > 100) {
    const entries = Array.from(processedInteractions);
    entries.slice(0, entries.length - 100).forEach(id => processedInteractions.delete(id));
  }

  // Defer ALL interactions immediately to prevent timeout
  if (!interaction.deferred && !interaction.replied) {
    try {
      if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ ephemeral: true });
      } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await interaction.deferUpdate();
      }
    } catch (deferError) {
      console.error('Error deferring interaction:', deferError);
      return;
    }
  }

  try {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName, options, member } = interaction;
      
      // Firestore Commands (require admin role)
      if (commandName.startsWith('product-')) {
        // Admin check
        if (!member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
          await interaction.editReply('⛔ You need admin privileges to use this command');
          return;
        }

        try {
          switch (commandName) {
            case 'product-add': {
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
            case 'product-remove': {
              const id = options.getString('id');
              await removeProduct(id);
              await interaction.editReply(`✅ Product ${id} removed successfully`);
              break;
            }
            case 'product-bulk-add': {
              const imagesOption = options.getAttachment('images');
              const names = options.getString('names').split(',').map(n => n.trim());
              const prices = options.getString('prices').split(',').map(p => p.trim());
              const links = options.getString('links').split(',').map(l => l.trim());

              // Validate input lengths
              if (names.length !== prices.length || names.length !== links.length) {
                await interaction.editReply('❌ Number of names, prices, and links must match');
                return;
              }
              
              if (names.length < 1 || names.length > 5) {
                await interaction.editReply('❌ You can only add 1-5 products at once');
                return;
              }
              
              // Create preview embeds
              const embeds = names.map((name, i) => 
                new EmbedBuilder()
                  .setTitle(`Product #${i+1}`)
                  .setDescription(`**${name}**\nPrice: ${prices[i]}\n[Link](${links[i]})`)
                  .setImage(imagesOption.url)
                  .setColor('#3498db')
              );

              // Create confirmation buttons
              const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId('product_confirm_bulk_add')
                  .setLabel('Confirm')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId('product_cancel_bulk_add')
                  .setLabel('Cancel')
                  .setStyle(ButtonStyle.Danger)
              );

              // Store product data in interaction for later use
              interaction.bulkProducts = names.map((name, i) => ({
                name,
                price: prices[i],
                link: links[i],
                imageUrl: imagesOption.url
              }));

              await interaction.editReply({
                content: `**Preview of ${names.length} products**\nPlease confirm:`,
                embeds,
                components: [actionRow]
              });
              break;
            }
          }
        } catch (error) {
          console.error('Product command error:', error);
          await interaction.editReply(`❌ Error: ${error.message}`);
        }
      }
      // Web Scraping Commands
      else {
        switch (commandName) {
          case 'update': {
            await interaction.deferReply();
            try {
              const results = await checkSites();
              const pages = chunkArray(results, 5);

              if (pages.length === 0) {
                await interaction.editReply("No products to monitor. Add products using /add command.");
                return;
              }

              const embedPage = createPageEmbed(pages[0], 0, pages.length);
              const buttons = createNavigationButtons(0, pages.length);

              const message = await interaction.editReply({
                ...embedPage,
                components: [buttons],
              });

              client.messageCache = client.messageCache || new Map();
              client.messageCache.set(message.id, { pages, currentPage: 0, interaction });
            } catch (error) {
              console.error("Error in update command:", error);
              await interaction.editReply("❌ An error occurred while checking products.");
            }
            break;
          }
          case 'invalid': {
            await interaction.deferReply();  // Add this line
            try {
              const results = await checkSites();
              const invalidSites = results.filter(r => r.error || r.stock.toLowerCase().includes("out of stock") || r.price === "N/A");
              if (invalidSites.length === 0) {
                await interaction.editReply("✅ No invalid or out-of-stock sites found.");
                return;
              }
              const lines = invalidSites.map(s =>
                s.error
                  ? `[${s.id}] 🚫 **${s.name}** - Error: ${s.error}\n${s.url}`
                  : `[${s.id}] ⚠️ **${s.name}** might be invalid or out of stock.\nPrice: \`${s.price}\`\nStock: \`${s.stock}\`\n${s.url}`
              );
              await interaction.editReply(lines.join("\n\n"));
            } catch (error) {
              console.error("Error in invalid command:", error);
              await interaction.editReply("❌ An error occurred while checking invalid sites.");
            }
            break;
          }
          case 'prices': {
            await interaction.deferReply();  // Add this line
            try {
              const amount = options.getInteger("amount");
              const results = await checkSites();
              const limited = results.slice(0, amount);
              const lines = limited.map(s =>
                s.error
                  ? `[${s.id}] 🚫 **${s.name}** - Error: ${s.error}\n${s.url}`
                  : `[${s.id}] 💰 **${s.name}** Price: \`${s.price}\`\n${s.url}`
              );
              await interaction.editReply(lines.join("\n\n"));
            } catch (error) {
              console.error("Error in prices command:", error);
              await interaction.editReply("❌ An error occurred while fetching prices.");
            }
            break;
          }
          case 'add': {
            try {
              const name = options.getString("name");
              const url = options.getString("url");

              if (products.length >= 100) {
                await interaction.editReply("❌ Maximum product limit reached (100 products)");
                return;
              }

              const id = generateProductId();
              if (!id) {
                await interaction.editReply("❌ No available IDs (1-100)");
                return;
              }

              const newProduct = {
                id,
                name,
                url,
                priceSelector: "b[class^='productPrice_price']",
                stockSelector: "button[class*='productButton_soldout']",
                checkText: "Sold Out"
              };

              products.push(newProduct);
              saveProducts();

              await interaction.editReply(`✅ Added product [${id}] ${name}\n${url}`);
            } catch (error) {
              console.error("Error in add command:", error);
              await interaction.editReply("❌ An error occurred while adding the product.");
            }
            break;
          }
          case 'remove': {
            try {
              const id = options.getInteger("id");

              const index = products.findIndex(p => p.id === id);
              if (index === -1) {
                await interaction.editReply(`❌ Product with ID ${id} not found`);
                return;
              }

              const [removed] = products.splice(index, 1);
              saveProducts();

              await interaction.editReply(`✅ Removed product [${id}] ${removed.name}`);
            } catch (error) {
              console.error("Error in remove command:", error);
              await interaction.editReply("❌ An error occurred while removing the product.");
            }
            break;
          }
          case 'bulk': {
            try {
              const attachment = options.getAttachment("file");

              if (!attachment.name.endsWith(".json")) {
                await interaction.editReply("❌ Please upload a JSON file");
                return;
              }

              const response = await axios.get(attachment.url);
              const bulkData = response.data;

              if (!Array.isArray(bulkData)) {
                await interaction.editReply("❌ Invalid JSON format. Expected an array of products");
                return;
              }

              let count = 0;
              const addedProducts = [];

              for (const item of bulkData) {
                if (products.length + addedProducts.length >= 100) {
                  await interaction.followUp({ 
                    content: `⚠️ Stopped importing: Reached maximum of 100 products`,
                    ephemeral: true
                  });
                  break;
                }

                const id = generateProductId();
                if (!id) {
                  await interaction.followUp({ 
                    content: `⚠️ Stopped importing: No available IDs (1-100)`,
                    ephemeral: true
                  });
                  break;
                }

                const url = item.url || item.value;
                if (!url) {
                  console.warn(`Skipping item without URL: ${JSON.stringify(item)}`);
                  continue;
                }

                const newProduct = {
                  id,
                  name: item.name,
                  url,
                  priceSelector: "b[class^='productPrice_price']",
                  stockSelector: "button[class*='productButton_soldout']",
                  checkText: "Sold Out"
                };

                addedProducts.push(newProduct);
                count++;
              }

              products.push(...addedProducts);
              saveProducts();

              await interaction.editReply(`✅ Imported ${count} products from bulk file`);
            } catch (error) {
              console.error("Error in bulk command:", error);
              await interaction.editReply("❌ An error occurred while processing the bulk file.");
            }
            break;
          }
        }
      }
    }

    // Handle button interactions
    if (interaction.isButton()) {
      // Firestore bulk add buttons
      if (interaction.customId.startsWith('product_')) {
        if (interaction.customId === 'product_confirm_bulk_add') {
          try {
            const products = interaction.message.interaction.bulkProducts;
            
            // Process images and add to Firestore
            const productsWithImages = await Promise.all(products.map(async (product) => {
              const response = await fetch(product.imageUrl);
              if (!response.ok) throw new Error('Failed to download image');
              
              const buffer = await response.buffer();
              return {
                ...product,
                image: {
                  data: buffer.toString('base64'),
                  contentType: response.headers.get('content-type'),
                  name: `product-${Date.now()}.${response.headers.get('content-type')?.split('/')[1] || 'png'}`
                }
              };
            }));

            const addedIds = await bulkAddProducts(productsWithImages);
            await interaction.editReply({
              content: `✅ Added ${addedIds.length} products successfully!`,
              embeds: [],
              components: []
            });
          } catch (error) {
            console.error('Bulk add error:', error);
            await interaction.editReply({
              content: `❌ Failed to add products: ${error.message}`,
              components: []
            });
          }
        }
        else if (interaction.customId === 'product_cancel_bulk_add') {
          await interaction.editReply({
            content: '❌ Bulk add cancelled',
            embeds: [],
            components: []
          });
        }
      }
      // Web scraping pagination buttons
      else {
        const messageData = client.messageCache?.get(interaction.message.id);
        if (!messageData) {
          await interaction.editReply({ content: "Pagination data expired.", ephemeral: true });
          return;
        }

        const requestedPage = parseInt(interaction.customId.split("_")[1]);
        if (isNaN(requestedPage) || requestedPage < 0 || requestedPage >= messageData.pages.length) {
          await interaction.editReply({ content: "Invalid page selected.", ephemeral: true });
          return;
        }

        messageData.currentPage = requestedPage;

        const embedPage = createPageEmbed(messageData.pages[requestedPage], requestedPage, messageData.pages.length);
        const buttons = createNavigationButtons(requestedPage, messageData.pages.length);

        await interaction.editReply({ ...embedPage, components: [buttons] });
      }
    }

    // Handle select menu interactions (web scraping pagination)
    if (interaction.isStringSelectMenu() && interaction.customId === "select_page") {
      const messageData = client.messageCache?.get(interaction.message.id);
      if (!messageData) {
        await interaction.editReply({ content: "Pagination data expired.", ephemeral: true });
        return;
      }

      const requestedPage = parseInt(interaction.values[0]);
      if (isNaN(requestedPage) || requestedPage < 0 || requestedPage >= messageData.pages.length) {
        await interaction.editReply({ content: "Invalid page selected.", ephemeral: true });
        return;
      }

      messageData.currentPage = requestedPage;

      const embedPage = createPageEmbed(messageData.pages[requestedPage], requestedPage, messageData.pages.length);
      const buttons = createNavigationButtons(requestedPage, messageData.pages.length);

      await interaction.editReply({ ...embedPage, components: [buttons] });
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ An error occurred while processing your request');
      } else {
        await interaction.reply({ 
          content: '⛔ You need admin privileges', 
           flags: 64  // Instead of ephemeral: true
        });

      await interaction.deferReply({ flags: 64 }); // Instead of ephemeral: true
      }
    } catch (replyError) {
      console.error('Error sending error reply:', replyError);
    }
  }
});

// Startup Sequence
client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}!`);
  
  try {
    // Register commands
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }
});

// Error Handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Login with error handling
client.login(process.env.DISCORD_BOT_TOKEN)
  .catch(error => {
    console.error('🔥 FATAL LOGIN ERROR:', error);
    console.log('Token length:', process.env.DISCORD_BOT_TOKEN?.length);
    console.log('First 5 chars:', process.env.DISCORD_BOT_TOKEN?.substring(0, 5));
    process.exit(1);
  });