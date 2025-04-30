/**
 * Web2Z Telegram Bot - Website Scraper
 * 
 * This bot scrapes websites and returns source code as zip files.
 * Features:
 * - Firebase integration for user tracking
 * - Admin panel for user statistics
 * - Broadcast functionality (text, image, video)
 * - Website scraping with Cheerio
 */

// Required dependencies
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const admin = require('firebase-admin');
const os = require('os');
const url = require('url');

// Environment variables
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required!');
  process.exit(1);
}

// Admin chat ID (replace with your Telegram ID)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
if (!ADMIN_CHAT_ID) {
  console.warn('⚠️ ADMIN_CHAT_ID not set. Admin features will be limited.');
}

// Initialize Firebase
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  process.exit(1);
}

// Create a reference to the Firebase database
const db = admin.database();
const usersRef = db.ref('web2z/users');
const statsRef = db.ref('web2z/stats');

// Initialize the bot with polling
const bot = new TelegramBot(TOKEN, { polling: true });

// Set up temp directory for downloads
const tempDir = path.join(os.tmpdir(), 'web2z-downloads');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Bot commands
const commands = [
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'Show help information' },
  { command: 'scrape', description: 'Scrape a website (send URL after command)' },
  { command: 'about', description: 'About this bot' },
];

// Set bot commands
bot.setMyCommands(commands).catch(error => {
  console.error('❌ Failed to set bot commands:', error.message);
});

// Utility to increment stats counter
async function incrementStats(key) {
  try {
    const snapshot = await statsRef.child(key).once('value');
    const currentValue = snapshot.val() || 0;
    await statsRef.child(key).set(currentValue + 1);
  } catch (error) {
    console.error(`❌ Error incrementing stats for ${key}:`, error.message);
  }
}

// Function to sanitize filenames
function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9.-]/gi, '_');
}

// Function to normalize URL for file creation
function normalizeUrl(inputUrl) {
  try {
    // Parse the URL
    const parsedUrl = new URL(inputUrl);
    
    // If no protocol, default to http
    if (!parsedUrl.protocol) {
      parsedUrl.protocol = 'http:';
    }
    
    return parsedUrl.toString();
  } catch (error) {
    // If parsing fails, try prepending http:// and try again
    if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
      return normalizeUrl('http://' + inputUrl);
    }
    throw error; // Re-throw if it still fails
  }
}

// Function to check if a URL is valid
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Functions to create inline keyboards
function getMainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Scrape Website', callback_data: 'scrape' }],
        [{ text: '❓ Help', callback_data: 'help' }, { text: 'ℹ️ About', callback_data: 'about' }]
      ]
    }
  };
}

function getAdminMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 User Statistics', callback_data: 'admin_stats' }],
        [{ text: '📢 Broadcast Message', callback_data: 'admin_broadcast' }],
        [{ text: '📨 Send Text Broadcast', callback_data: 'admin_broadcast_text' }],
        [{ text: '🖼️ Send Image Broadcast', callback_data: 'admin_broadcast_image' }],
        [{ text: '🎬 Send Video Broadcast', callback_data: 'admin_broadcast_video' }],
        [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
      ]
    }
  };
}

