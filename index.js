require('dotenv').config();

const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, AttachmentBuilder, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder } = require('discord.js');
const fs = require("fs");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const cheerio = require("cheerio");

puppeteerExtra.use(StealthPlugin());

// Default selectors and text for product monitoring
const DEFAULT_PRICE_SELECTOR = "b[class^='productPrice_price']";
const DEFAULT_STOCK_SELECTOR = "button[class*='productButton_soldout']";
const DEFAULT_CHECK_TEXT = "Sold Out";

if (process.env.BOT_TYPE === "FIREBASE_BOT") {
    console.log('Starting Firebase bot...');
    const missingVars = [];
    if (!process.env.DISCORD_BOT_TOKEN) missingVars.push('DISCORD_BOT_TOKEN');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) missingVars.push('FIREBASE_SERVICE_ACCOUNT');
    if (!process.env.ADMIN_ROLE_ID) missingVars.push('ADMIN_ROLE_ID');
    
    if (missingVars.length > 0) {
        console.error(`❌ FATAL: Missing environment variables: ${missingVars.join(', ')}`);
        process.exit(1);
    }
    
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

    const CATEGORIES = {
        MENS: ['SHOES', 'CLOTHES', 'FRAGRANCE'],
        WOMENS: ['SHOES', 'CLOTHES', 'FRAGRANCE'],
        KIDS: [],
        TECH: [],
        JEWELRY_ACCESSORIES: [],
        MISC: []
    };
    
    const commands = [
        {
            name: 'add',
            description: 'Add a new product',
            options: [
                { name: 'attachment', description: 'Image attachment', type: 11, required: true },
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
                { name: 'images', description: 'Product images (up to 5)', type: 11, required: true },
                { name: 'names', description: 'Product names (comma separated)', type: 3, required: true },
                { name: 'prices', description: 'Product prices (comma separated)', type: 3, required: true },
                { name: 'links', description: 'Product links (comma separated)', type: 3, required: true }
            ]
        },
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show all available commands')
            .toJSON()
    ];
    
    const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    async function addProduct(attachment, name, price, link, mainCategory = '', subCategory = '') {
        try {
            const response = await fetch(attachment.url);
            if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
            const buffer = await response.buffer();
            const base64Image = buffer.toString('base64');
            const imageData = {
                data: base64Image,
                contentType: attachment.contentType,
                name: attachment.name
            };
            const docRef = await db.collection('products').add({
                image: imageData,
                name,
                price,
                link,
                mainCategory,  // Added category fields
                subCategory,   // Added category fields
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
    

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName, options, member } = interaction;
    
    // Handle help command separately
    if (commandName === "help") {
        const helpEmbed = new EmbedBuilder()
            .setTitle('🔥 Firebase Bot Commands')
            .setDescription('Manage your product catalog')
            .setColor('#3498db')
            .addFields(
                { name: '/add', value: 'Add a new product with image, name, price and link' },
                { name: '/remove [id]', value: 'Remove a product by ID' },
                { name: '/bulk-add', value: 'Add multiple products at once (up to 5)' }
            );
        
        return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
    }
    
    // Admin-only commands below
    if (!member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
        return interaction.reply({ 
            content: '⛔ You need admin privileges to use this command', 
            ephemeral: true 
        });
    }
    
    // Defer reply for admin commands
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
                if (attachment.size > 1024 * 1024) {
                    await interaction.editReply('❌ Image too large (max 1MB)');
                    return;
                }
                
                // Create category selection menu
                const mainCategoryRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('main_category')
                        .setPlaceholder('Select main category')
                        .addOptions(
                            Object.keys(CATEGORIES).map(cat => ({
                                label: cat,
                                value: cat
                            }))
                        )
                );
                
                await interaction.editReply({
                    content: '✅ Product details received! Please select a category:',
                    components: [mainCategoryRow]
                });
                
                // Store product data temporarily for category selection
                interaction.productData = { attachment, name, price, link };
                break;
            }
            case 'bulk-add': {
                const imagesOption = interaction.options.getAttachment('images');
                const names = interaction.options.getString('names').split(',').map(n => n.trim());
                const prices = interaction.options.getString('prices').split(',').map(p => p.trim());
                const links = interaction.options.getString('links').split(',').map(l => l.trim());
                
                // Validate bulk input
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
                        .setCustomId('confirm_bulk_add')
                        .setLabel('Confirm')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('cancel_bulk_add')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Danger)
                );
                
                // Store bulk products temporarily
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
        console.error('Command error:', error);
        await interaction.editReply(`❌ Error: ${error.message}`);
    }
});

    
    client.on('interactionCreate', async interaction => {
        if (!interaction.isButton()) return;
        await interaction.deferUpdate();
        if (interaction.customId === 'confirm_bulk_add') {
            try {
                const products = interaction.message.interaction.bulkProducts;
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
        if (interaction.customId === 'cancel_bulk_add') {
            await interaction.editReply({
                content: '❌ Bulk add cancelled',
                embeds: [],
                components: []
            });
        }
    });
    
    client.once('ready', async () => {
        console.log(`✅ Bot logged in as ${client.user.tag}!`);
        try {
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );
            console.log('✅ Slash commands registered');
        } catch (error) {
            console.error('❌ Command registration failed:', error);
        }
    });
    
    client.login(process.env.DISCORD_BOT_TOKEN)
        .catch(error => {
            console.error('🔥 FATAL LOGIN ERROR:', error);
            process.exit(1);
        });
} else if (process.env.BOT_TYPE === "SCRAPER_BOT") {
    console.log('Starting Scraper bot...');
    const TOKEN = process.env.DISCORD_BOT_TOKEN;
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const GUILD_ID = process.env.DISCORD_GUILD_ID;
    const PRODUCTS_FILE = "./products.json";
    
    let products = [];
    let lastScrapeResults = [];
    let scrapeCacheTimestamp = 0;
    const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache
    
    try {
        if (fs.existsSync(PRODUCTS_FILE)) {
            products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
        } else {
            fs.writeFileSync(PRODUCTS_FILE, "[]");
        }
        console.log(`Loaded ${products.length} products`);
    } catch (err) {
        console.error("Error loading products:", err);
    }
    
    function saveProducts() {
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
    }
    
    function reorganizeIds() {
        products.sort((a, b) => a.id - b.id);
        for (let i = 0; i < products.length; i++) {
            products[i].id = i + 1;
        }
        saveProducts();
    }
    
    function generateProductId() {
        const usedIds = new Set(products.map(p => p.id));
        for (let id = 1; id <= 100; id++) {
            if (!usedIds.has(id)) return id;
        }
        return null;
    }
    
    async function safeGoto(page, url, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
                return;
            } catch (e) {
                if (i === retries - 1) throw e;
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    
    async function puppeteerCheck(site) {
        const browser = await puppeteerExtra.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-http2"],
        });
        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        );
        await safeGoto(page, site.url);
        const result = await page.evaluate(
            (priceSelector, stockSelector) => {
                const priceEl = document.querySelector(priceSelector);
                const stockEl = document.querySelector(stockSelector);
                const price = priceEl ? priceEl.innerText.trim() : "N/A";
                const stock = stockEl ? stockEl.innerText.trim() : "N/A";
                return { price, stock };
            },
            site.priceSelector,
            site.stockSelector
        );
        await browser.close();
        return result;
    }
    
    async function axiosFallback(site) {
        try {
            const res = await axios.get(site.url, { timeout: 15000 });
            const $ = cheerio.load(res.data);
            const price = $(site.priceSelector).first().text().trim() || "N/A";
            const stock = $(site.stockSelector).first().text().trim() || "N/A";
            return { price, stock };
        } catch (err) {
            throw new Error("Fallback axios error: " + err.message);
        }
    }
    
    async function checkSites() {
        const results = [];
        for (const site of products) {
            try {
                let result;
                try {
                    result = await puppeteerCheck(site);
                } catch (puppeteerErr) {
                    console.warn(`Puppeteer failed for ${site.name}: ${puppeteerErr.message}`);
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
        lastScrapeResults = results;
        scrapeCacheTimestamp = Date.now();
        return results;
    }
    
    function parsePrice(priceStr) {
        if (!priceStr) return null;
        const cleanStr = priceStr.replace(/[^\d.,]/g, '');
        const lastComma = cleanStr.lastIndexOf(',');
        const lastDot = cleanStr.lastIndexOf('.');
        
        if (lastComma > lastDot) {
            return parseFloat(cleanStr.replace(/\./g, '').replace(',', '.'));
        } else if (lastDot > lastComma) {
            return parseFloat(cleanStr.replace(/,/g, ''));
        }
        
        return parseFloat(cleanStr);
    }
    
    function getPriceData() {
        const now = Date.now();
        if (now - scrapeCacheTimestamp > CACHE_DURATION || lastScrapeResults.length === 0) {
            return null;
        }
        return lastScrapeResults.map(p => {
            const priceNum = parsePrice(p.price);
            return {
                ...p,
                priceNum: isNaN(priceNum) ? null : priceNum
            };
        }).filter(p => p.priceNum !== null);
    }
    
    function findClosestPrices(priceData, targetPrice, count = 5) {
        if (priceData.length === 0) return [];
        
        const withDifference = priceData.map(p => ({
            ...p,
            difference: Math.abs(p.priceNum - targetPrice)
        }));
        
        withDifference.sort((a, b) => a.difference - b.difference);
        
        return withDifference.slice(0, count);
    }
    
    function findPriceRange(priceData) {
        if (priceData.length === 0) return [];
        
        const sorted = [...priceData].sort((a, b) => a.priceNum - b.priceNum);
        const results = [];
        
        if (sorted.length > 0) results.push(sorted[0]);
        if (sorted.length > 1) results.push(sorted[sorted.length - 1]);
        if (sorted.length > 2) results.push(sorted[Math.floor(sorted.length / 2)]);
        
        return results.slice(0, 5);
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

    
    
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
        partials: [Partials.Channel],
    });
    
    client.once("ready", () => {
        console.log(`Logged in as ${client.user.tag}`);
        const commands = [
            new SlashCommandBuilder().setName("products").setDescription("Check for product updates"),
            new SlashCommandBuilder().setName("invalid").setDescription("Show invalid/dead links"),
            new SlashCommandBuilder()
                .setName("prices")
                .setDescription("Show prices closest to target")
                .addNumberOption(opt => opt.setName("target").setDescription("Target price").setRequired(true)),
            new SlashCommandBuilder()
                .setName("addlink")
                .setDescription("Add a new product")
                .addStringOption(opt => opt.setName("name").setDescription("Product name").setRequired(true))
                .addStringOption(opt => opt.setName("url").setDescription("Product URL").setRequired(true)),
            new SlashCommandBuilder()
                .setName("removelink")
                .setDescription("Remove a product by ID")
                .addIntegerOption(opt => opt.setName("id").setDescription("Product ID").setRequired(true)),
            new SlashCommandBuilder()
                .setName("bulklink")
                .setDescription("Bulk update products from JSON file")
                .addAttachmentOption(opt => opt.setName("file").setDescription("JSON file with products").setRequired(true)),
            new SlashCommandBuilder()
                .setName("bulkremovelink")
                .setDescription("Bulk remove products by IDs")
                .addStringOption(opt => opt.setName("ids").setDescription("Comma separated product IDs").setRequired(true)),
            new SlashCommandBuilder()
                .setName("help")
                .setDescription("Show all available commands")
        ].map(cmd => cmd.toJSON());
        
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        rest
            .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
            .then(() => console.log("Slash commands registered"))
            .catch(console.error);
    });
    
    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) {
            return;
        }
        
        try {
            if (interaction.isChatInputCommand()) {
                const command = interaction.commandName;
                
                if (command === "help") {
                    const helpEmbed = new EmbedBuilder()
                        .setTitle('🔍 Scraper Bot Commands')
                        .setDescription('Monitor product prices and availability')
                        .setColor('#2ecc71')
                        .addFields(
                            { name: '/products', value: 'Check current product status with pagination' },
                            { name: '/invalid', value: 'Show products with monitoring errors' },
                            { name: '/prices [target]', value: 'Find products closest to target price' },
                            { name: '/addlink [name] [url]', value: 'Add new product to monitor' },
                            { name: '/removelink [id]', value: 'Remove a product by ID' },
                            { name: '/bulklink [file]', value: 'Bulk import products from JSON file' },
                            { name: '/bulkremovelink [ids]', value: 'Remove multiple products by comma-separated IDs' }
                        );
                    
                    return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
                }
                
                // Defer reply for all other commands
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.deferReply();
                }
                
                if (command === "products") {
                    try {
                        const results = await checkSites();
                        const pages = chunkArray(results, 5);
                        
                        if (pages.length === 0) {
                            await interaction.editReply("No products to monitor. Add products using /addlink command.");
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
                        console.error("Error in products command:", error);
                        await interaction.editReply("❌ An error occurred while checking products.");
                    }
                } 
                else if (command === "invalid") {
                    try {
                        const results = lastScrapeResults.length > 0 ? lastScrapeResults : await checkSites();
                        const invalidProducts = results.filter(p => p.error);
                        
                        if (invalidProducts.length === 0) {
                            await interaction.editReply("✅ All products are working correctly!");
                            return;
                        }
                        
                        const invalidList = invalidProducts.map(p => 
                            `[${p.id}] **${p.name}**\n${p.url}\nError: ${p.error}`
                        ).join("\n\n");
                        
                        await interaction.editReply({
                            content: `⚠️ **Invalid Products (${invalidProducts.length})**\n\n${invalidList}`
                        });
                    } catch (error) {
                        console.error("Error in invalid command:", error);
                        await interaction.editReply("❌ Failed to check invalid products.");
                    }
                }
                else if (command === "prices") {
                    try {
                        const targetPrice = interaction.options.getNumber("target");
                        let priceData = getPriceData();
                        
                        if (!priceData) {
                            await interaction.editReply("🔍 Prices are being updated... This might take a moment");
                            const results = await checkSites();
                            priceData = results.map(p => {
                                const priceNum = parsePrice(p.price);
                                return {
                                    ...p,
                                    priceNum: isNaN(priceNum) ? null : priceNum
                                };
                            }).filter(p => p.priceNum !== null);
                        }
                        
                        if (priceData.length === 0) {
                            await interaction.editReply("❌ No valid price data available");
                            return;
                        }
                        
                        const closestProducts = findClosestPrices(priceData, targetPrice);
                        let resultProducts = closestProducts;
                        
                        if (closestProducts.length === 0 || closestProducts[0].difference > 0) {
                            resultProducts = findPriceRange(priceData);
                        }
                        
                        if (resultProducts.length === 0) {
                            await interaction.editReply("❌ No products found with valid prices");
                            return;
                        }
                        
                        const priceList = resultProducts.map(p => 
                            `[${p.id}] **${p.name}**\nPrice: \`${p.price}\` (${p.priceNum.toFixed(2)})\nDifference: \`${p.difference ? p.difference.toFixed(2) : "N/A"}\``
                        ).join("\n\n");
                        
                        await interaction.editReply({
                            content: `💰 **Product Prices (Target: ${targetPrice})**\n\n${priceList}`
                        });
                    } catch (error) {
                        console.error("Error in prices command:", error);
                        await interaction.editReply("❌ Failed to retrieve prices.");
                    }
                }
                else if (command === "addlink") {
                    try {
                        const name = interaction.options.getString("name");
                        const url = interaction.options.getString("url");
                        
                        if (!name || !url) {
                            await interaction.editReply("❌ Both name and URL are required.");
                            return;
                        }
                        
                        const id = generateProductId();
                        if (!id) {
                            await interaction.editReply("❌ Maximum product limit reached (100 products)");
                            return;
                        }
                        
                        const newProduct = {
                            id,
                            name,
                            url,
                            priceSelector: DEFAULT_PRICE_SELECTOR,
                            stockSelector: DEFAULT_STOCK_SELECTOR,
                            checkText: DEFAULT_CHECK_TEXT
                        };
                        
                        products.push(newProduct);
                        saveProducts();
                        
                        await interaction.editReply(`✅ Added product: **${name}** (ID: ${id})\n${url}`);
                    } catch (error) {
                        console.error("Error in addlink command:", error);
                        await interaction.editReply("❌ Failed to add product.");
                    }
                }
                else if (command === "removelink") {
                    try {
                        const id = interaction.options.getInteger("id");
                        const index = products.findIndex(p => p.id === id);
                        
                        if (index === -1) {
                            await interaction.editReply(`❌ Product with ID ${id} not found.`);
                            return;
                        }
                        
                        const productName = products[index].name;
                        products.splice(index, 1);
                        saveProducts();
                        reorganizeIds();
                        
                        await interaction.editReply(`✅ Removed product: **${productName}** (ID: ${id})`);
                    } catch (error) {
                        console.error("Error in removelink command:", error);
                        await interaction.editReply("❌ Failed to remove product.");
                    }
                }
                else if (command === "bulkremovelink") {
                    try {
                        const idsInput = interaction.options.getString("ids");
                        const idsToRemove = idsInput.split(',').map(id => parseInt(id.trim()));
                        
                        if (idsToRemove.some(isNaN)) {
                            await interaction.editReply("❌ Invalid IDs format. Please use comma-separated numbers.");
                            return;
                        }
                        
                        const validIds = new Set(products.map(p => p.id));
                        const invalidIds = idsToRemove.filter(id => !validIds.has(id));
                        
                        if (invalidIds.length > 0) {
                            await interaction.editReply(`❌ These IDs are invalid: ${invalidIds.join(', ')}`);
                            return;
                        }
                        
                        const removedProducts = [];
                        products = products.filter(p => {
                            if (idsToRemove.includes(p.id)) {
                                removedProducts.push(`${p.id}: ${p.name}`);
                                return false;
                            }
                            return true;
                        });
                        
                        saveProducts();
                        reorganizeIds();
                        
                        await interaction.editReply({
                            content: `✅ Removed ${removedProducts.length} products:\n${removedProducts.join("\n")}`
                        });
                    } catch (error) {
                        console.error("Error in bulkremovelink command:", error);
                        await interaction.editReply("❌ Failed to remove products.");
                    }
                }
                else if (command === "bulklink") {
                    try {
                        const attachment = interaction.options.getAttachment("file");
                        if (!attachment || !attachment.contentType || !attachment.contentType.includes("json")) {
                            await interaction.editReply("❌ Please attach a valid JSON file.");
                            return;
                        }
                        
                        const response = await fetch(attachment.url);
                        if (!response.ok) throw new Error("Failed to download file");
                        const jsonData = await response.json();
                        
                        if (!Array.isArray(jsonData)) {
                            await interaction.editReply("❌ Invalid JSON format. Expected an array of products.");
                            return;
                        }
                        
                        const addedProducts = [];
                        for (const product of jsonData) {
                            const id = generateProductId();
                            if (!id) {
                                await interaction.editReply("❌ Maximum product limit reached (100 products)");
                                return;
                            }
                            
                            products.push({
                                id,
                                name: product.name || "Unnamed Product",
                                url: product.url || "",
                                priceSelector: product.priceSelector || DEFAULT_PRICE_SELECTOR,
                                stockSelector: product.stockSelector || DEFAULT_STOCK_SELECTOR,
                                checkText: product.checkText || DEFAULT_CHECK_TEXT
                            });
                            addedProducts.push(`${id}: ${product.name || "Unnamed Product"}`);
                        }
                        
                        saveProducts();
                        
                        await interaction.editReply({
                            content: `✅ Added ${jsonData.length} products:\n${addedProducts.join("\n")}`
                        });
                    } catch (error) {
                        console.error("Error in bulklink command:", error);
                        await interaction.editReply(`❌ Failed to bulk add products: ${error.message}`);
                    }
                }
            }
            else if (interaction.isButton() || interaction.isStringSelectMenu()) {
                if (!client.messageCache) return;
                const cached = client.messageCache.get(interaction.message.id);
                if (!cached) return;
                
                await interaction.deferUpdate();
                
                let newPage = cached.currentPage;
                if (interaction.isButton()) {
                    const pageIndex = parseInt(interaction.customId.split("_")[1]);
                    newPage = pageIndex;
                } else if (interaction.isStringSelectMenu()) {
                    if (interaction.customId === "select_page") {
                        newPage = parseInt(interaction.values[0]);
                    }
                }
                
                const embedPage = createPageEmbed(cached.pages[newPage], newPage, cached.pages.length);
                const buttons = createNavigationButtons(newPage, cached.pages.length);
                
                await interaction.editReply({
                    content: embedPage.content,
                    components: [buttons]
                });
                
                cached.currentPage = newPage;
                client.messageCache.set(interaction.message.id, cached);
            }
        } catch (error) {
            console.error('Error handling interaction:', error);
            
            if (error.code === 40060) {
                return;
            }
            
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: `❌ Error: ${error.message}`
                });
            } else if (interaction.deferred) {
                await interaction.editReply({ 
                    content: `❌ Error: ${error.message}`
                });
            } else {
                await interaction.followUp({ 
                    content: `❌ Error: ${error.message}`
                });
            }
        }
    });
    
    client.login(TOKEN);
} else {
    console.error("FATAL: BOT_TYPE environment variable not set or invalid. Must be 'FIREBASE_BOT' or 'SCRAPER_BOT'");
    process.exit(1);
}