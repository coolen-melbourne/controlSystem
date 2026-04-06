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
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// -------------------- Models --------------------
const productManagerSchema = new mongoose.Schema({
  productType: { type: String, required: true },
  quantity: { type: Number, required: true },
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

// -------------------- Telegram Bot --------------------
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;
if (botToken && botToken !== 'your_bot_token_here') {
  bot = new TelegramBot(botToken, { polling: true });
  console.log("🤖 Telegram bot polling started");
} else {
  console.warn("⚠️ Telegram bot token not provided. Bot commands disabled.");
}

// -------------------- Yordamchi funksiyalar --------------------
const BAND_TYPES = [
  "1-band","2-band","3-band","4-band","5-band","6-band","7-band","8-band",
  "9-band","10-band","11-band","12-band","13-band","14-band","15-band",
  "16-band","17-band","18-band"
];

async function getTotalProduction() {
  const allProducts = await ProductManager.find({ productType: { $in: BAND_TYPES } });
  return allProducts.reduce((sum, p) => sum + p.quantity, 0);
}

async function getDailyProduction() {
  const todayStart = moment().startOf('day').toDate();
  const todayEnd = moment().endOf('day').toDate();
  const todayProducts = await ProductManager.find({
    productType: { $in: BAND_TYPES },
    createdAt: { $gte: todayStart, $lte: todayEnd }
  });
  return todayProducts.reduce((sum, p) => sum + p.quantity, 0);
}

// -------------------- Telegram Bot Helper Functions --------------------
const sendTelegramMessage = async (message, chatId = null) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const defaultChatId = process.env.TELEGRAM_CHAT_ID;
  const targetChatId = chatId || defaultChatId;
  if (!token || !targetChatId || targetChatId === 'your_chat_id_here') {
    console.warn('⚠️ Telegram token yoki chat ID noto‘g‘ri. Xabar yuborilmadi.');
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

// -------------------- Band qo‘shish uchun state --------------------
const userState = new Map(); // chatId -> { action: 'awaiting_band_quantity', band: string }

// -------------------- Bot Command Handlers --------------------
if (bot) {
  const mainMenuKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Statistika", callback_data: "stats" }, { text: "📈 Kunlik / Jami", callback_data: "daily_total" }],
        [{ text: "📥 Kroy kirim", callback_data: "kroy" }, { text: "📤 Kroy chiqim", callback_data: "chiqim" }],
        [{ text: "👥 Kadrlar", callback_data: "kadrlar" }, { text: "🖨️ Mashinalar", callback_data: "mashinalar" }],
        [{ text: "🧵 Aksessuarlar", callback_data: "aksessuar" }, { text: "➕ Bandga qiymat", callback_data: "add_band" }],
        [{ text: "🔍 Qidirish", switch_inline_query_current_chat: "" }]
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

  // /add_band buyrug'i
  bot.onText(/\/add_band/, async (msg) => {
    const chatId = msg.chat.id;
    await sendBandSelectionKeyboard(chatId);
  });

  // Statistika buyruqlari
  bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    await sendFullStatsToChat(chatId);
  });

  bot.onText(/\/daily/, async (msg) => {
    const chatId = msg.chat.id;
    await sendDailyTotalStats(chatId);
  });

  bot.onText(/\/kroy/, async (msg) => {
    const chatId = msg.chat.id;
    await sendIncomingList(chatId, 0);
  });

  bot.onText(/\/chiqim/, async (msg) => {
    const chatId = msg.chat.id;
    await sendExpenseList(chatId, 0);
  });

  bot.onText(/\/kadrlar/, async (msg) => {
    const chatId = msg.chat.id;
    await sendStaffList(chatId, 0);
  });

  bot.onText(/\/mashinalar/, async (msg) => {
    const chatId = msg.chat.id;
    await sendMachinesList(chatId);
  });

  bot.onText(/\/aksessuar/, async (msg) => {
    const chatId = msg.chat.id;
    await sendAccessoriesList(chatId);
  });

  bot.onText(/\/search (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];
    await searchAll(chatId, query);
  });

  // Matn xabarlar – band miqdorini kiritish uchun
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    const state = userState.get(chatId);
    if (state && state.action === 'awaiting_band_quantity') {
      const quantity = parseInt(text, 10);
      if (isNaN(quantity) || quantity <= 0) {
        bot.sendMessage(chatId, "❌ Iltimos, to‘g‘ri son kiriting (musbat butun). Qaytadan urinib ko‘ring.");
        userState.delete(chatId);
        return;
      }
      try {
        const newItem = new ProductManager({ productType: state.band, quantity });
        await newItem.save();
        await sendTelegramMessage(`✅ ${state.band} ga ${quantity} dona qo‘shildi!`, chatId);
        // Ixtiyoriy: statistikani yangilash yoki boshqa
      } catch (err) {
        console.error("Save band error:", err);
        bot.sendMessage(chatId, "❌ Saqlashda xatolik yuz berdi. Qayta urining.");
      }
      userState.delete(chatId);
    }
  });

  // Callback query
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    if (data.startsWith('kroy_page_')) {
      const page = parseInt(data.split('_')[2]);
      await sendIncomingList(chatId, page, messageId);
    } else if (data.startsWith('chiqim_page_')) {
      const page = parseInt(data.split('_')[2]);
      await sendExpenseList(chatId, page, messageId);
    } else if (data.startsWith('kadrlar_page_')) {
      const page = parseInt(data.split('_')[2]);
      await sendStaffList(chatId, page, messageId);
    } else if (data === 'stats') {
      await sendFullStatsToChat(chatId);
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
      const band = data.substring(5); // "band_1-band" -> "1-band"
      userState.set(chatId, { action: 'awaiting_band_quantity', band });
      bot.editMessageText(`🎚️ <b>${band}</b> uchun miqdorni (dona) kiriting:`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML"
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
    const row = [];
    row.push({ text: BAND_TYPES[i], callback_data: `band_${BAND_TYPES[i]}` });
    if (i + 1 < BAND_TYPES.length) {
      row.push({ text: BAND_TYPES[i+1], callback_data: `band_${BAND_TYPES[i+1]}` });
    }
    buttons.push(row);
  }
  const keyboard = { inline_keyboard: buttons };
  bot.sendMessage(chatId, "🎚️ Qaysi bandga qiymat kiritmoqchisiz? Tanlang:", {
    reply_markup: keyboard,
    parse_mode: "HTML"
  });
}

