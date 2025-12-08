const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser"); // <--- added
// const fetch = require("node-fetch");    // removed — use global fetch (Node 18+)
const { randomUUID } = require("crypto");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Serve login at root
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "register.html"));
});

// Serve static files
app.use(express.static("public"));

// Database configuration
const pool = mysql.createPool({
    host: "centerbeam.proxy.rlwy.net",
    user: "root",
    password: "jMNYJWgXozTYlDbPcECyjHBMuTwXwvWU",
    database: "railway",
    port: 12008,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection
pool.getConnection()
    .then(connection => {
        console.log("✅ Connected to MySQL database");
        connection.release();
    })
    .catch(err => {
        console.error("❌ Database connection failed:", err.message);
    });

// --------------------- AUTHENTICATION MIDDLEWARE ---------------------
function requireAuth(req, res, next) {
    const user_id = req.cookies.user_id || req.body.user_id || req.query.user_id;
    
    if (!user_id) {
        return res.status(401).json({ error: "Authentication required" });
    }
    
    req.user_id = user_id;
    next();
}

// --------------------- AUTH ROUTES ---------------------
app.post("/auth/google", async (req, res) => {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ success: false, message: "No id_token provided" });

    try {
        const googleResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
        const googleUser = await googleResp.json();
        if (googleUser.error_description) {
            return res.status(400).json({ success: false, message: googleUser.error_description });
        }

        const user_id = googleUser.sub;
        const name = googleUser.name || null;
        const email = googleUser.email || null;
        const picture = googleUser.picture || null;

        // Use task_users table (was incorrectly using `users`)
        await pool.query(
            `INSERT INTO task_users (user_id, name, email, picture)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), picture = VALUES(picture)`,
            [user_id, name, email, picture]
        );

        res.cookie("user_id", user_id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user: { user_id, name, email, picture } });
    } catch (err) {
        console.error("Google auth error:", err);
        return res.status(500).json({ success: false, message: "Google login failed" });
    }
});

app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "All fields required" });

    try {
        // Query task_users (was mistakenly `users`)
        const [rows] = await pool.query("SELECT * FROM task_users WHERE email = ? AND password = ? LIMIT 1", [email, password]);
        if (rows.length === 0) return res.status(401).json({ success: false, message: "Invalid credentials" });

        const user = rows[0];
        res.cookie("user_id", user.user_id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user: { user_id: user.user_id, name: user.name, email: user.email, picture: user.picture } });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ success: false, message: "Login failed" });
    }
});

app.post("/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required" });

    try {
        // Check/insert into task_users (was mistakenly `users`)
        const [existing] = await pool.query("SELECT 1 FROM task_users WHERE email = ? LIMIT 1", [email]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: "Email already registered" });

        const user_id = randomUUID();
        await pool.query("INSERT INTO task_users (user_id, name, email, password) VALUES (?, ?, ?, ?)", [user_id, name, email, password]);

        res.cookie("user_id", user_id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user: { user_id, name, email } });
    } catch (err) {
        console.error("Register error:", err);
        return res.status(500).json({ success: false, message: "Registration failed" });
    }
});

app.post("/auth/logout", (req, res) => {
    res.clearCookie("user_id");
    res.json({ success: true, message: "Logged out successfully" });
});

// --------------------- PROTECTED API ROUTES ---------------------

