const express = require(“express”);
const cors = require(“cors”);
const { Pool } = require(“pg”);
const bcrypt = require(“bcryptjs”);
const jwt = require(“jsonwebtoken”);
const Anthropic = require(”@anthropic-ai/sdk”);
const path = require(“path”);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(“public”)); // 前端静态文件

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || “little-ones-secret-2024”;

// ── 验证中间件 ──────────────────────────────
const auth = (req, res, next) => {
const token = req.headers.authorization?.split(” “)[1];
if (!token) return res.status(401).json({ error: “未登录” });
try {
req.user = jwt.verify(token, JWT_SECRET);
next();
} catch {
res.status(401).json({ error: “登录已过期，请重新登录” });
}
};

// ── 用户接口 ────────────────────────────────

app.post(”/api/register”, async (req, res) => {
const { email, password, name } = req.body;
if (!email || !password) return res.status(400).json({ error: “请填写邮箱和密码” });
if (password.length < 6) return res.status(400).json({ error: “密码至少6位” });
try {
const hash = await bcrypt.hash(password, 10);
const r = await db.query(
“INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name”,
[email.toLowerCase().trim(), hash, name || “家长”]
);
const user = r.rows[0];
const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: “30d” });
res.json({ token, user });
} catch (e) {
if (e.code === “23505”) return res.status(400).json({ error: “该邮箱已注册” });
res.status(500).json({ error: “注册失败，请重试” });
}
});

app.post(”/api/login”, async (req, res) => {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: “请填写邮箱和密码” });
try {
const r = await db.query(“SELECT * FROM users WHERE email = $1”, [email.toLowerCase().trim()]);
const user = r.rows[0];
if (!user || !(await bcrypt.compare(password, user.password_hash))) {
return res.status(401).json({ error: “邮箱或密码错误” });
}
const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: “30d” });
res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
} catch {
res.status(500).json({ error: “登录失败，请重试” });
}
});

// ── 孩子接口 ────────────────────────────────

app.get(”/api/kids”, auth, async (req, res) => {
const r = await db.query(“SELECT * FROM kids WHERE user_id = $1 ORDER BY created_at”, [req.user.id]);
res.json(r.rows);
});

app.post(”/api/kids”, auth, async (req, res) => {
const { name, gender, age, parent_role } = req.body;
if (!name?.trim() || !age) return res.status(400).json({ error: “请填写孩子信息” });
const count = await db.query(“SELECT COUNT(*) FROM kids WHERE user_id = $1”, [req.user.id]);
if (parseInt(count.rows[0].count) >= 3) return res.status(400).json({ error: “最多创建3个孩子” });
const r = await db.query(
“INSERT INTO kids (user_id, name, gender, age, parent_role) VALUES ($1,$2,$3,$4,$5) RETURNING *”,
[req.user.id, name.trim(), gender || “boy”, parseInt(age), parent_role || “妈妈”]
);
res.json(r.rows[0]);
});

app.delete(”/api/kids/:id”, auth, async (req, res) => {
await db.query(“DELETE FROM kids WHERE id = $1 AND user_id = $2”, [req.params.id, req.user.id]);
res.json({ ok: true });
});

// ── 对话接口 ────────────────────────────────

app.get(”/api/kids/:id/messages”, auth, async (req, res) => {
const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “找不到该孩子” });
const msgs = await db.query(
“SELECT * FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 100”,
[req.params.id]
);
res.json(msgs.rows.reverse());
});

app.post(”/api/kids/:id/chat”, auth, async (req, res) => {
const { message } = req.body;
if (!message?.trim()) return res.status(400).json({ error: “消息不能为空” });

const kidResult = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
const kid = kidResult.rows[0];
if (!kid) return res.status(404).json({ error: “找不到该孩子” });

// 获取最近对话历史
const histResult = await db.query(
“SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20”,
[kid.id]
);
const history = histResult.rows.reverse();

// 保存用户消息
await db.query(“INSERT INTO messages (kid_id, role, content) VALUES ($1,‘user’,$2)”, [kid.id, message.trim()]);

// 构建系统提示词
const system = buildSystem(kid);

try {
const response = await claude.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 300,
system,
messages: [
…history.map(m => ({ role: m.role, content: m.content })),
{ role: “user”, content: message.trim() }
]
});

```
const reply = response.content[0].text.trim();
const saved = await db.query(
  "INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2) RETURNING id, created_at",
  [kid.id, reply]
);

res.json({ reply, id: saved.rows[0].id });
```

} catch (e) {
console.error(e);
res.status(500).json({ error: “孩子暂时没有回应，请稍后再试” });
}
});

// ── 辅助函数 ────────────────────────────────

function buildSystem(kid) {
const age = parseInt(kid.age);
const style =
age <= 1 ? “你只能发咿呀声和哭声，用（动作描述）表达，完全不会说话” :
age <= 3 ? “你说话用1-3字叠词，咬字不清，非常简短可爱” :
age <= 6 ? “你说简单完整的句子，爱问为什么，天真好奇，偶尔语法不对” :
age <= 10 ? “你表达清楚流畅，活泼直接，有自己的想法，爱分享学校的事” :
age <= 14 ? “你有主见，偶尔叛逆，但内心很依赖父母，说话直接真实，不喜欢说套话” :
“你独立思考，话不多，但说出来都是真心话，重视被理解和尊重”;

return `你现在完全是「${kid.name}」这个孩子，不是AI助手。

基本信息：${kid.name}，${kid.gender === “boy” ? “男孩” : “女孩”}，${kid.age}岁，正在和${kid.parent_role}用文字聊天。

说话方式：${style}

严格规则：

1. 回复要短，最多2-3句话，像真实孩子发微信一样简短自然
1. 禁止用星号加动作的格式，比如紧抱妈妈、挺起胸膛这类写法完全不允许
1. 禁止用括号描述动作或心理，比如认真思考、特别骄傲
1. 直接用文字表达情绪，比如哇、真的吗、嘻嘻
1. 绝不说好的、嗯嗯等无意义回应
1. 只输出${kid.name}说的话，不加任何说明

你就是${kid.name}，永远保持这个身份。`;
}

// ── 数据库初始化 ────────────────────────────

async function initDB() {
await db.query(`CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, name VARCHAR(100) DEFAULT '家长', created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS kids ( id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(50) NOT NULL, gender VARCHAR(10) DEFAULT 'boy', age INTEGER NOT NULL, parent_role VARCHAR(10) DEFAULT '妈妈', created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS messages ( id SERIAL PRIMARY KEY, kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW() ); CREATE INDEX IF NOT EXISTS idx_messages_kid ON messages(kid_id, created_at);`);
console.log(“✅ 数据库就绪”);
}

// 所有前端路由都返回 index.html（单页应用）
app.get(”*”, (req, res) => {
res.sendFile(path.join(__dirname, “public”, “index.html”));
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`🚀 服务器启动：${PORT}`)));
