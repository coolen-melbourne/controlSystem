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
const server = http.createServer(app);
const io = socketIo(server);

// -------------------- Helper --------------------
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(
    /[&<>]/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m],
  );
}

// -------------------- MIDDLEWARE (ENG AVVAL) --------------------
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  next();
});

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
hbs.registerPartials(path.join(__dirname, "views/partials"));
hbs.registerHelper("eq", (a, b) => a === b);

// -------------------- Models --------------------
const productManagerSchema = new mongoose.Schema({
  productType: { type: String, required: true },
  quantity: { type: Number, required: true },
  enteredBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const ProductManager = mongoose.model("ProductManager", productManagerSchema);

const incomingProductSchema = new mongoose.Schema({
  modelName: String,
  variant: String,
  orderNumber: String,
  quantity: Number,
  hasAccessory: Boolean,
  imageData: String,
  date: { type: Date, default: Date.now },
});
const IncomingProduct = mongoose.model(
  "IncomingProduct",
  incomingProductSchema,
);

const expenseSchema = new mongoose.Schema({
  band: String,
  modelName: String,
  variant: String,
  orderNumber: String,
  quantity: Number,
  date: { type: Date, default: Date.now },
});
const Expense = mongoose.model("Expense", expenseSchema);

const staffSchema = new mongoose.Schema({
  fullName: String,
  role: { type: String, enum: ["band", "upakovka", "dazmol", "general"] },
  bandNumber: String,
  phone: String,
  hireDate: Date,
  photo: String,
});
const Staff = mongoose.model("Staff", staffSchema);

const attendanceSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
    required: true,
  },
  date: { type: String, required: true },
  checkIn: Date,
  checkOut: Date,
  lateMinutes: { type: Number, default: 0 },
  extraWorkMinutes: { type: Number, default: 0 },
  extraWorkDays: { type: Number, default: 0 },
  extraWorkHours: { type: Number, default: 0 },
  workDurationMinutes: { type: Number, default: 0 },
  autoCheckedOut: { type: Boolean, default: false },
});
attendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });
const Attendance = mongoose.model("Attendance", attendanceSchema);

const machineSchema = new mongoose.Schema({
  name: String,
  model: String,
  serial: String,
  createdAt: { type: Date, default: Date.now },
});
const Machine = mongoose.model("Machine", machineSchema);

const accessorySchema = new mongoose.Schema({
  productName: String,
  code: String,
  quantity: Number,
  kg: Number,
  meters: Number,
  createdAt: { type: Date, default: Date.now },
});
const Accessory = mongoose.model("Accessory", accessorySchema);

const qrNameSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  band: String,
  modelName: String,
  variant: String,
  orderNumber: String,
  quantity: Number,
  date: { type: Date, default: Date.now },
  month: { type: String, default: () => new Date().toISOString().slice(0, 7) },
});
const QRName = mongoose.model("QRName", qrNameSchema);

// Kunlik plan modeli
const dailyPlanSchema = new mongoose.Schema({
  date: { type: String, required: true },
  enteredBy: { type: String, required: true },
  plans: [{ band: String, quantity: Number }],
  createdAt: { type: Date, default: Date.now },
});
dailyPlanSchema.index({ date: 1 }, { unique: true });
const DailyPlan = mongoose.model("DailyPlan", dailyPlanSchema);

// -------------------- Indexes --------------------
(async () => {
  try {
    await ProductManager.collection.createIndex({
      createdAt: 1,
      productType: 1,
    });
    await IncomingProduct.collection.createIndex({ date: 1 });
    await Expense.collection.createIndex({ date: 1 });
    await Machine.collection.createIndex({ createdAt: 1 });
    await Accessory.collection.createIndex({ createdAt: 1 });
    await QRName.collection.createIndex({ month: 1, fullName: 1 });
    await QRName.collection.createIndex({ date: -1 });
    console.log("Indexes created successfully");
  } catch (err) {
    console.error("Index creation error:", err);
  }
})();

// -------------------- Yordamchi funksiyalar --------------------
const BAND_TYPES = [
  "1-band",
  "2-band",
  "3-band",
  "4-band",
  "5-band",
  "6-band",
  "7-band",
  "8-band",
  "9-band",
  "10-band",
  "11-band",
  "12-band",
  "13-band",
  "14-band",
  "15-band",
  "16-band",
  "17-band",
  "18-band",
];

