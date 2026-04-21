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
app.use(express.static(“public”));

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || “little-ones-secret-2024”;

const auth = (req, res, next) => {
const token = req.headers.authorization?.split(” “)[1];
if (!token) return res.status(401).json({ error: “Not logged in” });
try {
req.user = jwt.verify(token, JWT_SECRET);
next();
} catch {
res.status(401).json({ error: “Session expired” });
}
};

function calcAge(birthday) {
if (!birthday) return null;
const born = new Date(birthday);
const today = new Date();
let age = today.getFullYear() - born.getFullYear();
const m = today.getMonth() - born.getMonth();
if (m < 0 || (m === 0 && today.getDate() < born.getDate())) age–;
return age < 0 ? 0 : age;
}

function daysSince(date) {
if (!date) return 999;
const diff = new Date() - new Date(date);
return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function companionDays(createdAt) {
if (!createdAt) return 0;
const diff = new Date() - new Date(createdAt);
return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function bondLevel(score) {
if (score >= 1000) return “permanent”;
if (score >= 501) return “devoted”;
if (score >= 301) return “close”;
if (score >= 151) return “warm”;
if (score >= 51) return “growing”;
return “new”;
}

app.post(”/api/register”, async (req, res) => {
const { email, password, name } = req.body;
if (!email || !password) return res.status(400).json({ error: “Please enter email and password” });
if (password.length < 6) return res.status(400).json({ error: “Password must be at least 6 characters” });
try {
const hash = await bcrypt.hash(password, 10);
const r = await db.query(
“INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name”,
[email.toLowerCase().trim(), hash, name || “Parent”]
);
const user = r.rows[0];
const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: “30d” });
res.json({ token, user });
} catch (e) {
if (e.code === “23505”) return res.status(400).json({ error: “Email already registered” });
res.status(500).json({ error: “Registration failed” });
}
});

app.post(”/api/login”, async (req, res) => {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: “Please enter email and password” });
try {
const r = await db.query(“SELECT * FROM users WHERE email = $1”, [email.toLowerCase().trim()]);
const user = r.rows[0];
if (!user || !(await bcrypt.compare(password, user.password_hash))) {
return res.status(401).json({ error: “Incorrect email or password” });
}
const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: “30d” });
res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
} catch {
res.status(500).json({ error: “Login failed” });
}
});

app.get(”/api/kids”, auth, async (req, res) => {
const r = await db.query(“SELECT * FROM kids WHERE user_id = $1 ORDER BY created_at”, [req.user.id]);
const kids = r.rows.map(k => ({
…k,
companion_days: companionDays(k.created_at),
bond_level: bondLevel(k.bond_score || 0)
}));
res.json(kids);
});

app.post(”/api/kids”, auth, async (req, res) => {
const { name, gender, age, parent_role, birthday, avatar, personality, growth_mode } = req.body;
if (!name) return res.status(400).json({ error: “Please fill in child name” });
const count = await db.query(“SELECT COUNT(*) FROM kids WHERE user_id = $1”, [req.user.id]);
if (parseInt(count.rows[0].count) >= 3) return res.status(400).json({ error: “Maximum 3 children allowed” });

let finalAge = age ? parseInt(age) : 0;
if (birthday) {
const computed = calcAge(birthday);
if (computed !== null) finalAge = computed;
}

const mode = growth_mode || “fixed”;

const r = await db.query(
“INSERT INTO kids (user_id, name, gender, age, parent_role, birthday, avatar, personality, growth_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *”,
[req.user.id, name.trim(), gender || “boy”, finalAge, parent_role || “mom”, birthday || null, avatar || null, personality || “lively”, mode]
);
const kid = r.rows[0];
res.json({ …kid, companion_days: 0, bond_level: bondLevel(0) });
});

app.delete(”/api/kids/:id”, auth, async (req, res) => {
await db.query(“DELETE FROM kids WHERE id = $1 AND user_id = $2”, [req.params.id, req.user.id]);
res.json({ ok: true });
});

app.get(”/api/kids/:id/messages”, auth, async (req, res) => {
const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “Child not found” });
const msgs = await db.query(
“SELECT * FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 100”,
[req.params.id]
);
res.json(msgs.rows.reverse());
});

