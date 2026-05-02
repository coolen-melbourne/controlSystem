const express = require("express");
const path = require("path");
const http = require("http");
const socketIo = require("socket.io");
const hbs = require("hbs");
const mongoose = require("mongoose");
const cron = require("node-cron");
const moment = require("moment");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const compression = require("compression");
require("dotenv").config();

const app = express();
app.use(compression());
const server = http.createServer(app);
const io = socketIo(server);

// -------------------- Models --------------------
const productManagerSchema = new mongoose.Schema({
  productType: { type: String, required: true },
  quantity: { type: Number, required: true },
  enteredBy: { type: String, required: true }, // Ism qo'shildi
  createdAt: { type: Date, default: Date.now }
});
const ProductManager = mongoose.model("ProductManager", productManagerSchema);

const incomingProductSchema = new mongoose.Schema({
  modelName: String,
  variant: String,
  orderNumber: String,
  quantity: Number,
  hasAccessory: Boolean,
  imageData: String,
  date: { type: Date, default: Date.now }
});
const IncomingProduct = mongoose.model("IncomingProduct", incomingProductSchema);

const expenseSchema = new mongoose.Schema({
  band: String,
  modelName: String,
  variant: String,
  orderNumber: String,
  quantity: Number,
  date: { type: Date, default: Date.now }
});
const Expense = mongoose.model("Expense", expenseSchema);

const staffSchema = new mongoose.Schema({
  fullName: String,
  role: { type: String, enum: ["band", "upakovka", "dazmol", "general"] },
  bandNumber: String,
  phone: String,
  hireDate: Date,
  photo: String
});
const Staff = mongoose.model("Staff", staffSchema);

const attendanceSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
  date: { type: String, required: true },
  checkIn: Date,
  checkOut: Date,
  lateMinutes: { type: Number, default: 0 },
  extraWorkMinutes: { type: Number, default: 0 },
  extraWorkDays: { type: Number, default: 0 },
  extraWorkHours: { type: Number, default: 0 },
  workDurationMinutes: { type: Number, default: 0 },
  autoCheckedOut: { type: Boolean, default: false }
});
attendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });
const Attendance = mongoose.model("Attendance", attendanceSchema);

const machineSchema = new mongoose.Schema({
  name: String,
  model: String,
  serial: String,
  createdAt: { type: Date, default: Date.now }
});
const Machine = mongoose.model("Machine", machineSchema);

const accessorySchema = new mongoose.Schema({
  productName: String,
  code: String,
  quantity: Number,
  kg: Number,
  meters: Number,
  createdAt: { type: Date, default: Date.now }
});
const Accessory = mongoose.model("Accessory", accessorySchema);

// Add indexes for performance
(async () => {
  try {
    await ProductManager.collection.createIndex({ createdAt: 1, productType: 1 });
    await IncomingProduct.collection.createIndex({ date: 1 });
    await Expense.collection.createIndex({ date: 1 });
    await Machine.collection.createIndex({ createdAt: 1 });
    await Accessory.collection.createIndex({ createdAt: 1 });
    console.log('Indexes created successfully');
  } catch (err) {
    console.error('Index creation error:', err);
  }
})();

// -------------------- Telegram Bot --------------------
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;
if (botToken && botToken !== 'your_bot_token_here') {
  if (!global.telegramBotStarted) {
    bot = new TelegramBot(botToken, { polling: true });
    global.telegramBotStarted = true;
    console.log("🤖 Telegram bot polling started");
  }
}

// -------------------- Yordamchi funksiyalar --------------------
const BAND_TYPES = [
  "1-band","2-band","3-band","4-band","5-band","6-band","7-band","8-band",
  "9-band","10-band","11-band","12-band","13-band","14-band","15-band",
  "16-band","17-band","18-band"
];

async function getTotalProduction(monthKey = null) {
  const monthStart = monthKey ? moment(monthKey + '-01').startOf('month').toDate() : moment().startOf('month').toDate();
  const monthEnd = monthKey ? moment(monthKey + '-01').endOf('month').toDate() : moment().endOf('month').toDate();
  const result = await ProductManager.aggregate([
    { $match: { productType: { $in: BAND_TYPES }, createdAt: { $gte: monthStart, $lte: monthEnd } } },
    { $group: { _id: null, total: { $sum: "$quantity" } } }
  ]);
  return result[0]?.total || 0;
}

async function getDailyProduction() {
  const todayStart = moment().startOf('day').toDate();
  const todayEnd = moment().endOf('day').toDate();
  const result = await ProductManager.aggregate([
    { $match: { productType: { $in: BAND_TYPES }, createdAt: { $gte: todayStart, $lte: todayEnd } } },
    { $group: { _id: null, total: { $sum: "$quantity" } } }
  ]);
  return result[0]?.total || 0;
}

// -------------------- Telegram Helper --------------------
const sendTelegramMessage = async (message, chatId = null) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const defaultChatId = process.env.TELEGRAM_CHAT_ID;
  const targetChatId = chatId || defaultChatId;
  if (!token || !targetChatId || targetChatId === 'your_chat_id_here') {
    console.warn('⚠️ Telegram token yoki chat ID noto\'g\'ri. Xabar yuborilmadi.');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: targetChatId,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('✅ Telegram xabar yuborildi');
  } catch (err) {
    console.error('❌ Telegram yuborish xatosi:', err.message);
  }
};

async function getTTSBuffer(text, lang = 'uz') {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });
  if (response.status !== 200) throw new Error('TTS service failed');
  return response.data;
}

async function buildAITextSummary(stats) {
  const { totalToday, totalOverall, topBand, topQty, upakovkaMonth, dazmolMonth, availableWork, expenseToday, accessoriesCount, zeroBands, belowPlanBands } = stats;
  const openaiKey = process.env.OPENAI_API_KEY;
  const prompt = `Siz ombor va tikuv statistikasi bo'yicha eng aniq va amaliy xulosa yozadigan ekspert siz. Foydalanuvchi bugungi bandlar, oy davomidagi upakovka va dazmol ishlari, ombor holati va rejaga nisbatan natija haqida tezkor va qisqa xulosa kutmoqda. Xulosani O'zbek tilida, ravon va kuzatuvchan gaplar bilan yozing. 1-18 bandlar uchun reja 1000 dona, Upakovka va Dazmol uchun reja 10000 dona.

Bugungi ma'lumotlar:
- Bugungi bandlar jami: ${totalToday} dona
- Oylik jami tikuv: ${totalOverall} dona
- Eng ko'p tikkan band: ${topBand} (${topQty} dona)
- Upakovka (oylik): ${upakovkaMonth} dona
- Dazmol (oylik): ${dazmolMonth} dona
- Ombordagi mavjud ish: ${availableWork} dona
- Bugungi chiqim: ${expenseToday} dona
- Aksessuarlar: ${accessoriesCount} ta
- 0 darajali bandlar: ${zeroBands.length}
- 1000 dan past bajarilgan bandlar: ${belowPlanBands.length}

Faqat xulosa yozing, sarlavha qo'ymang.`;

  if (openaiKey) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Siz tezkor statistik xulosachi va ombor nazoratchisisiz.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 300
        },
        {
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data?.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
      console.error('OpenAI summary error:', err.message || err);
    }
  }

  const zeroText = zeroBands.length ? zeroBands.join(', ') : 'yo`q';
  return `Bugungi ishlab chiqarishdagi eng muhim xulosalar: bandlar bo'yicha umumiy ish ${totalToday} dona, ammo ${belowPlanBands.length} ta band hali rejadan past va ${zeroBands.length} tasi to'liq nolga tushgan (${zeroText}). Upakovka ${upakovkaMonth} dona, Dazmol ${dazmolMonth} dona, ular 10000 lik rejaga nisbatan orqada. Ombordagi ish hajmi ${availableWork} dona, bugungi chiqim ${expenseToday} dona. Hozirda eng katta diqqatni faqat past ko'rsatkichli bandlar va tezroq qayta tiklashga qaratish kerak.`;
}