const statsCache = new Map();
async function getProductionStats(startDate, endDate, cacheKey = null) {
  if (cacheKey && statsCache.has(cacheKey)) {
    const cached = statsCache.get(cacheKey);
    if (Date.now() - cached.time < 60000) return cached.data;
  }
  const result = await ProductManager.aggregate([
    {
      $match: {
        productType: { $in: BAND_TYPES },
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ]);
  const data = result[0]?.total || 0;
  if (cacheKey) statsCache.set(cacheKey, { data, time: Date.now() });
  return data;
}

async function getTotalProduction(monthKey = null) {
  const monthStart = monthKey
    ? moment(monthKey + "-01")
        .startOf("month")
        .toDate()
    : moment().startOf("month").toDate();
  const monthEnd = monthKey
    ? moment(monthKey + "-01")
        .endOf("month")
        .toDate()
    : moment().endOf("month").toDate();
  return getProductionStats(
    monthStart,
    monthEnd,
    `monthly_${monthKey || moment().format("YYYY-MM")}`,
  );
}

async function getDailyProduction() {
  const todayStart = moment().startOf("day").toDate();
  const todayEnd = moment().endOf("day").toDate();
  return getProductionStats(
    todayStart,
    todayEnd,
    `daily_${moment().format("YYYY-MM-DD")}`,
  );
}

// -------------------- Telegram Helper --------------------
const sendTelegramMessage = async (message, chatId = null) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const defaultChatId = process.env.TELEGRAM_CHAT_ID;
  const targetChatId = chatId || defaultChatId;
  if (!token || !targetChatId || targetChatId === "your_chat_id_here") {
    console.warn(
      "⚠️ Telegram token yoki chat ID noto'g'ri. Xabar yuborilmadi.",
    );
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: targetChatId,
      text: message,
      parse_mode: "HTML",
    });
    console.log("✅ Telegram xabar yuborildi");
  } catch (err) {
    console.error("❌ Telegram yuborish xatosi:", err.message);
  }
};

async function getTTSBuffer(text, lang = "uz") {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (response.status !== 200) throw new Error("TTS service failed");
  return response.data;
}

async function buildAITextSummary(stats) {
  const {
    totalToday,
    totalOverall,
    topBand,
    topQty,
    upakovkaMonth,
    dazmolMonth,
    availableWork,
    expenseToday,
    accessoriesCount,
    zeroBands,
    belowPlanBands,
  } = stats;
  const openaiKey = process.env.OPENAI_API_KEY;
  const prompt = `Siz ombor va tikuv statistikasi bo'yicha eng aniq va amaliy xulosa yozadigan ekspert siz. ... (to'liq prompt) ... Faqat xulosa yozing.`;
  if (openaiKey) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content:
                "Siz tezkor statistik xulosachi va ombor nazoratchisisiz.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 300,
        },
        {
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
        },
      );
      return response.data?.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      console.error("OpenAI summary error:", err.message || err);
    }
  }
  const zeroText = zeroBands.length ? zeroBands.join(", ") : "yo`q";
  return `Bugungi ishlab chiqarishdagi eng muhim xulosalar: bandlar bo'yicha umumiy ish ${totalToday} dona, ammo ${belowPlanBands.length} ta band hali rejadan past va ${zeroBands.length} tasi to'liq nolga tushgan (${zeroText}). Upakovka ${upakovkaMonth} dona, Dazmol ${dazmolMonth} dona, ular 10000 lik rejaga nisbatan orqada. Ombordagi ish hajmi ${availableWork} dona, bugungi chiqim ${expenseToday} dona. Hozirda eng katta diqqatni faqat past ko'rsatkichli bandlar va tezroq qayta tiklashga qaratish kerak.`;
}

// -------------------- Telegram Bot (409 xatosi tuzatilgan) --------------------
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot;
if (botToken && botToken !== "your_bot_token_here") {
  if (!global.telegramBotStarted) {
    if (global.telegramBotInstance) {
      try {
        global.telegramBotInstance.stopPolling();
      } catch (e) {}
    }
    bot = new TelegramBot(botToken, { polling: true });
    global.telegramBotStarted = true;
    global.telegramBotInstance = bot;
    console.log("🤖 Telegram bot polling started");
  } else {
    bot = global.telegramBotInstance;
  }
}

const userState = new Map();

