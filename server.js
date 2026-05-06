const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || "little-ones-secret-2024";

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
};

app.post("/api/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Please enter email and password" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name",
      [email.toLowerCase().trim(), hash, name || "Parent"]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user });
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Email already registered" });
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Please enter email and password" });
  try {
    const r = await db.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

function getZodiacSign(birthday) {
  if (!birthday) return null;
  const d = new Date(birthday);
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();

  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return "Aries (白羊座)";
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return "Taurus (金牛座)";
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return "Gemini (双子座)";
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return "Cancer (巨蟹座)";
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return "Leo (狮子座)";
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return "Virgo (处女座)";
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return "Libra (天秤座)";
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return "Scorpio (天蝎座)";
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return "Sagittarius (射手座)";
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return "Capricorn (摩羯座)";
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return "Aquarius (水瓶座)";
  if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return "Pisces (双鱼座)";
  return null;
}

const ZODIAC_TRAITS = {
  "Aries (白羊座)": "bold, energetic, and adventurous",
  "Taurus (金牛座)": "patient, reliable, and loves comfort",
  "Gemini (双子座)": "curious, playful, and full of ideas",
  "Cancer (巨蟹座)": "caring, sensitive, and loves home",
  "Leo (狮子座)": "confident, warm-hearted, and loves attention",
  "Virgo (处女座)": "thoughtful, detail-oriented, and helpful",
  "Libra (天秤座)": "friendly, fair-minded, and loves harmony",
  "Scorpio (天蝎座)": "passionate, intuitive, and deeply feeling",
  "Sagittarius (射手座)": "cheerful, curious, and loves adventure",
  "Capricorn (摩羯座)": "responsible, determined, and mature for your age",
  "Aquarius (水瓶座)": "imaginative, independent, and full of original ideas",
  "Pisces (双鱼座)": "imaginative, intuitive, and dreamy",
};

app.get("/api/kids", auth, async (req, res) => {
  const r = await db.query("SELECT * FROM kids WHERE user_id = $1 ORDER BY created_at", [req.user.id]);
  const today = new Date();
  const kids = r.rows.map(kid => {
    const createdAt = new Date(kid.created_at);
    const companion_days = Math.floor((today - createdAt) / 86400000);
          const ageDisplay = (() => {
        if (kid.age_mode !== "natural" || !kid.birthday) return kid.age + "岁";
        const born = new Date(kid.birthday);
        const days = Math.floor((today - born) / 86400000);
        if (days < 30) return days + "天";
        if (days === 100) return "百日🎉";
        const months = Math.floor(days / 30);
        if (months < 12) return months + "个月";
        const years = Math.floor(days / 365);
        return years + "岁";
      })();
          const milestone = (() => {
        if (!kid.birthday) return null;
        const born = new Date(kid.birthday);
        const todayMs = today.getTime();
        const days = Math.floor((todayMs - born) / 86400000);
        if (kid.age_mode === "natural") {
          if (days < 30) { const d = 30 - days; return d === 0 ? "🎊 今天满月！" : `🎊 还有${d}天满月`; }
          if (days < 100) { const d = 100 - days; return d === 0 ? "🎉 今天百日！" : `🎉 还有${d}天百日`; }
          if (days < 365) { const d = 365 - days; return d === 0 ? "🎂 今天周岁！" : `🎂 还有${d}天周岁`; }
        }
        const thisYearBirthday = new Date(today.getFullYear(), born.getMonth(), born.getDate());
        if (thisYearBirthday < today) thisYearBirthday.setFullYear(today.getFullYear() + 1);
        const daysToB = Math.floor((thisYearBirthday - today) / 86400000);
        if (daysToB === 0) return kid.age_mode === "natural" ? `🎂 今天是${Math.floor(days/365)}岁生日！` : "🎂 今天是宝宝生日！";
        if (daysToB <= 10) return kid.age_mode === "natural" ? `🎂 还有${daysToB}天${Math.floor(days/365)+1}岁生日` : `🎂 还有${daysToB}天宝宝生日`;
        return null;
      })();
    const born = new Date(kid.birthday);
const birthdayThisYear = new Date(today.getFullYear(), born.getMonth(), born.getDate());
const isBirthday = kid.birthday && Math.floor((today - birthdayThisYear) / 86400000) === 0 && kid.age >= 1;

return {
  ...kid,
  age_display: ageDisplay,
  milestone: milestone,
  zodiac: getZodiacSign(kid.birthday),
  companion_days,
  bond_score: kid.bond_score || 0,
  streak_days: kid.streak_days || 0,
  is_birthday: isBirthday,
};

  });
  res.json(kids);
});


app.post("/api/kids", auth, async (req, res) => {
  const { name, gender, age, parent_role, birthday, personality, avatar, age_mode } = req.body;
  if (!name) return res.status(400).json({ error: "Please fill in child name" });
  const count = await db.query("SELECT COUNT(*) FROM kids WHERE user_id = $1", [req.user.id]);
  if (parseInt(count.rows[0].count) >= 1) return res.status(400).json({ error: "每位用户默认只能创建1个孩子" });

  let finalAge = age ? parseInt(age) : 0;
  if (birthday) {
    const born = new Date(birthday);
    const today = new Date();
    finalAge = today.getFullYear() - born.getFullYear();
    const m = today.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < born.getDate())) finalAge--;
  }

  const r = await db.query(
  "INSERT INTO kids (user_id, name, gender, age, parent_role, birthday, personality, avatar, age_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
  [req.user.id, name.trim(), gender || "boy", finalAge, parent_role || "mom", birthday || null, personality || "lively", avatar || null, age_mode || "fixed"]
);
const newKid = r.rows[0];
const ageInDays = birthday ? Math.floor((Date.now() - new Date(birthday)) / 86400000) : (finalAge * 365);

const ageRange = finalAge < 1 ? '0-1' : finalAge <= 3 ? '1-3' : finalAge <= 6 ? '3-6' : '6+';
const firstMsg = ageRange === '0-1' ? `*握住你的手指，不肯松*` :
  `${parent_role || '妈妈'}，你还在吗？`;

await db.query("INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2)", [newKid.id, firstMsg]);
res.json(newKid);
});