// -------------------- Band qo'shish uchun state --------------------
const userState = new Map();

// -------------------- Bot Command Handlers --------------------
if (bot) {
  const mainMenuKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Statistika", callback_data: "stats" }, { text: "🤖 AI xulosasi", callback_data: "ai_summary" }],
        [{ text: "📈 Kunlik / Jami", callback_data: "daily_total" }, { text: "📥 Kroy kirim", callback_data: "kroy" }],
        [{ text: "📤 Kroy chiqim", callback_data: "chiqim" }, { text: "👥 Kadrlar", callback_data: "kadrlar" }],
        [{ text: "🖨️ Mashinalar", callback_data: "mashinalar" }, { text: "🧵 Aksessuarlar", callback_data: "aksessuar" }],
        [{ text: "➕ Bandga qiymat", callback_data: "add_band" }, { text: "🔍 Qidirish", switch_inline_query_current_chat: "" }]
      ]
    }
  };

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "✨ <b>THE BESTTEX</b> ✨\n\n🏭 <b>Umumiy ishxona nazorati tizimi</b>\n\nQuyidagi tugmalar orqali maʼlumotlarni oling:", {
      parse_mode: "HTML",
      ...mainMenuKeyboard
    });
  });

  bot.onText(/\/add_band/, async (msg) => {
    await sendBandSelectionKeyboard(msg.chat.id);
  });

  bot.onText(/\/stats/, async (msg) => {
    await sendFullStatsToChat(msg.chat.id);
  });

  bot.onText(/\/daily/, async (msg) => {
    await sendDailyTotalStats(msg.chat.id);
  });

  bot.onText(/\/kroy/, async (msg) => {
    await sendIncomingList(msg.chat.id, 0);
  });

  bot.onText(/\/chiqim/, async (msg) => {
    await sendExpenseList(msg.chat.id, 0);
  });

  bot.onText(/\/kadrlar/, async (msg) => {
    await sendStaffList(msg.chat.id, 0);
  });

  bot.onText(/\/mashinalar/, async (msg) => {
    await sendMachinesList(msg.chat.id);
  });

  bot.onText(/\/aksessuar/, async (msg) => {
    await sendAccessoriesList(msg.chat.id);
  });

  bot.onText(/\/search (.+)/, async (msg, match) => {
    await searchAll(msg.chat.id, match[1]);
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;
    const state = userState.get(chatId);
    if (state && state.action === 'awaiting_band_quantity') {
      const quantity = parseInt(text, 10);
      if (isNaN(quantity) || quantity <= 0) {
        bot.sendMessage(chatId, "❌ Iltimos, to'g'ri son kiriting (musbat butun). Qaytadan urinib ko'ring.");
        userState.delete(chatId);
        return;
      }
      try {
        const newItem = new ProductManager({ productType: state.band, quantity });
        await newItem.save();
        await sendTelegramMessage(`✅ ${state.band} ga ${quantity} dona qo'shildi!`, chatId);
      } catch (err) {
        console.error("Save band error:", err);
        bot.sendMessage(chatId, "❌ Saqlashda xatolik yuz berdi. Qayta urining.");
      }
      userState.delete(chatId);
    }
  });

  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    if (data.startsWith('kroy_page_')) {
      await sendIncomingList(chatId, parseInt(data.split('_')[2]), messageId);
    } else if (data.startsWith('chiqim_page_')) {
      await sendExpenseList(chatId, parseInt(data.split('_')[2]), messageId);
    } else if (data.startsWith('kadrlar_page_')) {
      await sendStaffList(chatId, parseInt(data.split('_')[2]), messageId);
    } else if (data === 'stats') {
      await sendFullStatsToChat(chatId);
    } else if (data === 'ai_summary') {
      await sendAISummaryOnly(chatId);
    } else if (data === 'daily_total') {
      await sendDailyTotalStats(chatId);
    } else if (data === 'kroy') {
      await sendIncomingList(chatId, 0);
    } else if (data === 'chiqim') {
      await sendExpenseList(chatId, 0);
    } else if (data === 'kadrlar') {
      await sendStaffList(chatId, 0);
    } else if (data === 'mashinalar') {
      await sendMachinesList(chatId);
    } else if (data === 'aksessuar') {
      await sendAccessoriesList(chatId);
    } else if (data === 'add_band') {
      await sendBandSelectionKeyboard(chatId);
    } else if (data.startsWith('band_')) {
      const band = data.substring(5);
      userState.set(chatId, { action: 'awaiting_band_quantity', band });
      bot.editMessageText(`🎚️ <b>${band}</b> uchun miqdorni (dona) kiriting:`, {
        chat_id: chatId, message_id: messageId, parse_mode: "HTML"
      });
      bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    bot.answerCallbackQuery(callbackQuery.id);
  });
}

async function sendBandSelectionKeyboard(chatId) {
  const buttons = [];
  for (let i = 0; i < BAND_TYPES.length; i += 2) {
    const row = [{ text: BAND_TYPES[i], callback_data: `band_${BAND_TYPES[i]}` }];
    if (i + 1 < BAND_TYPES.length) row.push({ text: BAND_TYPES[i+1], callback_data: `band_${BAND_TYPES[i+1]}` });
    buttons.push(row);
  }
  bot.sendMessage(chatId, "🎚️ Qaysi bandga qiymat kiritmoqchisiz? Tanlang:", {
    reply_markup: { inline_keyboard: buttons }, parse_mode: "HTML"
  });
}