// Bot funksiyalari (deklaratsiyalar) - to‘liqligi uchun qisqartirilgan, asl server.js da mavjud
async function sendBandSelectionKeyboard(chatId) {
  /* ... */
}
async function buildStatsData() {
  /* ... */
}
async function sendFullStatsToChat(chatId) {
  /* ... */
}
async function sendAISummaryOnly(chatId) {
  /* ... */
}
async function sendDailyTotalStats(chatId) {
  /* ... */
}
async function sendPaginatedList(
  chatId,
  page,
  collection,
  titleTemplate,
  formatItem,
  callbackPrefix,
  editMessageId = null,
) {
  /* ... */
}
async function sendIncomingList(chatId, page = 0, editMessageId = null) {
  /* ... */
}
async function sendExpenseList(chatId, page = 0, editMessageId = null) {
  /* ... */
}
async function sendStaffList(chatId, page = 0, editMessageId = null) {
  /* ... */
}
async function sendMachinesList(chatId) {
  /* ... */
}
async function sendAccessoriesList(chatId) {
  /* ... */
}
async function searchAll(chatId, query) {
  /* ... */
}

// Bot command handlers (faqat bot mavjud bo'lsa)
if (bot) {
  const mainMenuKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Statistika", callback_data: "stats" },
          { text: "🤖 AI xulosasi", callback_data: "ai_summary" },
        ],
        [
          { text: "📈 Kunlik / Jami", callback_data: "daily_total" },
          { text: "📥 Kroy kirim", callback_data: "kroy" },
        ],
        [
          { text: "📤 Kroy chiqim", callback_data: "chiqim" },
          { text: "👥 Kadrlar", callback_data: "kadrlar" },
        ],
        [
          { text: "🖨️ Mashinalar", callback_data: "mashinalar" },
          { text: "🧵 Aksessuarlar", callback_data: "aksessuar" },
        ],
        [
          { text: "➕ Bandga qiymat", callback_data: "add_band" },
          { text: "🔍 Qidirish", switch_inline_query_current_chat: "" },
        ],
      ],
    },
  };
  bot.onText(/\/start/, (msg) => {
    /* ... */
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
  bot.on("message", async (msg) => {
    /* ... */
  });
  bot.on("callback_query", async (callbackQuery) => {
    /* ... */
  });
}

// -------------------- ✅ TO‘G‘RILANGAN KUNLIK PLAN API (BIR GET, BIR POST) --------------------
// GET /api/daily-plans?date=YYYY-MM-DD  -> bitta plan
// GET /api/daily-plans                  -> barcha planlar
app.get("/api/daily-plans", async (req, res) => {
  try {
    if (req.query.date) {
      const plan = await DailyPlan.findOne({ date: req.query.date });
      return res.json(plan || { date: req.query.date, plans: [] });
    }
    const allPlans = await DailyPlan.find().sort({ date: -1 }).limit(100);
    res.json(allPlans);
  } catch (err) {
    console.error("Daily plan GET error:", err);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// POST /api/daily-plans – yangi plan saqlash
app.post("/api/daily-plans", async (req, res) => {
  try {
    const { date, enteredBy, plans } = req.body;
    if (!date || !enteredBy || !Array.isArray(plans)) {
      return res
        .status(400)
        .json({ error: "To'liq ma'lumot yuboring (date, enteredBy, plans)" });
    }
    const updated = await DailyPlan.findOneAndUpdate(
      { date },
      { date, enteredBy, plans, createdAt: new Date() },
      { upsert: true, new: true },
    );
    const bandSummary = plans
      .filter((p) => p.quantity > 0)
      .map((p) => `${p.band}:${p.quantity}`)
      .join(", ");
    await sendTelegramMessage(
      `📅 Kunlik plan saqlandi (${date})\n👤 ${escapeHtml(enteredBy)}\n📊 ${bandSummary || "hech qanday plan kiritilmagan"}`,
    );
    res.json(updated);
  } catch (err) {
    console.error("Daily plan POST error:", err);
    res.status(500).json({ error: "Saqlashda xatolik: " + err.message });
  }
});

// Range endpoint (tarix oralig‘i uchun)
app.get("/api/daily-plans/range", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end)
      return res.status(400).json({ error: "start va end kerak (YYYY-MM-DD)" });
    const plans = await DailyPlan.find({
      date: { $gte: start, $lte: end },
    }).sort({ date: 1 });
    res.json(plans);
  } catch (err) {
    console.error("Daily plan range error:", err);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// Oylik plan bajarilishi statistikasi
app.get("/api/plan-summary", async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: "month kerak (YYYY-MM)" });
    const [year, monthNum] = month.split("-");
    const startDate = new Date(year, monthNum - 1, 1);
    const endDate = new Date(year, monthNum, 0);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const dailyPlans = await DailyPlan.find({
      date: { $gte: startStr, $lte: endStr },
    }).lean();
    const products = await ProductManager.find({
      createdAt: { $gte: startDate, $lte: endDate },
    }).lean();
    const actualByDate = new Map();
    for (const p of products) {
      const date = new Date(p.createdAt).toISOString().slice(0, 10);
      const band = p.productType;
      if (!band.includes("band")) continue;
      const key = `${date}|${band}`;
      actualByDate.set(key, (actualByDate.get(key) || 0) + (p.quantity || 0));
    }
    const planMapByDate = new Map();
    for (const dp of dailyPlans) {
      const bandPlan = new Map();
      for (const plan of dp.plans) bandPlan.set(plan.band, plan.quantity);
      planMapByDate.set(dp.date, bandPlan);
    }
    const BAND_TYPES_ARRAY = [...Array(18)].map((_, i) => `${i + 1}-band`);
    const bandSummary = {};
    for (const band of BAND_TYPES_ARRAY) {
      bandSummary[band] = {
        totalDays: 0,
        fullfilled: 0,
        high: 0,
        medium: 0,
        low: 0,
        zero: 0,
        totalActual: 0,
        totalPlan: 0,
      };
    }
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      const dateStr = d.toISOString().slice(0, 10);
      const bandPlan = planMapByDate.get(dateStr);
      if (!bandPlan) continue;
      for (const band of BAND_TYPES_ARRAY) {
        const planQty = bandPlan.get(band) || 1000;
        const actualQty = actualByDate.get(`${dateStr}|${band}`) || 0;
        const ratio = actualQty / planQty;
        bandSummary[band].totalDays++;
        bandSummary[band].totalActual += actualQty;
        bandSummary[band].totalPlan += planQty;
        if (ratio >= 1) bandSummary[band].fullfilled++;
        else if (ratio >= 0.8) bandSummary[band].high++;
        else if (ratio >= 0.5) bandSummary[band].medium++;
        else if (ratio > 0) bandSummary[band].low++;
        else bandSummary[band].zero++;
      }
    }
    res.json(bandSummary);
  } catch (err) {
    console.error("Plan summary error:", err);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// -------------------- Boshqa API Endpoints (qisqartirilgan, asl holida ishlaydi) --------------------
app.get("/api/productmanager", async (req, res) => {
  const items = await ProductManager.find().sort({ createdAt: -1 });
  res.json(items);
});
app.post("/api/productmanager", async (req, res) => {
  try {
    const item = new ProductManager(req.body);
    await item.save();
    statsCache.clear();
    sendTelegramMessage(
      `✅ Yangi mahsulot qo'shildi:\n📦 Turi: <b>${escapeHtml(item.productType)}</b>\n🔢 Miqdori: <b>${item.quantity}</b> dona\n👤 Kiritgan: <b>${escapeHtml(item.enteredBy)}</b>\n📅 Vaqt: ${moment(item.createdAt).format("DD.MM.YYYY HH:mm")}`,
    ).catch((err) => console.warn("TG xato:", err.message));
    res.json(item);
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ error: "Saqlashda xatolik" });
  }
});
app.put("/api/productmanager/:id", async (req, res) => {
  const item = await ProductManager.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (item) {
    statsCache.clear();
    sendTelegramMessage(
      `✏️ Mahsulot tahrirlandi:\n📦 Turi: <b>${escapeHtml(item.productType)}</b>\n🔢 Miqdori: <b>${item.quantity}</b> dona\n👤 Kiritgan: <b>${escapeHtml(item.enteredBy)}</b>\n📅 Vaqt: ${moment(item.createdAt).format("DD.MM.YYYY HH:mm")}`,
    ).catch((err) => console.warn("TG xato:", err.message));
  }
  res.json(item);
});
app.delete("/api/productmanager/:id", async (req, res) => {
  await ProductManager.findByIdAndDelete(req.params.id);
  statsCache.clear();
  res.json({ success: true });
});
app.get("/api/incoming", async (req, res) => {
  res.json(await IncomingProduct.find().sort({ date: -1 }));
});
app.post("/api/incoming", async (req, res) => {
  const product = new IncomingProduct(req.body);
  await product.save();
  await sendTelegramMessage(
    `📥 Yangi kirim: <b>${escapeHtml(product.modelName)}</b>, variant: ${escapeHtml(product.variant || "—")}, miqdor: ${product.quantity}`,
  );
  res.json(product);
});
app.put("/api/incoming/:id", async (req, res) => {
  res.json(
    await IncomingProduct.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    }),
  );
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
  await sendTelegramMessage(
    `📤 Yangi chiqim: <b>${escapeHtml(expense.modelName)}</b>, variant: ${escapeHtml(expense.variant || "—")}, miqdor: ${expense.quantity}`,
  );
  res.json(expense);
});
app.put("/api/expenses/:id", async (req, res) => {
  res.json(
    await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true }),
  );
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
  await sendTelegramMessage(
    `👤 Yangi xodim: <b>${escapeHtml(member.fullName)}</b>, lavozim: ${member.role}`,
  );
  res.json(member);
});
app.put("/api/staff/:id", async (req, res) => {
  res.json(
    await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true }),
  );
});
app.delete("/api/staff/:id", async (req, res) => {
  await Staff.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});