// Get all tasks for logged-in user
app.get("/api/tasks", requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT * FROM ai_task_manager 
             WHERE user_id = ? 
             ORDER BY 
                 CASE 
                     WHEN Status = 'Pending' THEN 1
                     WHEN Status = 'Not Started' THEN 2
                     WHEN Status = 'Completed' THEN 3
                     ELSE 4
                 END,
                 DueDate ASC`,
            [req.user_id]
        );
        res.json(rows);
    } catch (err) {
        console.error("Error fetching tasks:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get task stats for dashboard
app.get("/api/task-stats", requireAuth, async (req, res) => {
    try {
        // Get tasks for this user
        const [tasks] = await pool.query(
            "SELECT * FROM ai_task_manager WHERE user_id = ?",
            [req.user_id]
        );
        
        const stats = {
            byStatus: {
                "Not Started": 0,
                "Pending": 0,
                "Completed": 0
            },
            byPriority: {
                "High": 0,
                "Medium": 0,
                "Low": 0
            },
            total: 0,
            urgent: 0,
            upcomingDeadlines: []
        };
        
        tasks.forEach(task => {
            // Status counts
            stats.byStatus[task.Status] = (stats.byStatus[task.Status] || 0) + 1;
            
            // Priority counts
            if (task.Priority) {
                stats.byPriority[task.Priority] = (stats.byPriority[task.Priority] || 0) + 1;
            }
            
            // Urgent tasks (due in 3 days or less)
            if (task.DueDate && task.Status !== 'Completed') {
                const dueDate = new Date(task.DueDate);
                const now = new Date();
                const diffDays = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
                
                if (diffDays <= 3 && diffDays >= 0) {
                    stats.urgent++;
                }
                
                // Upcoming deadlines (next 7 days)
                if (diffDays >= 0 && diffDays <= 7) {
                    stats.upcomingDeadlines.push({
                        ...task,
                        days_remaining: diffDays
                    });
                }
            }
        });
        
        stats.total = tasks.length;
        
        // Sort upcoming deadlines
        stats.upcomingDeadlines.sort((a, b) => a.days_remaining - b.days_remaining);
        
        res.json(stats);
    } catch (err) {
        console.error("Error fetching task stats:", err);
        res.status(500).json({ error: err.message });
    }
});

// Update task status
app.put("/api/tasks/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const { Status, Priority } = req.body;
    
    try {
        let query = "UPDATE ai_task_manager SET ";
        const values = [];
        
        if (Status !== undefined) {
            query += "Status = ? ";
            values.push(Status);
        }
        
        if (Priority !== undefined) {
            if (Status !== undefined) query += ", ";
            query += "Priority = ? ";
            values.push(Priority);
        }
        
        query += "WHERE TaskID = ? AND user_id = ?";
        values.push(id, req.user_id);
        
        const [result] = await pool.query(query, values);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Task not found or access denied" });
        }
        
        res.json({ success: true, message: "Task updated successfully" });
    } catch (err) {
        console.error("Error updating task:", err);
        res.status(500).json({ error: err.message });
    }
});

// Delete task
app.delete("/api/tasks/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    
    try {
        const [result] = await pool.query(
            "DELETE FROM ai_task_manager WHERE TaskID = ? AND user_id = ?",
            [id, req.user_id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Task not found or access denied" });
        }
        
        res.json({ success: true, message: "Task deleted successfully" });
    } catch (err) {
        console.error("Error deleting task:", err);
        res.status(500).json({ error: err.message });
    }
});

// Chat with AI
app.post("/api/chat", requireAuth, async (req, res) => {
    const { message } = req.body;
    const WEBHOOK_URL = "https://n8n-production-be6f.up.railway.app/webhook/17e8f3f1-996f-448c-86df-16a3ee302e96";
    
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                message,
                user_id: req.user_id 
            })
        });
        
        let responseData;
        const contentType = response.headers.get("content-type");
        
        if (contentType && contentType.includes("application/json")) {
            responseData = await response.json();
        } else {
            const text = await response.text();
            responseData = { response: text || "No reply received" };
        }
        
        res.json(responseData);
    } catch (err) {
        console.error("Error calling n8n webhook:", err);
        res.status(500).json({ error: "Failed to communicate with AI agent" });
    }
});

// Get notifications
app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
        const [tasks] = await pool.query(
            `SELECT 
                TaskID,
                Title,
                DueDate,
                Status,
                Priority
            FROM ai_task_manager 
            WHERE 
                user_id = ?
                AND Status != 'Completed' 
                AND DueDate IS NOT NULL
                AND DueDate <= CURDATE() + INTERVAL 3 DAY
            ORDER BY DueDate ASC`,
            [req.user_id]
        );
        
        const notifications = tasks.map(task => {
            const dueDate = new Date(task.DueDate);
            const now = new Date();
            const daysRemaining = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
            
            let message = '';
            let type = 'info';
            
            if (daysRemaining < 0) {
                message = `"${task.Title}" is overdue by ${Math.abs(daysRemaining)} days!`;
                type = 'urgent';
            } else if (daysRemaining === 0) {
                message = `"${task.Title}" is due today!`;
                type = 'warning';
            } else if (daysRemaining <= 2) {
                message = `"${task.Title}" is due in ${daysRemaining} days`;
                type = 'warning';
            } else {
                message = `"${task.Title}" is due in ${daysRemaining} days`;
                type = 'info';
            }
            
            return {
                ...task,
                message,
                type
            };
        }).filter(n => n.message);
        
        res.json(notifications);
    } catch (err) {
        console.error("Error fetching notifications:", err);
        res.status(500).json({ error: err.message });
    }
});

// Check if user is authenticated
app.get("/api/check-auth", (req, res) => {
    const user_id = req.cookies.user_id;
    
    if (!user_id) {
        return res.json({ authenticated: false });
    }
    
    res.json({ 
        authenticated: true,
        user_id: user_id 
    });
});

// Serve the main app (protected)
app.get("/app", (req, res) => {
    if (!req.cookies.user_id) {
        return res.redirect("/login");
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle all other routes - serve index.html for SPA
app.get("*", (req, res) => {
    // For API routes, return 404
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "API endpoint not found" });
    }
    
    // For HTML routes, check authentication
    if (req.path === "/" || req.path === "/login" || req.path === "/register") {
        return res.sendFile(path.join(__dirname, "public", req.path.substring(1) + ".html"));
    }
    
    // For app routes, require authentication
    if (!req.cookies.user_id) {
        return res.redirect("/login");
    }
    
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});