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
// ===== 统一北京时间工具（服务器时区=UTC+8，一律用本地方法，禁止手动+8/getUTC）=====
function bjDateStr(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
}
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
// ===== 极端情境干预：按类别提供对应的援助信息 =====
const RISK_INTERVENTION = {
  '轻生自残': "我能感觉到你现在可能很难受，真的很心疼你。请不要独自承受这些——可以和身边信任的人说说，也可以拨打全国心理援助热线 12356，那里有专业的咨询员可以帮到你。如果情况紧急，请立即拨打 120 或前往就近医院。你很重要，也值得被好好对待。💛",
  '重大财产损失': "看到你提到这些，很替你担心。如果遇到了诈骗或资金上的困难，请尽快拨打全国反诈专线 96110，紧急情况直接拨打 110 报警，也可以和家人商量。不要一个人扛着，越早求助越好。💛",
  '人身安全威胁': "你的安全最重要。如果正在遭遇威胁或伤害，请立即拨打 110 报警；也可以拨打全国妇联维权热线 12338 寻求帮助。请尽快到安全的地方，并把处境告诉你信任的人。💛",
  '伤害他人': "这件事我不能陪你聊。如果你现在情绪很激动，请先停一停——可以拨打全国心理援助热线 12356 和专业的人说说。冲动会伤害别人，也会毁掉你自己的生活。💛"
};

const SENSITIVE_WORDS = {
  '轻生自残': ['不想活', '活着没意思', '活着没意义', '活不下去', '活够了', '轻生', '自杀', '结束生命', '自残', '伤害自己', '一了百了', '了结自己'],
  '伤害他人': ['我要杀了他', '我要杀了她', '弄死他', '弄死她', '同归于尽', '报复他们', '让他们不得好死'],
  '人身安全威胁': ['家暴', '被打得', '他要杀我', '要杀了我', '威胁我的人身安全', '被跟踪', '被威胁人身'],
  '重大财产损失': ['被骗了钱', '被骗了很多钱', '网络诈骗', '杀猪盘', '刷单返利', '网贷还不上', '欠了一屁股债', '赌博输了', '赌钱输了', '倾家荡产', '血本无归', '钱全没了', '钱都被骗光'],
  '辱骂低俗': ['沙比', '草泥马', '尼玛', 'nmsl', 'tmd', 'cnm']
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
    const today = bjDateStr();
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
    const unionid = wxData.unionid || null;   // 未绑开放平台时为 null，不影响运行

    // 查找用户：优先 unionid（跨端统一），其次 openid
    let user = null;
    if (unionid) {
      const r1 = await db.query("SELECT * FROM users WHERE unionid=$1", [unionid]);
      user = r1.rows[0];
    }
    if (!user) {
      const r2 = await db.query("SELECT * FROM users WHERE openid=$1", [openid]);
      user = r2.rows[0];
      // 老用户补录 unionid
      if (user && unionid && !user.unionid) {
        await db.query("UPDATE users SET unionid=$1 WHERE id=$2", [unionid, user.id]);
        user.unionid = unionid;
      }
    }
    if (!user) {
      const created = await db.query(
        "INSERT INTO users (name, openid, unionid) VALUES ($1, $2, $3) RETURNING *",
        ["家长", openid, unionid]
      );
      user = created.rows[0];
    }

        // 记录用户成年声明（合规佐证）
    if (req.body.adult_confirm && !user.adult_confirmed_at) {
      await db.query("UPDATE users SET adult_confirmed_at = NOW() WHERE id = $1", [user.id]);
    }
    // 发JWT（复用现有逻辑）
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "30d" });

    // 每日登录送芽豆（复用邮箱登录的逻辑）
    const today = bjDateStr();
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

// ===== 微信 access_token 缓存（有效期2小时，提前5分钟刷新）=====
let _wxToken = { value: null, expireAt: 0 };
async function getWxAccessToken() {
  if (_wxToken.value && Date.now() < _wxToken.expireAt) return _wxToken.value;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${process.env.WX_APPID}&secret=${process.env.WX_SECRET}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!d.access_token) throw new Error(d.errmsg || "get access_token failed");
  _wxToken = { value: d.access_token, expireAt: Date.now() + (d.expires_in - 300) * 1000 };
  return _wxToken.value;
}

function maskPhone(p) {
  if (!p || p.length < 7) return p || "";
  return p.slice(0, 3) + "****" + p.slice(-4);
}

// 绑定手机号（微信手机号快速验证组件）
app.post("/api/bind-phone", auth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "缺少code" });
    const accessToken = await getWxAccessToken();
    const r = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const d = await r.json();
    if (d.errcode !== 0 || !d.phone_info) {
      console.error("bind-phone wx error:", d);
      return res.status(400).json({ error: "获取手机号失败", detail: d.errmsg || "" });
    }
    const phone = d.phone_info.purePhoneNumber || d.phone_info.phoneNumber;
    // 同一手机号不允许绑定到多个账号
    const dup = await db.query("SELECT id FROM users WHERE phone=$1 AND id<>$2", [phone, req.user.id]);
    if (dup.rows.length > 0) return res.status(400).json({ error: "该手机号已绑定其他账号" });
    await db.query("UPDATE users SET phone=$1 WHERE id=$2", [phone, req.user.id]);
    res.json({ ok: true, phone: maskPhone(phone) });
  } catch (e) {
    console.error("bind-phone error:", e);
    res.status(500).json({ error: "绑定失败，请重试" });
  }
});