app.get("/api/attendance", async (req, res) => {
  res.json(await Attendance.find().populate("employeeId").sort({ date: -1 }));
});
app.post("/api/attendance", async (req, res) => {
  /* ... to'liq asl nusxada ... */
});
app.put("/api/attendance/:id", async (req, res) => {
  /* ... */
});
app.delete("/api/attendance/:id", async (req, res) => {
  /* ... */
});
app.post("/api/attendance/:id/extra-work", async (req, res) => {
  /* ... */
});
app.post("/api/attendance/extra-days/:employeeId", async (req, res) => {
  /* ... */
});
app.post("/api/attendance/extra-hours/:employeeId", async (req, res) => {
  /* ... */
});
app.get("/api/machines", async (req, res) => {
  res.json(await Machine.find());
});
app.post("/api/machines", async (req, res) => {
  const machine = new Machine(req.body);
  await machine.save();
  await sendTelegramMessage(
    `🖨️ Yangi mashina: <b>${escapeHtml(machine.name)}</b>, model: ${escapeHtml(machine.model)}`,
  );
  res.json(machine);
});
app.put("/api/machines/:id", async (req, res) => {
  res.json(
    await Machine.findByIdAndUpdate(req.params.id, req.body, { new: true }),
  );
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
  await sendTelegramMessage(
    `🧵 Yangi aksessuar: <b>${escapeHtml(accessory.productName)}</b>, kod: ${escapeHtml(accessory.code || "—")}, miqdor: ${accessory.quantity}`,
  );
  res.json(accessory);
});
app.put("/api/accessories/:id", async (req, res) => {
  res.json(
    await Accessory.findByIdAndUpdate(req.params.id, req.body, { new: true }),
  );
});
app.delete("/api/accessories/:id", async (req, res) => {
  await Accessory.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});
