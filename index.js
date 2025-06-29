require('dotenv').config();

const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, StringSelectMenuBuilder } = require('discord.js');
const fs = require("fs");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const cheerio = require("cheerio");

puppeteerExtra.use(StealthPlugin());

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

    const interactionCache = new Map();
    const db = admin.firestore();
    const client = new Client({ 
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
    });

    const CATEGORIES = {
        MENS: ['SHOES', 'CLOTHES', 'FRAGRANCE'],
        WOMENS: ['SHOES', 'CLOTHES', 'FRAGRANCE'],
        KIDS: [],
        TECH: [],
        JEWELRY_ACCESSORIES: [],
        MISC: [],
        MAIN: []
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
            description: 'Add multiple products (up to 5) with shared image',
            options: [
                { name: 'image', description: 'Product image (shared)', type: 11, required: true },
                { name: 'names', description: 'Product names (comma separated)', type: 3, required: true },
                { name: 'prices', description: 'Product prices (comma separated)', type: 3, required: true },
                { name: 'links', description: 'Product links (comma separated)', type: 3, required: true }
            ]
        },
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show commands')
            .toJSON()
    ];
    
    const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    async function addProduct(attachment, name, price, link, mainCategory = '', subCategory = '') {
        try {
            const response = await fetch(attachment.url);
            if (!response.ok) throw new Error(`Failed to download image`);
            const buffer = await response.buffer();
            const base64Image = buffer.toString('base64');
            const docRef = await db.collection('products').add({
                image: {
                    data: base64Image,
                    contentType: attachment.contentType,
                    name: attachment.name
                },
                name,
                price,
                link,
                mainCategory,
                subCategory,
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });
            return docRef.id;
        } catch (error) {
            throw new Error('Failed to add product');
        }
    }

    async function removeProduct(id) {
        try {
            await db.collection('products').doc(id).delete();
            return true;
        } catch (error) {
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
                    image: product.image,
                    name: product.name,
                    price: product.price,
                    link: product.link,
                    mainCategory: product.mainCategory || '',
                    subCategory: product.subCategory || '',
                    created_at: admin.firestore.FieldValue.serverTimestamp()
                });
                addedIds.push(docRef.id);
            }
            await batch.commit();
            return addedIds;
        } catch (error) {
            throw new Error('Failed to add products in bulk');
        }
    }
    
    client.on('interactionCreate', async interaction => {
        if (!interaction.isCommand()) return;
        const { commandName, options, member } = interaction;
        
        if (commandName === "help") {
            const helpEmbed = new EmbedBuilder()
                .setTitle('🔥 Firebase Bot Commands')
                .setDescription('Manage your product catalog')
                .setColor('#3498db')
                .addFields(
                    { name: '/add', value: 'Add a new product' },
                    { name: '/remove [id]', value: 'Remove a product by ID' },
                    { name: '/bulk-add', value: 'Add multiple products at once' }
                );
            return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
        
        if (!member.roles.cache.has(process.env.ADMIN_ROLE_ID)) {
            return interaction.reply({ 
                content: '⛔ Admin privileges required', 
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
                    
                    if (!attachment || !attachment.contentType?.startsWith('image/')) {
                        await interaction.editReply('❌ Invalid image file');
                        return;
                    }
                    
                    const mainCategoryRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('main_category')
                            .setPlaceholder('Select main category')
                            .addOptions(Object.keys(CATEGORIES).map(cat => ({
                                label: cat,
                                value: cat
                            })))
                    );
                    
                    const message = await interaction.editReply({
                        content: '✅ Select category:',
                        components: [mainCategoryRow]
                    });
                    
                    interactionCache.set(message.id, { 
                        type: 'single',
                        attachment, 
                        name, 
                        price, 
                        link 
                    });
                    break;
                }
                case 'bulk-add': {
                    const imageAttachment = options.getAttachment('image');
                    const names = options.getString('names').split(',').map(n => n.trim());
                    const prices = options.getString('prices').split(',').map(p => p.trim());
                    const links = options.getString('links').split(',').map(l => l.trim());
                    
                    if (!imageAttachment || !imageAttachment.contentType?.startsWith('image/')) {
                        await interaction.editReply('❌ Invalid image file');
                        return;
                    }
                    
                    if (names.length !== prices.length || names.length !== links.length) {
                        await interaction.editReply('❌ Names/prices/links count mismatch');
                        return;
                    }
                    if (names.length < 1 || names.length > 5) {
                        await interaction.editReply('❌ Add 1-5 products at once');
                        return;
                    }
                    
                    const embeds = names.map((name, i) => 
                        new EmbedBuilder()
                            .setTitle(`Product #${i+1}`)
                            .setDescription(`**${name}**\nPrice: ${prices[i]}\n[Link](${links[i]})`)
                            .setImage(imageAttachment.url)
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
                    
                    const message = await interaction.editReply({
                        content: `**Preview of ${names.length} products**`,
                        embeds,
                        components: [actionRow]
                    });
                    
                    interactionCache.set(message.id, {
                        type: 'bulk_preview',
                        products: names.map((name, i) => ({
                            name,
                            price: prices[i],
                            link: links[i],
                            imageUrl: imageAttachment.url,
                            contentType: imageAttachment.contentType,
                            fileName: imageAttachment.name
                        }))
                    });
                    break;
                }
            }
        } catch (error) {
            await interaction.editReply(`❌ Error: ${error.message}`);
        }
    });

    client.on('interactionCreate', async interaction => {
        if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
        
        try {
            if (interaction.customId === 'confirm_bulk_add') {
                await interaction.deferUpdate();
                const cachedData = interactionCache.get(interaction.message.id);
                if (!cachedData || cachedData.type !== 'bulk_preview') {
                    return interaction.editReply({
                        content: '❌ Product data expired',
                        components: []
                    });
                }
                
                const productsWithImages = await Promise.all(cachedData.products.map(async (product) => {
                    const response = await fetch(product.imageUrl);
                    if (!response.ok) throw new Error('Failed to download image');
                    const buffer = await response.buffer();
                    return {
                        ...product,
                        image: {
                            data: buffer.toString('base64'),
                            contentType: product.contentType,
                            name: product.fileName
                        }
                    };
                }));
                
                interactionCache.set(interaction.message.id, {
                    type: 'bulk',
                    products: productsWithImages
                });

                const mainCategoryRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('main_category')
                        .setPlaceholder('Select category for all')
                        .addOptions(Object.keys(CATEGORIES).map(cat => ({
                            label: cat,
                            value: cat
                        }))
                );
                
                await interaction.editReply({
                    content: '✅ Products confirmed! Select category:',
                    embeds: [],
                    components: [mainCategoryRow]
                });
            }
            else if (interaction.customId === 'cancel_bulk_add') {
                await interaction.deferUpdate();
                interactionCache.delete(interaction.message.id);
                await interaction.editReply({
                    content: '❌ Bulk add cancelled',
                    embeds: [],
                    components: []
                });
            }
            else if (interaction.customId === 'main_category') {
                await interaction.deferUpdate();
                const mainCategory = interaction.values[0];
                const cachedData = interactionCache.get(interaction.message.id);
                if (!cachedData) return interaction.editReply('❌ Product data expired');
                
                interactionCache.set(interaction.message.id, {...cachedData, mainCategory});

                if (CATEGORIES[mainCategory]?.length > 0) {
                    const subCategoryRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('sub_category')
                            .setPlaceholder('Select subcategory')
                            .addOptions(CATEGORIES[mainCategory].map(subCat => ({
                                label: subCat,
                                value: subCat
                            })))
                    );
                    
                    await interaction.editReply({
                        content: `✅ Main category: **${mainCategory}**! Choose subcategory:`,
                        components: [subCategoryRow]
                    });
                } else {
                    if (cachedData.type === 'single') {
                        const { attachment, name, price, link } = cachedData;
                        const productId = await addProduct(attachment, name, price, link, mainCategory);
                        interactionCache.delete(interaction.message.id);
                        await interaction.editReply({
                            content: `✅ Added: "${name}" (ID: ${productId})\nCategory: **${mainCategory}**`,
                            components: []
                        });
                    } 
                    else if (cachedData.type === 'bulk') {
                        const productsWithCategory = cachedData.products.map(product => ({
                            ...product,
                            mainCategory,
                            subCategory: ''
                        }));
                        const addedIds = await bulkAddProducts(productsWithCategory);
                        interactionCache.delete(interaction.message.id);
                        await interaction.editReply({
                            content: `✅ Added ${addedIds.length} products under **${mainCategory}**`,
                            components: []
                        });
                    }
                }
            }
            else if (interaction.customId === 'sub_category') {
                await interaction.deferUpdate();
                const subCategory = interaction.values[0];
                const cachedData = interactionCache.get(interaction.message.id);
                if (!cachedData || !cachedData.mainCategory) {
                    return interaction.editReply('❌ Product data expired');
                }
                
                const mainCategory = cachedData.mainCategory;
                
                if (cachedData.type === 'single') {
                    const { attachment, name, price, link } = cachedData;
                    const productId = await addProduct(attachment, name, price, link, mainCategory, subCategory);
                    interactionCache.delete(interaction.message.id);
                    await interaction.editReply({
                        content: `✅ Added: "${name}" (ID: ${productId})\nCategory: **${mainCategory} > ${subCategory}**`,
                        components: []
                    });
                } 
                else if (cachedData.type === 'bulk') {
                    const productsWithCategory = cachedData.products.map(product => ({
                        ...product,
                        mainCategory,
                        subCategory
                    }));
                    const addedIds = await bulkAddProducts(productsWithCategory);
                    interactionCache.delete(interaction.message.id);
                    await interaction.editReply({
                        content: `✅ Added ${addedIds.length} products under **${mainCategory} > ${subCategory}**`,
                        components: []
                    });
                }
            }
        } catch (error) {
            await interaction.editReply(`❌ Error: ${error.message}`);
        }
    });
    
    client.once('ready', async () => {
        console.log(`✅ Bot logged in as ${client.user.tag}!`);
        try {
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            console.log('✅ Slash commands registered');
        } catch (error) {
            console.error('❌ Command registration failed:', error);
        }
    });
    
    client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
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
    const CACHE_DURATION = 5 * 60 * 1000;
    
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
            throw new Error("Fallback error");
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
        return { content: `📊 **Product Status (Page ${pageIndex + 1}/${totalPages})**\n\n${lines.join("\n\n")}` };
    }
    
    function createNavigationButtons(pageIndex, totalPages) {
        if (totalPages <= 3) {
            return new ActionRowBuilder().addComponents(
                ...Array(totalPages).fill().map((_, i) =>
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
                    .addOptions(Array(totalPages).fill().map((_, i) => ({
                        label: `Page ${i + 1}`,
                        value: `${i}`,
                    }))
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
            new SlashCommandBuilder().setName("products").setDescription("Check product updates"),
            new SlashCommandBuilder().setName("invalid").setDescription("Show dead links"),
            new SlashCommandBuilder()
                .setName("prices")
                .setDescription("Show prices closest to target")
                .addNumberOption(opt => opt.setName("target").setDescription("Target price").setRequired(true)),
            new SlashCommandBuilder()
                .setName("addlink")
                .setDescription("Add new product")
                .addStringOption(opt => opt.setName("name").setDescription("Product name").setRequired(true))
                .addStringOption(opt => opt.setName("url").setDescription("Product URL").setRequired(true)),
            new SlashCommandBuilder()
                .setName("removelink")
                .setDescription("Remove product by ID")
                .addIntegerOption(opt => opt.setName("id").setDescription("Product ID").setRequired(true)),
            new SlashCommandBuilder()
                .setName("bulklink")
                .setDescription("Bulk update from JSON")
                .addAttachmentOption(opt => opt.setName("file").setDescription("JSON file").setRequired(true)),
            new SlashCommandBuilder()
                .setName("bulkremovelink")
                .setDescription("Bulk remove by IDs")
                .addStringOption(opt => opt.setName("ids").setDescription("Comma separated IDs").setRequired(true)),
            new SlashCommandBuilder()
                .setName("help")
                .setDescription("Show commands")
        ].map(cmd => cmd.toJSON());
        
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
            .then(() => console.log("Slash commands registered"))
            .catch(console.error);
    });
    
    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;
        
        try {
            if (interaction.isChatInputCommand()) {
                const command = interaction.commandName;
                
                if (command === "help") {
                    const helpEmbed = new EmbedBuilder()
                        .setTitle('🔍 Scraper Bot Commands')
                        .setColor('#2ecc71')
                        .addFields(
                            { name: '/products', value: 'Check product status' },
                            { name: '/invalid', value: 'Show monitoring errors' },
                            { name: '/prices [target]', value: 'Find closest prices' },
                            { name: '/addlink [name] [url]', value: 'Add new product' },
                            { name: '/removelink [id]', value: 'Remove by ID' },
                            { name: '/bulklink [file]', value: 'Bulk import' },
                            { name: '/bulkremovelink [ids]', value: 'Bulk remove' }
                        );
                    return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
                }
                
                if (!interaction.replied && !interaction.deferred) await interaction.deferReply();
                
                if (command === "products") {
                    const results = await checkSites();
                    const pages = chunkArray(results, 5);
                    if (pages.length === 0) {
                        await interaction.editReply("No products to monitor");
                        return;
                    }
                    const embedPage = createPageEmbed(pages[0], 0, pages.length);
                    const buttons = createNavigationButtons(0, pages.length);
                    const message = await interaction.editReply({ ...embedPage, components: [buttons] });
                    client.messageCache = client.messageCache || new Map();
                    client.messageCache.set(message.id, { pages, currentPage: 0, interaction });
                } 
                else if (command === "invalid") {
                    const results = lastScrapeResults.length > 0 ? lastScrapeResults : await checkSites();
                    const invalidProducts = results.filter(p => p.error);
                    if (invalidProducts.length === 0) {
                        await interaction.editReply("✅ All products working");
                        return;
                    }
                    const invalidList = invalidProducts.map(p => 
                        `[${p.id}] **${p.name}**\n${p.url}\nError: ${p.error}`
                    ).join("\n\n");
                    await interaction.editReply({ content: `⚠️ **Invalid Products (${invalidProducts.length})**\n\n${invalidList}` });
                }
                else if (command === "prices") {
                    const targetPrice = interaction.options.getNumber("target");
                    let priceData = getPriceData();
                    if (!priceData) {
                        await interaction.editReply("🔍 Updating prices...");
                        const results = await checkSites();
                        priceData = results.map(p => ({
                            ...p,
                            priceNum: parsePrice(p.price) || null
                        })).filter(p => p.priceNum !== null);
                    }
                    if (priceData.length === 0) {
                        await interaction.editReply("❌ No valid price data");
                        return;
                    }
                    let resultProducts = findClosestPrices(priceData, targetPrice);
                    if (resultProducts.length === 0 || resultProducts[0].difference > 0) {
                        resultProducts = findPriceRange(priceData);
                    }
                    if (resultProducts.length === 0) {
                        await interaction.editReply("❌ No products found");
                        return;
                    }
                    const priceList = resultProducts.map(p => 
                        `[${p.id}] **${p.name}**\nPrice: \`${p.price}\` (${p.priceNum?.toFixed(2)})\nDiff: \`${p.difference?.toFixed(2) || "N/A"}\``
                    ).join("\n\n");
                    await interaction.editReply({ content: `💰 **Prices (Target: ${targetPrice})**\n\n${priceList}` });
                }
                else if (command === "addlink") {
                    const name = interaction.options.getString("name");
                    const url = interaction.options.getString("url");
                    if (!name || !url) {
                        await interaction.editReply("❌ Name/URL required");
                        return;
                    }
                    const id = generateProductId();
                    if (!id) {
                        await interaction.editReply("❌ Max limit (100)");
                        return;
                    }
                    products.push({
                        id,
                        name,
                        url,
                        priceSelector: DEFAULT_PRICE_SELECTOR,
                        stockSelector: DEFAULT_STOCK_SELECTOR,
                        checkText: DEFAULT_CHECK_TEXT
                    });
                    saveProducts();
                    await interaction.editReply(`✅ Added: **${name}** (ID: ${id})\n${url}`);
                }
                else if (command === "removelink") {
                    const id = interaction.options.getInteger("id");
                    const index = products.findIndex(p => p.id === id);
                    if (index === -1) {
                        await interaction.editReply(`❌ ID ${id} not found`);
                        return;
                    }
                    const productName = products[index].name;
                    products.splice(index, 1);
                    saveProducts();
                    reorganizeIds();
                    await interaction.editReply(`✅ Removed: **${productName}** (ID: ${id})`);
                }
                else if (command === "bulkremovelink") {
                    const idsInput = interaction.options.getString("ids");
                    const idsToRemove = idsInput.split(',').map(id => parseInt(id.trim()));
                    if (idsToRemove.some(isNaN)) {
                        await interaction.editReply("❌ Invalid IDs format");
                        return;
                    }
                    const validIds = new Set(products.map(p => p.id));
                    const invalidIds = idsToRemove.filter(id => !validIds.has(id));
                    if (invalidIds.length > 0) {
                        await interaction.editReply(`❌ Invalid IDs: ${invalidIds.join(', ')}`);
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
                    await interaction.editReply({ content: `✅ Removed ${removedProducts.length} products:\n${removedProducts.join("\n")}` });
                }
                else if (command === "bulklink") {
                    const attachment = interaction.options.getAttachment("file");
                    if (!attachment?.contentType?.includes("json")) {
                        await interaction.editReply("❌ Invalid JSON file");
                        return;
                    }
                    const response = await fetch(attachment.url);
                    if (!response.ok) throw new Error("Download failed");
                    const jsonData = await response.json();
                    if (!Array.isArray(jsonData)) {
                        await interaction.editReply("❌ Expected product array");
                        return;
                    }
                    const addedProducts = [];
                    for (const product of jsonData) {
                        const id = generateProductId();
                        if (!id) {
                            await interaction.editReply("❌ Max limit (100)");
                            return;
                        }
                        products.push({
                            id,
                            name: product.name || "Unnamed",
                            url: product.url || "",
                            priceSelector: product.priceSelector || DEFAULT_PRICE_SELECTOR,
                            stockSelector: product.stockSelector || DEFAULT_STOCK_SELECTOR,
                            checkText: product.checkText || DEFAULT_CHECK_TEXT
                        });
                        addedProducts.push(`${id}: ${product.name || "Unnamed"}`);
                    }
                    saveProducts();
                    await interaction.editReply({ content: `✅ Added ${jsonData.length} products:\n${addedProducts.join("\n")}` });
                }
            }
            else if (interaction.isButton() || interaction.isStringSelectMenu()) {
                if (!client.messageCache) return;
                const cached = client.messageCache.get(interaction.message.id);
                if (!cached) return;
                await interaction.deferUpdate();
                let newPage = cached.currentPage;
                if (interaction.isButton()) {
                    newPage = parseInt(interaction.customId.split("_")[1]);
                } else if (interaction.customId === "select_page") {
                    newPage = parseInt(interaction.values[0]);
                }
                const embedPage = createPageEmbed(cached.pages[newPage], newPage, cached.pages.length);
                const buttons = createNavigationButtons(newPage, cached.pages.length);
                await interaction.editReply({ content: embedPage.content, components: [buttons] });
                cached.currentPage = newPage;
                client.messageCache.set(interaction.message.id, cached);
            }
        } catch (error) {
            if (error.code === 40060) return;
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply(`❌ Error: ${error.message}`);
            } else if (interaction.deferred) {
                await interaction.editReply(`❌ Error: ${error.message}`);
            } else {
                await interaction.followUp(`❌ Error: ${error.message}`);
            }
        }
    });
    
    client.login(TOKEN);
} else {
    console.error("FATAL: Invalid BOT_TYPE");
    process.exit(1);
}