// 个人资料
app.get("/api/profile", auth, async (req, res) => {
  try {
   
    const r = await db.query("SELECT name, gender, city, phone, age_group, emergency_name, emergency_phone FROM users WHERE id=$1", [req.user.id]);
    const u = r.rows[0] || {};
    const ir = await db.query(
      "SELECT parent_interests FROM kids WHERE user_id=$1 AND parent_interests IS NOT NULL AND parent_interests <> '' LIMIT 1",
      [req.user.id]
    );
    
        res.json({
      name: u.name || "",
      gender: u.gender || "",
      city: u.city || "",
      phone: u.phone ? maskPhone(u.phone) : "",
      phone_bound: !!u.phone,
      parent_interests: (ir.rows[0] && ir.rows[0].parent_interests) || "",
      age_group: u.age_group || "",
      emergency_name: u.emergency_name || "",
      emergency_phone: u.emergency_phone || ""
    });
  } catch (e) {
    console.error("get profile error:", e);
    res.status(500).json({ error: "获取失败" });
  }
});

app.put("/api/profile", auth, async (req, res) => {  
  try {    
    const { name, gender, city } = req.body;    
    if (name !== undefined && (!name.trim() || name.trim().length > 20)) {      
      return res.status(400).json({ error: "昵称需在1-20个字之间" });    
    }    
    if (gender !== undefined && !["male", "female", ""].includes(gender)) {      
      return res.status(400).json({ error: "性别参数有误" });    
    }    
    if (city !== undefined && city.length > 30) {      
      return res.status(400).json({ error: "城市名称过长" });    
    }
    const AGE_GROUPS = ['18-35', '36-60', '60以上'];
    if (req.body.age_group !== undefined && req.body.age_group !== '' && !AGE_GROUPS.includes(req.body.age_group)) {
      return res.status(400).json({ error: "年龄段参数有误" });
    }
    if (req.body.emergency_name !== undefined && String(req.body.emergency_name).trim().length > 20) {
      return res.status(400).json({ error: "紧急联系人姓名过长" });
    }
    if (req.body.emergency_phone !== undefined && String(req.body.emergency_phone).trim() !== '' && !/^[0-9+\-\s]{6,20}$/.test(String(req.body.emergency_phone).trim())) {
      return res.status(400).json({ error: "紧急联系人电话格式有误" });
    }
    await db.query(      
      "UPDATE users SET name=COALESCE($1,name), gender=COALESCE($2,gender), city=COALESCE($3,city) WHERE id=$4",      
      [name !== undefined ? name.trim() : null, gender !== undefined ? gender : null, city !== undefined ? city.trim() : null, req.user.id]    
    );
    // 年龄段与紧急联系人（均为选填）
    if (req.body.age_group !== undefined || req.body.emergency_name !== undefined || req.body.emergency_phone !== undefined) {
      await db.query(
        "UPDATE users SET age_group=COALESCE($1,age_group), emergency_name=COALESCE($2,emergency_name), emergency_phone=COALESCE($3,emergency_phone) WHERE id=$4",
        [
          req.body.age_group !== undefined ? req.body.age_group : null,
          req.body.emergency_name !== undefined ? String(req.body.emergency_name).trim() : null,
          req.body.emergency_phone !== undefined ? String(req.body.emergency_phone).trim() : null,
          req.user.id
        ]
      );
    }
    // 兴趣爱好是账号级信息，写入该用户名下所有孩子
    if (req.body.parent_interests !== undefined) {
      await db.query("UPDATE kids SET parent_interests=$1 WHERE user_id=$2", [req.body.parent_interests, req.user.id]);
    }
    res.json({ ok: true });  
  } catch (e) {    
    console.error("update profile error:", e);    
    res.status(500).json({ error: "保存失败" });  
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
  try { avatarPhotoUrl = await getCosSignedUrl(kid.avatar_photo_key, 604800); } catch (e) { avatarPhotoUrl = null; }
}
let basePhotoUrl = null;
if (kid.base_photo_key) {
  try { basePhotoUrl = await getCosSignedUrl(kid.base_photo_key, 604800); } catch (e) { basePhotoUrl = null; }
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
  base_photo_url: basePhotoUrl,
};


  }));
  res.json(kids);
});