// Function to scrape a website and create a zip file
async function scrapeWebsite(chatId, inputUrl) {
  let tempFolderPath = '';
  let zipFilePath = '';
  
  try {
    // Send a "processing" message
    const processingMessage = await bot.sendMessage(
      chatId, 
      '⏳ Processing your request...\n\nScraping website and preparing the source code. This may take a moment.',
      { parse_mode: 'HTML' }
    );

    // Normalize and validate URL
    if (!isValidUrl(inputUrl)) {
      const normalizedUrl = normalizeUrl(inputUrl);
      if (!isValidUrl(normalizedUrl)) {
        throw new Error('Invalid URL format');
      }
      inputUrl = normalizedUrl;
    }

    // Extract domain for folder name
    const parsedUrl = url.parse(inputUrl);
    const domain = parsedUrl.hostname;
    
    // Create a unique folder name
    const folderName = `${sanitizeFilename(domain)}_${Date.now()}`;
    tempFolderPath = path.join(tempDir, folderName);
    fs.mkdirSync(tempFolderPath, { recursive: true });
    
    // Create zip file path
    zipFilePath = path.join(tempDir, `${folderName}.zip`);
    
    // Fetch the page HTML
    const { data } = await axios.get(inputUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Save the main HTML file
    fs.writeFileSync(path.join(tempFolderPath, 'index.html'), data);
    
    // Parse HTML to find and download assets
    const $ = cheerio.load(data);
    const assetPromises = [];
    
    // Function to download an asset
    async function downloadAsset(assetUrl, localPath) {
      try {
        // Make the asset URL absolute if it's relative
        let absoluteUrl = assetUrl;
        if (assetUrl.startsWith('//')) {
          absoluteUrl = 'https:' + assetUrl;
        } else if (assetUrl.startsWith('/')) {
          absoluteUrl = parsedUrl.protocol + '//' + parsedUrl.host + assetUrl;
        } else if (!assetUrl.startsWith('http')) {
          // Handle relative URLs that don't start with /
          const baseUrl = parsedUrl.protocol + '//' + parsedUrl.host + parsedUrl.pathname;
          absoluteUrl = new URL(assetUrl, baseUrl).href;
        }
        
        // Create directory structure if needed
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // Download the asset
        const response = await axios({
          method: 'get',
          url: absoluteUrl,
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        // Save the asset
        fs.writeFileSync(localPath, response.data);
      } catch (error) {
        console.error(`Failed to download asset ${assetUrl}: ${error.message}`);
        // Don't throw, just log the error and continue
      }
    }
    
    // Process CSS files
    $('link[rel="stylesheet"]').each((i, element) => {
      const cssUrl = $(element).attr('href');
      if (cssUrl) {
        const cssPath = path.join(tempFolderPath, cssUrl.replace(/^\//, ''));
        assetPromises.push(downloadAsset(cssUrl, cssPath));
      }
    });
    
    // Process JavaScript files
    $('script').each((i, element) => {
      const jsUrl = $(element).attr('src');
      if (jsUrl) {
        const jsPath = path.join(tempFolderPath, jsUrl.replace(/^\//, ''));
        assetPromises.push(downloadAsset(jsUrl, jsPath));
      }
    });
    
    // Process images
    $('img').each((i, element) => {
      const imgUrl = $(element).attr('src');
      if (imgUrl) {
        const imgPath = path.join(tempFolderPath, imgUrl.replace(/^\//, ''));
        assetPromises.push(downloadAsset(imgUrl, imgPath));
      }
    });
    
    // Wait for all assets to download (with a timeout)
    await Promise.allSettled(assetPromises);
    
    // Create a zip file
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Compression level
    });
    
    archive.pipe(output);
    archive.directory(tempFolderPath, false);
    
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
      archive.finalize();
    });
    
    // Send the zip file to the user
    await bot.deleteMessage(chatId, processingMessage.message_id);
    await bot.sendDocument(chatId, zipFilePath, {
      caption: `✅ Here's the source code for <b>${domain}</b>\n\nUse this code responsibly and respect website terms of service.`,
      parse_mode: 'HTML'
    });
    
    // Increment scrape counter
    await incrementStats('scrapes');
    
    // Clean up
    fs.rmSync(tempFolderPath, { recursive: true, force: true });
    fs.unlinkSync(zipFilePath);
    
  } catch (error) {
    console.error('Error scraping website:', error);
    
    // Clean up any files if there was an error
    if (tempFolderPath && fs.existsSync(tempFolderPath)) {
      fs.rmSync(tempFolderPath, { recursive: true, force: true });
    }
    
    if (zipFilePath && fs.existsSync(zipFilePath)) {
      fs.unlinkSync(zipFilePath);
    }
    
    // Send error message to user
    await bot.sendMessage(
      chatId, 
      `❌ Error scraping website: ${error.message}\n\nPlease check the URL and try again.`,
      { parse_mode: 'HTML' }
    );
  }
}

// Map to store user states (for multi-step operations)
const userStates = new Map();

// Handler for /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'User';
  
  try {
    // Save user to Firebase
    await usersRef.child(userId).set({
      chatId: chatId,
      firstName: firstName,
      lastName: msg.from.last_name || '',
      username: msg.from.username || '',
      joinedAt: admin.database.ServerValue.TIMESTAMP,
      lastActive: admin.database.ServerValue.TIMESTAMP
    });
    
    // Increment new user counter if this is a new user
    const snapshot = await usersRef.child(userId).once('value');
    if (!snapshot.hasChild('joinedAt')) {
      await incrementStats('newUsers');
    }
    
    // Increment total command counter
    await incrementStats('commands');
    
    // Send welcome message with animation
    await bot.sendMessage(
      chatId,
      `👋 <b>Welcome to Web2Z Bot, ${firstName}!</b>\n\n` +
      `I can scrape websites and provide you with their source code as a ZIP file.\n\n` +
      `<i>Just send me a URL or use the /scrape command followed by a website URL.</i>\n\n` +
      `<b>Example:</b> /scrape https://example.com`,
      {
        parse_mode: 'HTML',
        ...getMainMenu()
      }
    );
    
    // Notify admin about new user if admin ID is set
    if (ADMIN_CHAT_ID) {
      bot.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 New user started the bot!\n\n` +
        `ID: ${userId}\n` +
        `Name: ${firstName} ${msg.from.last_name || ''}\n` +
        `Username: @${msg.from.username || 'N/A'}`
      ).catch(err => console.error('Error sending admin notification:', err));
    }
  } catch (error) {
    console.error('Error in /start command:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error starting the bot. Please try again later.'
    );
  }
});

// Handler for /help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    // Increment command counter
    await incrementStats('commands');
    
    await bot.sendMessage(
      chatId,
      `<b>🔍 How to use Web2Z Bot:</b>\n\n` +
      `1️⃣ <b>Scrape a website:</b>\n` +
      `  • Send a website URL directly\n` +
      `  • Use /scrape followed by a URL\n` +
      `  • Example: /scrape https://example.com\n\n` +
      `2️⃣ <b>Commands:</b>\n` +
      `  • /start - Start the bot\n` +
      `  • /help - Show this help message\n` +
      `  • /scrape - Scrape a website\n` +
      `  • /about - About this bot\n\n` +
      `3️⃣ <b>Notes:</b>\n` +
      `  • Some websites may block scraping\n` +
      `  • Use the scraped content responsibly\n` +
      `  • Large websites may take longer to scrape`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Scrape Website', callback_data: 'scrape' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in /help command:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error showing help. Please try again later.'
    );
  }
});

// Handler for /about command
bot.onText(/\/about/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    // Increment command counter
    await incrementStats('commands');
    
    await bot.sendMessage(
      chatId,
      `<b>ℹ️ About Web2Z Bot</b>\n\n` +
      `Web2Z is a powerful Telegram bot that scrapes websites and provides their source code as ZIP files.\n\n` +
      `<b>Features:</b>\n` +
      `• Website scraping with asset collection\n` +
      `• ZIP file delivery of complete source code\n` +
      `• Simple and intuitive interface\n\n` +
      `<b>Technical Details:</b>\n` +
      `• Built with Node.js\n` +
      `• Uses Cheerio for HTML parsing\n` +
      `• Firebase backend for user tracking\n\n` +
      `<b>Responsible Use:</b>\n` +
      `Please respect website terms of service and use the scraped content ethically.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in /about command:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error showing about information. Please try again later.'
    );
  }
});

// Handler for /scrape command
bot.onText(/\/scrape(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1]?.trim();
  
  try {
    // Increment command counter
    await incrementStats('commands');
    
    // Update last active timestamp
    await usersRef.child(msg.from.id).update({
      lastActive: admin.database.ServerValue.TIMESTAMP
    });
    
    if (url) {
      // If URL is provided, scrape immediately
      await scrapeWebsite(chatId, url);
    } else {
      // If no URL, ask for it
      userStates.set(chatId, { 
        action: 'awaiting_url',
        timestamp: Date.now()
      });
      
      await bot.sendMessage(
        chatId,
        `📤 <b>Please send me the website URL you want to scrape</b>\n\n` +
        `Example: https://example.com\n\n` +
        `<i>I'll fetch the source code and send it to you as a ZIP file.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Cancel', callback_data: 'cancel_scrape' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error('Error in /scrape command:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error processing your scrape request. Please try again later.'
    );
  }
});

// Handle admin commands
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Check if the user is an admin
  if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
    await bot.sendMessage(chatId, '⛔ You are not authorized to use admin commands.');
    return;
  }
  
  try {
    await bot.sendMessage(
      chatId,
      `🔐 <b>Admin Panel</b>\n\n` +
      `Welcome to the Web2Z Bot admin panel. Here you can view statistics and send broadcast messages to all users.`,
      {
        parse_mode: 'HTML',
        ...getAdminMenu()
      }
    );
  } catch (error) {
    console.error('Error in /admin command:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error accessing the admin panel. Please try again later.'
    );
  }
});

// Process direct URL messages
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const chatId = msg.chat.id;
  const messageText = msg.text.trim();
  
  try {
    // Update last active timestamp
    await usersRef.child(msg.from.id).update({
      lastActive: admin.database.ServerValue.TIMESTAMP
    });
    
    // Check if we're waiting for user input
    const userState = userStates.get(chatId);
    if (userState && userState.action === 'awaiting_url') {
      // Clear user state
      userStates.delete(chatId);
      
      // Process the URL
      await scrapeWebsite(chatId, messageText);
      return;
    }
    
    // Check if message is for admin broadcast
    if (userState && userState.action.startsWith('admin_broadcast_')) {
      // Clear user state
      userStates.delete(chatId);
      
      // Make sure it's the admin
      if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
        await bot.sendMessage(chatId, '⛔ You are not authorized to broadcast messages.');
        return;
      }
      
      // Send broadcast
      await sendBroadcast(chatId, userState.action.replace('admin_broadcast_', ''), messageText);
      return;
    }
    
    // Check if the message looks like a URL
    if (messageText.includes('.') && (
      messageText.toLowerCase().startsWith('http') ||
      messageText.toLowerCase().startsWith('www.') ||
      messageText.match(/^[a-z0-9][-a-z0-9]*\.[a-z0-9][-a-z0-9]*\.[a-z]{2,}$/) ||
      messageText.match(/^[a-z0-9][-a-z0-9]*\.[a-z]{2,}$/)
    )) {
      await scrapeWebsite(chatId, messageText);
      return;
    }
    
    // If we get here, the message wasn't recognized as a command or URL
    await bot.sendMessage(
      chatId,
      `🤔 I'm not sure what you want me to do with that message.\n\n` +
      `If you want to scrape a website, please send me a URL or use the /scrape command.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Scrape Website', callback_data: 'scrape' }],
            [{ text: '❓ Help', callback_data: 'help' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error in message handler:', error);
    bot.sendMessage(
      chatId,
      '❌ There was an error processing your message. Please try again later.'
    );
  }
});

// Handle callback queries (button clicks)
bot.on('callback_query', async (callbackQuery) => {
  const action = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  
  try {
    // Update last active timestamp
    await usersRef.child(callbackQuery.from.id).update({
      lastActive: admin.database.ServerValue.TIMESTAMP
    });
    
    // Process based on the callback data
    switch (action) {
      case 'scrape':
        userStates.set(chatId, { 
          action: 'awaiting_url',
          timestamp: Date.now()
        });
        
        await bot.editMessageText(
          `📤 <b>Please send me the website URL you want to scrape</b>\n\n` +
          `Example: https://example.com\n\n` +
          `<i>I'll fetch the source code and send it to you as a ZIP file.</i>`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: 'cancel_scrape' }]
              ]
            }
          }
        );
        break;
        
      case 'cancel_scrape':
        userStates.delete(chatId);
        
        await bot.editMessageText(
          `🚫 Scraping request canceled.`,
          {
            chat_id: chatId,
            message_id: messageId,
            ...getMainMenu()
          }
        );
        break;
        
      case 'help':
        await bot.editMessageText(
          `<b>🔍 How to use Web2Z Bot:</b>\n\n` +
          `1️⃣ <b>Scrape a website:</b>\n` +
          `  • Send a website URL directly\n` +
          `  • Use /scrape followed by a URL\n` +
          `  • Example: /scrape https://example.com\n\n` +
          `2️⃣ <b>Commands:</b>\n` +
          `  • /start - Start the bot\n` +
          `  • /help - Show this help message\n` +
          `  • /scrape - Scrape a website\n` +
          `  • /about - About this bot\n\n` +
          `3️⃣ <b>Notes:</b>\n` +
          `  • Some websites may block scraping\n` +
          `  • Use the scraped content responsibly\n` +
          `  • Large websites may take longer to scrape`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🌐 Scrape Website', callback_data: 'scrape' }],
                [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
              ]
            }
          }
        );
        break;
        
      case 'about':
        await bot.editMessageText(
          `<b>ℹ️ About Web2Z Bot</b>\n\n` +
          `Web2Z is a powerful Telegram bot that scrapes websites and provides their source code as ZIP files.\n\n` +
          `<b>Features:</b>\n` +
          `• Website scraping with asset collection\n` +
          `• ZIP file delivery of complete source code\n` +
          `• Simple and intuitive interface\n\n` +
          `<b>Technical Details:</b>\n` +
          `• Built with Node.js\n` +
          `• Uses Cheerio for HTML parsing\n` +
          `• Firebase backend for user tracking\n\n` +
          `<b>Responsible Use:</b>\n` +
          `Please respect website terms of service and use the scraped content ethically.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
              ]
            }
          }
        );
        break;
        
      case 'back_to_main':
        await bot.editMessageText(
          `<b>Web2Z Bot - Main Menu</b>\n\n` +
          `I can scrape websites and provide you with their source code as a ZIP file.\n\n` +
          `<i>Just send me a URL or use the /scrape command followed by a website URL.</i>\n\n` +
          `<b>Example:</b> /scrape https://example.com`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            ...getMainMenu()
          }
        );
        break;
        
      // Admin actions
      case 'admin_stats':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to view stats.',
            show_alert: true
          });
          return;
        }
        
        await fetchAndSendStats(chatId, messageId);
        break;
        
      case 'admin_broadcast':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to send broadcasts.',
            show_alert: true
          });
          return;
        }
        
        await bot.editMessageText(
          `<b>📢 Broadcast Messages</b>\n\n` +
          `Select the type of broadcast you want to send:`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📨 Text Message', callback_data: 'admin_broadcast_text' }],
                [{ text: '🖼️ Image Message', callback_data: 'admin_broadcast_image' }],
                [{ text: '🎬 Video Message', callback_data: 'admin_broadcast_video' }],
                [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
              ]
            }
          }
        );
        break;
        
      case 'admin_broadcast_text':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to send broadcasts.',
            show_alert: true
          });
          return;
        }
        
        userStates.set(chatId, { 
          action: 'admin_broadcast_text',
          timestamp: Date.now()
        });
        
        await bot.editMessageText(
          `<b>📨 Text Broadcast</b>\n\n` +
          `Please send the text message you want to broadcast to all users.\n\n` +
          `<i>HTML formatting is supported. Use &lt;b&gt;bold&lt;/b&gt;, &lt;i&gt;italic&lt;/i&gt;, etc.</i>`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Cancel', callback_data: 'admin_menu' }]
              ]
            }
          }
        );
        break;
        
      case 'admin_broadcast_image':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to send broadcasts.',
            show_alert: true
          });
          return;
        }
        
        await bot.editMessageText(
          `<b>🖼️ Image Broadcast</b>\n\n` +
          `To send an image broadcast:\n\n` +
          `1. Send the image to this chat\n` +
          `2. Reply to the image with the caption text prefixed with "BROADCAST:"\n\n` +
          `Example: BROADCAST: Check out our new feature!`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Back to Broadcast Menu', callback_data: 'admin_broadcast' }]
              ]
            }
          }
        );
        break;
        
      case 'admin_broadcast_video':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to send broadcasts.',
            show_alert: true
          });
          return;
        }
        
        await bot.editMessageText(
          `<b>🎬 Video Broadcast</b>\n\n` +
          `To send a video broadcast:\n\n` +
          `1. Send the video to this chat\n` +
          `2. Reply to the video with the caption text prefixed with "BROADCAST:"\n\n` +
          `Example: BROADCAST: New tutorial video!`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Back to Broadcast Menu', callback_data: 'admin_broadcast' }]
              ]
            }
          }
        );
        break;
        
      case 'admin_menu':
        // Make sure it's the admin
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
          await bot.answerCallbackQuery(callbackQuery.id, {
            text: '⛔ You are not authorized to access the admin menu.',
            show_alert: true
          });
          return;
        }
        
        await bot.editMessageText(
          `🔐 <b>Admin Panel</b>\n\n` +
          `Welcome to the Web2Z Bot admin panel. Here you can view statistics and send broadcast messages to all users.`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            ...getAdminMenu()
          }
        );
        break;
    }
    
    // Answer the callback query to remove the loading indicator
    await bot.answerCallbackQuery(callbackQuery.id);
    
  } catch (error) {
    console.error('Error in callback query handler:', error);
    bot.answerCallbackQuery(callbackQuery.id, {
      text: '❌ There was an error processing your request. Please try again.',
      show_alert: true
    });
  }
});