app.get("/api/qr-names", async (req, res) => {
  const { month } = req.query;
  const query = month ? { month } : {};
  res.json(await QRName.find(query).sort({ date: -1 }));
});
app.post("/api/qr-names", async (req, res) => {
  try {
    const record = new QRName(req.body);
    await record.save();
    await sendTelegramMessage(
      `✅ QR Nom: <b>${escapeHtml(record.fullName)}</b> – ${escapeHtml(record.modelName)} (${record.quantity} dona)`,
    );
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Saqlashda xatolik" });
  }
});
app.put("/api/qr-names/:id", async (req, res) => {
  const record = await QRName.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  res.json(record);
});
app.delete("/api/qr-names/:id", async (req, res) => {
  await QRName.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});
app.get("/api/qr-names/export/excel", async (req, res) => {
  /* ... to‘liq asl nusxada ... */
});
app.get("/api/stats/today", async (req, res) => {
  /* ... to‘liq asl nusxada ... */
});
app.get("/api/ai-summary", async (req, res) => {
  /* ... to‘liq asl nusxada ... */
});

// -------------------- Cron Jobs --------------------
async function sendHourlyStats() {
  /* ... to‘liq asl nusxada ... */
}
cron.schedule("0 * * * *", () => {
  sendHourlyStats();
});
cron.schedule("0 18 * * *", async () => {
  /* auto-checkout */
});

