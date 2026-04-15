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
res.json(r.rows);
});

app.post(”/api/kids”, auth, async (req, res) => {
const { name, gender, age, parent_role } = req.body;
if (!name || !age) return res.status(400).json({ error: “Please fill in child info” });
const count = await db.query(“SELECT COUNT(*) FROM kids WHERE user_id = $1”, [req.user.id]);
if (parseInt(count.rows[0].count) >= 3) return res.status(400).json({ error: “Maximum 3 children allowed” });
const r = await db.query(
“INSERT INTO kids (user_id, name, gender, age, parent_role) VALUES ($1,$2,$3,$4,$5) RETURNING *”,
[req.user.id, name.trim(), gender || “boy”, parseInt(age), parent_role || “mom”]
);
res.json(r.rows[0]);
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
const kid = kidResult.rows[0];
if (!kid) return res.status(404).json({ error: “Child not found” });

const histResult = await db.query(
“SELECT role, content FROM messages WHERE kid_id=$1 ORDER BY created_at DESC LIMIT 20”,
[kid.id]
);
const history = histResult.rows.reverse();

await db.query(“INSERT INTO messages (kid_id, role, content) VALUES ($1,‘user’,$2)”, [kid.id, message.trim()]);

const age = parseInt(kid.age);
const name = kid.name;
const parent = kid.parent_role;
const gender = kid.gender;

const system = “You are “ + name + “, a “ + age + “-year-old “ + gender + “ child chatting with your “ + parent + “ by text message. Reply naturally as a real child. Keep replies SHORT (1-3 sentences). No asterisk actions like *hugs mom*. No bracket descriptions like (thinking). Just speak like a child texting. Stay in character as “ + name + “ always. Reply in Chinese.”;

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

async function initDB() {
await db.query(`CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, name VARCHAR(100) DEFAULT 'Parent', created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS kids ( id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(50) NOT NULL, gender VARCHAR(10) DEFAULT 'boy', age INTEGER NOT NULL, parent_role VARCHAR(20) DEFAULT 'mom', created_at TIMESTAMP DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS messages ( id SERIAL PRIMARY KEY, kid_id INTEGER REFERENCES kids(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW() ); CREATE INDEX IF NOT EXISTS idx_messages_kid ON messages(kid_id, created_at);`);
console.log(“Database ready”);
}

app.get(”*”, (req, res) => {
res.sendFile(path.join(__dirname, “public”, “index.html”));
});

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(“Server running on port “ + PORT)));