app.post(”/api/kids/:id/chat”, auth, async (req, res) => {
const { message } = req.body;
if (!message?.trim()) return res.status(400).json({ error: “Message cannot be empty” });

const kidResult = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
let kid = kidResult.rows[0];
if (!kid) return res.status(404).json({ error: “Child not found” });

// Auto-update age from birthday only if growth_mode is “grow”
if (kid.birthday && kid.growth_mode === “grow”) {
const currentAge = calcAge(kid.birthday);
if (currentAge !== null && currentAge !== kid.age) {
await db.query(“UPDATE kids SET age = $1 WHERE id = $2”, [currentAge, kid.id]);
kid.age = currentAge;
}
}

// Update bond score and streak
const today = new Date().toISOString().slice(0, 10);
const lastDate = kid.last_chat_date ? new Date(kid.last_chat_date).toISOString().slice(0, 10) : null;
let bondAdd = 2;
let newStreak = kid.streak_days || 0;

if (lastDate !== today) {
bondAdd += 3;
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yStr = yesterday.toISOString().slice(0, 10);
if (lastDate === yStr) {
newStreak += 1;
bondAdd += Math.min(newStreak, 10);
} else {
newStreak = 1;
}
}

const todayDate = new Date();
const isBirthday = kid.birthday &&
new Date(kid.birthday).getDate() === todayDate.getDate() &&
new Date(kid.birthday).getMonth() === todayDate.getMonth();
if (isBirthday) bondAdd += 50;

await db.query(
“UPDATE kids SET last_chat_at = NOW(), last_chat_date = $1, bond_score = COALESCE(bond_score,0) + $2, streak_days = $3 WHERE id = $4”,
[today, bondAdd, newStreak, kid.id]
);

const histResult = await db.query(
“SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20”,
[kid.id]
);
const history = histResult.rows.reverse();

await db.query(“INSERT INTO messages (kid_id, role, content) VALUES ($1,‘user’,$2)”, [kid.id, message.trim()]);

// Miss you note
const daysAway = daysSince(kid.last_chat_at);
const missNote = daysAway >= 1
? “ The parent has not visited for “ + daysAway + “ day(s). Early in the conversation, naturally mention in a childlike way that you missed them.”
: “”;

// Birthday note
const birthdayNote = isBirthday ? “ Today is your birthday! You are very excited about it!” : “”;

// Pending gift note
let giftNote = “”;
if (kid.pending_gift) {
const giftLevel = kid.pending_gift_level || “free”;
if (giftLevel === “free”) {
giftNote = “ You just received “ + kid.pending_gift + “ as a gift. React happily in 1 sentence.”;
} else if (giftLevel === “medium”) {
giftNote = “ You just received “ + kid.pending_gift + “ as a present! React with great excitement, mention wanting to use it together with your parent.”;
} else {
giftNote = “ You just received “ + kid.pending_gift + “!! React with EXTREME excitement, use lots of exclamation marks, mention it multiple times, beg parent to join you!”;
}
await db.query(“UPDATE kids SET pending_gift = NULL, pending_gift_level = NULL WHERE id = $1”, [kid.id]);
}

// Age text
let ageText = kid.age + “ years old”;
if (kid.age <= 1) ageText = “about 1 year old, just learning to talk, mostly babbling”;
else if (kid.age <= 2) ageText = “2 years old, speaks in short simple words”;
else if (kid.age <= 3) ageText = “3 years old, speaks in simple short sentences”;
else if (kid.age <= 6) ageText = kid.age + “ years old, goes to kindergarten”;
else if (kid.age <= 12) ageText = kid.age + “ years old, goes to primary school”;
else ageText = kid.age + “ years old, goes to middle school”;

// Personality note
const personalityMap = {
lively: “You are energetic, curious and talkative.”,
quiet: “You are gentle, thoughtful and speak softly.”,
clever: “You are smart, ask lots of questions and love learning.”
};
const personalityNote = personalityMap[kid.personality] || personalityMap.lively;

const system = “You are “ + kid.name + “, a “ + ageText + “ child chatting with your “ + kid.parent_role + “. “ + personalityNote + birthdayNote + missNote + giftNote + “ NEVER use asterisks. NEVER write actions. ONLY write spoken words. Keep it to 1-2 sentences. Reply in Chinese. You are exactly “ + kid.age + “ years old, act accordingly.”;

try {
const response = await claude.messages.create({
model: “claude-sonnet-4-20250514”,
max_tokens: 300,
system: system,
messages: [
…history.map(m => ({ role: m.role, content: m.content })),
{ role: “user”, content: message.trim() }
]
});

```
const reply = response.content[0].text.trim();
const saved = await db.query(
  "INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2) RETURNING id",
  [kid.id, reply]
);
res.json({ reply, id: saved.rows[0].id });
```

} catch (e) {
console.error(e);
res.status(500).json({ error: “No response, please try again” });
}
});

app.get(”/api/kids/:id/diary”, auth, async (req, res) => {
const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “Child not found” });
const entries = await db.query(
“SELECT * FROM diary WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 100”,
[req.params.id]
);
res.json(entries.rows);
});

app.post(”/api/kids/:id/diary”, auth, async (req, res) => {
const { content } = req.body;
if (!content?.trim()) return res.status(400).json({ error: “Content cannot be empty” });
const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “Child not found” });
const r = await db.query(
“INSERT INTO diary (kid_id, content) VALUES ($1,$2) RETURNING *”,
[req.params.id, content.trim()]
);
res.json(r.rows[0]);
});