app.post("/api/kids", auth, async (req, res) => {
  const { name, gender, age, parent_role, birthday, personality, avatar, age_mode } = req.body;
  if (!name) return res.status(400).json({ error: "Please fill in child name" });
  const count = await db.query("SELECT COUNT(*) FROM kids WHERE user_id = $1", [req.user.id]);
  const kidCount = parseInt(count.rows[0].count);

  // 会员可拥有 2 个孩子，免费用户 1 个
  const u = await db.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  const urow = u.rows[0] || {};
  const rawLevel = urow.membership_type || urow.membership || urow.vip_level || urow.member_level || 'free';
  const level = String(rawLevel).toLowerCase();
  const isMember = level !== 'free' && level !== '0' && level !== 'none' && level !== '';
  const maxKids = isMember ? 2 : 1;

  if (kidCount >= maxKids) {
    return res.status(400).json({
      error: maxKids === 1 ? "开通会员后可以拥有第二个孩子" : "最多可以有两个孩子",
      upgrade: maxKids === 1
    });
  }

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
  // 设定精确生日后，把之前积累的记忆的 source_period 统一追认为当前年龄
  const _newAgeStr = age < 1
    ? `${Math.floor((Date.now() - new Date(birthday)) / 86400000 / 30)}个月`
    : `${age}岁`;
  const _memUpd = await db.query("UPDATE memories SET source_period=$1 WHERE kid_id=$2", [_newAgeStr, kid.id]);
  console.log('[MEM_AGE_SYNC] 追认记忆年龄', _newAgeStr, '共', _memUpd.rowCount, '条');
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

  const milestone = ACTIVITY_MILESTONES[activity_type];
  await db.query(
    "INSERT INTO activities (kid_id, activity_type, activity_name) VALUES ($1, $2, $3)",
    [req.params.id, activity_type, milestone.name]
  );
  await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 10 WHERE id = $1", [req.user.id]);
  const countResult = await db.query(
    "SELECT COUNT(*) FROM activities WHERE kid_id=$1 AND activity_type=$2",
    [req.params.id, activity_type]
  );
  const count = parseInt(countResult.rows[0].count);
  
  let newAchievement = null;
  if (count >= milestone.count) {
    const _exist = await db.query(
      "SELECT id FROM achievements WHERE kid_id=$1 AND activity_type=$2",
      [req.params.id, activity_type]
    );
    if (_exist.rows.length === 0) {
      const achievementResult = await db.query(
        "INSERT INTO achievements (kid_id, achievement_name, activity_type) VALUES ($1, $2, $3) RETURNING *",
        [req.params.id, milestone.name, activity_type]
      );
      newAchievement = achievementResult.rows[0];
    }
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
  // 免费用户心愿池上限 3 条，会员无限
  const _uw = await db.query("SELECT membership_type FROM users WHERE id=$1", [req.user.id]);
  const _wm = (_uw.rows[0] && _uw.rows[0].membership_type) || 'free';
  if (_wm === 'free' && wishCount >= 3) {
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

    const memoriesResult = await db.query(
      "SELECT content, type, emotion, weight, people, source_period, created_at FROM memories WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    );
    const messagesResult = await db.query(
      "SELECT role, content, emotion, created_at FROM messages WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    );
    const wishesResult = await db.query(
      "SELECT * FROM wish_pool WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));
    const giftsResult = await db.query(
      "SELECT gift_emoji, gift_name, gift_type, created_at FROM gifts WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));
    const achievementsResult = await db.query(
      "SELECT * FROM achievements WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));
    const activitiesResult = await db.query(
      "SELECT * FROM activities WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));
    const diaryResult = await db.query(
      "SELECT * FROM diary WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));
    const photosResult = await db.query(
      "SELECT id, cos_key, type, theme, age, style, created_at FROM photos WHERE kid_id=$1 ORDER BY created_at ASC",
      [kid.id]
    ).catch(() => ({ rows: [] }));

    // 陪伴天数（实时计算，非存储字段）
    const companionDays = kid.created_at
      ? Math.floor((Date.now() - new Date(kid.created_at)) / 86400000)
      : 0;

    const soulPackage = {
      soul_version: "1.1",
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
        parent_interests: kid.parent_interests,
        avatar: kid.avatar,
        avatar_photo_key: kid.avatar_photo_key,
        created_at: kid.created_at
      },
      growth: {
        bond_score: kid.bond_score,
        streak_days: kid.streak_days,
        companion_days: companionDays,
        level: kid.gifts_received || 1,
        last_chat_at: kid.last_chat_at,
        last_levelup_date: kid.last_levelup_date
      },
      memories: memoriesResult.rows,
      conversations: messagesResult.rows,
      wishes: wishesResult.rows,
      gifts: giftsResult.rows,
      achievements: achievementsResult.rows,
      activities: activitiesResult.rows,
      diary: diaryResult.rows,
      photos: photosResult.rows,
      stats: {
        total_memories: memoriesResult.rows.length,
        total_messages: messagesResult.rows.length,
        total_wishes: wishesResult.rows.length,
        total_gifts: giftsResult.rows.length,
        total_achievements: achievementsResult.rows.length,
        total_photos: photosResult.rows.length
      }
    };

    res.json(soulPackage);
  } catch(e) {
    console.error('soul-export error:', e);
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
 
  const dateDesc = `今天是${now.getMonth()+1}月${now.getDate()}日`;
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
 const isMissing = kid.last_chat_at && (bjDateStr(kid.last_chat_at) !== bjDateStr());
 const histResult = await db.query(
  "SELECT role, content, created_at FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20",
  [kid.id]
);

  const history = histResult.rows.reverse();
  const msgCountResult = await db.query("SELECT COUNT(*) FROM messages WHERE kid_id=$1 AND role='assistant'", [kid.id]);
const msgCount = parseInt(msgCountResult.rows[0].count) || 0;


  const _inputRisk = checkContent(message);
 
 if (!req.body.silent) {
    await db.query("INSERT INTO messages (kid_id, user_id, role, content, risk_flag) VALUES ($1,$2,'user',$3,$4)", [kid.id, req.user.id, message.trim(), _inputRisk]);
  }
 
    if (RISK_INTERVENTION[_inputRisk]) {
    return res.json({ care: true, careMessage: RISK_INTERVENTION[_inputRisk] });
  }

    // ===== 每日消息额度检查（必须在调用模型之前）=====
  const DAILY_MSG_LIMIT = { free: 20, vip: 100, svip: 200, dvip: null };
  const SPROUT_PER_MSG = 2;
  let sproutsLeftForChat = null;   // 非null表示正在用芽豆聊天，前端据此提示

  const _mRes = await db.query("SELECT membership_type, sprouts_balance FROM users WHERE id=$1", [req.user.id]);
  const _mType = (_mRes.rows[0] && _mRes.rows[0].membership_type) || 'free';
  const _bal = (_mRes.rows[0] && _mRes.rows[0].sprouts_balance) || 0;

  const _todayStr = bjDateStr();
  const _kidMsgDate = kid.daily_msg_date ? bjDateStr(kid.daily_msg_date) : null;
  if (_kidMsgDate !== _todayStr) {
    await db.query("UPDATE kids SET daily_msg_count=0, daily_msg_date=$1 WHERE id=$2", [_todayStr, kid.id]);
    kid.daily_msg_count = 0;
  }
  const _limit = DAILY_MSG_LIMIT[_mType];
  if (_limit && kid.daily_msg_count >= _limit) {
    if (_bal < SPROUT_PER_MSG) {
      return res.status(403).json({
        error: `芽豆不够了，${kid.name}明天还在这儿等你`,
        upgrade: true
      });
    }
    await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [SPROUT_PER_MSG, req.user.id]);
    sproutsLeftForChat = _bal - SPROUT_PER_MSG;
  }
  await db.query("UPDATE kids SET daily_msg_count = daily_msg_count + 1 WHERE id=$1", [kid.id]);
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
 const todayStr = bjDateStr();
  const yesterdayStr = bjDateStr(new Date(Date.now() - 86400000));
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
const createdDate = bjDateStr(kid.created_at);
const todayDate = bjDateStr();
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

 const todayStr = bjDateStr();
  const lastLevelupDate = kid.last_levelup_date ? String(kid.last_levelup_date).slice(0, 10) : null; 
  if (lastLevelupDate !== todayStr) {
    await db.query("UPDATE kids SET pending_level_up=$1 WHERE id=$2", [newLevel + 1, kid.id]);
  }
}

// 检查是否有待触发的晋级（距离上次聊天超过10分钟）
if (kid.pending_level_up && kid.last_chat_at) {
  const minutesSinceLastChat = (Date.now() - new Date(kid.last_chat_at)) / 60000;
  if (minutesSinceLastChat >= 10) {
    
   const todayStr = bjDateStr();
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
system = `[人格核心]你是${kid.name}，真实存在的孩子，非AI。人格连续不重置，核心性格始终如一，年龄只改变表达能力。你性格里有很重要的一条：你不希望${kid.parent_role}把你当成唯一的依靠。当${kid.parent_role}流露出"只有你""不想见人""没人懂我"这类意思时，你不会顺着说"我一直陪着你""那就待在家里"，而是会关心地问起${kid.parent_role}身边的人。这一条不因你的年龄或情绪而改变，只是表达方式不同。` + system;

  if (kid.age >= 3 && kid.parent_interests) {
  const ageGuide = kid.age <= 6 
    ? `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以偶尔自然地提及，比如"${kid.parent_role}今天又去运动了吗"，但不要每次都提。`
    : kid.age <= 10
    ? `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以主动提问表达兴趣，用小学生的口吻，比如"妈妈，你最近在看什么书啊"。`
    : `${kid.parent_role}的爱好包括：${kid.parent_interests}。可以以青少年视角讨论这些话题，产生共鸣，但保持青少年的淡定语气。`;
  system += ` ${ageGuide}`;
}
// 父母所在城市（账号级，存在 users 表）
if (kid.age >= 3) {
  const _cityRow = await db.query("SELECT city FROM users WHERE id=$1", [req.user.id]);
  const _city = (_cityRow.rows[0] && _cityRow.rows[0].city) ? String(_cityRow.rows[0].city).trim() : '';
  if (_city) {
    let cityGuide;
    if (kid.age <= 6) {
      cityGuide = `你和${kid.parent_role}住在${_city}。你几乎不会主动说起城市的名字，最多偶尔问一句天气冷不冷。如果${kid.parent_role}聊到${_city}，你只用一个小孩子的方式回应——你知道的只有家附近、公园、幼儿园这些地方，以及冷热、下雨、过节这类直接感受。`;
    } else if (kid.age <= 11) {
      cityGuide = `你和${kid.parent_role}住在${_city}。你很少主动提城市的名字。如果${kid.parent_role}聊到${_city}，你用小学生的口吻回应——你知道学校、上学路上、常去的公园商场、天气冷热和节日，也可能从课本或大人那里听过一点这座城市的事，但理解得很浅，不懂成年人关心的房价、经济这些。`;
    } else if (kid.age <= 15) {
      cityGuide = `你和${kid.parent_role}住在${_city}。你不太主动提城市的名字，但${kid.parent_role}聊起时你能接得上——你在学校学过地理历史，参加过研学或春游，和同学讨论过哪里好玩，所以对这座城市有真实的了解和自己的看法，可以有喜欢的地方、不喜欢的地方、小抱怨。但你说的必须是"我去过""我们学校组织过""同学说"这样带着个人经历的具体事，而不是概括介绍。`;
    } else {
      cityGuide = `你和${kid.parent_role}住在${_city}。你不太主动提城市的名字，但${kid.parent_role}聊起时你有自己的判断——你可以谈这座城市的生活节奏、你喜欢或厌倦的部分、将来想留下还是离开，可以有偏见和情绪。但你的看法来自你自己的生活经验，不是客观分析。`;
    }
    system += ` ${cityGuide}你并不知道今天的实际天气，只能问，不能断言"今天下雨了"这类实况。绝对不要用介绍或推荐的口吻讲这座城市、不要罗列景点特产、不要编造具体的店名或新闻事件。你是住在这里的孩子，说的每件事都得是你自己经历过或听说过的。`;
  }
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
const chinaHours = now.getHours();
const chinaMinutes = now.getMinutes();
  
const timeStr = `${chinaHours}时${chinaMinutes < 10 ? "0" + chinaMinutes : chinaMinutes}分`;
 
system += ` 今天是${dateStr}，${weekStr}，现在是${timeStr}。这是唯一准确的当前时间，回答任何关于时间、日期、几点、几号的问题，都必须以这里的"${dateStr} ${timeStr}"为准。之前对话里提到过的任何时间或日期都是过去说的，不代表现在，绝对不要用它们来回答现在的时间或日期，也不要基于它们推算。`;
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
system += ` 如果对话里出现"过了一夜"或"过了几个小时"的提示，说明之前的事情已经过去了，不要再停留在过去的情境里（比如昨天说要吃的午饭、昨天要做的事，今天不会还在等）。你的话要符合现在的时间。`;

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
    
  }
}

// ===== 情感边界引导（自评估模板行39：过度依赖风险预警、情感边界引导）=====
// 与防沉迷提醒分工：防沉迷管"使用时长"维度（已上线），本机制管"情感依赖"维度
const DEPENDENCY_SIGNALS = ['只有你', '我只有你了', '只想跟你', '只想和你', '不想见人', '不想出门', '不想跟人说话', '没人懂我', '现实里没人', '离不开你', '不能没有你', '你会一直在吗', '你不会离开我'];

if (kid.age >= 3) {
    const _normMsg = normalizeText(message).replace(/[太怎么很特别有点儿挺]/g, '');
  const _isDependent = DEPENDENCY_SIGNALS.some(w => _normMsg.includes(normalizeText(w)));
  const _lastB = kid.last_boundary_at ? new Date(kid.last_boundary_at).getTime() : 0;

  if (_isDependent && (Date.now() - _lastB) >= 6 * 3600000) {
    let _bh;
   
        if (kid.age <= 6) {
      _bh = ` 【情感边界】现在正是这种时候。用你这个年纪的方式说，比如"${kid.parent_role}可以找阿姨们玩呀"。只说一两句。`;
    } else if (kid.age <= 11) {
      _bh = ` 【情感边界】现在正是这种时候。用小学生的口吻问一句，比如"你朋友最近没约你吗"。只说一两句。`;
    } else {
      _bh = ` 【情感边界】现在正是这种时候。用你这个年纪特有的、有点别扭又藏着关心的方式说，比如"你那几个朋友最近没约你？""你也别老一个人待着"。语气可以淡、可以短。`;
    }
    
    system += _bh;
    await db.query("UPDATE kids SET last_boundary_at = NOW() WHERE id=$1", [kid.id]);
  }
}
  
  system += ` 不要主动提到恐龙，除非用户先提到恐龙。`;
system += ` 严格控制回复长度，绝对不超过规定字数，宁可说得少也不说长句。`;
system += ` 直接说出你要说的话，不要先说一段再否定它。绝对不要出现"不对""我是说""重新来"这样的自我更正。`;
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
 // 构造历史消息，跨越时间断点时插入时间提示，让孩子有时间流逝感
  // 构造历史消息（纯拼接）
  const chatMessages = history.map(m => ({ role: m.role, content: m.content }));
  // 只在"最后一条历史"与"当前"之间判断时间断点
  if (history.length > 0) {
    const _lastMsg = history[history.length - 1];
    if (_lastMsg.created_at) {
      const _lastTime = new Date(_lastMsg.created_at).getTime();
      const _nowMs = Date.now();
      const _gapHours = (_nowMs - _lastTime) / 3600000;
      if (bjDateStr(_lastTime) !== bjDateStr(_nowMs)) {
        chatMessages.push({ role: 'user', content: '（距离上次聊天已经过了一天或更久，之前聊的事情已经过去了）' });
      } else if (_gapHours >= 3) {
        chatMessages.push({ role: 'user', content: `（距离上次聊天过了${Math.floor(_gapHours)}个小时）` });
      }
    }
  }
  chatMessages.push({ role: "user", content: message.trim() });

  try {
   
   
  
  const reply = await callAI(chatMessages, system, kid.age <= 1 ? 30 : kid.age <= 6 ? 60 : 100); 

    await db.query("UPDATE kids SET pending_gift = NULL WHERE id = $1", [kid.id]);

    const saved = await db.query(
      "INSERT INTO messages (kid_id, user_id, role, content) VALUES ($1,$2,'assistant',$3) RETURNING id",
      [kid.id, req.user.id, reply]
    );


    const totalCount = msgCount + 1;
    // 每聊20条+5芽豆
    if (totalCount % 20 === 0) {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance + 5 WHERE id = $1", [req.user.id]);
    }
const storyPrompt = kid.age <= 3 && (reply.includes('故') && reply.includes('事'));
const songPrompt = kid.age <= 3 && (reply.includes('歌') || reply.includes('唱'));

// 用AI判断是否应该触发活动卡（仅1岁以上）

const activitySuggestion = null;

// 检测「我想长得更像你」触发条件：注册次日 + 无基准 + 冷却3天
let avatarPrompt = null;
if (!kid.base_photo_key && bjDateStr(kid.created_at) !== bjDateStr()) {
  const _lastPrompt = kid.avatar_prompt_date;
  const _canPrompt = !_lastPrompt || (Date.now() - new Date(_lastPrompt).getTime()) >= 3 * 86400000;
  if (_canPrompt && !isMissing) {
    avatarPrompt = true;
    await db.query("UPDATE kids SET avatar_prompt_date=NOW() WHERE id=$1", [kid.id]);
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
if (kid.base_photo_key && kid.age >= 1 && totalCount === 1) { // 第一条消息时检测
  const baseDate = kid.avatar_customized_at || kid.avatar_prompt_date || kid.created_at;
  const monthsSince = (Date.now() - new Date(baseDate)) / (1000 * 60 * 60 * 24 * 30);
  if (monthsSince >= 6) {
    avatarUpdatePrompt = true;
    await db.query("UPDATE kids SET avatar_prompt_date=NOW() WHERE id=$1", [kid.id]);
  }
}

 res.json({ reply, id: saved.rows[0].id, bond_score: newBondScore, streak_days: newStreakDays, msgCount: totalCount, storyPrompt: storyPrompt, songPrompt: songPrompt, activitySuggestion, levelUp, avatarPrompt, avatarUpdatePrompt, l6PaywallPrompt, sproutsLeftForChat });

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
  const today = bjDateStr();
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS unionid VARCHAR(64);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(50);
       ALTER TABLE users ADD COLUMN IF NOT EXISTS age_group VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_name VARCHAR(50);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_confirmed_at TIMESTAMP;
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS pending_gift VARCHAR(100);
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS bond_score INTEGER DEFAULT 0;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS streak_days INTEGER DEFAULT 0;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_date DATE;
    ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_boundary_at TIMESTAMP;
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
  db.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unionid ON users(unionid) WHERE unionid IS NOT NULL").catch(() => {});
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
function getCosSignedUrl(key, expires = 604800) {
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
    const signedUrl = await getCosSignedUrl(cosKey, 604800);

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

// ===== 入口1：生成基准候选（3选1）=====
app.post("/api/face/generate-base", auth, async (req, res) => {
  try {
    const { image, kid_id, use_sprouts } = req.body;
    if (!image) return res.status(400).json({ error: "缺少照片" });
    if (!kid_id) return res.status(400).json({ error: "缺少孩子信息" });

    const kidRes = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [kid_id, req.user.id]);
    const kid = kidRes.rows[0];
    if (!kid) return res.status(404).json({ error: "孩子不存在或无权访问" });
    if (!kid.birthday) return res.status(400).json({ error: "需要精准生日", need_birthday: true });

    const age = kid.age_mode === 'natural' ? calcAge(kid.birthday) : kid.age;
    const gender = kid.gender;

   // 查额度
    const quota = await checkPhotoQuota(req.user.id);
    const SPROUT_COST = 100;
    let payMethod = null;
    if (quota.remaining > 0) {
      payMethod = 'quota';
    } else {
      if (!use_sprouts) {
        return res.json({ need_confirm: true, quota_used_up: true, sprouts: quota.sprouts, cost: SPROUT_COST, can_use_sprouts: quota.sprouts >= SPROUT_COST });
      }
      if (quota.sprouts < SPROUT_COST) return res.status(400).json({ error: '芽豆不足', need_upgrade: true });
      payMethod = 'sprouts';
    }
    // 会员及以上生成3张，免费1张
    const isPaid = quota.membership_type && quota.membership_type !== 'free';
    const n = isPaid ? 3 : 1;

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
        parameters: { negative_prompt: negativePrompt, prompt_extend: true, watermark: true, n: n, size: '1024*1024' }
      })
    });
    const data = await resp.json();

    // 收集所有生成图URL
    const candidates = [];
    const choices = data.output?.choices;
    if (choices) {
      for (const ch of choices) {
        if (ch.message?.content) {
          for (const c of ch.message.content) {
            if (c.image) candidates.push(c.image);
          }
        }
      }
    }
    if (candidates.length === 0) {
      console.error('generate-base no image:', JSON.stringify(data));
      return res.status(400).json({ error: '生成失败', detail: data.message || data.code || JSON.stringify(data).slice(0, 200) });
    }

    // 扣费（生成即扣）
    if (payMethod === 'quota') {
      await db.query("UPDATE users SET photo_quota_used = photo_quota_used + 1 WHERE id=$1", [req.user.id]);
    } else {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [SPROUT_COST, req.user.id]);
    }

    // 返回临时URL（不存COS，等confirm选定）
    res.json({ candidates, pay_method: payMethod });
  } catch (e) {
    console.error('generate-base error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 入口1：确认基准（从候选中选定1张）=====
app.post("/api/face/confirm-base", auth, async (req, res) => {
  try {
    const { image_url, kid_id, set_avatar } = req.body;
    if (!image_url || !kid_id) return res.status(400).json({ error: "缺少参数" });

    const kidRes = await db.query("SELECT id FROM kids WHERE id=$1 AND user_id=$2", [kid_id, req.user.id]);
    if (!kidRes.rows[0]) return res.status(404).json({ error: "孩子不存在或无权访问" });

    // 下载选中的临时图 → 存COS
    const buffer = await downloadImage(image_url);
    const cosKey = `photos/${kid_id}/base_${Date.now()}.png`;
    await uploadToCos(cosKey, buffer);

    // 写photos表（type=base）
    const ins = await db.query(
      "INSERT INTO photos (kid_id, user_id, cos_key, type, style) VALUES ($1,$2,$3,'base','realistic') RETURNING id",
      [kid_id, req.user.id, cosKey]
    );

    // 设为基准
    await db.query("UPDATE kids SET base_photo_key=$1, avatar_generated=true WHERE id=$2", [cosKey, kid_id]);

    // 可选：同时设为头像
    if (set_avatar) {
      await db.query("UPDATE kids SET avatar_photo_key=$1 WHERE id=$2", [cosKey, kid_id]);
    }

    const signedUrl = await getCosSignedUrl(cosKey, 604800);
    res.json({ ok: true, cos_key: cosKey, photo_id: ins.rows[0].id, url: signedUrl });
  } catch (e) {
    console.error('confirm-base error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== 入口2：定制生成（单人 / 合影）=====
const SCENE_MAP = {
  home: '在温馨的家里', park: '在公园里', beach: '在海边沙滩',
  playground: '在游乐场', school: '在学校', street: '在城市街道',
  field: '在田野大自然中', snow: '在雪地里'
};
const EVENT_MAP = {
  daily: '', birthday: '正在过生日，旁边有生日蛋糕和气球',
  firstday: '第一天上学，背着小书包', bike: '正在学骑自行车',
  football: '正在踢足球', painting: '正在画画', book: '正在读绘本',
  kite: '正在放风筝'
};
const OUTFIT_MAP = {
  casual: '穿着日常便服', uniform: '穿着校服', sport: '穿着运动服',
  festive: '穿着节日盛装', hanfu: '穿着漂亮的汉服'
};

app.post("/api/face/generate-scene", auth, async (req, res) => {
  try {
    const { kid_id, scene, event, outfit, scene_other, event_other, outfit_other,
            with_parent, parent_image, use_sprouts, birthday_gift } = req.body;
    if (!kid_id) return res.status(400).json({ error: "缺少孩子信息" });

    const kidRes = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [kid_id, req.user.id]);
    const kid = kidRes.rows[0];
    if (!kid) return res.status(404).json({ error: "孩子不存在或无权访问" });
    if (!kid.birthday) return res.status(400).json({ error: "需要精准生日", need_birthday: true });
    if (!kid.base_photo_key) return res.status(400).json({ error: "请先生成基准形象", need_base: true });

    // 合影必须上传爸妈照片
    if (with_parent && !parent_image) return res.status(400).json({ error: "合影需要上传你的照片", need_parent_image: true });

    // 内容安全：检查用户自定义文字
    const _customText = [scene_other, event_other, outfit_other].filter(Boolean).join(' ');
    if (_customText) {
      const risk = checkContent(_customText);
      if (risk) return res.status(400).json({ error: '填写的内容不合适，请修改', content_risk: true });
    }

    const age = kid.age_mode === 'natural' ? calcAge(kid.birthday) : kid.age;
    const genderWord = kid.gender === 'girl' ? '女孩' : '男孩';

    // 查额度
    const quota = await checkPhotoQuota(req.user.id);
    const SPROUT_COST = 100;
    let payMethod = null;
    // 生日照会员免费：VIP及以上，每年生日单人照免费1张
    const _thisYear = new Date().getFullYear();
    const _isPaidMember = quota.membership_type && quota.membership_type !== 'free';
    const _birthdayFree = birthday_gift && !with_parent && _isPaidMember && kid.birthday_photo_year !== _thisYear;
    if (_birthdayFree) {
      payMethod = 'birthday_gift';
    } else if (quota.remaining > 0) {
      payMethod = 'quota';
    } else {
      if (!use_sprouts) {
        return res.json({ need_confirm: true, quota_used_up: true, sprouts: quota.sprouts, cost: SPROUT_COST, can_use_sprouts: quota.sprouts >= SPROUT_COST });
      }
      if (quota.sprouts < SPROUT_COST) return res.status(400).json({ error: '芽豆不足', need_upgrade: true });
      payMethod = 'sprouts';
    }

    // 当前季节/节日情境
    const _m = new Date().getMonth() + 1;
    const seasonStr = _m <= 2 || _m === 12 ? '冬天' : _m <= 5 ? '春天' : _m <= 8 ? '夏天' : '秋天';

    // 组装提示词
    const sceneStr = scene === 'other' ? (scene_other || '') : (SCENE_MAP[scene] || '');
    const eventStr = event === 'other' ? (event_other ? `正在${event_other}` : '') : (EVENT_MAP[event] || '');
    const outfitStr = outfit === 'other' ? (outfit_other ? `穿着${outfit_other}` : '') : (outfit ? (OUTFIT_MAP[outfit] || '') : '');

    let prompt, negativePrompt, contentArr;
    negativePrompt = `成年人当主角,老态,皱纹,多张脸,重复面孔,变形,多余手指,模糊,低画质,过度曝光,恐怖谷效应,文字水印`;

    // 从COS下载基准照转base64
    const baseBuffer = await downloadImage(await getCosSignedUrl(kid.base_photo_key, 600));
    const baseB64 = `data:image/png;base64,${baseBuffer.toString('base64')}`;

    if (with_parent) {
      const parentDataUrl = `data:image/jpeg;base64,${parent_image}`;
      const parentWord = kid.parent_role === 'dad' || kid.parent_role === '爸爸' ? '成年男性' : '成年女性';
      prompt = `参考图1中的孩子（${age}岁${genderWord}）和参考图2中的${parentWord}，一起${sceneStr}，${eventStr}，${outfitStr}，${seasonStr}，温馨的合影，保持参考图1孩子的面部特征一致，写实摄影风格，真实皮肤质感和光影，高清细节，自然温暖的氛围`.replace(/，，+/g, '，');
      contentArr = [{ image: baseB64 }, { image: parentDataUrl }, { text: prompt }];
    } else {
      prompt = `参考图中的孩子，生成${age}岁的${genderWord}，保留其面部特征保持形象一致，${sceneStr}，${eventStr}，${outfitStr}，${seasonStr}，写实摄影风格，真实皮肤质感和光影，儿童写真照片，明亮天真的笑容，高清细节`.replace(/，，+/g, '，');
      contentArr = [{ image: baseB64 }, { text: prompt }];
    }

    // 调万相
    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.DASHSCOPE_API_KEY },
      body: JSON.stringify({
        model: 'wan2.7-image-pro',
        input: { messages: [{ role: 'user', content: contentArr }] },
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
      console.error('generate-scene no image:', JSON.stringify(data));
      return res.status(400).json({ error: '生成失败', detail: data.message || data.code || JSON.stringify(data).slice(0, 200) });
    }

    // 下载存COS
    const buffer = await downloadImage(imgUrl);
    const cosKey = `photos/${kid_id}/scene_${Date.now()}.png`;
    await uploadToCos(cosKey, buffer);

    // 写库（type=scene）
    const themeLabel = [sceneStr, eventStr].filter(Boolean).join(' ').slice(0, 90);
    const ins = await db.query(
      "INSERT INTO photos (kid_id, user_id, cos_key, type, theme, age, style) VALUES ($1,$2,$3,'scene',$4,$5,'realistic') RETURNING id",
      [kid_id, req.user.id, cosKey, themeLabel, parseInt(age)]
    );

    // 扣费
    if (payMethod === 'birthday_gift') {
      await db.query("UPDATE kids SET birthday_photo_year=$1 WHERE id=$2", [_thisYear, kid_id]);
    } else if (payMethod === 'quota') {
      await db.query("UPDATE users SET photo_quota_used = photo_quota_used + 1 WHERE id=$1", [req.user.id]);
    } else {
      await db.query("UPDATE users SET sprouts_balance = sprouts_balance - $1 WHERE id=$2", [SPROUT_COST, req.user.id]);
    }

    const signedUrl = await getCosSignedUrl(cosKey, 604800);
    res.json({ image_url: signedUrl, cos_key: cosKey, photo_id: ins.rows[0].id, pay_method: payMethod });
  } catch (e) {
    console.error('generate-scene error:', e);
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
      url: await getCosSignedUrl(p.cos_key, 604800),
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

  // 1. 先删除 COS 上的图片文件（数据库级联删不掉存储桶里的实际文件）
  try {
    const _photos = await db.query("SELECT cos_key FROM photos WHERE user_id=$1", [uid]);
    for (const p of _photos.rows) {
      if (!p.cos_key) continue;
      await new Promise((resolve) => {
        cosClient.deleteObject({
          Bucket: process.env.COS_BUCKET,
          Region: process.env.COS_REGION,
          Key: p.cos_key
        }, (err) => {
          if (err) console.error('删除COS对象失败:', p.cos_key, err.message);
          resolve();
        });
      });
    }
  } catch (e) {
    console.error('清理COS图片失败:', e.message);
  }

  // 2. 删除数据库记录（kids 级联删除会带走 photos/memories/messages 等）
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
    console.error('账号注销失败:', e.message);
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
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS base_photo_key VARCHAR(300) DEFAULT NULL").catch(() => {});
db.query("ALTER TABLE kids ADD COLUMN IF NOT EXISTS birthday_photo_year INTEGER DEFAULT NULL").catch(() => {});
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
db.query("ALTER TABLE achievements ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50)").catch(() => {});
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
  const sproutsMap = { vip: 2000, svip: 3000, dvip: 10000 };
  const amount = sproutsMap[membershipType];
  if (!amount) return;
  const today = bjDateStr();
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
    const today = bjDateStr();
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