// Handle photo messages for admin broadcasts
bot.on('photo', async (msg) => {
  if (!msg.chat || msg.chat.id.toString() !== ADMIN_CHAT_ID.toString()) return;
  
  // Store the photo ID for potential broadcast
  const photoId = msg.photo[msg.photo.length - 1].file_id; // Get the highest resolution
  
  await bot.sendMessage(
    msg.chat.id,
    `<b>🖼️ Photo received!</b>\n\n` +
    `To broadcast this image to all users, reply to it with text starting with "BROADCAST:"`,
    {
      parse_mode: 'HTML',
      reply_to_message_id: msg.message_id
    }
  );
});

// Handle video messages for admin broadcasts
bot.on('video', async (msg) => {
  if (!msg.chat || msg.chat.id.toString() !== ADMIN_CHAT_ID.toString()) return;
  
  // Store the video ID for potential broadcast
  const videoId = msg.video.file_id;
  
  await bot.sendMessage(
    msg.chat.id,
    `<b>🎬 Video received!</b>\n\n` +
    `To broadcast this video to all users, reply to it with text starting with "BROADCAST:"`,
    {
      parse_mode: 'HTML',
      reply_to_message_id: msg.message_id
    }
  );
});

// Handle replied messages for broadcasts
bot.on('message', async (msg) => {
  if (!msg.reply_to_message || !msg.chat || msg.chat.id.toString() !== ADMIN_CHAT_ID.toString()) return;
  if (!msg.text || !msg.text.startsWith('BROADCAST:')) return;
  
  const caption = msg.text.replace('BROADCAST:', '').trim();
  
  try {
    const replyMsg = msg.reply_to_message;
    
    // Check if replying to a photo
    if (replyMsg.photo && replyMsg.photo.length > 0) {
      const photoId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
      await sendImageBroadcast(photoId, caption);
      return;
    }
    
    // Check if replying to a video
    if (replyMsg.video) {
      const videoId = replyMsg.video.file_id;
      await sendVideoBroadcast(videoId, caption);
      return;
    }
    
    // If not replying to media, send a notice
    await bot.sendMessage(
      msg.chat.id,
      `❌ You must reply to a photo or video to broadcast it.`
    );
  } catch (error) {
    console.error('Error processing broadcast reply:', error);
    bot.sendMessage(
      msg.chat.id,
      `❌ Error sending broadcast: ${error.message}`
    );
  }
});