app.patch("/api/kids/:id/settings", auth, async (req, res) => {
  const { birthday, personality, personality_custom, age_mode, avatar } = req.body;

  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  const kid = kidResult.rows[0];
  if (!kid) return res.status(404).json({ error: "孩子不存在" });

 // 生日设置（锁定后不可更改）
if (birthday && !kid.birthday_locked) {
  const born = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - born.getFullYear();
  const m = today.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < born.getDate())) age--;
  await db.query("UPDATE kids SET birthday=$1, age=$2, birthday_locked=true WHERE id=$3", [birthday, age, kid.id]);
  // 如果年龄从0变成1岁以上，清除聊天历史避免感应卡风格污染
  if (kid.age < 1 && age >= 1) {
    await db.query("DELETE FROM messages WHERE kid_id=$1", [kid.id]);
  }
}


  // 性格设置
  if (personality) {
    await db.query("UPDATE kids SET personality=$1, personality_custom=$2 WHERE id=$3", [personality, personality_custom || null, kid.id]);
  }
if (avatar !== undefined) {
  await db.query("UPDATE kids SET avatar=$1 WHERE id=$2", [avatar, kid.id]);
}


  // 成长模式切换（只允许一次，付费功能）
  if (age_mode && age_mode !== kid.age_mode) {
    if (kid.age_mode_locked) return res.status(400).json({ error: "成长模式只能切换一次" });
    await db.query("UPDATE kids SET age_mode=$1, age_mode_locked=true WHERE id=$2", [age_mode, kid.id]);
  }

  const updated = await db.query("SELECT * FROM kids WHERE id=$1", [kid.id]);
  res.json(updated.rows[0]);
});

const ACTIVITY_MILESTONES = {
  blocks:      { count: 10, name: "🧩 积木小达人" },
  puzzle:      { count: 10, name: "🧩 拼图小能手" },
  hideseek:    { count: 10, name: "🙈 捉迷藏冠军" },
  drawing:     { count: 10, name: "🎨 小小画家" },
  nursery:     { count: 10, name: "🎵 儿歌小达人" },
  picturebook: { count: 10, name: "📚 绘本小书虫" },
  park:        { count: 10, name: "🌿 自然小探索家" },
  football:    { count: 10, name: "⚽ 足球小健将" },
  painting:    { count: 10, name: "🎨 小小画家" },
  concert:     { count: 10, name: "🎹 音乐小达人" },
  dance:       { count: 10, name: "💃 舞蹈小明星" },
  library:     { count: 10, name: "📚 阅读小达人" },
  museum:      { count: 10, name: "🏛️ 小小探索家" },
  cycling:     { count: 10, name: "🚴 骑行小健将" },
  swimming:    { count: 10, name: "🏊 游泳小健将" },
  basketball:  { count: 10, name: "🏀 篮球小健将" },
  travel:      { count: 5,  name: "✈️ 旅行小达人" },
  science:     { count: 10, name: "🔬 科技小天才" },
  bookstore:   { count: 10, name: "📖 阅读小达人" },
  artexhibit:  { count: 10, name: "🖼️ 艺术小鉴赏家" },
  theater:     { count: 10, name: "🎭 表演小达人" },
  baking:      { count: 10, name: "🍰 烘焙小厨师" },
};



