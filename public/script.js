const express = require('express');
const app = express();
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt'); // added for secure password hashing

const SALT_ROUNDS = 12;

// ------------------- DATABASE CONNECTION -------------------
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};


let db;
mysql.createConnection(dbConfig).then(connection => {
    db = connection;
    console.log("Database connected");
}).catch(err => console.error("DB Connection error:", err));

// ------------------- MIDDLEWARE -------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------- FRONTEND ROUTES -------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// ------------------- GOOGLE LOGIN -------------------
app.post('/auth/google', async (req, res) => {
    const { id_token } = req.body;
    if (!id_token) return res.json({ success: false, message: 'No ID token provided' });

    try {
        const googleResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
        const googleUser = await googleResponse.json();

        if (googleUser.error_description) {
            return res.json({ success: false, message: googleUser.error_description });
        }

        const user_id = googleUser.sub;
        const name = googleUser.name;
        const email = googleUser.email;
        const picture = googleUser.picture;

        // Ensure we use task_users table (not `users`)
        const [rows] = await db.execute('SELECT * FROM task_users WHERE user_id = ?', [user_id]);
        if (rows.length === 0) {
            await db.execute(
                'INSERT INTO task_users (user_id, name, email, picture, password) VALUES (?, ?, ?, ?, NULL)',
                [user_id, name, email, picture]
            );
        }

        res.json({ success: true, user: { user_id, name, email, picture } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Google login failed' });
    }
});

// ------------------- MANUAL LOGIN -------------------
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'All fields required' });

    try {
        // Query by email only, then compare hashed password
        const [rows] = await db.execute('SELECT * FROM task_users WHERE email = ?', [email]);
        if (rows.length === 0) return res.json({ success: false, message: 'Invalid credentials' });

        const user = rows[0];
        const match = await bcrypt.compare(password, user.password || '');
        if (!match) return res.json({ success: false, message: 'Invalid credentials' });

        res.json({ success: true, user: { 
            user_id: user.user_id, 
            name: user.name, 
            email: user.email, 
            picture: user.picture 
        } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Login failed' });
    }
});

// ------------------- MANUAL REGISTER -------------------
app.post('/auth/register', async (req, res) => {
    const { name, email, password, user_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: 'All fields required' });

    try {
        // Check existing email
        const [rows] = await db.execute('SELECT 1 FROM task_users WHERE email = ?', [email]);
        if (rows.length > 0) return res.status(409).json({ success: false, message: 'Email already registered' });

        // Use provided user_id when available (to align with Google flow), otherwise generate one
        const uid = user_id || uuidv4();

        // Hash password before storing
        const hashed = await bcrypt.hash(password, SALT_ROUNDS);

        await db.execute(
            'INSERT INTO task_users (user_id, name, email, picture, password) VALUES (?, ?, ?, NULL, ?)',
            [uid, name, email, hashed]
        );

        // Do not return password. Return user_id so frontend can keep continuity
        res.json({ success: true, user_id: uid });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

// ------------------- MIDDLEWARE TO CHECK user_id -------------------
function requireUserId(req, res, next) {
    const user_id = req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
    req.user_id = user_id;
    next();
}

// ------------------- TASKS API -------------------
app.get('/api/tasks', requireUserId, async (req, res) => {
    try {
        const [tasks] = await db.execute('SELECT * FROM ai_task_manager WHERE user_id = ?', [req.user_id]);
        res.json(tasks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

app.put('/api/tasks/:id', requireUserId, async (req, res) => {
    const taskId = req.params.id;
    const { Status } = req.body;
    try {
        await db.execute('UPDATE ai_task_manager SET Status = ? WHERE TaskID = ? AND user_id = ?', [Status, taskId, req.user_id]);
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

app.delete('/api/tasks/:id', requireUserId, async (req, res) => {
    const taskId = req.params.id;
    try {
        await db.execute('DELETE FROM ai_task_manager WHERE TaskID = ? AND user_id = ?', [taskId, req.user_id]);
        res.sendStatus(200);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// ------------------- TASK STATS (DASHBOARD) -------------------
app.get('/api/task-stats', requireUserId, async (req, res) => {
    try {
        const [tasks] = await db.execute('SELECT * FROM ai_task_manager WHERE user_id = ?', [req.user_id]);
        const byStatus = { 'Not Started': 0, 'Pending': 0, 'Completed': 0 };
        const byPriority = { 'High': 0, 'Medium': 0, 'Low': 0 };
        const urgent = [];
        const upcomingDeadlines = [];

        tasks.forEach(task => {
            byStatus[task.Status] = (byStatus[task.Status] || 0) + 1;
            byPriority[task.Priority] = (byPriority[task.Priority] || 0) + 1;

            if (task.DueDate) {
                const due = new Date(task.DueDate);
                const now = new Date();
                const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
                if (diffDays <= 2) urgent.push(task);
                if (diffDays >= 0) upcomingDeadlines.push(task);
            }
        });

        res.json({
            byStatus,
            byPriority,
            urgent: urgent.length,
            upcomingDeadlines
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ------------------- NOTIFICATIONS -------------------
app.get('/api/notifications', requireUserId, async (req, res) => {
    try {
        const [tasks] = await db.execute('SELECT * FROM ai_task_manager WHERE user_id = ?', [req.user_id]);
        const notifications = tasks
            .filter(task => task.DueDate && Math.ceil((new Date(task.DueDate) - new Date()) / (1000*60*60*24)) <= 2)
            .map(task => ({
                TaskID: task.TaskID,
                Title: task.Title,
                message: `Task "${task.Title}" is due soon!`,
                type: 'urgent',
                DueDate: task.DueDate
            }));
        res.json(notifications);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// ------------------- CHAT API (n8n) -------------------
app.post('/api/chat', requireUserId, async (req, res) => {
    const { message } = req.body;
    try {
        const response = await fetch('https://n8n-production-be6f.up.railway.app/webhook/17e8f3f1-996f-448c-86df-16a3ee302e96', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, user_id: req.user_id })
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send chat message' });
    }
});

// add a small helper for fetch that includes cookies
async function apiFetch(url, options = {}) {
  const opts = {
    credentials: 'include', // send cookies to server
    headers: { ...(options.headers || {}) },
    ...options
  };
  // default JSON header for body-carrying requests
  if (opts.body && !opts.headers?.['Content-Type']) {
    opts.headers['Content-Type'] = 'application/json';
  }
  return fetch(url, opts);
}

// Replace direct fetch to /api/chat with apiFetch
// Example: previously:
// const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, user_id: userId }) });

// New:
const res = await apiFetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ message }) // server reads req.user_id from cookie
});

// Also update other API calls to use apiFetch, e.g.:
// fetch(`/api/task-stats?user_id=${encodeURIComponent(userId)}`)
// -> apiFetch(`/api/task-stats`)  (server gets user_id from cookie)

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));