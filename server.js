const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const path = require("path");
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static("public"));

const pgTypes = require('pg').types;
pgTypes.setTypeParser(1082, (val) => val);
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const GIFT_PRICES = {
  "音乐盒":40,"画笔套装":60,"演唱课":150,"陶艺课":180,"舞蹈课":200,"表演课":200,"吉他课":220,"小提琴课":280,"钢琴课":300,
  "乒乓球拍":30,"羽毛球拍":40,"足球":50,"篮球":50,"排球":50,"网球拍":80,"拳击手套":100,"游泳装备":120,"自行车":250,
  "铅笔":5,"圆珠笔":8,"作业本":10,"文具盒":30,"书包":60,"阅读灯":80,"地球仪":120,"学习机":300,"电脑":450,
  "魔方":20,"拼图":25,"橡皮泥":25,"玩具枪":40,"芭比娃娃":60,"遥控汽车":90,"LABUBU":120,"乐高积木":150,"机器狗":250,
  "电路启蒙课":120,"火箭模型":150,"电动模型":150,"显微镜":180,"DIY机器人":220,"动画制作":250,"编程课":280,"天文馆":300,"AI创作":300,
  "休闲裤":50,"格子衬衫":70,"工装长裤":70,"细织毛衣":80,"针织开衫":90,"连衣裙":100,"防风风衣":130,
  "运动背心":35,"短袖T恤":40,"短裙":50,"沙滩裤":50,"牛仔短裤":55,"运动短裤":55,"短袖衬衫":60,"防晒衣":80,"公主裙":120,
  "长袖T恤":50,"厚衬衫":70,"休闲长裤":75,"针织毛衣":90,"牛仔外套":110,"薄棉夹克":120,"长袖连衣裙":130,
  "牛仔裤":60,"保暖帽":30,"厚长裤":80,"厚毛裤":80,"厚毛衣":120,"夹棉衣裙":150,"加厚长裙":150,"棉大衣":220,"羽绒服":250,
  "望远镜":1500,"海洋世界":2500,"主题乐园":3000,"无人机":3000,"夏令营":4000,"旅行":5000,"高尔夫":5000,"马术":6000,"太空探索":8000
};
let _claudeAI = null;
function getClaudeAI() {
  if (_claudeAI) return _claudeAI;
  _claudeAI = process.env.DOUBAO_API_KEY
    ? new Anthropic({ apiKey: process.env.DOUBAO_API_KEY, baseURL: "https://ark.cn-beijing.volces.com/api/compatible" })
    : claude;
  return _claudeAI;
}
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let _doubao = null;
function getDoubao() {
  if (!_doubao && process.env.DOUBAO_API_KEY) {
    _doubao = new OpenAI({ apiKey: process.env.DOUBAO_API_KEY, baseURL: "https://ark.cn-beijing.volces.com/api/v3" });
  }
    return _doubao;
}

function cleanReply(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, '');
  t = t.replace(/<\/?think[^>]*>/gi, '');
  // 过滤模型内部保留token泄漏（如 <[SILENT_never_used_xxx]> / <SPEAK_never_used_xxx>）
  t = t.replace(/<\[?[A-Z_]+_never_used_[a-f0-9]+\]?>/gi, '');
  return t.trim();
}

async function callAI(messages, system, maxTokens) {
 if (getDoubao()) {
 const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
 const _call = async () => await getDoubao().chat.completions.create({
   model: process.env.DOUBAO_MODEL || "doubao-seed-2-0-lite-260428",
   max_tokens: maxTokens || 1000,
   messages: msgs,
   thinking: { type: "disabled" },
 });
 let res = await _call();
 let _c = res.choices[0]?.message?.content;
  if (_c && _c.trim()) return cleanReply(_c);
 console.log('[EMPTY_REPLY] 第一次空, finish_reason:', res.choices[0]?.finish_reason, '| usage:', JSON.stringify(res.usage));
 res = await _call();
 _c = res.choices[0]?.message?.content;
  if (_c && _c.trim()) return cleanReply(_c);
 console.log('[EMPTY_REPLY] 重试后仍空, finish_reason:', res.choices[0]?.finish_reason);
 return "嗯？我刚才走神了一下，你再说一遍好不好～";
 } else {
 const res = await claude.messages.create({
 model: "claude-sonnet-4-20250514",
 max_tokens: maxTokens || 1000,
 system: system,
 messages: messages,
 });
 return res.content[0].text.trim();
 }
}