app.get(”/api/kids/:id/gifts”, auth, async (req, res) => {
const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “Child not found” });
const gifts = await db.query(
“SELECT * FROM gifts WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 50”,
[req.params.id]
);
res.json(gifts.rows);
});

app.post(”/api/kids/:id/gifts”, auth, async (req, res) => {
const { gift_emoji, gift_name, gift_type, gift_level } = req.body;
if (!gift_name) return res.status(400).json({ error: “Gift name required” });

const kid = await db.query(“SELECT * FROM kids WHERE id=$1 AND user_id=$2”, [req.params.id, req.user.id]);
if (!kid.rows[0]) return res.status(404).json({ error: “Child not found” });

if (gift_type === “paid”) {
return res.status(402).json({ error: “Payment required”, message: “即将开放，敬请期待” });
}

// Check daily free gift limit
const today = new Date().toISOString().slice(0, 10);
const dailyCount = await db.query(
“SELECT COUNT(*) FROM gifts WHERE kid_id=$1 AND gift_type=‘free’ AND created_at::date = $2::date”,
[req.params.id, today]
);
const count = parseInt(dailyCount.rows[0].count);
const limit = 1; // free users: 1 per day
if (count >= limit) {
return res.status(429).json({ error: “Daily limit reached”, message: “今天的免费礼物已送完，明天再来吧！” });
}

// Save gift
await db.query(
“INSERT INTO gifts (kid_id, gift_emoji, gift_name, gift_type, gift_level) VALUES ($1,$2,$3,$4,$5)”,
[req.params.id, gift_emoji || “”, gift_name, gift_type || “free”, gift_level || “free”]
);

// Set pending gift on kid
await db.query(
“UPDATE kids SET pending_gift = $1, pending_gift_level = $2 WHERE id = $3”,
[gift_emoji + “ “ + gift_name, gift_level || “free”, req.params.id]
);

// Add bond score for gift
const giftBond = gift_level === “premium” ? 30 : gift_level === “medium” ? 15 : 5;
await db.query(“UPDATE kids SET bond_score = COALESCE(bond_score,0) + $1 WHERE id = $2”, [giftBond, req.params.id]);

res.json({ ok: true, message: “礼物已送出！” });
});

async function initDB() {
await db.query(`CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, name VARCHAR(100) DEFAULT 'Parent', is_premium BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS kids ( id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(50) NOT NULL, gender VARCHAR(10) DEFAULT 'boy', age INTEGER NOT NULL DEFAULT 0, parent_role VARCHAR(20) DEFAULT 'mom', birthday DATE, avatar VARCHAR(10), personality VARCHAR(20) DEFAULT 'lively', growth_mode VARCHAR(10) DEFAULT 'fixed', last_chat_at TIMESTAMP, last_chat_date DATE, bond_score INTEGER DEFAULT 0, streak_days INTEGER DEFAULT 0, pending_gift VARCHAR(100), pending_gift_level VARCHAR(20), created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS messages ( id SERIAL PRIMARY KEY, kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS diary ( id SERIAL PRIMARY KEY, kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS gifts ( id SERIAL PRIMARY KEY, kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE, gift_emoji VARCHAR(10), gift_name VARCHAR(100), gift_type VARCHAR(20) DEFAULT 'free', gift_level VARCHAR(20) DEFAULT 'free', created_at TIMESTAMP DEFAULT NOW() ); CREATE INDEX IF NOT EXISTS idx_messages_kid ON messages(kid_id, created_at); ALTER TABLE kids ADD COLUMN IF NOT EXISTS birthday DATE; ALTER TABLE kids ADD COLUMN IF NOT EXISTS avatar VARCHAR(10); ALTER TABLE kids ADD COLUMN IF NOT EXISTS personality VARCHAR(20) DEFAULT 'lively'; ALTER TABLE kids ADD COLUMN IF NOT EXISTS growth_mode VARCHAR(10) DEFAULT 'fixed'; ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP; ALTER TABLE kids ADD COLUMN IF NOT EXISTS last_chat_date DATE; ALTER TABLE kids ADD COLUMN IF NOT EXISTS bond_score INTEGER DEFAULT 0; ALTER TABLE kids ADD COLUMN IF NOT EXISTS streak_days INTEGER DEFAULT 0; ALTER TABLE kids ADD COLUMN IF NOT EXISTS pending_gift VARCHAR(100); ALTER TABLE kids ADD COLUMN IF NOT EXISTS pending_gift_level VARCHAR(20); ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;`);
console.log(“Database ready”);
}

app.get(”*”, (req, res) => {
res.sendFile(path.join(__dirname, “public”, “index.html”));
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(“Server running on port “ + PORT)));