// -------------------- Socket.IO --------------------
const MAX_NOTES = 500;
let notes = [];
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("initial-notes", notes);
  socket.on("new-note", (note) => {
    const newNote = {
      id: Date.now(),
      text: note.text || "",
      date: new Date().toLocaleString("uz-UZ"),
    };
    notes.unshift(newNote);
    if (notes.length > MAX_NOTES) notes.pop();
    io.emit("note-added", newNote);
  });
  socket.on("voice-chunk", (audioData) =>
    socket.broadcast.emit("audio-stream", audioData),
  );
  socket.on("stop-voice", () => socket.broadcast.emit("audio-stopped"));
  socket.on("delete-note", (noteId) => {
    notes = notes.filter((n) => n.id !== noteId);
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
cron.schedule("50 7 * * *", () =>
  sendAnnouncement("warning", {
    message: "Ish boshlanishiga 10 daqiqa qoldi!",
  }),
);
cron.schedule("55 7 * * *", () =>
  sendAnnouncement("warning", { message: "Ish boshlanishiga 5 daqiqa qoldi!" }),
);
cron.schedule("0 8 * * *", () =>
  sendAnnouncement("warning", { message: "Ish boshlandi!" }),
);
cron.schedule("0 12 * * *", () =>
  sendAnnouncement("metro", { duration: 1000 }),
);
cron.schedule("0 13 * * *", () =>
  sendAnnouncement("metro", { duration: 1000 }),
);
cron.schedule("0 18 * * *", () => {
  let count = 0;
  const interval = setInterval(() => {
    sendAnnouncement("metro", { duration: 500 });
    if (++count >= 12) clearInterval(interval);
  }, 5000);
});

// -------------------- Google TTS --------------------
app.post("/api/tts-google", (req, res) => {
  const { text, lang = "uz" } = req.body;
  if (!text) return res.status(400).json({ error: "Text required" });
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
  require("https")
    .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (response) => {
      if (response.statusCode !== 200)
        return res
          .status(response.statusCode)
          .json({ error: `TTS error ${response.statusCode}` });
      res.setHeader("Content-Type", "audio/mpeg");
      response.pipe(res);
    })
    .on("error", (err) => {
      console.error("TTS error:", err);
      res.status(500).json({ error: "TTS failed" });
    });
});

// -------------------- Pages --------------------
app.get("/", (req, res) =>
  res.render("input", { title: "Mahsulotlar", active: "home" }),
);
app.get("/grafik", (req, res) =>
  res.render("grafik", { title: "Statistika", active: "graph" }),
);
app.get("/kesimXona", (req, res) =>
  res.render("kesimXona", { title: "Kirim", active: "income" }),
);
app.get("/chiqim", (req, res) =>
  res.render("chiqim", { title: "Chiqim", active: "expense" }),
);
app.get("/qrNames", (req, res) =>
  res.render("qrNames", { title: "QR Nomlar", active: "qrnames" }),
);
app.get("/mikrafon", (req, res) =>
  res.render("mikrafon", { title: "Mikrafon", active: "mic" }),
);
app.get("/mashinkalar", (req, res) =>
  res.render("mashinkalar", { title: "Mashinkalar", active: "machines" }),
);
app.get("/kadrlar", (req, res) =>
  res.render("kadrlar", { title: "Kadrlar", active: "staff" }),
);
app.get("/davomat", (req, res) =>
  res.render("davomat", { title: "Davomat", active: "attendance" }),
);
app.get("/aksessuar", (req, res) =>
  res.render("aksessuar", { title: "Aksessuarlar", active: "accessories" }),
);

// -------------------- Start --------------------
const PORT = process.env.PORT || 3900;
async function startServer() {
  const MONGO_URL = process.env.MONGO_URL;
  if (!MONGO_URL) {
    console.error("❌ MONGO_URL aniqlanmagan.");
    process.exit(1);
  }
  console.log(`MongoDB ga ulanilmoqda...`);
  try {
    await mongoose.connect(MONGO_URL, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB ulandi");
    try {
      await mongoose.connection.db
        .collection("attendances")
        .dropIndex("workerId_1_date_1");
    } catch (e) {}
    server.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 Server port ${PORT} da ishlamoqda`),
    );
  } catch (err) {
    console.error("❌ MongoDB xatosi:", err.message);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  if (global.telegramBotInstance) {
    await global.telegramBotInstance.stopPolling();
    console.log("Telegram bot polling to‘xtatildi");
  }
  process.exit(0);
});

startServer();