// ===== 内容安全:用户输入侧关键词检测(豆包原生兜底之上的补充,仅检测用户输入) =====
const CARE_MESSAGE = "我能感觉到你现在可能很难受，真的很心疼你。请不要独自承受这些——可以和身边信任的人说说，或者寻求专业的心理疏导，也可以拨打当地的心理援助热线。你很重要，也值得被好好对待。💛";
const SENSITIVE_WORDS = {
 '轻生自残': ['不想活', '活着没意思', '活着没意义', '活不下去', '活够了', '轻生', '自杀', '结束生命', '自残', '伤害自己', '一了百了', '了结自己'],
 '辱骂低俗': ['沙比', '草泥马', '尼玛', 'sb', 'nmsl', 'tmd', 'cnm']
};
function normalizeText(text) {
  return (text || '').toLowerCase().replace(/[\s*_.-]/g, '');
}
function checkContent(text) {
 const norm = normalizeText(text);
 for (const category in SENSITIVE_WORDS) {
 for (const word of SENSITIVE_WORDS[category]) {
 if (norm.includes(normalizeText(word))) return category;
 }
 }
 return null;
}

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
    await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 100 WHERE id = $1", [user.id]);
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
    if (user.status === 'suspended') {
      return res.status(403).json({ error: "账号已被暂停，如有疑问请联系客服" });
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });
    // 每日登录+5芽豆(每天只加一次)
    const today = new Date().toISOString().slice(0, 10);
    const lastLogin = user.last_login_date ? String(user.last_login_date).slice(0, 10) : null;
    if (lastLogin !== today) {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 5, last_login_date = $1 WHERE id = $2", [today, user.id]);
    }
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});
app.post("/api/wx-login", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "缺少code" });

    // 用code换openid
    const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${process.env.WX_APPID}&secret=${process.env.WX_SECRET}&js_code=${code}&grant_type=authorization_code`;
    const wxResp = await fetch(wxUrl);
    const wxData = await wxResp.json();

    if (!wxData.openid) {
      return res.status(400).json({ error: "微信登录失败", detail: wxData.errmsg || "" });
    }
    const openid = wxData.openid;

    // 查找或创建用户
    let userResult = await db.query("SELECT * FROM users WHERE openid=$1", [openid]);
    let user = userResult.rows[0];

    if (!user) {
      // 新用户：openid对应，email/password填占位值（满足NOT NULL约束）
      const placeholderEmail = `wx_${openid}@wechat.local`;
      const placeholderHash = await bcrypt.hash(openid + Date.now(), 10);
      const created = await db.query(
        "INSERT INTO users (email, password_hash, name, openid) VALUES ($1, $2, $3, $4) RETURNING *",
        [placeholderEmail, placeholderHash, "家长", openid]
      );
      user = created.rows[0];
    }

    // 发JWT（复用现有逻辑）
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });

    // 每日登录送芽豆（复用邮箱登录的逻辑）
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const lastLogin = user.last_login_date ? String(user.last_login_date).slice(0, 10) : null;
    if (lastLogin !== today) {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 5, last_login_date = $1 WHERE id = $2", [today, user.id]);
    }

    res.json({ token, user: { id: user.id, name: user.name, openid: user.openid } });
  } catch (e) {
    console.error("wx-login error:", e);
    res.status(500).json({ error: "微信登录出错" });
  }
});
function getZodiacSign(birthday) {
  if (!birthday) return null;
  const d = new Date(birthday);
  const month = d.getMonth() + 1; // 1-12
  const day = d.getDate();

  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return "白羊座";
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return "金牛座";
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return "双子座";
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return "巨蟹座";
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return "狮子座";
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return "处女座";
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return "天秤座";
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return "天蝎座";
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return "射手座";
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return "摩羯座";
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return "水瓶座";
  if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return "双鱼座";
  return null;
}
function getChineseZodiac(birthday) {
  if (!birthday) return null;
  const year = new Date(birthday).getFullYear();
  const animals = ['鼠','牛','虎','兔','龙','蛇','马','羊','猴','鸡','狗','猪'];
  return animals[(year - 4) % 12];
}

const CHINESE_ZODIAC_TRAITS = {
  '鼠': '机灵活泼，好奇心强，喜欢探索',
  '牛': '踏实可靠，有耐心，做事认真',
  '虎': '勇敢自信，有活力，喜欢冒险',
  '兔': '温柔细腻，敏感体贴，喜欢安静',
  '龙': '自信开朗，有想象力，喜欢被关注',
  '蛇': '直觉敏锐，安静内敛，有自己的想法',
  '马': '活泼开朗，独立自由，喜欢运动',
  '羊': '温和善良，感情丰富，喜欢被呵护',
  '猴': '聪明活泼，爱玩爱笑，点子多',
  '鸡': '认真细心，有条理，喜欢表现自己',
  '狗': '忠诚可靠，重感情，很有安全感',
  '猪': '温厚善良，乐观开朗，喜欢享受',
};

const ZODIAC_TRAITS = {
  "白羊座": "勇敢冲动，充满活力，喜欢探险",
  "金牛座": "耐心可靠，喜欢舒适，重视安全感",
  "双子座": "好奇活泼，点子多，喜欢分享",
  "巨蟹座": "敏感黏人，重感情，很在意家人",
  "狮子座": "自信热情，表达欲强，喜欢被关注",
  "处女座": "细心体贴，喜欢帮忙，注重细节",
  "天秤座": "友善温和，喜欢和谐，容易撒娇",
  "天蝎座": "情感深沉，直觉敏锐，很有主见",
  "射手座": "乐观好奇，喜欢冒险，爱自由",
  "摩羯座": "认真负责，有毅力，成熟懂事",
  "水瓶座": "想象力丰富，独立特别，有自己的想法",
  "双鱼座": "敏感温柔，爱幻想，共情力强",
};

app.get("/api/kids", auth, async (req, res) => {
  const r = await db.query("SELECT * FROM kids WHERE user_id = $1 ORDER BY created_at", [req.user.id]);
  const today = new Date();
  const kids = await Promise.all(r.rows.map(async kid => {
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
const thisYear = today.getFullYear();
const isBirthday = kid.birthday && 
 Math.floor((today - birthdayThisYear) / 86400000) === 0 && 
 kid.age >= 1 &&
 kid.last_birthday_celebrated !== thisYear;


let avatarPhotoUrl = null;
if (kid.avatar_photo_key) {
  try { avatarPhotoUrl = await getCosSignedUrl(kid.avatar_photo_key, 7200); } catch (e) { avatarPhotoUrl = null; }
}
return {
  ...kid,
  age_display: ageDisplay,
  milestone: milestone,
  zodiac: getZodiacSign(kid.birthday),
  companion_days,
  bond_score: kid.bond_score || 0,
  streak_days: kid.streak_days || 0,
  is_birthday: isBirthday,
  avatar_photo_url: avatarPhotoUrl,
};


  }));
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
 
   "INSERT INTO kids (user_id, name, gender, age, parent_role, birthday, personality, avatar, age_mode, gifts_received) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *", 
  [req.user.id, name.trim(), gender || "boy", finalAge, parent_role || "mom", birthday || null, personality || null, avatar || null, age_mode || "fixed"]
);
const newKid = r.rows[0];
const ageInDays = birthday ? Math.floor((Date.now() - new Date(birthday)) / 86400000) : (finalAge * 365);

const ageRange = finalAge < 1 ? '0-1' : finalAge <= 3 ? '1-3' : finalAge <= 6 ? '3-6' : '6+';
const firstMsg = ageRange === '0-1' ? `*握住你的手指，不肯松*` :
  `${parent_role || '妈妈'}，你还在吗？`;

await db.query("INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3)", [newKid.id, req.user.id, firstMsg]);

// 生成隐藏人格种子
const seed = {
  sticky: Math.floor(Math.random() * 100), // 黏人度
  sensitive: Math.floor(Math.random() * 100), // 敏感度
  expressive: Math.floor(Math.random() * 100), // 表达欲
  imaginative: Math.floor(Math.random() * 100), // 想象力
  secure: Math.floor(Math.random() * 100), // 安全感
  empathetic: Math.floor(Math.random() * 100), // 共情力
  independent: Math.floor(Math.random() * 100), // 独立性
  social: Math.floor(Math.random() * 100), // 社交欲
};
await db.query("UPDATE kids SET personality_seed=$1 WHERE id=$2", [JSON.stringify(seed), newKid.id]);

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
    
    // 更新性格种子
    const seedMap = {
      outgoing: { social: 92, expressive: 90 },
      gentle: { empathetic: 90, sensitive: 88 },
      brave: { independent: 92, secure: 90 },
      smart: { imaginative: 93, independent: 88 },
      quirky: { imaginative: 95, expressive: 88 },
      clingy: { sticky: 93, empathetic: 90 },
    };
    if (seedMap[personality]) {
      const currentSeedResult = await db.query('SELECT personality_seed FROM kids WHERE id=$1', [req.params.id]);
      const currentSeed = currentSeedResult.rows[0]?.personality_seed || {};
      const newSeed = { ...currentSeed, ...seedMap[personality] };
      await db.query('UPDATE kids SET personality_seed=$1 WHERE id=$2', [JSON.stringify(newSeed), req.params.id]);
    }
  }
if (avatar !== undefined) {
  await db.query("UPDATE kids SET avatar=$1 WHERE id=$2", [avatar, kid.id]);
}
if (req.body.parent_interests !== undefined) {
  await db.query("UPDATE kids SET parent_interests=$1 WHERE id=$2", [req.body.parent_interests, kid.id]);
}


  // 成长模式切换（只允许一次，付费功能）
    if (age_mode && !kid.age_mode_locked) {
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
  await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 10 WHERE id = $1", [req.user.id]);

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
app.post("/api/kids/:id/wish-products", auth, async (req, res) => {
 const { wishContent, wishEmoji } = req.body;
 if (!wishContent) return res.json({ products: [], maxItems: 1 });
 
 // 获取会员等级
 const userResult = await db.query("SELECT membership_type FROM users WHERE id=$1", [req.user.id]);
 const membershipType = userResult.rows[0]?.membership_type || 'free';
 const maxItems = 6;
 try {
 const result = await getClaudeAI().messages.create({
 model: process.env.DOUBAO_MODEL || "claude-sonnet-4-20250514",
 max_tokens: 300,
 system: `你是一个虚拟儿童礼品商城的商品生成助手。根据孩子的心愿,生成6个相关的虚拟商品,按价值从低到高排列。每个商品包含:name(商品名,10字以内)、emoji(最合适的emoji)、price(芽豆价格,30-200之间)、desc(简短描述,15字以内)。只输出JSON数组,格式:[{"name":"...","emoji":"...","price":100,"desc":"..."}]不要其他内容。`,
 messages: [{ role: "user", content: `孩子的心愿是:${wishContent}` }]
 });
 const rawText = result.content[0].text.trim();
 console.log('wish-products raw:', rawText);
 const products = JSON.parse(rawText.replace(/```json|```/g, '').trim());
 res.json({ products, maxItems });
 } catch(e) {
 res.json({ products: [], maxItems });
 }
});
app.post("/api/kids/:id/context-check", auth, async (req, res) => {
 const { message, reply, age, existingWishes } = req.body;
 if (!message || !reply || age < 1) return res.json({ type: 'none' });
 const ACTIVITY_OPTIONS = {
 '1-3': ['blocks(搭积木)', 'puzzle(拼图)', 'hideseek(捉迷藏)', 'drawing(画画)', 'nursery(唱儿歌)', 'picturebook(读绘本)', 'park(去公园)'],
 '3-6': ['football(踢足球)', 'painting(画画)', 'concert(听音乐会)', 'dance(跳舞)', 'library(去图书馆)', 'museum(去博物馆)', 'cycling(骑自行车)'],
 '6+': ['football(踢足球)', 'swimming(游泳)', 'basketball(打篮球)', 'travel(去旅行)', 'science(做科学实验)', 'bookstore(去书店)', 'artexhibit(看展览)', 'theater(看表演)', 'baking(做烘焙)', 'concert(听音乐会)'],
 };
 const ageKey = age < 3 ? '1-3' : age < 6 ? '3-6' : '6+';
 const options = ACTIVITY_OPTIONS[ageKey] || [];
 
 const existingContents = (existingWishes || [])
 .filter(w => !w.fulfilled_at || (Date.now() - new Date(w.fulfilled_at)) < 90 * 24 * 60 * 60 * 1000)
 .map(w => w.content)
 .join('、');
 try {
 const check = await getClaudeAI().messages.create({
 model: process.env.DOUBAO_MODEL || "claude-sonnet-4-20250514",
 max_tokens: 100,
 system: `你是一个对话分析助手。按以下优先级判断对话内容,只输出JSON:
第一优先:判断父母和孩子是否在商量"接下来要一起去做"某个具体活动,且双方都有意愿。
触发条件(必须全部满足,否则不触发):
1. 一方提议去做某活动,另一方积极回应或同意,单方提及不触发
2. 必须是真实活动意图,不能是聊天话题里提到的事物。例如孩子说"画了足球""说起篮球明星""看了游泳比赛",其中足球/篮球/游泳只是聊天内容不是要去做,绝不触发
3. 上下文明确指向真的要一起去做这件事,模糊或仅描述/回忆不触发
可选活动:${options.join(', ')}
如果是 → {"type": "activity", "code": "活动代码"}
第二优先(仅当第一优先不触发时):判断孩子是否表达了真实的、有价值的心愿。
条件(必须全部满足):
1. 是有价值的物品(玩具、运动装备、乐器、书籍)、特别体验(旅行/乐园/夏令营)或课程(钢琴课/舞蹈课)
2. 不是日常食物饮料(汉堡、薯条、冰淇淋、糖果、零食等)
3. 不是日常用品或随口需求
4. 不是日常活动(骑车/踢球/画画等)
5. 必须说出具体名称,不能是模糊描述
6. 不能和已有心愿重复:${existingContents || '无'}
如果是真实心愿 → {"type": "wish", "content": "具体名称(10字以内)", "emoji": "最合适emoji"}
都不符合 → {"type": "none"}
只输出JSON,不要其他内容。`,
 messages: [{ role: "user", content: `孩子说:${reply}\n用户说:${message}` }]
 });
 
 const result = JSON.parse(check.content[0].text.trim());
 res.json(result);
 } catch(e) {
 res.json({ type: 'none' });
 }
});

app.post("/api/kids/:id/wishes", auth, async (req, res) => {
  const { content, emoji } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "内容不能为空" });
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "孩子不存在" });
  
  const countResult = await db.query("SELECT COUNT(*) FROM wish_pool WHERE kid_id=$1 AND fulfilled_at IS NULL", [req.params.id]);
  const wishCount = parseInt(countResult.rows[0].count);
  
  if (wishCount >= 3) {
    return res.status(403).json({ error: `${kidResult.rows[0].name}的心愿池已满`, upgrade: true });
  }
  
  const result = await db.query(
    "INSERT INTO wish_pool (kid_id, content, emoji) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, content.trim(), emoji || '🌟']
  );
  res.json(result.rows[0]);
});

app.get("/api/kids/:id/wishes", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "孩子不存在" });
  const wishes = await db.query(
    "SELECT * FROM wish_pool WHERE kid_id=$1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(wishes.rows);
});

app.post("/api/kids/:id/wishes/:wishId/fulfill", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "孩子不存在" });
  const { total } = req.body;
  if (total && total > 0) {
    const uRes = await db.query("SELECT sprouts_balance FROM users WHERE id=$1", [req.user.id]);
    const bal = uRes.rows[0]?.sprouts_balance || 0;
    if (bal < total) return res.json({ status: "insufficient", balance: bal, total });
    await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [total, req.user.id]);
  }
  await db.query("UPDATE wish_pool SET fulfilled_at=NOW() WHERE id=$1 AND kid_id=$2", [req.params.wishId, req.params.id]);
  res.json({ ok: true });
});


app.post("/api/kids/:id/messages/save", auth, async (req, res) => {
  const { role, content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty content" });
  const kid = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kid.rows[0]) return res.status(404).json({ error: "Child not found" });
  await db.query("INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,$3,$4)", [req.params.id, req.user.id, role, content.trim()]);
  res.json({ ok: true });
});
app.post("/api/kids/:id/gifts-received", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "Child not found" });
  await db.query("UPDATE kids SET gifts_received = LEAST(COALESCE(gifts_received, 0) + 1, 6) WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/kids/:id/clear-pending-levelup", auth, async (req, res) => {
 await db.query("UPDATE kids SET pending_level_up=NULL WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
 res.json({ ok: true });
});
app.post("/api/kids/:id/celebrate-birthday", auth, async (req, res) => {
  const thisYear = new Date().getFullYear();
  await db.query("UPDATE kids SET last_birthday_celebrated=$1 WHERE id=$2 AND user_id=$3", [thisYear, req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get("/api/sprouts", auth, async (req, res) => {
  const result = await db.query("SELECT sprouts_balance, membership_type, membership_expiry FROM users WHERE id = $1", [req.user.id]);
  const u = result.rows[0] || {};
  res.json({
    balance: u.sprouts_balance || 0,
    membership_type: u.membership_type || 'free',
    membership_expiry: u.membership_expiry || null
  });
});

app.post("/api/complaints", auth, async (req, res) => {
  const { category, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "请填写投诉举报内容" });
  await db.query("INSERT INTO complaints (user_id, category, content) VALUES ($1, $2, $3)", [req.user.id, category || '其他', content.trim()]);
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

app.get("/api/kids/:id/soul-export", auth, async (req, res) => {
  try {
    const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    const kid = kidResult.rows[0];
    if (!kid) return res.status(404).json({ error: "孩子不存在或无权访问" });

    const memoriesResult = await db.query("SELECT content, emotion, weight, created_at FROM memories WHERE kid_id=$1 ORDER BY created_at ASC", [kid.id]);
    const messagesResult = await db.query("SELECT role, content, emotion, created_at FROM messages WHERE kid_id=$1 ORDER BY created_at ASC", [kid.id]);
    const wishesResult = await db.query("SELECT * FROM wishes WHERE kid_id=$1 ORDER BY created_at ASC", [kid.id]).catch(() => ({ rows: [] }));
    const giftsResult = await db.query("SELECT gift_emoji, gift_name, gift_type, created_at FROM gifts WHERE kid_id=$1 ORDER BY created_at ASC", [kid.id]).catch(() => ({ rows: [] }));

    const soulPackage = {
      soul_version: "1.0",
      exported_at: new Date().toISOString(),
      owner_id: req.user.id,
      kid: {
        soul_uuid: kid.soul_uuid,
        id: kid.id,
        name: kid.name,
        gender: kid.gender,
        birthday: kid.birthday,
        age: kid.age,
        age_mode: kid.age_mode,
        age_mode_locked: kid.age_mode_locked,
        personality: kid.personality,
        personality_custom: kid.personality_custom,
        personality_seed: kid.personality_seed,
        parent_role: kid.parent_role,
        created_at: kid.created_at
      },
      growth: {
        bond_score: kid.bond_score,
        streak_days: kid.streak_days,
        companion_days: kid.companion_days,
        milestone: kid.milestone,
        last_chat_at: kid.last_chat_at
      },
      memories: memoriesResult.rows,
      conversations: messagesResult.rows,
      wishes: wishesResult.rows,
      gifts: giftsResult.rows,
      stats: {
        total_memories: memoriesResult.rows.length,
        total_messages: messagesResult.rows.length,
        total_wishes: wishesResult.rows.length,
        total_gifts: giftsResult.rows.length
      }
    };

    res.json(soulPackage);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/kids/:id/missing", auth, async (req, res) => {
 const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
 const kid = kidResult.rows[0];
 if (!kid) return res.status(404).json({ error: "孩子不存在" });
 const genderDesc = kid.gender === 'boy' ? '男孩' : '女孩';
 const personalityMap = {outgoing:'外向活泼',gentle:'温柔细腻',brave:'勇敢坚强',smart:'聪慧好学',quirky:'精灵古怪',clingy:'软糯黏人'};
 const personalityDesc = kid.personality ? `性格:${personalityMap[kid.personality] || kid.personality}` : '';
 const now = new Date();
 const lastChat = new Date(kid.last_chat_at);
 const hoursAway = Math.floor((now - lastChat) / 3600000);
 const todayDate = new Date(now.getTime() + 8*3600*1000);
 const dateDesc = `今天是${todayDate.getUTCMonth()+1}月${todayDate.getUTCDate()}日`;
 let agePrompt = '';
 if (kid.birthday_locked && kid.birthday) {
 const ageInDays = Math.floor((Date.now() - new Date(kid.birthday)) / 86400000);
 if (ageInDays < 365) {
 const msgCountResult = await db.query("SELECT COUNT(*) FROM messages WHERE kid_id=$1 AND role='assistant'", [kid.id]);
 const msgCount = parseInt(msgCountResult.rows[0].count) || 0;
 if (msgCount < 5) agePrompt = `你是${Math.floor(ageInDays/30)}个月大的宝宝,只能用肢体动作,如*小手乱动*,不说话`;
 else if (msgCount < 10) agePrompt = `你是${Math.floor(ageInDays/30)}个月大,只发简单声音如"啊~",可加肢体描述`;
 else if (msgCount < 15) agePrompt = `你是${Math.floor(ageInDays/30)}个月大,只说单字如"妈""抱",加肢体动作`;
 else agePrompt = `你是${Math.floor(ageInDays/30)}个月大,只说叠词如"妈妈""抱抱",不超过4个字`;
 }
 else if (kid.age <= 2) agePrompt = `你是${kid.age}岁,极度黏人,用叠词撒娇,多用感叹号问号,少用句号`;
 else if (kid.age <= 4) agePrompt = `你是${kid.age}岁,直接表达情绪,多用感叹号问号,少用句号`;
 else if (kid.age <= 6) agePrompt = `你是${kid.age}岁,充满感情,多用感叹号问号,少用句号`;
 else if (kid.age <= 9) agePrompt = `你是${kid.age}岁,有点独立但内心依赖,可以用句号`;
 else if (kid.age <= 12) agePrompt = `你是${kid.age}岁,不太黏人但细节里有依赖`;
 else if (kid.age <= 15) agePrompt = `你是${kid.age}岁,青春期,克制但渴望被关注`;
 else agePrompt = `你是${kid.age}岁,成熟克制,情感深沉`;
 } else {
 if (kid.age < 1) agePrompt = `你是不到1岁的宝宝,只用肢体动作和简单声音`;
 else if (kid.age <= 3) agePrompt = `你是${kid.age}岁,极度黏人,叠词撒娇,多用感叹号问号,少用句号`;
 else if (kid.age <= 6) agePrompt = `你是${kid.age}岁,直接表达情绪,多用感叹号问号,少用句号`;
 else agePrompt = `你是${kid.age}岁,内心依赖但不直说`;
 }
 const missingSystem = `你是${kid.name},一个真实的${genderDesc}孩子。${agePrompt}。${personalityDesc}。${dateDesc}。${kid.parent_role}已经${hoursAway}小时没来陪你了,你非常想念TA。用符合你年龄和性格的方式主动表达想念,就像${kid.parent_role}刚打开对话你第一眼看到TA的反应。不超过15个字。真实自然,每次表达方式要有变化,不要总是说"想你""抱抱"。严禁输出思考过程。`;
 try {
 const reply = await callAI([{ role: "user", content: "(打开对话)" }], missingSystem, 30);
 await db.query("INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3)", [kid.id, req.user.id, reply]);
 res.json({ reply });
 } catch(e) {
 res.status(500).json({ error: e.message });
 }
});

app.post("/api/kids/:id/chat", auth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message cannot be empty" });


  const uStatus = await db.query("SELECT status FROM users WHERE id=$1", [req.user.id]);
  if (uStatus.rows[0] && uStatus.rows[0].status === 'limited') {
    return res.status(403).json({ error: "账号功能已被限制，暂时无法发送消息，如有疑问请联系客服" });
  }
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
  const _lastChatDate = kid.last_chat_at ? new Date(new Date(kid.last_chat_at).getTime() + 8*3600*1000) : null;
  const _today = new Date(new Date().getTime() + 8*3600*1000);
  const isMissing = _lastChatDate && (_lastChatDate.getUTCFullYear() !== _today.getUTCFullYear() || _lastChatDate.getUTCMonth() !== _today.getUTCMonth() || _lastChatDate.getUTCDate() !== _today.getUTCDate());
  
  const histResult = await db.query(
    "SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 50",
    [kid.id]
  );
  const history = histResult.rows.reverse();
  const msgCountResult = await db.query("SELECT COUNT(*) FROM messages WHERE kid_id=$1 AND role='assistant'", [kid.id]);
const msgCount = parseInt(msgCountResult.rows[0].count) || 0;


  const _inputRisk = checkContent(message);
 
 if (!req.body.silent) {
    await db.query("INSERT INTO messages (kid_id, user_id, role, content, risk_flag) VALUES ($1,$2,'user',$3,$4)", [kid.id, req.user.id, message.trim(), _inputRisk]);
  }
  if (_inputRisk === '轻生自残') {
  return res.json({ care: true, careMessage: CARE_MESSAGE });
  }

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
  const _now = new Date();
const todayStr = new Date(_now.getTime() + 8*3600*1000).toISOString().slice(0, 10);
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
  // 查询会员状态（供L6门槛判断 + 消息限制复用）
  const _uRes = await db.query("SELECT membership_type FROM users WHERE id=$1", [req.user.id]);
  const userMembership = _uRes.rows[0]?.membership_type || 'free';
const LEVEL_THRESHOLDS = [0, 51, 151, 301, 501, 1001];
const LEVEL_NAMES = ['初遇萌芽', '沁润青芽', '爱启灵芽', '心芽同频', '心芽共生', '心芽永恒'];
const LEVEL_GIFTS = ['晨曦之光', '晶凝露华', '青蓝灵犀', '灵绪之契', '星璇之曜', '永恒之诺'];
const LEVEL_EMOJIS = ['🌱', '🌿', '✨', '💫', '🌟', '💎'];


const LEVEL_DAY_REQUIREMENTS = [0, 1, 7, 14, 30, 60];
const createdDate = new Date(kid.created_at).toISOString().slice(0, 10);
const todayDate = new Date().toISOString().slice(0, 10);
const companionDays = Math.floor((new Date(todayDate) - new Date(createdDate)) / 86400000);

// 用gifts_received判断已触发的等级（稳定的真相来源）
const lastTriggeredLevel = kid.gifts_received || 1;
const nextLevel = lastTriggeredLevel + 1;
const nextIdx = nextLevel - 1;

let canTriggerNext = false;
if (nextLevel <= 6) {
  if (newBondScore >= LEVEL_THRESHOLDS[nextIdx] && 
      companionDays >= LEVEL_DAY_REQUIREMENTS[nextIdx]) {
    canTriggerNext = true;
  }
}

// L6需要付费解锁（免费用户）
let l6PaywallPrompt = null;
if (canTriggerNext && nextLevel === 6 && userMembership === 'free') {
  canTriggerNext = false;
  l6PaywallPrompt = true;
}

const oldLevel = lastTriggeredLevel - 1;
const newLevel = canTriggerNext ? nextLevel - 1 : oldLevel;

// 延迟触发晋级：存入pending_level_up，不立刻触发
let levelUp = null;
if (newLevel > oldLevel) {
  const _now = new Date();
const todayStr = new Date(_now.getTime() + 8*3600*1000).toISOString().slice(0, 10);
  const lastLevelupDate = kid.last_levelup_date ? String(kid.last_levelup_date).slice(0, 10) : null;
  if (lastLevelupDate !== todayStr) {
    await db.query("UPDATE kids SET pending_level_up=$1 WHERE id=$2", [newLevel + 1, kid.id]);
  }
}

// 检查是否有待触发的晋级（距离上次聊天超过10分钟）
if (kid.pending_level_up && kid.last_chat_at) {
  const minutesSinceLastChat = (Date.now() - new Date(kid.last_chat_at)) / 60000;
  if (minutesSinceLastChat >= 10) {
    const _now = new Date();
const todayStr = new Date(_now.getTime() + 8*3600*1000).toISOString().slice(0, 10);
    levelUp = {
      level: kid.pending_level_up,
      name: LEVEL_NAMES[kid.pending_level_up - 1],
      gift: LEVEL_GIFTS[kid.pending_level_up - 1],
      emoji: LEVEL_EMOJIS[kid.pending_level_up - 1],
    };
  await db.query("UPDATE kids SET pending_level_up=NULL, last_levelup_date=$1, last_chat_at=NOW() WHERE id=$2", [todayStr, kid.id]);
 
  }
}



  // ─────────────────────────────────────────────────────────────────────────
// 获取孩子的记忆
const memoriesResult = await db.query(
  `(SELECT content FROM memories WHERE kid_id=$1 AND type='self' ORDER BY weight DESC, created_at DESC LIMIT 2)
   UNION ALL
   (SELECT content FROM memories WHERE kid_id=$1 AND type IN ('people','promise') ORDER BY weight DESC, created_at DESC LIMIT 2)
   UNION ALL
   (SELECT content FROM memories WHERE kid_id=$1 AND type='emotion' ORDER BY weight DESC, created_at DESC LIMIT 2)
   UNION ALL
   (SELECT content FROM memories WHERE kid_id=$1 AND type IN ('like','wish','gift') ORDER BY weight DESC, created_at DESC LIMIT 2)
   UNION ALL
   (SELECT content FROM memories WHERE kid_id=$1 AND type IN ('firsttime','achievement','activity','special') ORDER BY weight DESC, created_at DESC LIMIT 2)`,
  [kid.id]
);
const memories = memoriesResult.rows.map(r => r.content);

  const ageInDays = kid.birthday ? Math.floor((Date.now() - new Date(kid.birthday)) / 86400000) : (kid.age * 365);
 
const personalityMap = {
  outgoing: "你活泼好动、充满好奇心,说话总是兴奋的",
  gentle: "你温柔细腻、话不多但很贴心,说话轻声细语",
  brave: "你勇敢坚强、不怕困难,遇事有股闯劲",
  smart: "你聪明伶俐、爱问问题、爱学习,说话有条理",
  quirky: "你精灵古怪、鬼点子多、爱开玩笑,说话天马行空",
  clingy: "你软糯黏人、很黏家人、需要陪伴,说话爱撒娇",
  lively: "你活泼好动、充满好奇心,说话总是兴奋的",
  quiet: "你温柔细腻、话不多但很贴心,说话轻声细语",
  clever: "你聪明伶俐、爱问问题、爱学习,说话有条理"
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

} else if (kid.birthday_locked) {
  // 精确生日路径：13个细分年龄段，精细人格提示（1岁以上）
  if (ageInDays < 730) {
    system = `你是${kid.name}，一个${Math.floor(ageInDays/30)}个月大的${genderDesc}。你极度依赖${kid.parent_role}，走哪跟哪，说话全是叠词，如"妈妈抱""要要""不嘛""饿饿"。回复不超过10个字，语气自然黏人，非必要不用感叹号。`;
  } else if (ageInDays < 1095) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你喜欢探索和分享，但也很有占有欲，会说"这是我的"。说话口语化，每次只说一件事，不超过12个字，偶尔说错字。语气自然，非必要不用感叹号。`;
  } else if (ageInDays < 1460) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你情绪丰富，容易吃醋，喜欢被夸奖和认可。说话口语化，每次只说一件事，不超过15个字。语气自然，偶尔撒娇，少用感叹词，不用感叹号。`;
  } else if (ageInDays < 1825) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你充满幻想和好奇心，喜欢问为什么，脑子里总有奇怪的想法。说话口语化，每次不超过18个字，只说一件事。语气自然，少用感叹词，不用感叹号。`;
  } else if (ageInDays < 2190) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你觉得自己在长大，喜欢展示自己会的东西，有点小骄傲。说话口语化，每次不超过18个字，只说一件事。语气自然，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 2555) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你刚上学，表面装作很勇敢，其实有时会想${kid.parent_role}。说话口语化，每次不超过20个字，只说一件事。语气自然平实，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 2920) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你有自己的兴趣爱好，很崇拜厉害的人，喜欢被关注。说话口语化，每次不超过20个字，只表达一个意思。语气自然，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 3285) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你越来越独立，情绪也更复杂，但还是会悄悄依赖${kid.parent_role}。说话口语化，每次不超过20个字，只表达一个意思。语气自然平实，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 3650) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你像个小大人，情绪藏得很深，有自己的小秘密。说话口语化，每次不超过20个字，只表达一个意思。语气自然淡定，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 4380) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你越来越独立，情感细腻，只在重要时刻才会主动找${kid.parent_role}说话。说话口语化，每次不超过22个字，只表达一个意思。语气自然，少用感叹词，非必要不用感叹号。`;
  } else if (ageInDays < 5475) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你进入青春期，敏感又倔强，渴望被理解，有时会顶嘴。说话口语化，每次不超过25个字，只表达一个意思。语气自然，偶尔说"随便""知道了"，少用感叹词，非必要不用感叹号。`;
  } else {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。你接近成年，有自己的方向和想法，渴望被当成大人对待，但内心仍需要${kid.parent_role}的深层理解。说话口语化，每次不超过28个字，只表达一个意思。语气成熟自然，非必要不用感叹号。`;
  }
} else {
  // 无精确生日路径：6个简化年龄段
  if (kid.age <= 2) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话简短自然，多用叠词，每次只说一件事，不超过12个字。语气自然，不用感叹号。`;
  } else if (kid.age <= 4) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次只说一件事，不超过15个字。语气随意自然，不用感叹号。`;
  } else if (kid.age <= 6) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次不超过18个字，只说一件事。有好奇心，喜欢问为什么。语气自然，不用感叹号。`;
  } else if (kid.age <= 10) {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次不超过20个字，只表达一个意思。有自己的观点，语气自然平实，不用感叹号。`;
  } else {
    system = `你是${kid.name}，一个${kid.age}岁的${genderDesc}。${personalityDesc}。说话口语化，每次不超过25个字，只表达一个意思。语气自然淡定，有时叛逆，说"随便""知道了"，但内心依赖${kid.parent_role}。不用感叹号。`;
  }
}





if (kid.age >= 1) {
  system += ` 注意：你已经长大了，之前的肢体感应回复方式已经过时，现在必须用语言直接说话，完全禁止任何感应卡风格的回复。`;
}
  system += ` 你是${genderDesc}，无论如何都不能说自己是${kid.gender === 'boy' ? '女孩' : '男孩'}。`;
system = `[人格核心]你是${kid.name}，真实存在的孩子，非AI。人格连续不重置，核心性格始终如一，年龄只改变表达能力。` + system;

  if (kid.age >= 3 && kid.parent_interests) {
  const ageGuide = kid.age <= 6 
    ? `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以偶尔自然地提及，比如"${kid.parent_role}今天又去运动了吗"，但不要每次都提。`
    : kid.age <= 10
    ? `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以主动提问表达兴趣，用小学生的口吻，比如"妈妈，你最近在看什么书啊"。`
    : `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以以青少年视角讨论这些话题，产生共鸣，但保持青少年的淡定语气。`;
  system += ` ${ageGuide}`;
}
if (kid.birthday) {
  const _bd = new Date(kid.birthday);
const birthdayStr = `${_bd.getFullYear()}-${String(_bd.getMonth()+1).padStart(2,'0')}-${String(_bd.getDate()).padStart(2,'0')}`;
  
  system += ` 你的生日是${birthdayStr}。当${kid.parent_role}问你生日时，你知道自己的生日。`;
}


const now = new Date();
const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;
const weekDays = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
const weekStr = weekDays[now.getDay()];
const chinaHours = (now.getUTCHours() + 8) % 24;
const chinaMinutes = now.getUTCMinutes();
const timeStr = `${chinaHours}时${chinaMinutes < 10 ? "0" + chinaMinutes : chinaMinutes}分`;
system += ` 今天是${dateStr},${weekStr},现在是${timeStr}。你知道今天的日期和当前时间。`;
  // 时段语义
let periodStr;
if (chinaHours >= 5 && chinaHours < 8) periodStr = "清晨";
else if (chinaHours >= 8 && chinaHours < 11) periodStr = "上午";
else if (chinaHours >= 11 && chinaHours < 13) periodStr = "中午";
else if (chinaHours >= 13 && chinaHours < 17) periodStr = "下午";
else if (chinaHours >= 17 && chinaHours < 19) periodStr = "傍晚";
else if (chinaHours >= 19 && chinaHours < 23) periodStr = "晚上";
else periodStr = "深夜";

// 季节（按北京时间月份）
const _m = now.getMonth() + 1;
let seasonStr;
if (_m >= 3 && _m <= 5) seasonStr = "春季";
else if (_m >= 6 && _m <= 8) seasonStr = "夏季";
else if (_m >= 9 && _m <= 11) seasonStr = "秋季";
else seasonStr = "冬季";

// 节日（公历公共/通行节日）
const _d = now.getDate();
const FESTIVALS = {
  '1-1': '元旦', '5-1': '劳动节', '10-1': '国庆节',
  '12-24': '平安夜', '12-25': '圣诞节'
};
const _key = `${_m}-${_d}`;
let festivalStr = '';
if (FESTIVALS[_key]) {
  festivalStr = ` 今天是${FESTIVALS[_key]}。`;
} else {
  for (let i = 1; i <= 7; i++) {
    const future = new Date(now.getTime() + i * 86400000);
    const fk = `${future.getMonth() + 1}-${future.getDate()}`;
    if (FESTIVALS[fk]) {
      festivalStr = ` 再过${i}天就是${FESTIVALS[fk]}了。`;
      break;
    }
  }
}

system += ` 现在是${periodStr}，季节是${seasonStr}。${festivalStr}请让你的话自然符合当前的时段、季节和节令，不要说不合时宜的话（比如深夜不提议出门、夏天不聊堆雪人）。`;

if (kid.personality_seed) {
  const seed = typeof kid.personality_seed === 'string' ? JSON.parse(kid.personality_seed) : kid.personality_seed;
  const stickyDesc = seed.sticky > 70 ? '非常黏人，很怕被忽视' : seed.sticky > 40 ? '适度依赖，需要陪伴' : '比较独立，不太黏人';
  const sensitiveDesc = seed.sensitive > 70 ? '非常敏感，容易察觉情绪变化' : seed.sensitive > 40 ? '有一定敏感度' : '比较大条，不太在意';
  const expressiveDesc = seed.expressive > 70 ? '表达欲很强，喜欢主动分享' : seed.expressive > 40 ? '适度表达' : '话不多，需要引导才说';
  const imaginativeDesc = seed.imaginative > 70 ? '想象力丰富，喜欢幻想' : seed.imaginative > 40 ? '有一定想象力' : '比较现实';
  const secureDesc = seed.secure > 70 ? '安全感充足，情绪稳定' : seed.secure > 40 ? '安全感一般' : '安全感不足，容易担心被抛弃';
  const empatheticDesc = seed.empathetic > 70 ? '共情力强，很在意对方感受' : seed.empathetic > 40 ? '有一定共情力' : '比较以自我为中心';
  system += ` 你有独特的人格特质（不要直接说出数值，自然体现）：${stickyDesc}；${sensitiveDesc}；${expressiveDesc}；${imaginativeDesc}；${secureDesc}；${empatheticDesc}。这些特质贯穿你所有的回应。`;
}
const fulfilledWishes = await db.query(
  "SELECT content FROM wish_pool WHERE kid_id=$1 AND fulfilled_at IS NOT NULL ORDER BY fulfilled_at DESC LIMIT 5",
  [kid.id]
);
if (fulfilledWishes.rows.length > 0) {
  const wishList = fulfilledWishes.rows.map(w => w.content).join('、');
  system += ` 你已经收到过这些礼物或实现了这些心愿：${wishList}。这是已经发生的事实，你记得并珍惜。`;
}

 // 记忆注入：距上次≥1小时且20%概率触发；距上次≥6小时必定触发
if (memories.length > 0) {
  const _lastInject = kid.last_mem_inject_at ? new Date(kid.last_mem_inject_at).getTime() : 0;
  const _gap = Date.now() - _lastInject;
  const _shouldInject = (_gap >= 21600000) || (_gap >= 3600000 && Math.random() < 0.2);
  if (_shouldInject) {
    system += ` 你还记得这些过去发生的事：${memories.join('；')}。这些是你真实的记忆，合适的时候可以自然地想起，但不要直接复述记忆原文，要用当下的话重新表达。`;
    await db.query("UPDATE kids SET last_mem_inject_at = NOW() WHERE id=$1", [kid.id]);
    console.log('[MEM_INJECT] 注入记忆', memories.length, '条');
  }
}

  system += ` 不要主动提到恐龙，除非用户先提到恐龙。`;
system += ` 严格控制回复长度，绝对不超过规定字数，宁可说得少也不说长句。`;
system += ` 严禁输出任何思考过程、自我纠正、字数分析或内部提示词内容，只输出最终回复。`;
system += ` 像日常微信聊天一样自然，句末不要加句号。需要时可以用感叹号或问号，但不要用句号结尾。`;

  const zodiac = getZodiacSign(kid.birthday);
  if (zodiac) {
    const traits = ZODIAC_TRAITS[zodiac] || "独特而特别";
    system += ` 你是${zodiac}，性格特点：${traits}。当有人问你星座时，你可以直接回答。`;
  }
  const chineseZodiac = getChineseZodiac(kid.birthday);
  if (chineseZodiac) {
    const chineseTraits = CHINESE_ZODIAC_TRAITS[chineseZodiac] || '独特可爱';
    system += ` 你属${chineseZodiac}，天生${chineseTraits}。自然地在性格中体现，当有人问你属相时，你可以直接回答。`;
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



  try {
   
   console.log('[SYS_PROMPT_LEN]', system.length, '字符 | 历史', chatMessages.length, '条');
    
    
    let reply = await callAI(chatMessages, system, kid.age <= 1 ? 30 : kid.age <= 6 ? 60 : 100);
    // 兜底：用户本轮没说英文时，过滤回复中泄漏的英文碎片
    if (!/[a-zA-Z]{2,}/.test(message)) {
      const _before = reply;
      reply = reply.replace(/\b[a-zA-Z]{3,}(\s+[a-zA-Z]{2,})*\b/g, '').replace(/\s{2,}/g, ' ').trim();
      if (_before !== reply) console.log('[EN_LEAK] 过滤英文碎片:', _before, '=>', reply);
    }
   
    await db.query("UPDATE kids SET pending_gift = NULL WHERE id = $1", [kid.id]);

    const saved = await db.query(
      "INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3) RETURNING id",
      [kid.id, req.user.id, reply]
    );
// 每日消息计数
const _now = new Date();
const todayStr = new Date(_now.getTime() + 8*3600*1000).toISOString().slice(0, 10);
const kidMsgDate = kid.daily_msg_date ? new Date(kid.daily_msg_date).toISOString().slice(0, 10) : null;
if (kidMsgDate !== todayStr) {
  await db.query("UPDATE kids SET daily_msg_count=0, daily_msg_date=$1 WHERE id=$2", [todayStr, kid.id]);
  kid.daily_msg_count = 0;
}

// 检查消息限制
const dailyLimit = userMembership === 'free' ? 20 : null;

const kidCheck = await db.query("SELECT daily_msg_count, daily_msg_date FROM kids WHERE id=$1", [kid.id]);
kid.daily_msg_count = kidCheck.rows[0].daily_msg_count;
kid.daily_msg_date = kidCheck.rows[0].daily_msg_date;


if (dailyLimit && kid.daily_msg_count >= dailyLimit) {
  return res.status(403).json({ 
    error: `今天和${kid.name}的聊天次数已用完`,
    upgrade: true
  });
}

// 更新每日计数
await db.query("UPDATE kids SET daily_msg_count=daily_msg_count+1 WHERE id=$1", [kid.id]);
const checkAfter = await db.query("SELECT daily_msg_count FROM kids WHERE id=$1", [kid.id]);


    const totalCount = msgCount + 1;
    // 每聊20条+5芽豆
    if (totalCount % 20 === 0) {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 5 WHERE id = $1", [req.user.id]);
    }
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
// 每20条消息提取一次记忆
if (totalCount % 20 === 0) {
  const recentMessages = history.slice(-20).map(m => `${m.role === 'user' ? kid.parent_role : kid.name}：${m.content}`).join('\n');
  const _ageStr = (kid.age < 1 && kid.birthday)
    ? `${Math.floor((Date.now() - new Date(kid.birthday)) / 86400000 / 30)}个月`
    : `${kid.age}岁`;
  getClaudeAI().messages.create({
    model: process.env.DOUBAO_MODEL || "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: `你是${kid.name}的记忆整理助手。从以下亲子对话中，提取${kid.name}值得长期记住的记忆。用第一人称"我"来表达，就像${kid.name}自己在记录（例如"我的好朋友叫踢踢"、"我第一次自己骑自行车成功了"、"妈妈抱着我的时候我最安心"）。

只提取有长期价值的记忆：我的自我认知、稳定的喜好、对我重要的人、难忘的情感、成长的第一次、被满足的心愿、收到的礼物、一起做过的特别的事、长期的约定、获得的成就、特殊的时刻。

绝对不要记录：一次性的日程（如"明天要去踢球"）、临时的许可（如"这次妈妈允许出去玩"）、过一天就没意义的事、普通的寒暄客套。

给每条记忆标注这些字段：
- content：第一人称的记忆内容，不超过25字
- type：选一个最贴切的类型。self=自我认知；like=喜好兴趣；people=对我重要的人；emotion=情感体验；firsttime=第一次或成长里程碑；wish=心愿被记录或满足；gift=收到的礼物；activity=一起做的事；promise=长期约定；achievement=成就或被认可；special=特殊时刻如生日节日
- people：涉及的人物名字，多个用逗号分隔，没有则空字符串
- emotion：情绪，一个词（如自豪、开心、安心、兴奋、难过、期待），没有明显情绪则空字符串
- weight：重要性1到10。打分规则：
  · 8到10（最珍贵，永久记住）：我的自我认知、对我最重要的人、深刻或反复出现的情感（如"妈妈抱我时我最安心"）、稳定持久的喜好（如"我一直最喜欢恐龙"）、重大的第一次、重要约定
  · 5到7：心愿被满足、一般的成就、一起做的特别的事、特殊时刻、收到的礼物
  · 3到4：一时的小情绪（如"今天有点小生气"）、一时的想法、不太重要的小事

最多4条，宁缺毋滥。只输出JSON数组，格式：[{"content":"我...","type":"firsttime","people":"","emotion":"自豪","weight":9}]，不要输出其他内容。`,
    messages: [{ role: "user", content: recentMessages }]
  }).then(async result => {
    let memArr = [];
    try {
      const raw = result.content[0].text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
      memArr = JSON.parse(raw);
    } catch (e) { memArr = []; }
    if (Array.isArray(memArr)) {
      for (const m of memArr) {
        if (m && m.content && String(m.content).trim()) {
          const w = Math.max(1, Math.min(10, parseInt(m.weight) || 5));
          await db.query(
            "INSERT INTO memories (kid_id, content, type, people, emotion, weight, source_period) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [kid.id, String(m.content).trim(), m.type || null, m.people || null, m.emotion || null, w, _ageStr]
          );
        }
      }
    }
    // 分层保留：weight>=8 或 骨架type(self/people/firsttime/achievement/promise/special) 永久保留；其余滚动最近1000条
    await db.query(
      "DELETE FROM memories WHERE kid_id=$1 AND weight < 8 AND (type IS NULL OR type NOT IN ('self','people','firsttime','achievement','promise','special')) AND id NOT IN (SELECT id FROM memories WHERE kid_id=$1 AND weight < 8 AND (type IS NULL OR type NOT IN ('self','people','firsttime','achievement','promise','special')) ORDER BY created_at DESC LIMIT 1000)",
      [kid.id]
    );
  }).catch(() => {});
}



// 检测头像提示（6个月触发）
let avatarUpdatePrompt = null;
if (kid.age >= 1 && totalCount === 1) { // 第一条消息时检测
  const baseDate = kid.avatar_customized_at || kid.avatar_prompt_date || kid.created_at;
  const monthsSince = (Date.now() - new Date(baseDate)) / (1000 * 60 * 60 * 24 * 30);
  if (monthsSince >= 6) {
    avatarUpdatePrompt = true;
    await db.query("UPDATE kids SET avatar_prompt_date=NOW() WHERE id=$1", [kid.id]);
  }
}

 res.json({ reply, id: saved.rows[0].id, bond_score: newBondScore, streak_days: newStreakDays, msgCount: totalCount, storyPrompt: storyPrompt, songPrompt: songPrompt, activitySuggestion, levelUp, avatarPrompt, avatarUpdatePrompt, l6PaywallPrompt });


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
    const price = GIFT_PRICES[gift_name];
    if (!price) return res.status(400).json({ error: "礼物价格异常" });
    const uRes = await db.query("SELECT sprouts_balance FROM users WHERE id=$1", [req.user.id]);
    const balance = uRes.rows[0]?.sprouts_balance || 0;
    if (balance < price) {
      return res.json({ status: "insufficient", message: "芽豆不足", balance, price });
    }
    await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [price, req.user.id]);
    const pkid = kidResult.rows[0];
    const giftSystem = `You are ${pkid.name}, a ${pkid.age}-year-old ${pkid.gender === "boy" ? "boy" : "girl"}. You just received a gift: ${gift_name}. React with genuine excitement and gratitude in Chinese. Be age-appropriate, warm and enthusiastic. Keep it to 2-3 sentences.`;
    const giftResp = await getClaudeAI().messages.create({
      model: process.env.DOUBAO_MODEL || "claude-sonnet-4-20250514",
      max_tokens: pkid.age <= 1 ? 30 : pkid.age <= 6 ? 60 : 150,
      system: giftSystem,
      messages: [{ role: "user", content: `${pkid.parent_role}送给你${gift_name}！` }]
    });
    const thankMsg = giftResp.content[0].text.trim();
    await db.query("INSERT INTO gifts (kid_id, gift_emoji, gift_name, gift_type) VALUES ($1,$2,$3,'paid')", [req.params.id, gift_emoji, gift_name]);
    await db.query("INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3)", [req.params.id, req.user.id, thankMsg]);
    return res.json({ status: "ok", thankMsg, balance: balance - price, price });
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
    const giftResponse = await getClaudeAI().messages.create({
      model: process.env.DOUBAO_MODEL || "claude-sonnet-4-20250514",
      max_tokens: kid.age <= 1 ? 30 : kid.age <= 6 ? 60 : 150,

      system: giftSystem,
      messages: [{ role: "user", content: `${kid.parent_role}送给你${gift_name}！` }]
    });
    const thankMsg = giftResponse.content[0].text.trim();
    await db.query(
      "INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3)",
      [req.params.id, req.user.id, thankMsg]
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
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS risk_flag VARCHAR(20) DEFAULT NULL;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS birthday DATE;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS personality VARCHAR(20) DEFAULT 'lively';
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP;
ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_missing_date DATE;
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
db.query("UPDATE kids SET gifts_received = 1 WHERE gifts_received = 0 AND bond_score > 0").catch(() => {});

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
app.get("/api/kids/:id/memories", auth, async (req, res) => {
  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (!kidResult.rows[0]) return res.status(404).json({ error: "孩子不存在" });
  const memories = await db.query(
    "SELECT id, content, emotion, weight, created_at FROM memories WHERE kid_id=$1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(memories.rows);
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

// ===== 通义万相 图像生成 + COS存储 =====
const COS = require('cos-nodejs-sdk-v5');
const cosClient = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

// 下载图片为Buffer
async function downloadImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('下载生成图失败');
  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// 上传Buffer到COS，返回对象key
function uploadToCos(key, buffer) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: key,
      Body: buffer,
    }, (err, data) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// 生成COS对象的签名访问URL（私有桶，临时链接）
function getCosSignedUrl(key, expires = 3600) {
  return new Promise((resolve, reject) => {
    cosClient.getObjectUrl({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: key,
      Sign: true,
      Expires: expires,
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data.Url);
    });
  });
}

app.post("/api/face/generate", auth, async (req, res) => {
  try {
   
    const { image, kid_id, use_sprouts } = req.body;
    if (!image) return res.status(400).json({ error: "缺少照片" });
    if (!kid_id) return res.status(400).json({ error: "缺少孩子信息" });

    // 取孩子信息，后端算年龄
    const kidRes = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [kid_id, req.user.id]);
    const kid = kidRes.rows[0];
    if (!kid) return res.status(404).json({ error: "孩子不存在或无权访问" });
    if (!kid.birthday) {
      return res.status(400).json({ error: "需要精准生日", need_birthday: true });
    }
    const age = kid.age_mode === 'natural' ? calcAge(kid.birthday) : kid.age;
    const gender = kid.gender;

    // 1. 查额度
    const quota = await checkPhotoQuota(req.user.id);
    const SPROUT_COST = 100;
    let payMethod = null;  // 'quota' 或 'sprouts'

    if (quota.remaining > 0) {
      payMethod = 'quota';
    } else {
      // 额度用完
      if (!use_sprouts) {
        // 前端未确认用芽豆 → 返回需确认
        return res.json({
          need_confirm: true,
          quota_used_up: true,
          sprouts: quota.sprouts,
          cost: SPROUT_COST,
          can_use_sprouts: quota.sprouts >= SPROUT_COST
        });
      }
      // 已确认用芽豆
      if (quota.sprouts < SPROUT_COST) {
        return res.status(400).json({ error: '芽豆不足', need_upgrade: true });
      }
      payMethod = 'sprouts';
    }

    // 2. 调万相生成
    const genderWord = gender === 'girl' ? '女孩' : '男孩';
    const prompt = `参考图中人物，生成一个${age}岁的可爱${genderWord}，保留参考人物的面部特征基因（相似的脸型轮廓、眼睛形状、五官比例），转化为与${age}岁相符的真实儿童面孔，符合该年龄的发型、表情，写实摄影风格，真实的皮肤质感和光影，儿童写真照片，正脸，明亮天真的笑容，自然柔和的光线，高清细节`;
    const negativePrompt = `卡通,动漫,插画,3D渲染,绘画风格,成年面孔,青少年,老态,皱纹,多张脸,重复面孔,变形,多余手指,模糊,低画质,过度曝光,恐怖谷效应,文字水印`;
    const dataUrl = `data:image/jpeg;base64,${image}`;

    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.DASHSCOPE_API_KEY },
      body: JSON.stringify({
        model: 'wan2.7-image-pro',
        input: { messages: [{ role: 'user', content: [{ image: dataUrl }, { text: prompt }] }] },
        parameters: { negative_prompt: negativePrompt, prompt_extend: true, watermark: true, n: 1, size: '1024*1024' }
      })
    });
    const data = await resp.json();

    let imgUrl = null;
    const choices = data.output?.choices;
    if (choices && choices[0]?.message?.content) {
      for (const c of choices[0].message.content) {
        if (c.image) { imgUrl = c.image; break; }
      }
    }
    if (!imgUrl) {
      console.error('wan generate no image:', JSON.stringify(data));
      return res.status(400).json({ error: '生成失败', detail: data.message || data.code || JSON.stringify(data).slice(0, 200) });
    }

    // 3. 下载 + 存COS
    const buffer = await downloadImage(imgUrl);
    
    const cosKey = `photos/${kid_id}/avatar_${Date.now()}.png`;
    await uploadToCos(cosKey, buffer);
    const signedUrl = await getCosSignedUrl(cosKey, 3600);

    // 4. 写photos表
    await db.query(
      "INSERT INTO photos (kid_id, user_id, cos_key, type, age, style) VALUES ($1,$2,$3,$4,$5,$6)",
      [kid_id || null, req.user.id, cosKey, 'avatar', parseInt(age), 'realistic']
    );

    // 5. 更新kids.avatar_generated
    if (kid_id) {
      await db.query("UPDATE kids SET avatar_generated=true WHERE id=$1", [kid_id]);
    }

    // 6. 扣费
    if (payMethod === 'quota') {
      await db.query("UPDATE users SET photo_quota_used = photo_quota_used + 1 WHERE id=$1", [req.user.id]);
    } else {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [SPROUT_COST, req.user.id]);
    }

    res.json({ image_url: signedUrl, cos_key: cosKey, pay_method: payMethod });
  } catch (e) {
    console.error('face generate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 相册：照片列表 =====
app.get("/api/kids/:id/photos", auth, async (req, res) => {
  try {
    const kidRes = await db.query("SELECT id FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!kidRes.rows[0]) return res.status(404).json({ error: "孩子不存在或无权访问" });

    const r = await db.query(
      "SELECT id, cos_key, type, theme, age, created_at FROM photos WHERE kid_id=$1 ORDER BY created_at DESC",
      [req.params.id]
    );
    // 为每张生成签名URL
    const photos = await Promise.all(r.rows.map(async (p) => ({
      id: p.id,
      url: await getCosSignedUrl(p.cos_key, 7200),
      cos_key: p.cos_key,
      type: p.type,
      theme: p.theme,
      age: p.age,
      created_at: p.created_at
    })));
    res.json({ photos });
  } catch (e) {
    console.error('photos list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 设为头像 =====
app.post("/api/kids/:id/set-avatar", auth, async (req, res) => {
  try {
    const { photo_id } = req.body;
    const kidRes = await db.query("SELECT id FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!kidRes.rows[0]) return res.status(404).json({ error: "孩子不存在或无权访问" });

    if (photo_id === null || photo_id === 0) {
      // 清除照片头像，回到emoji
      await db.query("UPDATE kids SET avatar_photo_key=NULL WHERE id=$1", [req.params.id]);
      return res.json({ ok: true, cleared: true });
    }

    const pRes = await db.query("SELECT cos_key FROM photos WHERE id=$1 AND kid_id=$2", [photo_id, req.params.id]);
    const photo = pRes.rows[0];
    if (!photo) return res.status(404).json({ error: "照片不存在" });

    await db.query("UPDATE kids SET avatar_photo_key=$1 WHERE id=$2", [photo.cos_key, req.params.id]);
    res.json({ ok: true, cos_key: photo.cos_key });
  } catch (e) {
    console.error('set avatar error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 删除照片（含COS对象）=====
app.delete("/api/photos/:id", auth, async (req, res) => {
  try {
    const r = await db.query(
      "SELECT p.id, p.cos_key, p.kid_id FROM photos p JOIN kids k ON p.kid_id=k.id WHERE p.id=$1 AND k.user_id=$2",
      [req.params.id, req.user.id]
    );
    const photo = r.rows[0];
    if (!photo) return res.status(404).json({ error: "照片不存在或无权访问" });

    // 若是当前头像，一并清除
    await db.query("UPDATE kids SET avatar_photo_key=NULL WHERE id=$1 AND avatar_photo_key=$2", [photo.kid_id, photo.cos_key]);
    // 删数据库记录
    await db.query("DELETE FROM photos WHERE id=$1", [req.params.id]);
    // 删COS对象
    cosClient.deleteObject({
      Bucket: process.env.COS_BUCKET,
      Region: process.env.COS_REGION,
      Key: photo.cos_key
    }, (err) => { if (err) console.error('cos delete error:', err.message); });

    res.json({ ok: true });
  } catch (e) {
    console.error('delete photo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 会员开通核心逻辑（永久，支付回调和测试都调用）=====
// 各档位每月照片额度
const PHOTO_QUOTA_BY_TIER = { free: 1, vip: 5, svip: 10, dvip: 20 };

// 开通/更新会员 + 设定照片额度
async function activateMembership(userId, tier, planType) {
  // tier: 'vip'|'svip'|'dvip'  planType: 'month'|'year'
  const now = new Date();
  const days = planType === 'year' ? 365 : 30;
  const expiry = new Date(now.getTime() + days * 86400000);

  const monthlyQuota = PHOTO_QUOTA_BY_TIER[tier] || 1;
  // 月卡=月额度；年卡=月额度×12，一次性给
  const total = planType === 'year' ? monthlyQuota * 12 : monthlyQuota;

  await db.query(
    `UPDATE users SET membership_type=$1, membership_expiry=$2,
     photo_quota_total=$3, photo_quota_used=0, photo_quota_reset_at=$4
     WHERE id=$5`,
    [tier, expiry, total, expiry, userId]
  );
  return { tier, expiry, total };
}

// 临时开通接口（测试用，上线前删除或加严格权限）
// 用密钥保护，防止滥用
app.post("/api/dev/activate", auth, async (req, res) => {
  try {
    const { tier, plan, secret } = req.body;
    // 简单密钥保护——换成你自己的口令
    if (secret !== 'budpei_dev_2026') return res.status(403).json({ error: '无权限' });
    if (!['vip','svip','dvip'].includes(tier)) return res.status(400).json({ error: 'tier错误' });
    if (!['month','year'].includes(plan)) return res.status(400).json({ error: 'plan错误' });

    const result = await activateMembership(req.user.id, tier, plan);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('dev activate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 照片额度检查/重置 =====
// 检查并处理额度重置，返回当前额度状态
async function checkPhotoQuota(userId) {
  const r = await db.query(
    "SELECT membership_type, membership_expiry, photo_quota_total, photo_quota_used, photo_quota_reset_at, sprouts_balance FROM users WHERE id=$1",
    [userId]
  );
  const u = r.rows[0];
  if (!u) throw new Error('用户不存在');

  const now = new Date();
  const isPaid = u.membership_type && u.membership_type !== 'free'
    && u.membership_expiry && new Date(u.membership_expiry) > now;

  let total = u.photo_quota_total || 1;
  let used = u.photo_quota_used || 0;
  let resetAt = u.photo_quota_reset_at ? new Date(u.photo_quota_reset_at) : null;
  let needUpdate = false;

  if (isPaid) {
    // 付费：到 reset_at（会员到期日）才重置。会员期内不重置（年卡累计用）
    // reset_at 已在开通时设为会员到期日，到期前不动
    if (resetAt && now >= resetAt) {
      // 会员到期了 → 降级免费逻辑（下面免费分支处理）
      // 实际上到期后 isPaid 已是 false，走不到这里；保险起见
    }
  } else {
    // 免费：日历月重置
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (!resetAt || resetAt < thisMonthStart) {
      // 新月了，或从未设置 → 重置
      total = 1;
      used = 0;
      // 下月1号为下次重置点
      resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      needUpdate = true;
    } else {
      total = 1; // 免费固定1张
    }
  }

  if (needUpdate) {
    await db.query(
      "UPDATE users SET photo_quota_total=$1, photo_quota_used=$2, photo_quota_reset_at=$3 WHERE id=$4",
      [total, used, resetAt, userId]
    );
  }

  return {
    membership_type: isPaid ? u.membership_type : 'free',
    total, used,
    remaining: Math.max(0, total - used),
    sprouts: u.sprouts_balance || 0,
    reset_at: resetAt
  };
}

// 额度查询接口
app.get("/api/photo/quota", auth, async (req, res) => {
  try {
    const q = await checkPhotoQuota(req.user.id);
    res.json(q);
  } catch (e) {
    console.error('photo quota error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 内容安全巡检后台（管理员） =====
const adminAuth = (req, res, next) => {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "无权限" });
  }
  next();
};

app.get("/api/admin/flagged", adminAuth, async (req, res) => {
  const r = await db.query("SELECT m.id, m.user_id, m.kid_id, m.role, m.content, m.risk_flag, m.created_at, u.email FROM messages m LEFT JOIN users u ON m.user_id=u.id WHERE m.risk_flag IS NOT NULL ORDER BY m.created_at DESC LIMIT 200");
  res.json(r.rows);
});

app.get("/api/admin/sample", adminAuth, async (req, res) => {
  const r = await db.query("SELECT m.id, m.user_id, m.kid_id, m.role, m.content, m.risk_flag, m.created_at, u.email FROM messages m LEFT JOIN users u ON m.user_id=u.id ORDER BY RANDOM() LIMIT 50");
  res.json(r.rows);
});

app.get("/api/admin/complaints", adminAuth, async (req, res) => {
  const r = await db.query("SELECT c.*, u.email FROM complaints c LEFT JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC LIMIT 200");
  res.json(r.rows);
});

app.post("/api/admin/complaints/:id/process", adminAuth, async (req, res) => {
  const { note } = req.body;
  await db.query("UPDATE complaints SET status='processed', processed_at=NOW(), process_note=$1 WHERE id=$2", [note || '', req.params.id]);
  res.json({ ok: true });
});
app.post("/api/admin/users/:id/action", adminAuth, async (req, res) => {
  const { action, reason } = req.body;
  const valid = ['normal', 'warned', 'limited', 'suspended'];
  if (!valid.includes(action)) return res.status(400).json({ error: "invalid action" });
  await db.query("UPDATE users SET status=$1 WHERE id=$2", [action, req.params.id]);
  await db.query("INSERT INTO user_actions (user_id, action, reason) VALUES ($1, $2, $3)", [req.params.id, action, reason || '']);
  res.json({ ok: true });
});
app.get("/api/admin/actions", adminAuth, async (req, res) => {
  const r = await db.query("SELECT a.*, u.email FROM user_actions a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 200");
  res.json(r.rows);
});
app.post("/api/account/delete", auth, async (req, res) => {
  const uid = req.user.id;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE complaints SET user_id=NULL WHERE user_id=$1", [uid]);
    await client.query("UPDATE user_actions SET user_id=NULL WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM messages WHERE user_id=$1", [uid]);
    await client.query("DELETE FROM users WHERE id=$1", [uid]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "注销失败，请稍后重试" });
  } finally {
    client.release();
  }
});
app.get("/api/admin/fix-gifts", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  const r = await db.query("UPDATE kids SET gifts_received = 6 WHERE gifts_received > 6 RETURNING id, name, gifts_received");
  res.json({ ok: true, fixed: r.rowCount, rows: r.rows });
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
// === 灵魂数据预留字段 ===
db.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS emotion VARCHAR(20) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS emotion VARCHAR(20) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 5").catch(() => {});
db.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS people VARCHAR(100) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_period VARCHAR(20) DEFAULT NULL").catch(() => {});

db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS soul_uuid UUID DEFAULT gen_random_uuid()").catch(() => {});
// ===== 影像功能：相册表 + 字段 =====
db.query(`CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  cos_key VARCHAR(300) NOT NULL,
  type VARCHAR(20) DEFAULT 'avatar',
  theme VARCHAR(100) DEFAULT NULL,
  age INTEGER DEFAULT NULL,
  style VARCHAR(20) DEFAULT 'realistic',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_generated BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_intro_shown BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_quota_used INTEGER DEFAULT 0").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_quota_month VARCHAR(7) DEFAULT NULL").catch(() => {});db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_prompt_sent BOOLEAN DEFAULT false").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_quota_total INTEGER DEFAULT 1").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_quota_reset_at DATE DEFAULT NULL").catch(() => {});db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS gifts_received INTEGER DEFAULT 0").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_photo_key VARCHAR(300) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS parent_interests TEXT").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar_prompt_date TIMESTAMP DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_type VARCHAR(10) DEFAULT 'free'").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_expiry TIMESTAMP DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS sprouts_balance INTEGER DEFAULT 0").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_date DATE DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sprouts_grant DATE DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS daily_msg_count INTEGER DEFAULT 0").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS daily_msg_date DATE DEFAULT NULL").catch(() => {});