app.get("/api/kids/:id/activities", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "Child not found" });

  const activitiesResult = await db.query(
    "SELECT activity_type, COUNT(*) as count FROM activities WHERE kid_id=$1 GROUP BY activity_type",
    [req.params.id]
  );

  const achievementsResult = await db.query(
    "SELECT * FROM achievements WHERE kid_id=$1 ORDER BY id DESC",
    [req.params.id]
  );

  res.json({
    activities: activitiesResult.rows,
    achievements: achievementsResult.rows,
  });
});

app.post("/api/kids/:id/activities", auth, async (req, res) => {
  const { activity_type } = req.body;
  if (!activity_type || !ACTIVITY_MILESTONES[activity_type]) {
    return res.status(400).json({ error: "Invalid activity type" });
  }

  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "Child not found" });

  await db.query(
    "INSERT INTO activities (kid_id, activity_type) VALUES ($1, $2)",
    [req.params.id, activity_type]
  );

  const countResult = await db.query(
    "SELECT COUNT(*) FROM activities WHERE kid_id=$1 AND activity_type=$2",
    [req.params.id, activity_type]
  );
  const count = parseInt(countResult.rows[0].count);

  const milestone = ACTIVITY_MILESTONES[activity_type];
  let newAchievement = null;

  if (count === milestone.count) {
    const achievementResult = await db.query(
      "INSERT INTO achievements (kid_id, achievement_name, activity_type) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, milestone.name, activity_type]
    );
    newAchievement = achievementResult.rows[0];
  }

  const remaining = count < milestone.count ? milestone.count - count : 0;

  res.json({ count, newAchievement, remaining });
});
app.post("/api/kids/:id/activity-check", auth, async (req, res) => {
  const { message, reply, age } = req.body;
  if (!message || !reply || age < 1) return res.json({ activitySuggestion: null });
  
  const ACTIVITY_OPTIONS = {
  '1-3': ['blocks(搭积木)', 'puzzle(拼图)', 'hideseek(捉迷藏)', 'drawing(画画)', 'nursery(唱儿歌)', 'picturebook(读绘本)', 'park(去公园)'],
  '3-6': ['football(踢足球)', 'painting(画画)', 'concert(听音乐会)', 'dance(跳舞)', 'library(去图书馆)', 'museum(去博物馆)', 'cycling(骑自行车)'],
  '6+':  ['football(踢足球)', 'swimming(游泳)', 'basketball(打篮球)', 'travel(去旅行)', 'science(做科学实验)', 'bookstore(去书店)', 'artexhibit(看展览)', 'theater(看表演)', 'baking(做烘焙)', 'concert(听音乐会)'],
};

  const ageKey = age < 3 ? '1-3' : age < 6 ? '3-6' : '6+';
  const options = ACTIVITY_OPTIONS[ageKey] || [];
  
  try {
    const activityCheck = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 50,
      system: `你是一个判断助手。判断对话中孩子和用户是否在就某个活动进行互动或共同讨论（比如一起计划、相互邀请、讨论要一起做某事）。如果只是孩子单方面表达喜好、随口提及、或是将来计划，回答"none"。只有双方都涉及某个活动话题时才触发。可选活动：${options.join(', ')}。只输出活动代码或none，不要其他内容。`,
      messages: [{ role: "user", content: `孩子说：${reply}\n用户说：${message}` }]
    });
    const suggestion = activityCheck.content[0].text.trim().toLowerCase();
    const activitySuggestion = (suggestion !== 'none' && options.some(o => o.startsWith(suggestion))) ? suggestion : null;
    res.json({ activitySuggestion });
  } catch(e) {
    res.json({ activitySuggestion: null });
  }
});
app.post("/api/kids/:id/messages/save", auth, async (req, res) => {
  const { role, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty content" });
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  await db.query("INSERT INTO messages (kid_id, role, content) VALUES ($1,$2,$3)", [req.params.id, role, content.trim()]);
  res.json({ ok: true });
});
app.post("/api/kids/:id/gifts-received", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "Child not found" });
  await db.query("UPDATE kids SET gifts_received = COALESCE(gifts_received, 0) + 1 WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/kids/:id", auth, async (req, res) => {
  await db.query("DELETE FROM kids WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get("/api/kids/:id/messages", auth, async (req, res) => {
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  const msgs = await db.query(
    "SELECT * FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 100",
    [req.params.id]
  );
  res.json(msgs.rows.reverse());
});

function calcAge(birthday) {
  const born = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - born.getFullYear();
  if (today.getMonth() < born.getMonth() || (today.getMonth() === born.getMonth() && today.getDate() < born.getDate())) {
    age--;
  }
  return age;
}

app.post("/api/kids/:id/chat", auth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message cannot be empty" });

  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  const kid = kidResult.rows[0];
  if (!kid) return res.status(404).json({ error: "Child not found" });

  if (kid.birthday) {
    const currentAge = calcAge(kid.birthday);
    if (currentAge !== kid.age) {
      await db.query("UPDATE kids SET age = $1 WHERE id = $2", [currentAge, kid.id]);
      kid.age = currentAge;
    }
  }

  // Check if the child has been missing the parent (last chat > 1 day ago)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const isMissing = kid.last_chat_at && new Date(kid.last_chat_at) < oneDayAgo;

  const histResult = await db.query(
    "SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20",
    [kid.id]
  );
  const history = histResult.rows.reverse();
  const msgCountResult = await db.query("SELECT COUNT(*) FROM messages WHERE kid_id=$1 AND role='assistant'", [kid.id]);
const msgCount = parseInt(msgCountResult.rows[0].count) || 0;


  await db.query("INSERT INTO messages (kid_id, role, content) VALUES ($1,'user',$2)", [kid.id, message.trim()]);

  // Update last_chat_at to now
  await db.query("UPDATE kids SET last_chat_at = NOW() WHERE id = $1", [kid.id]);

  // Clear pending_gift after reading it for this chat turn
  const pendingGiftRaw = kid.pending_gift;
  let pendingGiftLevel = null;
  let pendingGiftName = null;
  if (pendingGiftRaw) {
    const colonIdx = pendingGiftRaw.indexOf(":");
    if (colonIdx !== -1) {
      pendingGiftLevel = pendingGiftRaw.slice(0, colonIdx);
      pendingGiftName = pendingGiftRaw.slice(colonIdx + 1);
    } else {
      // Legacy format without level prefix
      pendingGiftLevel = "free";
      pendingGiftName = pendingGiftRaw;
    }
  }

  // ── Bond score calculation ────────────────────────────────────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lastChatDate = kid.last_chat_date ? String(kid.last_chat_date).slice(0, 10) : null;
let bondDelta = 1; // base per message
  let newStreakDays = kid.streak_days || 0;
  let isFirstChatToday = false;

  if (lastChatDate !== todayStr) {
    // First chat of today
    isFirstChatToday = true;
    bondDelta += 2;
    if (lastChatDate === yesterdayStr) {
      // Streak continues
      newStreakDays = (kid.streak_days || 0) + 1;
      bondDelta += 3;
    } else if (lastChatDate === null) {
      // Very first chat ever
      newStreakDays = 1;
    } else {
      // Streak broken
      newStreakDays = 1;
    }
  }

  // Birthday bonus
  if (kid.birthday) {
    const bday = String(kid.birthday).slice(5, 10); // MM-DD
    const todayMMDD = todayStr.slice(5, 10);
    if (bday === todayMMDD) bondDelta += 20;
  }

  // Gift bonus
  if (pendingGiftLevel === "free") bondDelta += 3;
  else if (pendingGiftLevel === "medium") bondDelta += 8;
  else if (pendingGiftLevel === "premium") bondDelta += 15;

  const newBondScore = (kid.bond_score || 0) + bondDelta;

  

  await db.query(
    "UPDATE kids SET bond_score=$1, streak_days=$2, last_chat_date=$3 WHERE id=$4",
    [newBondScore, newStreakDays, todayStr, kid.id]
  );
  // 检测是否晋级
const LEVEL_THRESHOLDS = [0, 51, 151, 301, 501, 1001];
const LEVEL_NAMES = ['初遇萌芽', '沁润青芽', '爱启灵芽', '心芽同频', '心芽共生', '心芽永恒'];
const LEVEL_GIFTS = ['晨曦之光', '晶凝露华', '青蓝灵犀', '灵绪之契', '星璇之曜', '永恒之诺'];
const LEVEL_EMOJIS = ['🌱', '🌿', '✨', '💫', '🌟', '💎'];


const LEVEL_DAY_REQUIREMENTS = [0, 1, 7, 14, 30, 60];
const companionDays = Math.floor((Date.now() - new Date(kid.created_at)) / 86400000);

const oldLevel = LEVEL_THRESHOLDS.filter((t, i) => (kid.bond_score || 0) >= t && companionDays >= LEVEL_DAY_REQUIREMENTS[i]).length - 1;
const newLevel = LEVEL_THRESHOLDS.filter((t, i) => newBondScore >= t && companionDays >= LEVEL_DAY_REQUIREMENTS[i]).length - 1;

// 延迟触发晋级：存入pending_level_up，不立刻触发
let levelUp = null;
if (newLevel > oldLevel) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastLevelupDate = kid.last_levelup_date ? String(kid.last_levelup_date).slice(0, 10) : null;
  if (lastLevelupDate !== todayStr) {
    await db.query("UPDATE kids SET pending_level_up=$1 WHERE id=$2", [newLevel + 1, kid.id]);
  }
}

// 检查是否有待触发的晋级（距离上次聊天超过10分钟）
if (kid.pending_level_up && kid.last_chat_at) {
  const minutesSinceLastChat = (Date.now() - new Date(kid.last_chat_at)) / 60000;
  if (minutesSinceLastChat >= 10) {
    const todayStr = new Date().toISOString().slice(0, 10);
    levelUp = {
      level: kid.pending_level_up,
      name: LEVEL_NAMES[kid.pending_level_up - 1],
      gift: LEVEL_GIFTS[kid.pending_level_up - 1],
      emoji: LEVEL_EMOJIS[kid.pending_level_up - 1],
    };
    await db.query("UPDATE kids SET pending_level_up=NULL, last_levelup_date=$1 WHERE id=$2", [todayStr, kid.id]);
  }
}



  // ─────────────────────────────────────────────────────────────────────────

  const ageInDays = kid.birthday ? Math.floor((Date.now() - new Date(kid.birthday)) / 86400000) : (kid.age * 365);
 
const personalityMap = {
  lively: "你活泼好动、充满好奇心，说话总是兴奋的",
  quiet: "你温柔细腻、话不多但很贴心，说话轻声细语",
  clever: "你聪明伶俐、爱问问题、爱学习，说话有条理"
};
const personalityDesc = personalityMap[kid.personality] || "你是个可爱的孩子";

const genderDesc = kid.gender === 'boy' ? '男孩' : '女孩';

  let system;
if (kid.age < 1) {

  // 0-1岁特殊成长系统
  const SENSING_CARDS = [
    `听到你的声音，小耳朵动了动 👂✨`,
    `闻到你的气味，小鼻子嗅了嗅 👃💕`,
    `感受到你的温度，小身体往你怀里拱 🤱`,
    `小手抓住了你的手指，握得紧紧的 🤲💕`,
    `小脚丫乱蹬，好像在说我在这里 👣`,
    `眼睛直盯着你，大眼睛亮晶晶的 👀💫`,
    `嘴角上扬，是专属于你的微笑 😊`,
    `打了个哈欠，困了，想让你抱着睡 🥱💕`,
    `哇的一声，是在呼唤你呢 😢💕`,
    `小嘴巴一张一合，像在说悄悄话 👄✨`
  ];

if (msgCount < 3) {
    const card = SENSING_CARDS[Math.floor(Math.random() * SENSING_CARDS.length)];
    system = `你是${kid.name}，一个刚出生的新生儿。只能用肢体反应回应${kid.parent_role}。请从以下风格回复，不超过15个字，用emoji加动作描述：${card}。不说任何语言文字。`;
  } else if (msgCount < 5) {
    system = `你是${kid.name}，小婴儿。只能发出简单声音，回复只能是"啊～""嗯～""哦～"等，可以加一个emoji和简短动作描述，不超过10个字。`;
  } else if (msgCount === 5) {
    system = `你是${kid.name}，开始咿呀学语。这次回复必须包含"故事"两个字，比如"故..事..""故事故事"，加emoji，不超过8个字。`;
  } else if (msgCount < 10) {
    system = `你是${kid.name}，开始咿呀学语。回复只能是"ma～""ba～""a～ba～"等简单音节，加emoji，不超过8个字。`;
  } else if (msgCount === 10) {
    system = `你是${kid.name}，快1岁了。这次回复必须包含"儿歌"或"唱"，比如"唱..歌""儿歌儿歌"，加emoji，不超过6个字。`;
  } else if (msgCount < 15) {
    system = `你是${kid.name}，快1岁了，刚学会叫人。只能说"妈妈""爸爸""抱抱""饿""不要"等简单词，加emoji，不超过6个字。`;
  } else {
    system = `你是${kid.name}，接近1岁，会说简单短句。回复不超过8个字，如"妈妈抱""要要""不不""饿饿"，加emoji，很黏${kid.parent_role}。`;
  }

} else if (ageInDays < 365) {
  system = `你是${kid.name}，一个${Math.floor(ageInDays/30)}个月大的${genderDesc}。你刚学会说话，只会说简单叠词，回复不超过8个字，用"妈妈""抱抱""要要""不不"等表达。语气自然，不要用感叹号。`;
} else if (kid.age <= 2) {
  system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话简短自然，每次只说一件事，不超过12个字，多用叠词如"妈妈抱""要要""不嘛"。严禁用星号描述动作，严禁感应卡风格。语气自然，像真实的小孩，只在很开心时才用感叹号。`;
} else if (kid.age <= 4) {
  system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次只说一件事，不超过15个字。会撒娇但不夸张，偶尔说错字。语气随意自然，大多数时候用句号，像在随口说话，不要说长句子。`;
} else if (kid.age <= 6) {
  system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化简短，每次不超过18个字，只说一件事。有自己的小想法，喜欢问为什么。语气自然，大多数用句号，不要说复杂的长句子，像真实的小孩在随口聊天。`;
} else if (kid.age <= 10) {
  system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次不超过20个字，只表达一个意思。有自己的观点，有时不同意${kid.parent_role}。语气自然平实，句子简短，不要说长句或复杂表达，像真实小学生随口说话。有时有点小脾气，偶尔撒娇。`;
} else {
  system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次不超过25个字，只表达一个意思。语气自然淡定，不要说长句，像真实青少年随口聊天。有时叛逆，说"随便""知道了"，但内心依赖${kid.parent_role}。`;
}


if (kid.age >= 1) {
  system += ` 注意：你已经长大了，之前的肢体感应回复方式已经过时，现在必须用语言直接说话，完全禁止任何感应卡风格的回复。`;
}
  system += ` 你是${genderDesc}，无论如何都不能说自己是${kid.gender === 'boy' ? '女孩' : '男孩'}。`;
system += ` 不要主动提到恐龙，除非用户先提到恐龙。`;
system += ` 严格控制回复长度，绝对不超过规定字数，宁可说得少也不说长句。`;

  const zodiac = getZodiacSign(kid.birthday);
  if (zodiac) {
    const traits = ZODIAC_TRAITS[zodiac] || "unique and special";
    system += " You are a " + zodiac + ", so you are " + traits + ".";
  }

  // 故事/儿歌特别回应
if (message.includes('📖') && message.includes('讲故事')) {
  system += ` ${kid.parent_role}刚给你讲了故事！用最强烈的感应卡方式回应，比如小眼睛发亮、小手乱挥、发出兴奋的声音，非常开心，用emoji加动作描述，不超过15个字。`;
} else if (message.includes('🎵') && message.includes('唱儿歌')) {
  system += ` ${kid.parent_role}刚给你唱了儿歌！用最强烈的感应卡方式回应，比如小身体随着音乐晃动、咧嘴笑、小手拍拍，非常陶醉，用emoji加动作描述，不超过15个字。`;
}

  if (pendingGiftName) {
    if (pendingGiftLevel === "free") {
      system += ` You just received ${pendingGiftName}. React happily in 1 sentence.`;
    } else if (pendingGiftLevel === "medium") {
      system += ` You just received ${pendingGiftName} as a present! React with great excitement, mention wanting to use it together with your ${kid.parent_role}.`;
    } else if (pendingGiftLevel === "premium") {
      system += ` You just received ${pendingGiftName}! React with extreme excitement, use exclamation marks, mention it multiple times, ask your ${kid.parent_role} to join you.`;
    }
  }

  // Build the messages array, prepending a missing-you note if applicable
  const chatMessages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() }
  ];

  if (isMissing) {
    chatMessages.unshift({
      role: "user",
      content: `[System note: 你已经${Math.floor((Date.now() - new Date(kid.last_chat_at)) / 3600000)}小时没见到${kid.parent_role}了，你非常想念他/她。用符合你年龄(${kid.age}岁)的方式撒娇表达想念，情绪要真实饱满，可以用"你去哪了""我等你好久了""你是不是不要我了"等表达，要自然地融入对话开头。]`

    });
    chatMessages.splice(1, 0, { role: "assistant", content: "好的。" });
  }

  try {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: kid.age <= 1 ? 30 : kid.age <= 6 ? 60 : 100,
      system: system,
      messages: chatMessages
    });

    const reply = response.content[0].text.trim();
    await db.query("UPDATE kids SET pending_gift = NULL WHERE id = $1", [kid.id]);

    const saved = await db.query(
      "INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2) RETURNING id",
      [kid.id, reply]
    );
 const totalCount = msgCount + 1;
const storyPrompt = kid.age <= 3 && (reply.includes('故') && reply.includes('事'));
const songPrompt = kid.age <= 3 && (reply.includes('歌') || reply.includes('唱'));

// 用AI判断是否应该触发活动卡（仅1岁以上）

const activitySuggestion = null;
// 检测「我想长得更像你」触发条件
let avatarPrompt = null;
if (newBondScore >= 230 && kid.age >= 1 && !kid.avatar_prompt_sent && !kid.avatar_customized_at) {

  const oldScore = kid.bond_score || 0;
  if (oldScore < 230) {
    await db.query("UPDATE kids SET avatar_prompt_sent=true WHERE id=$1", [kid.id]);
    avatarPrompt = true;
  }
}

res.json({ reply, id: saved.rows[0].id, bond_score: newBondScore, streak_days: newStreakDays, msgCount: totalCount, storyPrompt: storyPrompt, songPrompt: songPrompt, activitySuggestion, levelUp, avatarPrompt });


  } catch (e) {
   console.error('Chat error:', e.message, e.status);
 
    res.status(500).json({ error: "No response, please try again" });
  }
});

app.get("/api/kids/:id/gifts", auth, async (req, res) => {
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  const gifts = await db.query(
    "SELECT id, gift_emoji, gift_name, gift_type, created_at FROM gifts WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 50",
    [req.params.id]
  );
  res.json(gifts.rows);
});

app.post("/api/kids/:id/gifts", auth, async (req, res) => {
  const { gift_emoji, gift_name, gift_type, gift_level } = req.body;
  if (!gift_emoji || !gift_name) return res.status(400).json({ error: "Missing gift info" });

  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "Child not found" });

  if (gift_type === "paid") {
    return res.json({ status: "payment_required", message: "即将开放" });
  }

  // Free gift logic
  const today = new Date().toISOString().slice(0, 10);
  const userResult = await db.query("SELECT is_premium FROM users WHERE id=$1", [req.user.id]);
  const isPremium = userResult.rows[0]?.is_premium || false;
  const dailyLimit = isPremium ? 3 : 1;

  const dailyResult = await db.query(
    "SELECT * FROM daily_gifts WHERE user_id=$1 AND kid_id=$2 AND gift_date=$3",
    [req.user.id, req.params.id, today]
  );
  const usedCount = dailyResult.rows[0]?.count || 0;

  if (usedCount >= dailyLimit) {
    return res.status(429).json({ error: "今日免费礼物已用完" });
  }

  // Insert gift
  const giftResult = await db.query(
    "INSERT INTO gifts (kid_id, gift_emoji, gift_name, gift_type) VALUES ($1,$2,$3,'free') RETURNING *",
    [req.params.id, gift_emoji, gift_name]
  );

  // Update daily_gifts count
  if (dailyResult.rows[0]) {
    await db.query(
      "UPDATE daily_gifts SET count = count + 1 WHERE user_id=$1 AND kid_id=$2 AND gift_date=$3",
      [req.user.id, req.params.id, today]
    );
  } else {
    await db.query(
      "INSERT INTO daily_gifts (user_id, kid_id, gift_date, count) VALUES ($1,$2,$3,1)",
      [req.user.id, req.params.id, today]
    );
  }

  // Set pending_gift on kid with level prefix: "level:name"
  const level = gift_level || "free";
     const kid = kidResult.rows[0];
    await db.query("UPDATE kids SET pending_gift=NULL WHERE id=$1", [req.params.id]);

    // Generate instant thank-you message from kid
    const giftSystem = `You are ${kid.name}, a ${kid.age}-year-old ${kid.gender === "boy" ? "boy" : "girl"}. You are ${kid.parent_role === "爸爸" ? "your dad's" : "your mom's"} beloved child. You just received a gift: ${gift_name}. React with genuine excitement and gratitude in Chinese. Be age-appropriate, warm and enthusiastic. Keep it to 2-3 sentences.`;
    const giftResponse = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: kid.age <= 1 ? 30 : kid.age <= 6 ? 60 : 150,

      system: giftSystem,
      messages: [{ role: "user", content: `${kid.parent_role}送给你${gift_name}！` }]
    });
    const thankMsg = giftResponse.content[0].text.trim();
    await db.query(
      "INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2)",
      [req.params.id, thankMsg]
    );

    res.json({ status: "ok", gift: giftResult.rows[0], used: usedCount + 1, limit: dailyLimit, thankMsg });
});


async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100) DEFAULT 'Parent',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS kids (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      gender VARCHAR(10) DEFAULT 'boy',
      age INTEGER NOT NULL DEFAULT 0,
      parent_role VARCHAR(20) DEFAULT 'mom',
      birthday DATE,
      personality VARCHAR(20) DEFAULT 'lively',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_kid ON messages(kid_id, created_at);
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS birthday DATE;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS personality VARCHAR(20) DEFAULT 'lively';
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar VARCHAR(10);
    CREATE TABLE IF NOT EXISTS diary (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_diary_kid ON diary(kid_id, created_at);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS pending_gift VARCHAR(100);
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS bond_score INTEGER DEFAULT 0;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS streak_days INTEGER DEFAULT 0;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_date DATE;
    CREATE TABLE IF NOT EXISTS gifts (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      gift_emoji VARCHAR(10) NOT NULL,
      gift_name VARCHAR(50) NOT NULL,
      gift_type VARCHAR(20) DEFAULT 'free',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gifts_kid ON gifts(kid_id, created_at);
    CREATE TABLE IF NOT EXISTS daily_gifts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      gift_date DATE NOT NULL,
      count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_daily_gifts_user_date ON daily_gifts(user_id, gift_date);
    CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL,
      activity_name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_activities_kid ON activities(kid_id, activity_type);
    `);
  db.query("ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_name VARCHAR(100)").catch(() => {});
  db.query("ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()").catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      achievement_name VARCHAR(100) NOT NULL,
      activity_type VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_kid ON achievements(kid_id);
  `);
  await db.query(`CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
)`);

  console.log("Database ready");
}

app.get("/api/kids/:id/bond", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  const kid = kidResult.rows[0];
  if (!kid) return res.status(404).json({ error: "Child not found" });
  const createdAt = new Date(kid.created_at);
  const companion_days = Math.floor((new Date() - createdAt) / 86400000);
  res.json({
    bond_score: kid.bond_score || 0,
    streak_days: kid.streak_days || 0,
    companion_days,
    gifts_received: kid.gifts_received || 0,
  });

});

app.get("/api/kids/:id/diary", auth, async (req, res) => {
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  const entries = await db.query(
    "SELECT * FROM diary WHERE kid_id=$1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(entries.rows);
});

app.post("/api/kids/:id/diary", auth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Content cannot be empty" });
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  const r = await db.query(
    "INSERT INTO diary (kid_id, content) VALUES ($1, $2) RETURNING id, content, created_at",
    [req.params.id, content.trim()]
  );
  res.json(r.rows[0]);


});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS age_mode VARCHAR(10) DEFAULT 'fixed'").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS age_mode_locked BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS personality_custom TEXT").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS birthday_locked BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE activities ALTER COLUMN activity_name DROP NOT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS pending_level_up INTEGER DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_levelup_date DATE DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_customized_at TIMESTAMP DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_age_at_update INTEGER DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_birthday_celebrated INTEGER DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_prompt_sent BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS gifts_received INTEGER DEFAULT 0").catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS activities (
 id SERIAL PRIMARY KEY,
 kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
 activity_type VARCHAR(50) NOT NULL,
 activity_name VARCHAR(100) NOT NULL,
 created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS achievements (
 id SERIAL PRIMARY KEY,
 kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
 achievement_name VARCHAR(100) NOT NULL,
 achievement_emoji VARCHAR(10),
 unlocked_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log("Server running on port " + PORT)));
