const express = require('express');
const app = express();
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');

// ------------------- DATABASE CONNECTION -------------------
const dbConfig = {
    host: "mysql.railway.internal", // Use public host if running locally
    user: "root",
    password: "jMNYJWgXozTYlDbPcECyjHBMuTwXwvWU",
    database: "railway"
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

        // Check if user exists
        const [rows] = await db.execute('SELECT * FROM task_users WHERE user_id = ?', [user_id]);
        if (rows.length === 0) {
            // Insert new user
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

// ------------------- MANUAL REGISTER -------------------
app.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.json({ success: false, message: 'All fields required' });

    try {
        const [rows] = await db.execute('SELECT * FROM task_users WHERE email = ?', [email]);
        if (rows.length > 0) return res.json({ success: false, message: 'Email already registered' });

        const user_id = uuidv4();
        await db.execute(
            'INSERT INTO task_users (user_id, name, email, picture, password) VALUES (?, ?, ?, NULL, ?)',
            [user_id, name, email, password]
        );

        res.json({ success: true, user_id });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Registration failed' });
    }
});

// ------------------- MIDDLEWARE TO CHECK user_id -------------------
function requireUserId(req, res, next) {
    // GET requests → user_id in query
    // POST requests → user_id in body
    const user_id = req.query.user_id || req.body.user_id;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
    req.user_id = user_id; // attach to request for easy use
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
                type: 'urgent'
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

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Minimal client-side script: redirect to login if not authenticated and protect index UI.

window.addEventListener("load", () => {
  const path = window.location.pathname;
  const isIndex = path === "/" || path.endsWith("/index.html");
  const userId = localStorage.getItem("user_id");

  if (isIndex && !userId) {
    // User not logged in client-side — redirect to login page.
    window.location.href = "/login";
    return;
  }

  // Placeholder for other client-side initialization (charts, tasks, chat)
  console.log("Client script initialized. user_id:", userId);
});
