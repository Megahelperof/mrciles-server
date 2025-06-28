const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require("fs");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const cheerio = require("cheerio");

puppeteerExtra.use(StealthPlugin());

if (process.env.BOT_TYPE === "FIREBASE_BOT") {
    console.log('Starting Firebase bot...');
    console.log('Environment variables:');
    console.log(`- DISCORD_BOT_TOKEN: ${process.env.DISCORD_BOT_TOKEN ? 'SET' : 'MISSING'}`);
    console.log(`- FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING'}`);
    console.log(`- ADMIN_ROLE_ID: ${process.env.ADMIN_ROLE_ID ? 'SET' : 'MISSING'}`);
    
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
        }
    ];
    
    const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    async function addProduct(attachment, name, price, link) {
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
        if (!member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
            return interaction.reply({ 
                content: '⛔ You need admin privileges to use this command', 
                ephemeral: true 
            });
        }
        await interaction.deferReply({ ephemeral: true });
        try {
            switch (commandName) {
                case 'add': {
                    const attachment = options.getAttachment('attachment');
                    const name = options.getString('name');
                    const price = options.getString('price');
                    const link = options.getString('link');
                    if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) {
                        await interaction.editReply('❌ Please attach a valid image file');
                        return;
                    }
                    if (attachment.size > 1024 * 1024) {
                        await interaction.editReply('❌ Image too large (max 1MB)');
                        return;
                    }
                    const productId = await addProduct(attachment, name, price, link);
                    await interaction.editReply(`✅ Added product: "${name}" (ID: ${productId})`);
                    break;
                }
                case 'bulk-add': {
                    const imagesOption = interaction.options.getAttachment('images');
                    const names = interaction.options.getString('names').split(',').map(n => n.trim());
                    const prices = interaction.options.getString('prices').split(',').map(p => p.trim());
                    const links = interaction.options.getString('links').split(',').map(l => l.trim());
                    if (names.length !== prices.length || names.length !== links.length) {
                        await interaction.editReply('❌ Number of names, prices, and links must match');
                        return;
                    }
                    if (names.length < 1 || names.length > 5) {
                        await interaction.editReply('❌ You can only add 1-5 products at once');
                        return;
                    }
                    const embeds = names.map((name, i) => 
                        new EmbedBuilder()
                            .setTitle(`Product #${i+1}`)
                            .setDescription(`**${name}**\nPrice: ${prices[i]}\n[Link](${links[i]})`)
                            .setImage(imagesOption.url)
                            .setColor('#3498db')
                    );
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
    try {
        if (fs.existsSync(PRODUCTS_FILE)) {
            products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
        } else {
            fs.writeFileSync(PRODUCTS_FILE, "[]");
        }
    } catch (err) {
        console.error("Error loading products:", err);
    }
    
    function saveProducts() {
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
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
    
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
        partials: [Partials.Channel],
    });
    
    client.once("ready", () => {
        console.log(`Logged in as ${client.user.tag}`);
        const commands = [
            new SlashCommandBuilder().setName("update").setDescription("Check for product updates"),
            new SlashCommandBuilder().setName("invalid").setDescription("Show invalid/dead links"),
            new SlashCommandBuilder()
                .setName("prices")
                .setDescription("Show prices with a limit")
                .addIntegerOption(opt => opt.setName("amount").setDescription("Amount of items to show").setRequired(true)),
            new SlashCommandBuilder()
                .setName("add")
                .setDescription("Add a new product")
                .addStringOption(opt => opt.setName("name").setDescription("Product name").setRequired(true))
                .addStringOption(opt => opt.setName("url").setDescription("Product URL").setRequired(true)),
            new SlashCommandBuilder()
                .setName("remove")
                .setDescription("Remove a product by ID")
                .addIntegerOption(opt => opt.setName("id").setDescription("Product ID (1-100)").setRequired(true)),
            new SlashCommandBuilder()
                .setName("bulk")
                .setDescription("Bulk update products from JSON file")
                .addAttachmentOption(opt => opt.setName("file").setDescription("JSON file with products").setRequired(true)),
        ].map(cmd => cmd.toJSON());
        
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        rest
            .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
            .then(() => console.log("Slash commands registered"))
            .catch(console.error);
    });
    
    const processedInteractions = new Set();
    
    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) {
            return;
        }
        if (processedInteractions.has(interaction.id)) {
            return;
        }
        processedInteractions.add(interaction.id);
        if (processedInteractions.size > 100) {
            const entries = Array.from(processedInteractions);
            entries.slice(0, entries.length - 100).forEach(id => processedInteractions.delete(id));
        }
        try {
            if (interaction.isChatInputCommand()) {
                const command = interaction.commandName;
                if (command === "update") {
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
                } 
            }
        } catch (error) {
            console.error('Error handling interaction:', error);
        }
    });
    
    client.login(TOKEN);
} else {
    console.error("FATAL: BOT_TYPE environment variable not set or invalid. Must be 'FIREBASE_BOT' or 'SCRAPER_BOT'");
    process.exit(1);
}