// -------------------- Bot funksiyalari --------------------
async function sendFullStatsToChat(chatId) {
  try {
    const monthStart = moment().startOf('month').toDate();
    const monthEnd = moment().endOf('month').toDate();
    const todayStart = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();
    const allProducts = await ProductManager.find({ createdAt: { $gte: todayStart, $lte: todayEnd } });
    const monthProducts = await ProductManager.find({
      productType: { $in: BAND_TYPES },
      createdAt: { $gte: monthStart, $lte: monthEnd }
    });
    const totalToday = allProducts.filter(p => BAND_TYPES.includes(p.productType)).reduce((sum,p)=>sum+p.quantity,0);
    const totalOverall = await getTotalProduction();
    const bandStats = Object.fromEntries(BAND_TYPES.map(band => [band, 0]));
    const monthlyBandStats = Object.fromEntries(BAND_TYPES.map(band => [band, 0]));
    allProducts.forEach(p => {
      if (BAND_TYPES.includes(p.productType)) {
        bandStats[p.productType] += p.quantity;
      }
    });
    monthProducts.forEach(p => {
      if (BAND_TYPES.includes(p.productType)) {
        monthlyBandStats[p.productType] += p.quantity;
      }
    });
    let topBand = '—', topQty = 0;
    for (const [band, qty] of Object.entries(monthlyBandStats)) {
      if (qty > topQty) { topBand = band; topQty = qty; }
    }
    const upakovkaMonth = monthProducts.filter(p=>p.productType==='Upakovka').reduce((s,p)=>s+p.quantity,0);
    const dazmolMonth = monthProducts.filter(p=>p.productType==='Dazmol').reduce((s,p)=>s+p.quantity,0);
    const totalIncoming = (await IncomingProduct.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalExpense = (await Expense.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const expenseToday = (await Expense.aggregate([{$match:{date:{$gte:todayStart,$lte:todayEnd}}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalStaff = await Staff.countDocuments();
    const attendances = await Attendance.find({ date: moment().format("YYYY-MM-DD") });
    const presentCount = attendances.filter(a=>a.checkIn).length;
    const lateCount = attendances.filter(a=>a.checkIn&&a.lateMinutes>0).length;
    const machinesCount = await Machine.countDocuments();
    const accessoriesCount = await Accessory.countDocuments();

    const bandLines = BAND_TYPES.map(band => {
      const qty = monthlyBandStats[band] || 0;
      const pct = Math.min(100, Math.round((qty / 1000) * 100));
      const icon = pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴';
      return `• ${icon} ${band}: <code>${qty}/1000</code> (${pct}%)`;
    }).join('\n');
    const zeroBands = BAND_TYPES.filter(band => (monthlyBandStats[band] || 0) === 0);
    const belowPlanBands = BAND_TYPES.filter(band => (monthlyBandStats[band] || 0) < 1000);

    const statsMessage = `
📊 <b>📅 Statistika – ${moment().format("DD.MM.YYYY, HH:mm")}</b>

🔹 <b>Ishlab chiqarish</b>
• 📅 <b>Kunlik tikuv</b>: <code>${totalToday}</code> dona
• �️ <b>Oylik jami tikuv</b>: <code>${totalOverall}</code> dona
• 🏆 Eng ko'p tikkan band: <b>${topBand}</b> (${topQty} dona)
• 🔥 Dazmol (oylik): ${dazmolMonth} dona
• 📦 Upakovka (oylik): ${upakovkaMonth} dona

📊 <b>Bandlar bo'yicha jarayon</b>
${bandLines}

📦 <b>Ombor holati</b>
• Mavjud ish: ${totalIncoming - totalExpense} dona
• Kunlik chiqim: ${expenseToday} dona

👥 <b>Davomat</b>
• Jami xodimlar: ${totalStaff}
• ✅ Kelganlar: ${presentCount}
• ❌ Kelmaganlar: ${totalStaff - presentCount}
• ⏰ Kech qolganlar: ${lateCount}

🖨️ Mashinalar soni: ${machinesCount}
`;

    await bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });

    const summaryText = await buildAITextSummary({
      totalToday,
      totalOverall,
      topBand,
      topQty,
      upakovkaMonth,
      dazmolMonth,
      availableWork: totalIncoming - totalExpense,
      expenseToday,
      accessoriesCount,
      zeroBands,
      belowPlanBands
    });

    await bot.sendMessage(chatId, `<b>AI xulosasi:</b>\n${escapeHtml(summaryText)}`, { parse_mode: 'HTML' });
    try {
      const audioBuffer = await getTTSBuffer(summaryText, 'uz');
      await bot.sendAudio(chatId, audioBuffer, { caption: 'AI xulosasi (Alisa tovushida)', parse_mode: 'HTML', filename: 'summary.mp3' });
    } catch (ttsErr) {
      console.warn('TTS audio yuborilmadi:', ttsErr.message || ttsErr);
      await bot.sendMessage(chatId, '⚠️ AI xulosasini audio shaklda yuborishda muammo yuz berdi, ammo matn yuborildi.', { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('sendFullStatsToChat error:', err);
    await bot.sendMessage(chatId, '❌ Statistika yuklanmadi.', { parse_mode: 'HTML' });
  }
}

async function sendAISummaryOnly(chatId) {
  try {
    const monthStart = moment().startOf('month').toDate();
    const monthEnd = moment().endOf('month').toDate();
    const todayStart = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();
    const allProducts = await ProductManager.find({ createdAt: { $gte: todayStart, $lte: todayEnd } });
    const monthProducts = await ProductManager.find({
      productType: { $in: BAND_TYPES },
      createdAt: { $gte: monthStart, $lte: monthEnd }
    });
    const totalToday = allProducts.filter(p => BAND_TYPES.includes(p.productType)).reduce((sum,p)=>sum+p.quantity,0);
    const totalOverall = await getTotalProduction();
    const bandStats = Object.fromEntries(BAND_TYPES.map(band => [band, 0]));
    const monthlyBandStats = Object.fromEntries(BAND_TYPES.map(band => [band, 0]));
    allProducts.forEach(p => {
      if (BAND_TYPES.includes(p.productType)) {
        bandStats[p.productType] += p.quantity;
      }
    });
    monthProducts.forEach(p => {
      if (BAND_TYPES.includes(p.productType)) {
        monthlyBandStats[p.productType] += p.quantity;
      }
    });
    let topBand = '—', topQty = 0;
    for (const [band, qty] of Object.entries(monthlyBandStats)) {
      if (qty > topQty) { topBand = band; topQty = qty; }
    }
    const upakovkaMonth = monthProducts.filter(p=>p.productType==='Upakovka').reduce((s,p)=>s+p.quantity,0);
    const dazmolMonth = monthProducts.filter(p=>p.productType==='Dazmol').reduce((s,p)=>s+p.quantity,0);
    const totalIncoming = (await IncomingProduct.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalExpense = (await Expense.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const expenseToday = (await Expense.aggregate([{$match:{date:{$gte:todayStart,$lte:todayEnd}}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const accessoriesCount = await Accessory.countDocuments();
    const zeroBands = BAND_TYPES.filter(band => (monthlyBandStats[band] || 0) === 0);
    const belowPlanBands = BAND_TYPES.filter(band => (monthlyBandStats[band] || 0) < 1000);

    const summaryText = await buildAITextSummary({
      totalToday,
      totalOverall,
      topBand,
      topQty,
      upakovkaMonth,
      dazmolMonth,
      availableWork: totalIncoming - totalExpense,
      expenseToday,
      accessoriesCount,
      zeroBands,
      belowPlanBands
    });

    await bot.sendMessage(chatId, `<b>🤖 AI xulosasi:</b>\n${escapeHtml(summaryText)}`, { parse_mode: 'HTML' });
    try {
      const audioBuffer = await getTTSBuffer(summaryText, 'uz');
      await bot.sendAudio(chatId, audioBuffer, { caption: 'AI xulosasi (Alisa tovushida)', parse_mode: 'HTML', filename: 'summary.mp3' });
    } catch (ttsErr) {
      console.warn('TTS audio yuborilmadi:', ttsErr.message || ttsErr);
      await bot.sendMessage(chatId, '⚠️ AI xulosasini audio shaklda yuborishda muammo yuz berdi, ammo matn yuborildi.', { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('sendAISummaryOnly error:', err);
    await bot.sendMessage(chatId, '❌ AI xulosasi yuklanmadi.', { parse_mode: 'HTML' });
  }
}

async function sendDailyTotalStats(chatId) {
  try {
    const daily = await getDailyProduction();
    const total = await getTotalProduction();
    await sendTelegramMessage(`📈 <b>Kunlik va Oylik tikuv</b>\n\n📅 <b>Kunlik:</b> <code>${daily}</code> dona\n📊 <b>Oylik:</b> <code>${total}</code> dona`, chatId);
  } catch (err) {
    await sendTelegramMessage("❌ Maʼlumot yuklanmadi.", chatId);
  }
}

async function sendIncomingList(chatId, page=0, editMessageId=null) {
  const limit=5, skip=page*limit;
  const total=await IncomingProduct.countDocuments();
  const items=await IncomingProduct.find().sort({date:-1}).skip(skip).limit(limit);
  if (!items.length) {
    const text="📭 Hech qanday kirim mahsuloti topilmadi.";
    if (editMessageId&&bot) await bot.editMessageText(text,{chat_id:chatId,message_id:editMessageId});
    else await sendTelegramMessage(text,chatId);
    return;
  }
  let msg=`📥 <b>Kroy kirim (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  items.forEach((item,idx)=>{msg+=`${skip+idx+1}. <b>${escapeHtml(item.modelName)}</b> (${escapeHtml(item.variant||'—')})\n   🏷️ Zakaz: ${escapeHtml(item.orderNumber||'—')} | 🔢 ${item.quantity} dona\n   📅 ${moment(item.date).format("DD.MM.YYYY HH:mm")}\n\n`;});
  const kb={inline_keyboard:[]};
  if (page>0) kb.inline_keyboard.push([{text:"◀️ Oldingi",callback_data:`kroy_page_${page-1}`}]);
  if ((page+1)*limit<total) kb.inline_keyboard.push([{text:"Keyingi ▶️",callback_data:`kroy_page_${page+1}`}]);
  const opts={parse_mode:"HTML",...(kb.inline_keyboard.length?{reply_markup:kb}:{})};
  if (editMessageId&&bot) await bot.editMessageText(msg,{chat_id:chatId,message_id:editMessageId,...opts});
  else if (bot) await bot.sendMessage(chatId,msg,opts);
  else await sendTelegramMessage(msg,chatId);
}

async function sendExpenseList(chatId, page=0, editMessageId=null) {
  const limit=5, skip=page*limit;
  const total=await Expense.countDocuments();
  const items=await Expense.find().sort({date:-1}).skip(skip).limit(limit);
  if (!items.length) {
    const text="📭 Hech qanday chiqim topilmadi.";
    if (editMessageId&&bot) await bot.editMessageText(text,{chat_id:chatId,message_id:editMessageId});
    else await sendTelegramMessage(text,chatId);
    return;
  }
  let msg=`📤 <b>Kroy chiqimlar (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  items.forEach((item,idx)=>{msg+=`${skip+idx+1}. <b>${escapeHtml(item.modelName)}</b> (${escapeHtml(item.variant||'—')})\n   🎚️ Band: ${escapeHtml(item.band||'—')} | 🔢 ${item.quantity} dona\n   📅 ${moment(item.date).format("DD.MM.YYYY HH:mm")}\n\n`;});
  const kb={inline_keyboard:[]};
  if (page>0) kb.inline_keyboard.push([{text:"◀️ Oldingi",callback_data:`chiqim_page_${page-1}`}]);
  if ((page+1)*limit<total) kb.inline_keyboard.push([{text:"Keyingi ▶️",callback_data:`chiqim_page_${page+1}`}]);
  const opts={parse_mode:"HTML",...(kb.inline_keyboard.length?{reply_markup:kb}:{})};
  if (editMessageId&&bot) await bot.editMessageText(msg,{chat_id:chatId,message_id:editMessageId,...opts});
  else if (bot) await bot.sendMessage(chatId,msg,opts);
  else await sendTelegramMessage(msg,chatId);
}

async function sendStaffList(chatId, page=0, editMessageId=null) {
  const limit=5, skip=page*limit;
  const total=await Staff.countDocuments();
  const items=await Staff.find().skip(skip).limit(limit);
  if (!items.length) {
    const text="👥 Hech qanday xodim topilmadi.";
    if (editMessageId&&bot) await bot.editMessageText(text,{chat_id:chatId,message_id:editMessageId});
    else await sendTelegramMessage(text,chatId);
    return;
  }
  const roleMap={band:"Band ishchisi",upakovka:"Upakovka",dazmol:"Dazmol",general:"Umumiy"};
  let msg=`👥 <b>Xodimlar (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  items.forEach((item,idx)=>{msg+=`${skip+idx+1}. <b>${escapeHtml(item.fullName)}</b> – ${roleMap[item.role]||item.role}\n   ${item.bandNumber?`🎚️ Band: ${item.bandNumber} | `:''}📞 ${item.phone||'—'}\n   📅 ${item.hireDate?moment(item.hireDate).format("DD.MM.YYYY"):'—'}\n\n`;});
  const kb={inline_keyboard:[]};
  if (page>0) kb.inline_keyboard.push([{text:"◀️ Oldingi",callback_data:`kadrlar_page_${page-1}`}]);
  if ((page+1)*limit<total) kb.inline_keyboard.push([{text:"Keyingi ▶️",callback_data:`kadrlar_page_${page+1}`}]);
  const opts={parse_mode:"HTML",...(kb.inline_keyboard.length?{reply_markup:kb}:{})};
  if (editMessageId&&bot) await bot.editMessageText(msg,{chat_id:chatId,message_id:editMessageId,...opts});
  else if (bot) await bot.sendMessage(chatId,msg,opts);
  else await sendTelegramMessage(msg,chatId);
}

async function sendMachinesList(chatId) {
  const machines=await Machine.find();
  if (!machines.length){await sendTelegramMessage("🖨️ Hech qanday mashina topilmadi.",chatId);return;}
  let msg="🖨️ <b>Mashinalar ro'yxati</b>\n\n";
  machines.forEach((m,idx)=>{msg+=`${idx+1}. <b>${escapeHtml(m.name)}</b> (${escapeHtml(m.model)})\n   🔢 Seriya: ${escapeHtml(m.serial)}\n\n`;});
  await sendTelegramMessage(msg,chatId);
}

async function sendAccessoriesList(chatId) {
  const items=await Accessory.find();
  if (!items.length){await sendTelegramMessage("🧵 Hech qanday aksessuar topilmadi.",chatId);return;}
  let msg="🧵 <b>Aksessuarlar ro'yxati</b>\n\n";
  items.forEach((a,idx)=>{msg+=`${idx+1}. <b>${escapeHtml(a.productName)}</b> (${escapeHtml(a.code||'—')})\n   🔢 ${a.quantity||0} dona | ⚖️ ${a.kg||0} kg | 📏 ${a.meters||0} m\n\n`;});
  await sendTelegramMessage(msg,chatId);
}

async function searchAll(chatId, query) {
  const results=[];
  (await ProductManager.find({productType:{$regex:query,$options:'i'}}).limit(10)).forEach(p=>results.push(`📦 ${p.productType}: ${p.quantity} dona`));
  (await IncomingProduct.find({$or:[{modelName:{$regex:query,$options:'i'}},{orderNumber:{$regex:query,$options:'i'}}]}).limit(10)).forEach(i=>results.push(`📥 Kirim: ${i.modelName} – ${i.quantity} dona`));
  (await Expense.find({$or:[{modelName:{$regex:query,$options:'i'}},{orderNumber:{$regex:query,$options:'i'}}]}).limit(10)).forEach(e=>results.push(`📤 Chiqim: ${e.modelName} – ${e.quantity} dona`));
  (await Staff.find({fullName:{$regex:query,$options:'i'}}).limit(10)).forEach(s=>results.push(`👥 ${s.fullName} (${s.role})`));
  (await Machine.find({name:{$regex:query,$options:'i'}}).limit(10)).forEach(m=>results.push(`🖨️ ${m.name} (${m.model})`));
  (await Accessory.find({productName:{$regex:query,$options:'i'}}).limit(10)).forEach(a=>results.push(`🧵 ${a.productName}`));
  if (!results.length){await sendTelegramMessage(`🔍 "${query}" bo'yicha hech narsa topilmadi.`,chatId);return;}
  let msg=`🔍 <b>"${query}" natijalari:</b>\n\n`;
  results.slice(0,20).forEach(r=>msg+=`• ${r}\n`);
  await sendTelegramMessage(msg,chatId);
}

// -------------------- Cron: Soatlik statistika --------------------
async function sendHourlyStats() {
  try {
    const now=new Date();
    const todayStart=moment().startOf('day').toDate();
    const todayEnd=moment().endOf('day').toDate();
    const currentHour=now.getHours();
    const hourStart=moment().hour(currentHour).minute(0).second(0).toDate();
    const hourEnd=moment().hour(currentHour).minute(59).second(59).toDate();
    const allProducts=await ProductManager.find({createdAt:{$gte:todayStart,$lte:todayEnd}});
    const totalToday=allProducts.filter(p=>BAND_TYPES.includes(p.productType)).reduce((s,p)=>s+p.quantity,0);
    const totalOverall=await getTotalProduction();
    const hourProducts=await ProductManager.find({createdAt:{$gte:hourStart,$lte:hourEnd}});
    const totalHour=hourProducts.reduce((s,p)=>s+p.quantity,0);
    const bandStats={};
    allProducts.forEach(p=>{if(p.productType.includes('band'))bandStats[p.productType]=(bandStats[p.productType]||0)+p.quantity;});
    let topBand='—',topQty=0;
    for(const[band,qty]of Object.entries(bandStats))if(qty>topQty){topBand=band;topQty=qty;}
    const upakovkaToday=allProducts.filter(p=>p.productType==='Upakovka').reduce((s,p)=>s+p.quantity,0);
    const dazmolToday=allProducts.filter(p=>p.productType==='Dazmol').reduce((s,p)=>s+p.quantity,0);
    const totalIncoming=(await IncomingProduct.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalExpense=(await Expense.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const expenseToday=(await Expense.aggregate([{$match:{date:{$gte:todayStart,$lte:todayEnd}}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalStaff=await Staff.countDocuments();
    const attendances=await Attendance.find({date:moment().format("YYYY-MM-DD")});
    const presentCount=attendances.filter(a=>a.checkIn).length;
    const lateCount=attendances.filter(a=>a.checkIn&&a.lateMinutes>0).length;
    const machinesCount=await Machine.countDocuments();
    const message=`
📊 <b>Soatlik hisobot – ${moment().format("HH:mm")}</b>
📅 Sana: ${moment().format("DD.MM.YYYY")}

🔹 <b>Ishlab chiqarish</b>
• 📅 <b>Kunlik tikuv</b>: <code>${totalToday}</code> dona
• 📊 <b>Jami tikuv</b>: <code>${totalOverall}</code> dona
• ⏱️ Soatlik (${currentHour}:00–${currentHour}:59): ${totalHour} dona
• 🏆 Eng ko'p tikkan: ${topBand} (${topQty} dona)
• 🔥 Dazmol: ${dazmolToday} | 📦 Upakovka: ${upakovkaToday}

📦 <b>Ombor holati</b>
• Mavjud ish: ${totalIncoming-totalExpense} dona
• Kunlik chiqim: ${expenseToday} dona

👥 <b>Davomat</b>
• Jami: ${totalStaff} | Kelganlar: ${presentCount} | Kelmaganlar: ${totalStaff-presentCount} | ⏰ Kech: ${lateCount}

🖨️ Mashinalar: ${machinesCount}
    `;
    await sendTelegramMessage(message);
  } catch(err){console.error('Hourly stats error:',err);}
}

// -------------------- Middleware --------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
hbs.registerPartials(path.join(__dirname, "views/partials"));
hbs.registerHelper("eq", (a, b) => a === b);

async function cleanupIndexes() {
  try { await mongoose.connection.db.collection('attendances').dropIndex('workerId_1_date_1'); console.log('Eski indeks o\'chirildi'); } catch(err){}
  try { await Attendance.createIndexes(); console.log('Attendance indekslari tayyor'); } catch(err){ console.error('Indeks xatosi:',err); }
}

// -------------------- API Endpoints --------------------
app.get("/api/productmanager", async (req, res) => {
  const items = await ProductManager.find().sort({ createdAt: -1 });
  res.json(items);
});

app.post("/api/productmanager", async (req, res) => {
  try {
    const item = new ProductManager(req.body);
    await item.save();
    // ✅ FIX 3: To'liq va aniq Telegram xabari
    sendTelegramMessage(
      `✅ Yangi mahsulot qo'shildi:\n📦 Turi: <b>${escapeHtml(item.productType)}</b>\n🔢 Miqdori: <b>${item.quantity}</b> dona\n� Kiritgan: <b>${escapeHtml(item.enteredBy)}</b>\n�📅 Vaqt: ${moment(item.createdAt).format("DD.MM.YYYY HH:mm")}`
    ).catch(err => console.warn('TG xato:', err.message));
    res.json(item);
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Saqlashda xatolik' });
  }
});

app.put("/api/productmanager/:id", async (req, res) => {
  const item = await ProductManager.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (item) {
    sendTelegramMessage(
      `✏️ Mahsulot tahrirlandi:\n📦 Turi: <b>${escapeHtml(item.productType)}</b>\n🔢 Miqdori: <b>${item.quantity}</b> dona\n👤 Kiritgan: <b>${escapeHtml(item.enteredBy)}</b>\n📅 Vaqt: ${moment(item.createdAt).format("DD.MM.YYYY HH:mm")}`
    ).catch(err => console.warn('TG xato:', err.message));
  }
  res.json(item);
});

app.delete("/api/productmanager/:id", async (req, res) => {
  await ProductManager.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/incoming", async (req, res) => {
  res.json(await IncomingProduct.find().sort({ date: -1 }));
});

app.post("/api/incoming", async (req, res) => {
  const product = new IncomingProduct(req.body);
  await product.save();
  await sendTelegramMessage(`📥 Yangi kirim: <b>${escapeHtml(product.modelName)}</b>, variant: ${escapeHtml(product.variant||'—')}, miqdor: ${product.quantity}`);
  res.json(product);
});

app.put("/api/incoming/:id", async (req, res) => {
  res.json(await IncomingProduct.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete("/api/incoming/:id", async (req, res) => {
  await IncomingProduct.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/expenses", async (req, res) => {
  res.json(await Expense.find().sort({ date: -1 }));
});

app.post("/api/expenses", async (req, res) => {
  const expense = new Expense(req.body);
  await expense.save();
  await sendTelegramMessage(`📤 Yangi chiqim: <b>${escapeHtml(expense.modelName)}</b>, variant: ${escapeHtml(expense.variant||'—')}, miqdor: ${expense.quantity}`);
  res.json(expense);
});

app.put("/api/expenses/:id", async (req, res) => {
  res.json(await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete("/api/expenses/:id", async (req, res) => {
  await Expense.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/staff", async (req, res) => {
  res.json(await Staff.find());
});

app.post("/api/staff", async (req, res) => {
  const member = new Staff(req.body);
  await member.save();
  await sendTelegramMessage(`👤 Yangi xodim: <b>${escapeHtml(member.fullName)}</b>, lavozim: ${member.role}`);
  res.json(member);
});

app.put("/api/staff/:id", async (req, res) => {
  res.json(await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete("/api/staff/:id", async (req, res) => {
  await Staff.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/attendance", async (req, res) => {
  res.json(await Attendance.find().populate("employeeId").sort({ date: -1 }));
});

app.post("/api/attendance", async (req, res) => {
  const { employeeId, date, checkIn, checkOut, lateMinutes, extraWorkMinutes } = req.body;
  let record = await Attendance.findOne({ employeeId, date });
  if (record) {
    if (checkIn !== undefined) record.checkIn = checkIn;
    if (checkOut !== undefined) record.checkOut = checkOut;
    if (lateMinutes !== undefined) record.lateMinutes = lateMinutes;
    if (extraWorkMinutes !== undefined) record.extraWorkMinutes = extraWorkMinutes;
    if (record.checkIn && record.checkOut) {
      record.workDurationMinutes = Math.floor((new Date(record.checkOut) - new Date(record.checkIn)) / 60000);
    }
    await record.save();
    return res.json(record);
  } else {
    const newRecord = new Attendance({ employeeId, date, checkIn, checkOut, lateMinutes, extraWorkMinutes });
    if (newRecord.checkIn && newRecord.checkOut) {
      newRecord.workDurationMinutes = Math.floor((new Date(newRecord.checkOut) - new Date(newRecord.checkIn)) / 60000);
    }
    await newRecord.save();
    await sendTelegramMessage(`📅 Yangi davomat: sana ${date}, xodim ID: ${employeeId}`);
    return res.json(newRecord);
  }
});

app.put("/api/attendance/:id", async (req, res) => {
  const { checkIn, checkOut, lateMinutes, extraWorkMinutes } = req.body;
  const record = await Attendance.findById(req.params.id);
  if (!record) return res.status(404).json({ error: "Record not found" });
  if (checkIn !== undefined) record.checkIn = checkIn;
  if (checkOut !== undefined) record.checkOut = checkOut;
  if (lateMinutes !== undefined) record.lateMinutes = lateMinutes;
  if (extraWorkMinutes !== undefined) record.extraWorkMinutes = extraWorkMinutes;
  if (record.checkIn && record.checkOut) {
    record.workDurationMinutes = Math.floor((new Date(record.checkOut) - new Date(record.checkIn)) / 60000);
  }
  await record.save();
  res.json(record);
});

app.delete("/api/attendance/:id", async (req, res) => {
  await Attendance.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.post("/api/attendance/:id/extra-work", async (req, res) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) return res.status(404).json({ error: "Record not found" });
  record.extraWorkMinutes = (record.extraWorkMinutes || 0) + req.body.minutes;
  await record.save();
  res.json(record);
});

app.post("/api/attendance/extra-days/:employeeId", async (req, res) => {
  try {
    const { extraDays } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    let record = await Attendance.findOne({ employeeId: req.params.employeeId, date: today });
    if (!record) { record = new Attendance({ employeeId: req.params.employeeId, date: today, extraWorkDays: extraDays||0 }); }
    else { record.extraWorkDays = (record.extraWorkDays||0) + (extraDays||0); }
    await record.save();
    res.json(record);
  } catch(err){ res.status(500).json({ error: err.message }); }
});

app.post("/api/attendance/extra-hours/:employeeId", async (req, res) => {
  try {
    const { extraHours } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    let record = await Attendance.findOne({ employeeId: req.params.employeeId, date: today });
    if (!record) { record = new Attendance({ employeeId: req.params.employeeId, date: today, extraWorkHours: extraHours||0 }); }
    else { record.extraWorkHours = (record.extraWorkHours||0) + (extraHours||0); }
    await record.save();
    res.json(record);
  } catch(err){ res.status(500).json({ error: err.message }); }
});

app.get("/api/machines", async (req, res) => {
  res.json(await Machine.find());
});

app.post("/api/machines", async (req, res) => {
  const machine = new Machine(req.body);
  await machine.save();
  await sendTelegramMessage(`🖨️ Yangi mashina: <b>${escapeHtml(machine.name)}</b>, model: ${escapeHtml(machine.model)}`);
  res.json(machine);
});

app.put("/api/machines/:id", async (req, res) => {
  res.json(await Machine.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete("/api/machines/:id", async (req, res) => {
  await Machine.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/accessories", async (req, res) => {
  res.json(await Accessory.find());
});

app.post("/api/accessories", async (req, res) => {
  const accessory = new Accessory(req.body);
  await accessory.save();
  await sendTelegramMessage(`🧵 Yangi aksessuar: <b>${escapeHtml(accessory.productName)}</b>, kod: ${escapeHtml(accessory.code||'—')}, miqdor: ${accessory.quantity}`);
  res.json(accessory);
});

app.put("/api/accessories/:id", async (req, res) => {
  res.json(await Accessory.findByIdAndUpdate(req.params.id, req.body, { new: true }));
});

app.delete("/api/accessories/:id", async (req, res) => {
  await Accessory.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/stats/today", async (req, res) => {
  try {
    const todayStart=moment().startOf("day").toDate(), todayEnd=moment().endOf("day").toDate();
    const pmToday=await ProductManager.aggregate([{$match:{createdAt:{$gte:todayStart,$lte:todayEnd}}},{$group:{_id:"$productType",total:{$sum:"$quantity"}}}]);
    const todayTotals={}; pmToday.forEach(g=>{todayTotals[g._id]=g.total;});
    const bandTotals=await ProductManager.aggregate([{$match:{productType:{$regex:/^[0-9]+-band$/}}},{$group:{_id:"$productType",total:{$sum:"$quantity"}}}]);
    const bandTotalsObj={}; bandTotals.forEach(b=>{bandTotalsObj[b._id]=b.total;});
    let topBand=null,topQty=0;
    for(const[band,qty]of Object.entries(bandTotalsObj))if(qty>topQty){topBand=band;topQty=qty;}
    const upakovkaTotal=(await ProductManager.aggregate([{$match:{productType:"Upakovka"}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const dazmolTotal=(await ProductManager.aggregate([{$match:{productType:"Dazmol"}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalIncoming=(await IncomingProduct.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const totalExpense=(await Expense.aggregate([{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const expenseToday=(await Expense.aggregate([{$match:{date:{$gte:todayStart,$lte:todayEnd}}},{$group:{_id:null,total:{$sum:"$quantity"}}}]))[0]?.total||0;
    const accessoriesCount=await Accessory.countDocuments();
    const totalStaff=await Staff.countDocuments();
    const todayStr=moment().format("YYYY-MM-DD");
    const attendances=await Attendance.find({date:todayStr}).populate("employeeId");
    const presentCount=attendances.filter(a=>a.checkIn).length;
    const lateCount=attendances.filter(a=>a.checkIn&&a.lateMinutes>0).length;
    const machinesCount=await Machine.countDocuments();
    res.json({ todayTotals, upakovkaTotal, dazmolTotal, topBand, topBandQty:topQty, availableWork:totalIncoming-totalExpense, expenseToday, accessoriesCount, totalStaff, presentCount, absentCount:totalStaff-presentCount, lateCount, machinesCount });
  } catch(err){ console.error("Stats error:",err); res.status(500).json({error:"Server error"}); }
});

app.get("/api/ai-summary", async (req, res) => {
  try {
    const monthStart = moment().startOf('month').toDate();
    const monthEnd = moment().endOf('month').toDate();
    const todayStart = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();
    const bandTotals = await ProductManager.aggregate([
      { $match: { createdAt: { $gte: todayStart, $lte: todayEnd }, productType: { $in: BAND_TYPES } } },
      { $group: { _id: "$productType", total: { $sum: "$quantity" } } }
    ]);
    const bandTotalsObj = Object.fromEntries(bandTotals.map(b => [b._id, b.total]));
    const monthBandTotals = await ProductManager.aggregate([
      { $match: { createdAt: { $gte: monthStart, $lte: monthEnd }, productType: { $in: BAND_TYPES } } },
      { $group: { _id: "$productType", total: { $sum: "$quantity" } } }
    ]);
    const monthBandTotalsObj = Object.fromEntries(monthBandTotals.map(b => [b._id, b.total]));
    const upakovkaToday = (await ProductManager.aggregate([{ $match: { createdAt: { $gte: todayStart, $lte: todayEnd }, productType: "Upakovka" } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const dazmolToday = (await ProductManager.aggregate([{ $match: { createdAt: { $gte: todayStart, $lte: todayEnd }, productType: "Dazmol" } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const upakovkaMonth = (await ProductManager.aggregate([{ $match: { createdAt: { $gte: monthStart, $lte: monthEnd }, productType: "Upakovka" } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const dazmolMonth = (await ProductManager.aggregate([{ $match: { createdAt: { $gte: monthStart, $lte: monthEnd }, productType: "Dazmol" } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const totalIncoming = (await IncomingProduct.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const totalExpense = (await Expense.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const todayExpense = (await Expense.aggregate([{ $match: { date: { $gte: todayStart, $lte: todayEnd } } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const accessoriesCount = await Accessory.countDocuments();
    const totalToday = BAND_TYPES.reduce((sum, band) => sum + (bandTotalsObj[band] || 0), 0);
    const totalOverall = await getTotalProduction();
    const zeroBands = BAND_TYPES.filter(band => (monthBandTotalsObj[band] || 0) === 0);
    const belowPlanBands = BAND_TYPES.filter(band => (monthBandTotalsObj[band] || 0) < 1000);
    let topBand = null; let topQty = 0;
    for (const [band, qty] of Object.entries(monthBandTotalsObj)) {
      if (qty > topQty) { topQty = qty; topBand = band; }
    }

    const summaryPrompt = `Siz ombor va tikuv statistikasi uchun kuchli, aniq va tezkor xulosa tayyorlaysiz. Foydalanuvchiga bugungi qilgan ishlarini, reja bilan hozirgi ahvolni, eng katta muammoni va nimaga e'tibor berish kerakligini aytib bering. Har band uchun rejalar:
- 1-18 band: har biri 1000 dona
- Upakovka va Dazmol: har biri 10000 dona

Bugungi ma'lumot:
- Bugungi bandlar: ${totalToday} dona
- Oylik jami tikuv: ${totalOverall} dona
- Top band (oylik): ${topBand || 'yo`q'} (${topQty} dona)
- Nolinchi bandlar: ${zeroBands.length} ta (${zeroBands.slice(0,5).join(', ') || 'yo`q'})
- 1000 dan kam bajarilgan bandlar: ${belowPlanBands.length} ta
- Upakovka (oylik): ${upakovkaMonth} dona
- Dazmol (oylik): ${dazmolMonth} dona
- Ombordagi mavjud ish: ${totalIncoming - totalExpense} dona
- Bugungi chiqim: ${todayExpense} dona
- Aksessuarlar soni: ${accessoriesCount}

Faqat qattiq va amaliy xulosani O'zbek tilida yozing. Sarlavha qo'ymang, qisqa paragraf tarzida taqdim eting.`;

    const openaiKey = process.env.OPENAI_API_KEY;
    let summaryText;
    if (openaiKey) {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [
            { role: "system", content: "Siz tezkor statistik xulosachi va ombor nazoratchisisiz." },
            { role: "user", content: summaryPrompt }
          ],
          temperature: 0.2,
          max_tokens: 300
        },
        { headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" } }
      );
      summaryText = response.data?.choices?.[0]?.message?.content?.trim();
    }
    if (!summaryText) {
      const shortZero = zeroBands.slice(0,5).join(', ') || 'yo\'q';
      summaryText = `Bugungi ishlab chiqarish natijasi juda real holatda. Barcha bandlar uchun reja 1000 dona, lekin ${belowPlanBands.length} ta band hali rejadan past; ayniqsa ${topBand || 'hech qaysi band'} yuqori natija, ${shortZero} bandlar esa bugun nolni ko'rsatmoqda. Upakovka ${upakovkaMonth} va Dazmol ${dazmolMonth} dona, ular 10000 lik rejaga yaqin emas. Omborda mavjud ish hajmi ${totalIncoming - totalExpense} dona, bugungi chiqim ${todayExpense} dona. Ehtiyot qismlar soni ${accessoriesCount} ta. Hozirgi vaqtda eng muhim vazifa: 0 ga yoki rejadan past bo'lgan bandlarga diqqatni qaratish.`;
    }

    res.json({ summary: summaryText, data: { totalToday, topBand, topQty, zeroBands, belowPlanBands, upakovkaMonth, dazmolMonth, availableWork: totalIncoming - totalExpense, todayExpense, accessoriesCount } });
  } catch (err) {
    console.error("AI summary error:", err.message || err);
    res.status(500).json({ error: "Xulosa olishda xatolik yuz berdi." });
  }
});

// -------------------- Cron Jobs --------------------
cron.schedule("0 * * * *", () => {
  console.log(`⏰ Soatlik statistika – ${moment().format("HH:mm")}`);
  sendHourlyStats();
});

// ✅ FIX 3: Auto-checkout — null va undefined checkOut ham qo'shilgan
cron.schedule("0 18 * * *", async () => {
  console.log("Avtomatik ketish (18:00)");
  const today = moment().format("YYYY-MM-DD");
  // ✅ FIX: $exists:false null qiymatlarni o'tkazib yuboradi, shuning uchun $in ishlatamiz
  const records = await Attendance.find({
    date: today,
    $or: [
      { checkOut: { $exists: false } },
      { checkOut: null }
    ]
  });
  for (const record of records) {
    const now = new Date();
    record.checkOut = now;
    record.autoCheckedOut = true;
    if (record.checkIn) {
      record.workDurationMinutes = Math.floor((now - new Date(record.checkIn)) / 60000);
    }
    await record.save();
    console.log(`${record.employeeId} avtomatik ketdi`);
  }
});

// -------------------- Socket.IO --------------------
let notes = [];
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("initial-notes", notes);
  socket.on("new-note", (note) => {
    const newNote = { id: Date.now(), text: note.text||"", date: new Date().toLocaleString("uz-UZ") };
    notes.unshift(newNote);
    io.emit("note-added", newNote);
  });
  socket.on("voice-chunk", (audioData) => socket.broadcast.emit("audio-stream", audioData));
  socket.on("stop-voice", () => socket.broadcast.emit("audio-stopped"));
  socket.on("delete-note", (noteId) => { notes = notes.filter(n => n.id !== noteId); io.emit("note-deleted", noteId); });
  socket.on("clear-all", () => { notes = []; io.emit("all-cleared"); });
  socket.on("disconnect", () => console.log("Client disconnected"));
});

// -------------------- Announcements --------------------
function sendAnnouncement(type, data={}) { io.emit("announcement", { type, ...data }); }
cron.schedule("50 7 * * *", () => sendAnnouncement("warning", { message: "Ish boshlanishiga 10 daqiqa qoldi!" }));
cron.schedule("55 7 * * *", () => sendAnnouncement("warning", { message: "Ish boshlanishiga 5 daqiqa qoldi!" }));
cron.schedule("0 8 * * *",  () => sendAnnouncement("warning", { message: "Ish boshlandi!" }));
cron.schedule("0 12 * * *", () => sendAnnouncement("metro", { duration: 1000 }));
cron.schedule("0 13 * * *", () => sendAnnouncement("metro", { duration: 1000 }));
cron.schedule("0 18 * * *", () => {
  let count=0;
  const interval=setInterval(()=>{ sendAnnouncement("metro",{duration:500}); if(++count>=12)clearInterval(interval); }, 5000);
});

// -------------------- Google TTS --------------------
app.post("/api/tts-google", (req, res) => {
  const { text, lang="uz" } = req.body;
  if (!text) return res.status(400).json({ error: "Text required" });
  const url=`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  require("https").get(url, { headers: { 'User-Agent':'Mozilla/5.0' } }, (response) => {
    if (response.statusCode!==200) return res.status(response.statusCode).json({ error:`TTS error ${response.statusCode}` });
    res.setHeader("Content-Type","audio/mpeg");
    response.pipe(res);
  }).on("error", err=>{ console.error("TTS error:",err); res.status(500).json({error:"TTS failed"}); });
});

// -------------------- Pages --------------------
app.get("/",          (req,res)=>res.render("input",      {title:"Mahsulotlar", active:"home"}));
app.get("/grafik",    (req,res)=>res.render("grafik",     {title:"Statistika",  active:"graph"}));
app.get("/kesimXona", (req,res)=>res.render("kesimXona",  {title:"Kirim",       active:"income"}));
app.get("/chiqim",    (req,res)=>res.render("chiqim",     {title:"Chiqim",      active:"expense"}));
app.get("/mikrafon",  (req,res)=>res.render("mikrafon",   {title:"Mikrafon",    active:"mic"}));
app.get("/mashinkalar",(req,res)=>res.render("mashinkalar",{title:"Mashinkalar",active:"machines"}));
app.get("/kadrlar",   (req,res)=>res.render("kadrlar",    {title:"Kadrlar",     active:"staff"}));
app.get("/davomat",   (req,res)=>res.render("davomat",    {title:"Davomat",     active:"attendance"}));
app.get("/aksessuar", (req,res)=>res.render("aksessuar",  {title:"Aksessuarlar",active:"accessories"}));

// -------------------- Start --------------------
const PORT = process.env.PORT || 3900;

async function startServer() {
  const MONGO_URL = process.env.MONGO_URL;
  if (!MONGO_URL) { console.error("❌ MONGO_URL aniqlanmagan."); process.exit(1); }
  console.log(`MongoDB ga ulanilmoqda...`);
  try {
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 45000 });
    console.log("✅ MongoDB ulandi");
    await cleanupIndexes();
    server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server port ${PORT} da ishlamoqda`));
  } catch(err) {
    console.error("❌ MongoDB xatosi:", err.message);
    process.exit(1);
  }
}

startServer();

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m]));
}