// Function to fetch and send stats
async function fetchAndSendStats(chatId, messageId = null) {
  try {
    // Get total users count
    const usersSnapshot = await usersRef.once('value');
    const totalUsers = usersSnapshot.numChildren();
    
    // Get stats
    const statsSnapshot = await statsRef.once('value');
    const stats = statsSnapshot.val() || {};
    
    // Get active users (active in the last 7 days)
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const activeUsers = Array.from(usersSnapshot.val() || {}).filter(([_, user]) => 
      user.lastActive && user.lastActive > oneWeekAgo
    ).length;
    
    // Prepare stats message
    const statsMessage = 
      `📊 <b>Bot Statistics</b>\n\n` +
      `👥 <b>Users:</b>\n` +
      `• Total users: ${totalUsers}\n` +
      `• Active users (7d): ${activeUsers}\n\n` +
      `🔢 <b>Activity:</b>\n` +
      `• Commands used: ${stats.commands || 0}\n` +
      `• Websites scraped: ${stats.scrapes || 0}\n` +
      `• Broadcasts sent: ${stats.broadcasts || 0}\n\n` +
      `🕒 <b>Last updated:</b> ${new Date().toISOString()}`;
    
    // Send or edit message
    if (messageId) {
      await bot.editMessageText(
        statsMessage,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Refresh Stats', callback_data: 'admin_stats' }],
              [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
            ]
          }
        }
      );
    } else {
      await bot.sendMessage(
        chatId,
        statsMessage,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Refresh Stats', callback_data: 'admin_stats' }],
              [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    console.error('Error fetching stats:', error);
    bot.sendMessage(
      chatId,
      `❌ Error fetching statistics: ${error.message}`
    );
  }
}

// Function to send text broadcast
async function sendBroadcast(adminChatId, type, text) {
  try {
    // Get all user chat IDs
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val() || {};
    
    // Prepare confirmation message
    let confirmationMsg = await bot.sendMessage(
      adminChatId,
      `🔄 Preparing to send broadcast to ${Object.keys(users).length} users...`,
      { parse_mode: 'HTML' }
    );
    
    let successCount = 0;
    let failCount = 0;
    let progress = 0;
    const totalUsers = Object.keys(users).length;
    
    // Send the broadcast to each user
    for (const [userId, user] of Object.entries(users)) {
      try {
        if (type === 'text') {
          await bot.sendMessage(user.chatId, text, { parse_mode: 'HTML' });
        }
        successCount++;
      } catch (err) {
        console.error(`Failed to send broadcast to user ${userId}:`, err);
        failCount++;
      }
      
      // Update progress every 5% or for small batches, every user
      const newProgress = Math.round((successCount + failCount) / totalUsers * 100);
      if (newProgress >= progress + 5 || totalUsers < 20) {
        progress = newProgress;
        await bot.editMessageText(
          `🔄 Sending broadcast: ${progress}% complete\n\n` +
          `✅ Success: ${successCount}\n` +
          `❌ Failed: ${failCount}\n\n` +
          `Please wait...`,
          {
            chat_id: adminChatId,
            message_id: confirmationMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    }
    
    // Update stats
    await incrementStats('broadcasts');
    
    // Send final confirmation
    await bot.editMessageText(
      `✅ Broadcast complete!\n\n` +
      `📊 Results:\n` +
      `• Total users: ${totalUsers}\n` +
      `• Successfully sent: ${successCount}\n` +
      `• Failed: ${failCount}`,
      {
        chat_id: adminChatId,
        message_id: confirmationMsg.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error sending broadcast:', error);
    bot.sendMessage(
      adminChatId,
      `❌ Error sending broadcast: ${error.message}`
    );
  }
}

// Function to send image broadcast
async function sendImageBroadcast(photoId, caption) {
  try {
    // Get all user chat IDs
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val() || {};
    
    // Prepare confirmation message
    let confirmationMsg = await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔄 Preparing to send image broadcast to ${Object.keys(users).length} users...`,
      { parse_mode: 'HTML' }
    );
    
    let successCount = 0;
    let failCount = 0;
    let progress = 0;
    const totalUsers = Object.keys(users).length;
    
    // Send the broadcast to each user
    for (const [userId, user] of Object.entries(users)) {
      try {
        await bot.sendPhoto(user.chatId, photoId, { 
          caption: caption,
          parse_mode: 'HTML'
        });
        successCount++;
      } catch (err) {
        console.error(`Failed to send image broadcast to user ${userId}:`, err);
        failCount++;
      }
      
      // Update progress every 5% or for small batches, every user
      const newProgress = Math.round((successCount + failCount) / totalUsers * 100);
      if (newProgress >= progress + 5 || totalUsers < 20) {
        progress = newProgress;
        await bot.editMessageText(
          `🔄 Sending image broadcast: ${progress}% complete\n\n` +
          `✅ Success: ${successCount}\n` +
          `❌ Failed: ${failCount}\n\n` +
          `Please wait...`,
          {
            chat_id: ADMIN_CHAT_ID,
            message_id: confirmationMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    }
    
    // Update stats
    await incrementStats('broadcasts');
    
    // Send final confirmation
    await bot.editMessageText(
      `✅ Image broadcast complete!\n\n` +
      `📊 Results:\n` +
      `• Total users: ${totalUsers}\n` +
      `• Successfully sent: ${successCount}\n` +
      `• Failed: ${failCount}`,
      {
        chat_id: ADMIN_CHAT_ID,
        message_id: confirmationMsg.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error sending image broadcast:', error);
    bot.sendMessage(
      ADMIN_CHAT_ID,
      `❌ Error sending image broadcast: ${error.message}`
    );
  }
}

// Function to send video broadcast
async function sendVideoBroadcast(videoId, caption) {
  try {
    // Get all user chat IDs
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val() || {};
    
    // Prepare confirmation message
    let confirmationMsg = await bot.sendMessage(
      ADMIN_CHAT_ID,
      `🔄 Preparing to send video broadcast to ${Object.keys(users).length} users...`,
      { parse_mode: 'HTML' }
    );
    
    let successCount = 0;
    let failCount = 0;
    let progress = 0;
    const totalUsers = Object.keys(users).length;
    
    // Send the broadcast to each user
    for (const [userId, user] of Object.entries(users)) {
      try {
        await bot.sendVideo(user.chatId, videoId, { 
          caption: caption,
          parse_mode: 'HTML'
        });
        successCount++;
      } catch (err) {
        console.error(`Failed to send video broadcast to user ${userId}:`, err);
        failCount++;
      }
      
      // Update progress every 5% or for small batches, every user
      const newProgress = Math.round((successCount + failCount) / totalUsers * 100);
      if (newProgress >= progress + 5 || totalUsers < 20) {
        progress = newProgress;
        await bot.editMessageText(
          `🔄 Sending video broadcast: ${progress}% complete\n\n` +
          `✅ Success: ${successCount}\n` +
          `❌ Failed: ${failCount}\n\n` +
          `Please wait...`,
          {
            chat_id: ADMIN_CHAT_ID,
            message_id: confirmationMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    }
    
    // Update stats
    await incrementStats('broadcasts');
    
    // Send final confirmation
    await bot.editMessageText(
      `✅ Video broadcast complete!\n\n` +
      `📊 Results:\n` +
      `• Total users: ${totalUsers}\n` +
      `• Successfully sent: ${successCount}\n` +
      `• Failed: ${failCount}`,
      {
        chat_id: ADMIN_CHAT_ID,
        message_id: confirmationMsg.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Error sending video broadcast:', error);
    bot.sendMessage(
      ADMIN_CHAT_ID,
      `❌ Error sending video broadcast: ${error.message}`
    );
  }
}

// Clear expired user states every hour
setInterval(() => {
  const now = Date.now();
  for (const [chatId, state] of userStates.entries()) {
    // Clear states older than 30 minutes
    if (now - state.timestamp > 30 * 60 * 1000) {
      userStates.delete(chatId);
    }
  }
}, 60 * 60 * 1000);

// Log that the bot is running
console.log('🤖 Web2Z Bot is running...');
console.log('⏳ Waiting for messages...');

// Error handling for unhandled exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Keep the bot running despite errors
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Keep the bot running despite errors
});