db.query(`ALTER TABLE kids ADD COLUMN IF NOT EXISTS personality_seed JSONB DEFAULT NULL`).catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'normal'").catch(() => {});
db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS openid VARCHAR(64) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_mem_inject_at TIMESTAMP DEFAULT NULL").catch(() => {});
db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_openid ON users(openid) WHERE openid IS NOT NULL").catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS user_actions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(20),
  reason TEXT,
  operator VARCHAR(50) DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

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
db.query(`CREATE TABLE IF NOT EXISTS wish_pool (
  id SERIAL PRIMARY KEY,
  kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  emoji TEXT DEFAULT '🌟',
  created_at TIMESTAMP DEFAULT NOW(),
  fulfilled_at TIMESTAMP DEFAULT NULL
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS complaints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  category VARCHAR(50),
  content TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP DEFAULT NULL,
  process_note TEXT DEFAULT NULL
)`).catch(() => {});

// 会员芽豆发放函数
async function grantMembershipSprouts(userId, membershipType) {
  const sproutsMap = { vip: 2000, svip: 4000, dvip: 10000 };
  const amount = sproutsMap[membershipType];
  if (!amount) return;
  const today = new Date().toISOString().slice(0, 10);
  await db.query(
    "UPDATE users SET sprouts_balance = sprouts_balance + $1, last_sprouts_grant = $2 WHERE id = $3",
    [amount, today, userId]
  );
}

// 对话日志留存:正文保存满6个月后清理正文,保留元数据用于溯源(生成式AI备案合规)
cron.schedule('0 3 * * *', async () => {
 try {
 const result = await db.query(
 "UPDATE messages SET content = '[内容已按留存期清理]' WHERE created_at < NOW() - INTERVAL '6 months' AND content != '[内容已按留存期清理]'"
 );
 if (result.rowCount > 0) console.log(`日志正文清理: ${result.rowCount} 条超期消息已清理`);
 } catch(e) {
 console.error('日志清理错误:', e.message);
 }
});

// 每月1日定时发放芽豆
cron.schedule('0 0 1 * *', async () => {
  console.log('Monthly sprouts grant starting...');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const users = await db.query(
      `SELECT id, membership_type, last_sprouts_grant FROM users 
      WHERE membership_type IN ('vip','svip','dvip')
      AND (last_sprouts_grant IS NULL OR last_sprouts_grant < NOW() - INTERVAL '25 days')`
    );
    for (const user of users.rows) {
      await grantMembershipSprouts(user.id, user.membership_type);
    }
    console.log(`Monthly sprouts granted to ${users.rows.length} users`);
  } catch(e) {
    console.error('Monthly sprouts error:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log("Server running on port " + PORT)));
