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
  const kids = r.rows.map(kid => ({
    ...kid,
    zodiac: getZodiacSign(kid.birthday),
  }));
  res.json(kids);
});

app.post("/api/kids", auth, async (req, res) => {
  const { name, gender, age, parent_role, birthday, personality } = req.body;
  if (!name) return res.status(400).json({ error: "Please fill in child name" });
  const count = await db.query("SELECT COUNT(*) FROM kids WHERE user_id = $1", [req.user.id]);
  if (parseInt(count.rows[0].count) >= 3) return res.status(400).json({ error: "Maximum 3 children allowed" });

  let finalAge = age ? parseInt(age) : 0;
  if (birthday) {
    const born = new Date(birthday);
    const today = new Date();
    finalAge = today.getFullYear() - born.getFullYear();
    const m = today.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < born.getDate())) finalAge--;
  }

  const r = await db.query(
    "INSERT INTO kids (user_id, name, gender, age, parent_role, birthday, personality) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [req.user.id, name.trim(), gender || "boy", finalAge, parent_role || "mom", birthday || null, personality || "lively"]
  );
  res.json(r.rows[0]);
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

app.post("/api/kids/:id/chat", auth, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Message cannot be empty" });

  const kidResult = await db.query("SELECT * FROM kids WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  const kid = kidResult.rows[0];
  if (!kid) return res.status(404).json({ error: "Child not found" });

  // Check if the child has been missing the parent (last chat > 2 days ago)
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const isMissing = kid.last_chat_at && new Date(kid.last_chat_at) < twoDaysAgo;

  const histResult = await db.query(
    "SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20",
    [kid.id]
  );
  const history = histResult.rows.reverse();

  await db.query("INSERT INTO messages (kid_id, role, content) VALUES ($1,'user',$2)", [kid.id, message.trim()]);

  // Update last_chat_at to now
  await db.query("UPDATE kids SET last_chat_at = NOW() WHERE id = $1", [kid.id]);

  let system = "You are " + kid.name + ", a " + kid.age + "-year-old child chatting with your " + kid.parent_role + ". NEVER use asterisks. NEVER write actions. ONLY write spoken words. Keep it to 1-2 sentences. Reply in Chinese.";

  if (kid.personality === 'lively') {
    system += " You are energetic, curious and talkative.";
  } else if (kid.personality === 'quiet') {
    system += " You are gentle, thoughtful and speak softly.";
  } else if (kid.personality === 'clever') {
    system += " You are smart, ask lots of questions and love learning.";
  }

  const zodiac = getZodiacSign(kid.birthday);
  if (zodiac) {
    const traits = ZODIAC_TRAITS[zodiac] || "unique and special";
    system += " You are a " + zodiac + ", so you are " + traits + ".";
  }

  // Build the messages array, prepending a missing-you note if applicable
  const chatMessages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message.trim() }
  ];

  if (isMissing) {
    chatMessages.unshift({
      role: "user",
      content: "[System note: You haven't seen your parent for a few days and you've been missing them. Mention this naturally early in the conversation.]"
    });
    chatMessages.splice(1, 0, { role: "assistant", content: "好的。" });
  }

  try {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: system,
      messages: chatMessages
    });

    const reply = response.content[0].text.trim();
    const saved = await db.query(
      "INSERT INTO messages (kid_id, role, content) VALUES ($1,'assistant',$2) RETURNING id",
      [kid.id, reply]
    );
    res.json({ reply, id: saved.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No response, please try again" });
  }
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
    CREATE TABLE IF NOT EXISTS diary (
      id SERIAL PRIMARY KEY,
      kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_diary_kid ON diary(kid_id, created_at);
  `);
  console.log("Database ready");
}

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

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log("Server running on port " + PORT)));