// -------------------- Bot funksiyalari (maʼlumotlarni yig‘ish va jo‘natish) --------------------
async function sendFullStatsToChat(chatId) {
  try {
    const todayStart = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();

    const allProducts = await ProductManager.find({
      createdAt: { $gte: todayStart, $lte: todayEnd }
    });
    const totalToday = allProducts.filter(p => BAND_TYPES.includes(p.productType)).reduce((sum, p) => sum + p.quantity, 0);
    const totalOverall = await getTotalProduction();

    const bandStats = {};
    allProducts.forEach(p => {
      if (p.productType.includes('band')) {
        bandStats[p.productType] = (bandStats[p.productType] || 0) + p.quantity;
      }
    });
    let topBand = '—', topQty = 0;
    for (const [band, qty] of Object.entries(bandStats)) {
      if (qty > topQty) { topBand = band; topQty = qty; }
    }

    const upakovkaToday = allProducts.filter(p => p.productType === 'Upakovka').reduce((s,p) => s + p.quantity, 0);
    const dazmolToday = allProducts.filter(p => p.productType === 'Dazmol').reduce((s,p) => s + p.quantity, 0);

    const totalIncoming = (await IncomingProduct.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const totalExpense = (await Expense.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const availableWork = totalIncoming - totalExpense;

    const expenseToday = (await Expense.aggregate([
      { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;

    const totalStaff = await Staff.countDocuments();
    const attendances = await Attendance.find({ date: moment().format("YYYY-MM-DD") });
    const presentCount = attendances.filter(a => a.checkIn).length;
    const absentCount = totalStaff - presentCount;
    const lateCount = attendances.filter(a => a.checkIn && a.lateMinutes > 0).length;
    const machinesCount = await Machine.countDocuments();

    const message = `
📊 <b>📅 Statistika – ${moment().format("DD.MM.YYYY, HH:mm")}</b>

🔹 <b>Ishlab chiqarish</b>
• 📅 <b>Kunlik tikuv</b> (bandlar): <code>${totalToday}</code> dona
• 📊 <b>Jami tikuv</b> (barcha bandlar): <code>${totalOverall}</code> dona
• 🏆 Eng ko‘p tikkan band: <b>${topBand}</b> (${topQty} dona)
• 🔥 Dazmol: ${dazmolToday} dona
• 📦 Upakovka: ${upakovkaToday} dona

📦 <b>Ombor holati</b>
• Mavjud ish: ${availableWork} dona
• Kunlik chiqim: ${expenseToday} dona

👥 <b>Davomat</b>
• Jami xodimlar: ${totalStaff}
• ✅ Kelganlar: ${presentCount}
• ❌ Kelmaganlar: ${absentCount}
• ⏰ Kech qolganlar: ${lateCount}

🖨️ Mashinalar soni: ${machinesCount}
    `;
    await sendTelegramMessage(message, chatId);
  } catch (err) {
    console.error('sendFullStatsToChat error:', err);
    await sendTelegramMessage("❌ Statistika yuklanmadi. Qayta urinib ko‘ring.", chatId);
  }
}

async function sendDailyTotalStats(chatId) {
  try {
    const daily = await getDailyProduction();
    const total = await getTotalProduction();
    const message = `
📈 <b>Kunlik va Jami tikuv</b>

📅 <b>Kunlik tikuv</b> (bugungi bandlar): <code>${daily}</code> dona
📊 <b>Jami tikuv</b> (barcha vaqt): <code>${total}</code> dona
    `;
    await sendTelegramMessage(message, chatId);
  } catch (err) {
    console.error('sendDailyTotalStats error:', err);
    await sendTelegramMessage("❌ Maʼlumot yuklanmadi.", chatId);
  }
}

async function sendIncomingList(chatId, page = 0, editMessageId = null) {
  const limit = 5;
  const skip = page * limit;
  const total = await IncomingProduct.countDocuments();
  const items = await IncomingProduct.find().sort({ date: -1 }).skip(skip).limit(limit);
  if (!items.length) {
    const text = "📭 Hech qanday kirim mahsuloti topilmadi.";
    if (editMessageId && bot) await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId });
    else await sendTelegramMessage(text, chatId);
    return;
  }
  let message = `📥 <b>Kroy kirim mahsulotlari (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  items.forEach((item, idx) => {
    message += `${skip+idx+1}. <b>${escapeHtml(item.modelName)}</b> (${escapeHtml(item.variant || '—')})\n   🏷️ Zakaz: ${escapeHtml(item.orderNumber || '—')} | 🔢 Miqdor: ${item.quantity} dona\n   📅 Sana: ${moment(item.date).format("DD.MM.YYYY HH:mm")}\n\n`;
  });
  const keyboard = { inline_keyboard: [] };
  if (page > 0) keyboard.inline_keyboard.push([{ text: "◀️ Oldingi", callback_data: `kroy_page_${page-1}` }]);
  if ((page+1)*limit < total) keyboard.inline_keyboard.push([{ text: "Keyingi ▶️", callback_data: `kroy_page_${page+1}` }]);
  if (keyboard.inline_keyboard.length && bot) {
    if (editMessageId) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML", reply_markup: keyboard });
    else await bot.sendMessage(chatId, message, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    if (editMessageId && bot) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML" });
    else await sendTelegramMessage(message, chatId);
  }
}

async function sendExpenseList(chatId, page = 0, editMessageId = null) {
  const limit = 5;
  const skip = page * limit;
  const total = await Expense.countDocuments();
  const items = await Expense.find().sort({ date: -1 }).skip(skip).limit(limit);
  if (!items.length) {
    const text = "📭 Hech qanday chiqim topilmadi.";
    if (editMessageId && bot) await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId });
    else await sendTelegramMessage(text, chatId);
    return;
  }
  let message = `📤 <b>Kroy chiqimlar (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  items.forEach((item, idx) => {
    message += `${skip+idx+1}. <b>${escapeHtml(item.modelName)}</b> (${escapeHtml(item.variant || '—')})\n   🎚️ Band: ${escapeHtml(item.band || '—')} | 🔢 Miqdor: ${item.quantity} dona\n   📅 Sana: ${moment(item.date).format("DD.MM.YYYY HH:mm")}\n\n`;
  });
  const keyboard = { inline_keyboard: [] };
  if (page > 0) keyboard.inline_keyboard.push([{ text: "◀️ Oldingi", callback_data: `chiqim_page_${page-1}` }]);
  if ((page+1)*limit < total) keyboard.inline_keyboard.push([{ text: "Keyingi ▶️", callback_data: `chiqim_page_${page+1}` }]);
  if (keyboard.inline_keyboard.length && bot) {
    if (editMessageId) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML", reply_markup: keyboard });
    else await bot.sendMessage(chatId, message, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    if (editMessageId && bot) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML" });
    else await sendTelegramMessage(message, chatId);
  }
}

async function sendStaffList(chatId, page = 0, editMessageId = null) {
  const limit = 5;
  const skip = page * limit;
  const total = await Staff.countDocuments();
  const items = await Staff.find().skip(skip).limit(limit);
  if (!items.length) {
    const text = "👥 Hech qanday xodim topilmadi.";
    if (editMessageId && bot) await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId });
    else await sendTelegramMessage(text, chatId);
    return;
  }
  let message = `👥 <b>Xodimlar (sahifa ${page+1}/${Math.ceil(total/limit)})</b>\n\n`;
  const roleMap = { band: "Band ishchisi", upakovka: "Upakovka", dazmol: "Dazmol", general: "Umumiy" };
  items.forEach((item, idx) => {
    message += `${skip+idx+1}. <b>${escapeHtml(item.fullName)}</b> – ${roleMap[item.role] || item.role}\n   ${item.bandNumber ? `🎚️ Band: ${item.bandNumber} | ` : ''}📞 ${item.phone || '—'}\n   📅 Qabul: ${item.hireDate ? moment(item.hireDate).format("DD.MM.YYYY") : '—'}\n\n`;
  });
  const keyboard = { inline_keyboard: [] };
  if (page > 0) keyboard.inline_keyboard.push([{ text: "◀️ Oldingi", callback_data: `kadrlar_page_${page-1}` }]);
  if ((page+1)*limit < total) keyboard.inline_keyboard.push([{ text: "Keyingi ▶️", callback_data: `kadrlar_page_${page+1}` }]);
  if (keyboard.inline_keyboard.length && bot) {
    if (editMessageId) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML", reply_markup: keyboard });
    else await bot.sendMessage(chatId, message, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    if (editMessageId && bot) await bot.editMessageText(message, { chat_id: chatId, message_id: editMessageId, parse_mode: "HTML" });
    else await sendTelegramMessage(message, chatId);
  }
}

async function sendMachinesList(chatId) {
  const machines = await Machine.find();
  if (!machines.length) {
    await sendTelegramMessage("🖨️ Hech qanday mashina topilmadi.", chatId);
    return;
  }
  let message = "🖨️ <b>Mashinalar ro‘yxati</b>\n\n";
  machines.forEach((m, idx) => {
    message += `${idx+1}. <b>${escapeHtml(m.name)}</b> (${escapeHtml(m.model)})\n   🔢 Seriya: ${escapeHtml(m.serial)}\n\n`;
  });
  await sendTelegramMessage(message, chatId);
}

async function sendAccessoriesList(chatId) {
  const accessories = await Accessory.find();
  if (!accessories.length) {
    await sendTelegramMessage("🧵 Hech qanday aksessuar topilmadi.", chatId);
    return;
  }
  let message = "🧵 <b>Aksessuarlar ro‘yxati</b>\n\n";
  accessories.forEach((a, idx) => {
    message += `${idx+1}. <b>${escapeHtml(a.productName)}</b> (${escapeHtml(a.code || '—')})\n   🔢 Soni: ${a.quantity || 0} dona | ⚖️ Kg: ${a.kg || 0} | 📏 Metr: ${a.meters || 0}\n\n`;
  });
  await sendTelegramMessage(message, chatId);
}

async function searchAll(chatId, query) {
  const results = [];
  const products = await ProductManager.find({ productType: { $regex: query, $options: 'i' } }).limit(10);
  products.forEach(p => results.push(`📦 ${p.productType}: ${p.quantity} dona (${moment(p.createdAt).format("DD.MM")})`));
  const incoming = await IncomingProduct.find({ $or: [{ modelName: { $regex: query, $options: 'i' } }, { orderNumber: { $regex: query, $options: 'i' } }] }).limit(10);
  incoming.forEach(i => results.push(`📥 Kirim: ${i.modelName} (${i.variant}) – ${i.quantity} dona`));
  const expenses = await Expense.find({ $or: [{ modelName: { $regex: query, $options: 'i' } }, { orderNumber: { $regex: query, $options: 'i' } }] }).limit(10);
  expenses.forEach(e => results.push(`📤 Chiqim: ${e.modelName} – ${e.quantity} dona`));
  const staff = await Staff.find({ fullName: { $regex: query, $options: 'i' } }).limit(10);
  staff.forEach(s => results.push(`👥 Xodim: ${s.fullName} (${s.role})`));
  const machines = await Machine.find({ name: { $regex: query, $options: 'i' } }).limit(10);
  machines.forEach(m => results.push(`🖨️ Mashina: ${m.name} (${m.model})`));
  const accessories = await Accessory.find({ productName: { $regex: query, $options: 'i' } }).limit(10);
  accessories.forEach(a => results.push(`🧵 Aksessuar: ${a.productName}`));

  if (results.length === 0) {
    await sendTelegramMessage(`🔍 "${query}" bo‘yicha hech narsa topilmadi.`, chatId);
  } else {
    let msg = `🔍 <b>"${query}" bo‘yicha qidiruv natijalari:</b>\n\n`;
    results.slice(0, 20).forEach(r => msg += `• ${r}\n`);
    await sendTelegramMessage(msg, chatId);
  }
}

// -------------------- Har soatlik statistikani yuborish (cron) --------------------
async function sendHourlyStats() {
  try {
    const now = new Date();
    const todayStart = moment().startOf('day').toDate();
    const todayEnd = moment().endOf('day').toDate();
    const currentHour = now.getHours();
    const hourStart = moment().hour(currentHour).minute(0).second(0).toDate();
    const hourEnd = moment().hour(currentHour).minute(59).second(59).toDate();

    const allProducts = await ProductManager.find({ createdAt: { $gte: todayStart, $lte: todayEnd } });
    const totalToday = allProducts.filter(p => BAND_TYPES.includes(p.productType)).reduce((sum, p) => sum + p.quantity, 0);
    const totalOverall = await getTotalProduction();
    const hourProducts = await ProductManager.find({ createdAt: { $gte: hourStart, $lte: hourEnd } });
    const totalHour = hourProducts.reduce((sum, p) => sum + p.quantity, 0);

    const bandStats = {};
    allProducts.forEach(p => {
      if (p.productType.includes('band')) bandStats[p.productType] = (bandStats[p.productType] || 0) + p.quantity;
    });
    let topBand = '—', topQty = 0;
    for (const [band, qty] of Object.entries(bandStats)) if (qty > topQty) { topBand = band; topQty = qty; }

    const upakovkaToday = allProducts.filter(p => p.productType === 'Upakovka').reduce((s,p) => s + p.quantity, 0);
    const dazmolToday = allProducts.filter(p => p.productType === 'Dazmol').reduce((s,p) => s + p.quantity, 0);
    const totalIncoming = (await IncomingProduct.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const totalExpense = (await Expense.aggregate([{ $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const availableWork = totalIncoming - totalExpense;
    const expenseToday = (await Expense.aggregate([{ $match: { date: { $gte: todayStart, $lte: todayEnd } } }, { $group: { _id: null, total: { $sum: "$quantity" } } }]))[0]?.total || 0;
    const totalStaff = await Staff.countDocuments();
    const attendances = await Attendance.find({ date: moment().format("YYYY-MM-DD") });
    const presentCount = attendances.filter(a => a.checkIn).length;
    const absentCount = totalStaff - presentCount;
    const lateCount = attendances.filter(a => a.checkIn && a.lateMinutes > 0).length;
    const machinesCount = await Machine.countDocuments();

    const message = `
📊 <b>Soatlik hisobot – ${moment().format("HH:mm")}</b>
📅 Sana: ${moment().format("DD.MM.YYYY")}

🔹 <b>Ishlab chiqarish</b>
• 📅 <b>Kunlik tikuv</b> (bandlar): <code>${totalToday}</code> dona
• 📊 <b>Jami tikuv</b> (barcha bandlar): <code>${totalOverall}</code> dona
• ⏱️ Soatlik (${currentHour}:00 – ${currentHour}:59): ${totalHour} dona
• 🏆 Eng ko‘p tikkan band: ${topBand} (${topQty} dona)
• 🔥 Dazmol: ${dazmolToday} dona
• 📦 Upakovka: ${upakovkaToday} dona

📦 <b>Ombor holati</b>
• Mavjud ish: ${availableWork} dona
• Kunlik chiqim: ${expenseToday} dona

👥 <b>Davomat</b>
• Jami xodimlar: ${totalStaff}
• Kelganlar: ${presentCount}
• Kelmaganlar: ${absentCount}
• ⏰ Kech qolganlar: ${lateCount}

🖨️ Mashinalar soni: ${machinesCount}
    `;
    await sendTelegramMessage(message);
  } catch (err) {
    console.error('Hourly stats error:', err);
  }
}

// -------------------- Middleware --------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
hbs.registerPartials(path.join(__dirname, "views/partials"));
hbs.registerHelper("eq", (a, b) => a === b);

// -------------------- Helper: Clean old index --------------------
async function cleanupIndexes() {
  try {
    await mongoose.connection.db.collection('attendances').dropIndex('workerId_1_date_1');
    console.log('Eski indeks (workerId_1_date_1) o‘chirildi');
  } catch (err) {}
  try {
    await Attendance.createIndexes();
    console.log('Attendance indekslari tayyor');
  } catch (err) {
    console.error('Indeks yaratish xatosi:', err);
  }
}

// -------------------- API Endpoints --------------------
// (All endpoints remain the same as in the previous version – they are all present)
app.get("/api/productmanager", async (req, res) => {
  const items = await ProductManager.find().sort({ createdAt: -1 });
  res.json(items);
});
app.post("/api/productmanager", async (req, res) => {
  const item = new ProductManager(req.body);
  await item.save();
  await sendTelegramMessage(`Yangi mahsulot qo'shildi (Input sahifasi): ${item.productType}, miqdor: ${item.quantity}`);
  res.json(item);
});
app.put("/api/productmanager/:id", async (req, res) => {
  const item = await ProductManager.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(item);
});
app.delete("/api/productmanager/:id", async (req, res) => {
  await ProductManager.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/incoming", async (req, res) => {
  const products = await IncomingProduct.find().sort({ date: -1 });
  res.json(products);
});
app.post("/api/incoming", async (req, res) => {
  const product = new IncomingProduct(req.body);
  await product.save();
  await sendTelegramMessage(`Yangi kirim mahsuloti qo'shildi (Kesim xona sahifasi): ${product.modelName}, variant: ${product.variant}, miqdor: ${product.quantity}`);
  res.json(product);
});
app.put("/api/incoming/:id", async (req, res) => {
  const product = await IncomingProduct.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(product);
});
app.delete("/api/incoming/:id", async (req, res) => {
  await IncomingProduct.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/expenses", async (req, res) => {
  const expenses = await Expense.find().sort({ date: -1 });
  res.json(expenses);
});
app.post("/api/expenses", async (req, res) => {
  const expense = new Expense(req.body);
  await expense.save();
  await sendTelegramMessage(`Yangi chiqim qo'shildi (Chiqim sahifasi): ${expense.modelName}, variant: ${expense.variant}, miqdor: ${expense.quantity}`);
  res.json(expense);
});
app.put("/api/expenses/:id", async (req, res) => {
  const expense = await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(expense);
});
app.delete("/api/expenses/:id", async (req, res) => {
  await Expense.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/staff", async (req, res) => {
  const staff = await Staff.find();
  res.json(staff);
});
app.post("/api/staff", async (req, res) => {
  const member = new Staff(req.body);
  await member.save();
  await sendTelegramMessage(`Yangi xodim qo'shildi (Kadrlar sahifasi): ${member.fullName}, lavozim: ${member.role}`);
  res.json(member);
});
app.put("/api/staff/:id", async (req, res) => {
  const member = await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(member);
});
app.delete("/api/staff/:id", async (req, res) => {
  await Staff.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/attendance", async (req, res) => {
  const records = await Attendance.find().populate("employeeId").sort({ date: -1 });
  res.json(records);
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
      const workMs = new Date(record.checkOut) - new Date(record.checkIn);
      record.workDurationMinutes = Math.floor(workMs / 60000);
    }
    await record.save();
    return res.json(record);
  } else {
    const newRecord = new Attendance({ employeeId, date, checkIn, checkOut, lateMinutes, extraWorkMinutes });
    if (newRecord.checkIn && newRecord.checkOut) {
      const workMs = new Date(newRecord.checkOut) - new Date(newRecord.checkIn);
      newRecord.workDurationMinutes = Math.floor(workMs / 60000);
    }
    await newRecord.save();
    await sendTelegramMessage(`Yangi davomat yozuvi qo'shildi (Davomat sahifasi): Sana ${date}, xodim ID: ${employeeId}`);
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
    const workMs = new Date(record.checkOut) - new Date(record.checkIn);
    record.workDurationMinutes = Math.floor(workMs / 60000);
  }
  await record.save();
  res.json(record);
});

app.delete("/api/attendance/:id", async (req, res) => {
  await Attendance.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.post("/api/attendance/:id/extra-work", async (req, res) => {
  const { minutes } = req.body;
  const record = await Attendance.findById(req.params.id);
  if (!record) return res.status(404).json({ error: "Record not found" });
  record.extraWorkMinutes = (record.extraWorkMinutes || 0) + minutes;
  await record.save();
  res.json(record);
});

app.post("/api/attendance/extra-days/:employeeId", async (req, res) => {
  try {
    const { extraDays } = req.body;
    const employeeId = req.params.employeeId;
    const today = new Date().toISOString().slice(0, 10);
    let record = await Attendance.findOne({ employeeId, date: today });
    if (!record) {
      record = new Attendance({ employeeId, date: today, extraWorkDays: extraDays || 0 });
    } else {
      record.extraWorkDays = (record.extraWorkDays || 0) + (extraDays || 0);
    }
    await record.save();
    res.json(record);
  } catch (err) {
    console.error("Extra days error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/attendance/extra-hours/:employeeId", async (req, res) => {
  try {
    const { extraHours } = req.body;
    const employeeId = req.params.employeeId;
    const today = new Date().toISOString().slice(0, 10);
    let record = await Attendance.findOne({ employeeId, date: today });
    if (!record) {
      record = new Attendance({ employeeId, date: today, extraWorkHours: extraHours || 0 });
    } else {
      record.extraWorkHours = (record.extraWorkHours || 0) + (extraHours || 0);
    }
    await record.save();
    res.json(record);
  } catch (err) {
    console.error("Extra hours error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/machines", async (req, res) => {
  const machines = await Machine.find();
  res.json(machines);
});
app.post("/api/machines", async (req, res) => {
  const machine = new Machine(req.body);
  await machine.save();
  await sendTelegramMessage(`Yangi mashina qo'shildi (Mashinkalar sahifasi): ${machine.name}, model: ${machine.model}`);
  res.json(machine);
});
app.put("/api/machines/:id", async (req, res) => {
  const machine = await Machine.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(machine);
});
app.delete("/api/machines/:id", async (req, res) => {
  await Machine.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/accessories", async (req, res) => {
  const accessories = await Accessory.find();
  res.json(accessories);
});
app.post("/api/accessories", async (req, res) => {
  const accessory = new Accessory(req.body);
  await accessory.save();
  await sendTelegramMessage(`Yangi aksessuar qo'shildi (Aksessuarlar sahifasi): ${accessory.productName}, kod: ${accessory.code}, miqdor: ${accessory.quantity}`);
  res.json(accessory);
});
app.put("/api/accessories/:id", async (req, res) => {
  const accessory = await Accessory.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json(accessory);
});
app.delete("/api/accessories/:id", async (req, res) => {
  await Accessory.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get("/api/stats/today", async (req, res) => {
  try {
    const todayStart = moment().startOf("day").toDate();
    const todayEnd = moment().endOf("day").toDate();

    const productManagerToday = await ProductManager.aggregate([
      { $match: { createdAt: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: "$productType", total: { $sum: "$quantity" } } }
    ]);
    const todayTotals = {};
    productManagerToday.forEach(g => { todayTotals[g._id] = g.total; });

    const bandTotals = await ProductManager.aggregate([
      { $match: { productType: { $regex: /^[0-9]+-band$/ } } },
      { $group: { _id: "$productType", total: { $sum: "$quantity" } } }
    ]);
    const bandTotalsObj = {};
    bandTotals.forEach(b => { bandTotalsObj[b._id] = b.total; });

    let topBand = null, topQty = 0;
    for (const [band, qty] of Object.entries(bandTotalsObj)) {
      if (qty > topQty) { topBand = band; topQty = qty; }
    }

    const upakovkaTotal = (await ProductManager.aggregate([
      { $match: { productType: "Upakovka" } },
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;
    const dazmolTotal = (await ProductManager.aggregate([
      { $match: { productType: "Dazmol" } },
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;

    const totalIncoming = (await IncomingProduct.aggregate([
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;
    const totalExpense = (await Expense.aggregate([
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;
    const availableWork = totalIncoming - totalExpense;

    const expenseToday = (await Expense.aggregate([
      { $match: { date: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: null, total: { $sum: "$quantity" } } }
    ]))[0]?.total || 0;

    const accessoriesCount = await Accessory.countDocuments();
    const totalStaff = await Staff.countDocuments();
    const todayStr = moment().format("YYYY-MM-DD");
    const attendances = await Attendance.find({ date: todayStr }).populate("employeeId");
    const presentCount = attendances.filter(a => a.checkIn).length;
    const lateCount = attendances.filter(a => a.checkIn && a.lateMinutes > 0).length;
    const absentCount = totalStaff - presentCount;
    const machinesCount = await Machine.countDocuments();

    res.json({
      todayTotals,
      upakovkaTotal,
      dazmolTotal,
      topBand,
      topBandQty: topQty,
      availableWork,
      expenseToday,
      accessoriesCount,
      totalStaff,
      presentCount,
      absentCount,
      lateCount,
      machinesCount
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Cron: Har soatning boshida statistikani yuborish --------------------
cron.schedule("0 * * * *", () => {
  console.log(`⏰ Soatlik statistika yuborilmoqda – ${moment().format("HH:mm")}`);
  sendHourlyStats();
});

// -------------------- Avtomatik ketish (18:00) --------------------
cron.schedule("0 18 * * *", async () => {
  console.log("Avtomatik ketish ishga tushdi (18:00)");
  const today = moment().format("YYYY-MM-DD");
  const records = await Attendance.find({ date: today, checkOut: { $exists: false } });
  for (const record of records) {
    const now = new Date();
    record.checkOut = now;
    record.autoCheckedOut = true;
    if (record.checkIn) {
      const workMs = now - new Date(record.checkIn);
      record.workDurationMinutes = Math.floor(workMs / 60000);
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
    const newNote = { id: Date.now(), text: note.text || "", date: new Date().toLocaleString("uz-UZ") };
    notes.unshift(newNote);
    io.emit("note-added", newNote);
  });
  socket.on("voice-chunk", (audioData) => socket.broadcast.emit("audio-stream", audioData));
  socket.on("stop-voice", () => socket.broadcast.emit("audio-stopped"));
  socket.on("delete-note", (noteId) => {
    notes = notes.filter(n => n.id !== noteId);
    io.emit("note-deleted", noteId);
  });
  socket.on("clear-all", () => {
    notes = [];
    io.emit("all-cleared");
  });
  socket.on("disconnect", () => console.log("Client disconnected"));
});

// -------------------- Announcements --------------------
function sendAnnouncement(type, data = {}) {
  io.emit("announcement", { type, ...data });
}
cron.schedule("50 7 * * *", () => sendAnnouncement("warning", { message: "Ish boshlanishiga 10 daqiqa qoldi!" }));
cron.schedule("55 7 * * *", () => sendAnnouncement("warning", { message: "Ish boshlanishiga 5 daqiqa qoldi!" }));
cron.schedule("0 8 * * *", () => sendAnnouncement("warning", { message: "Ish boshlandi!" }));
cron.schedule("0 12 * * *", () => sendAnnouncement("metro", { duration: 1000 }));
cron.schedule("0 13 * * *", () => sendAnnouncement("metro", { duration: 1000 }));
cron.schedule("0 18 * * *", () => {
  let count = 0;
  const interval = setInterval(() => {
    sendAnnouncement("metro", { duration: 500 });
    if (++count >= 12) clearInterval(interval);
  }, 5000);
});

// -------------------- Google TTS Proxy --------------------
app.post("/api/tts-google", (req, res) => {
  const { text, lang = "uz" } = req.body;
  if (!text) return res.status(400).json({ error: "Text required" });
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
  require("https").get(url, options, (response) => {
    if (response.statusCode !== 200) return res.status(response.statusCode).json({ error: `TTS error ${response.statusCode}` });
    res.setHeader("Content-Type", "audio/mpeg");
    response.pipe(res);
  }).on("error", err => {
    console.error("TTS error:", err);
    res.status(500).json({ error: "TTS failed" });
  });
});

// -------------------- Serve Pages --------------------
app.get("/", (req, res) => res.render("input", { title: "Mahsulotlar", active: "home" }));
app.get("/grafik", (req, res) => res.render("grafik", { title: "Statistika", active: "graph" }));
app.get("/kesimXona", (req, res) => res.render("kesimXona", { title: "Kirim", active: "income" }));
app.get("/chiqim", (req, res) => res.render("chiqim", { title: "Chiqim", active: "expense" }));
app.get("/mikrafon", (req, res) => res.render("mikrafon", { title: "Mikrafon", active: "mic" }));
app.get("/mashinkalar", (req, res) => res.render("mashinkalar", { title: "Mashinkalar", active: "machines" }));
app.get("/kadrlar", (req, res) => res.render("kadrlar", { title: "Kadrlar", active: "staff" }));
app.get("/davomat", (req, res) => res.render("davomat", { title: "Davomat", active: "attendance" }));
app.get("/aksessuar", (req, res) => res.render("aksessuar", { title: "Aksessuarlar", active: "accessories" }));

// -------------------- Start Server --------------------
const PORT = process.env.PORT || 3900;

async function startServer() {
  const MONGO_URL = process.env.MONGO_URL;
  if (!MONGO_URL) {
    console.error("❌ MONGO_URL is not defined in environment variables.");
    process.exit(1);
  }
  const maskedUrl = MONGO_URL.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@');
  console.log(`Attempting to connect to MongoDB: ${maskedUrl}`);

  try {
    await mongoose.connect(MONGO_URL, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB connected successfully");
    await cleanupIndexes();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

startServer();

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}