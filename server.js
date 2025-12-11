const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const { randomUUID } = require("crypto");
const bcrypt = require("bcrypt");

// create app
const app = express();

// load environment variables once
require('dotenv').config();

// Frontend origin (set FRONTEND_ORIGIN in .env for production)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://ai-task-manager-1-y92u.onrender.com';

// If behind a proxy (Render, Railway, etc.) trust first proxy so secure cookies and req.protocol work
app.set('trust proxy', 1);

// unified cookie options helper
const cookieOptions = () => {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        secure: isProd,                    // true in production (Render requires)
        sameSite: isProd ? 'none' : 'lax', // none for cross-site in prod, lax for local dev
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000
    };
};

// small helper used for clearing cookies (matching sameSite/secure behavior)
const clearCookieOptions = () => {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        path: '/',
        sameSite: isProd ? 'none' : 'lax',
        secure: isProd
    };
};

// expose google client id to frontend
app.get("/config", (req, res) => {
  res.json({
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || ""
  });
});

// Middleware
app.use(cors({
    origin: FRONTEND_ORIGIN,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Database configuration
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 17136,
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
// Google Login
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

        // Check if user exists, insert if not
        const [existing] = await pool.query("SELECT user_id FROM task_users WHERE user_id = ?", [user_id]);
        
        if (existing.length === 0) {
            await pool.query(
                `INSERT INTO task_users (user_id, name, email, picture) VALUES (?, ?, ?, ?)`,
                [user_id, name, email, picture]
            );
        } else {
            // Update user info if already exists
            await pool.query(
                `UPDATE task_users SET name = ?, email = ?, picture = ? WHERE user_id = ?`,
                [name, email, picture, user_id]
            );
        }

        // Set cookie with user_id using unified options
        res.cookie("user_id", user_id, cookieOptions());
        
        return res.json({ 
            success: true, 
            user: { 
                user_id, 
                name, 
                email, 
                picture 
            } 
        });
    } catch (err) {
        console.error("Google auth error:", err);
        return res.status(500).json({ success: false, message: "Google login failed" });
    }
});

// Manual Login
app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    try {
        // Query user by email
        const [rows] = await pool.query(
            "SELECT * FROM task_users WHERE email = ? LIMIT 1", 
            [email]
        );
        
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        const user = rows[0];
        
        // Check if password exists (for Google users who haven't set password)
        if (!user.password) {
            return res.status(401).json({ success: false, message: "Please login with Google or reset your password" });
        }

        // Compare password with bcrypt
        const passwordMatch = await bcrypt.compare(password, user.password);
        
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: "Invalid email or password" });
        }

        // Set cookie
        res.cookie("user_id", user.user_id, cookieOptions());
        
        return res.json({ 
            success: true, 
            user: { 
                user_id: user.user_id, 
                name: user.name, 
                email: user.email, 
                picture: user.picture 
            } 
        });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ success: false, message: "Login failed" });
    }
});

// Registration
app.post("/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    
    // Validate input
    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: "All fields are required" });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }
    
    if (!email.includes("@") || !email.includes(".")) {
        return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    try {
        // Check if email already exists
        const [existing] = await pool.query(
            "SELECT user_id FROM task_users WHERE email = ? LIMIT 1", 
            [email]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ success: false, message: "Email already registered" });
        }

        // Generate unique user_id
        const user_id = randomUUID();
        
        // Hash password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Insert user into database
        await pool.query(
            `INSERT INTO task_users (user_id, name, email, picture, password) 
             VALUES (?, ?, ?, NULL, ?)`,
            [user_id, name, email, hashedPassword]
        );

        // Set cookie
        res.cookie("user_id", user_id, cookieOptions());
        
        return res.json({ 
            success: true, 
            user: { 
                user_id, 
                name, 
                email 
            } 
        });
    } catch (err) {
        console.error("Registration error:", err);
        return res.status(500).json({ success: false, message: "Registration failed. Please try again." });
    }
});

app.post("/auth/logout", (req, res) => {
    res.clearCookie("user_id", clearCookieOptions());
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













// --- Server-side helpers (put near top of server.js) ---
function parseServerDate(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  const s = String(value).trim();
  // If MySQL returns "YYYY-MM-DD HH:MM:SS" or ISO, try Date parsing robustly
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z'); // treat as UTC
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function utcDateOnlyMsServer(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}


// Get task stats for dashboard

app.get("/api/task-stats", requireAuth, async (req, res) => {
    try {
        const [tasks] = await pool.query(
            "SELECT * FROM ai_task_manager WHERE user_id = ?",
            [req.user_id]
        );
        
        const stats = {
            byStatus: { "Not Started": 0, "Pending": 0, "Completed": 0 },
            byPriority: { "High": 0, "Medium": 0, "Low": 0 },
            total: 0,
            urgent: 0,
            upcomingDeadlines: []
        };

        const now = new Date();
        const msPerDay = 24 * 60 * 60 * 1000;
        const utcNowMs = utcDateOnlyMsServer(now);

        tasks.forEach(task => {
            stats.byStatus[task.Status] = (stats.byStatus[task.Status] || 0) + 1;
            if (task.Priority) {
                stats.byPriority[task.Priority] = (stats.byPriority[task.Priority] || 0) + 1;
            }

            if (task.DueDate && task.Status !== 'Completed') {
                const dueDateObj = parseServerDate(task.DueDate);
                if (!dueDateObj) return;

                const utcDueMs = utcDateOnlyMsServer(dueDateObj);
                const diffDays = Math.floor((utcDueMs - utcNowMs) / msPerDay); // 0 = today, >0 future, <0 overdue

                // Urgent tasks (due in 3 days or less, and not overdue)
                if (diffDays <= 3 && diffDays >= 0) {
                    stats.urgent++;
                }

                // Upcoming deadlines (next 7 days, including today)
                if (diffDays >= 0 && diffDays <= 7) {
                    stats.upcomingDeadlines.push({
                        ...task,
                        days_remaining: diffDays
                    });
                }
            }
        });

        stats.total = tasks.length;
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
    const { message } = req.body || {};
    const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

    if (!message) {
        return res.status(400).json({ error: "No message provided" });
    }

    try {
        let userInfo = { user_id: req.user_id };
        try {
            const [rows] = await pool.query("SELECT user_id, name, email FROM task_users WHERE user_id = ? LIMIT 1", [req.user_id]);
            if (rows && rows.length > 0) userInfo = rows[0];
        } catch (dbErr) {
            console.warn("Failed to load user info for webhook payload:", dbErr?.message || dbErr);
        }

        const outgoingPayload = {
            message,
            user_id: req.user_id,
            user: userInfo,
            timestamp: new Date().toISOString()
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-User-ID": req.user_id
            },
            body: JSON.stringify(outgoingPayload),
            signal: controller.signal
        });

        clearTimeout(timeout);

        const status = response.status;
        const ct = response.headers.get("content-type") || "";
        const text = await response.text().catch(() => null);
        let body;
        try { body = ct.includes("application/json") ? JSON.parse(text) : text; } catch (e) { body = text; }

        if (status < 200 || status >= 300) {
            return res.status(502).json({ error: "Webhook returned non-2xx", status, body });
        }

        return res.status(200).json(body);
    } catch (err) {
        console.error("Error calling n8n webhook:", err && err.stack ? err.stack : err);
        const detail = err.name === "AbortError" ? "timeout" : (err.message || String(err));
        return res.status(500).json({ error: "Failed to call webhook", detail });
    }
});

// Get notifications


app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
        // Keep SQL filter for 3 days window if you want DB-level filtering, otherwise you can fetch all and filter in JS.
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
            ORDER BY DueDate ASC`,
            [req.user_id]
        );

        const now = new Date();
        const msPerDay = 24 * 60 * 60 * 1000;
        const utcNowMs = utcDateOnlyMsServer(now);

        const notifications = tasks.map(task => {
            const dueDateObj = parseServerDate(task.DueDate);
            if (!dueDateObj) return null;

            const utcDueMs = utcDateOnlyMsServer(dueDateObj);
            const diffDays = Math.floor((utcDueMs - utcNowMs) / msPerDay);

            let message = '';
            let type = 'info';

            if (diffDays < 0) {
                message = `"${task.Title}" is overdue by ${Math.abs(diffDays)} ${Math.abs(diffDays) === 1 ? 'day' : 'days'}!`;
                type = 'urgent';
            } else if (diffDays === 0) {
                message = `"${task.Title}" is due today!`;
                type = 'warning';
            } else if (diffDays <= 2) {
                message = `"${task.Title}" is due in ${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
                type = 'warning';
            } else {
                message = `"${task.Title}" is due in ${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
                type = 'info';
            }

            return {
                ...task,
                message,
                type,
                days_remaining: diffDays
            };
        }).filter(n => n && n.message);

        // Optionally filter to only notifications within +3 days (if needed)
        const filtered = notifications.filter(n => n.days_remaining <= 3);

        res.json(filtered);
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

// --------------------- HTML ROUTES ---------------------
// Serve specific HTML files directly
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/index.html", (req, res) => {
    // Check if user is authenticated
    if (!req.cookies.user_id) {
        return res.redirect("/login.html");
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve static files (CSS, JS, etc.) - IMPORTANT: This must come AFTER specific routes
app.use(express.static("public"));

// Catch-all route for SPA - redirect to login if not authenticated
app.get("*", (req, res) => {
    // For API routes, return 404
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "API endpoint not found" });
    }
    
    // Check if the file exists in public folder
    const filePath = path.join(__dirname, "public", req.path);
    const fs = require("fs");
    
    if (fs.existsSync(filePath) && !req.path.includes(".html")) {
        // Serve the static file if it exists
        return res.sendFile(filePath);
    }
    
    // For authenticated users trying to access app routes
    if (req.cookies.user_id) {
        // Check if they're trying to access login/register pages
        if (req.path === "/login" || req.path === "/login.html" || 
            req.path === "/register" || req.path === "/register.html") {
            return res.redirect("/index.html");
        }
        // Otherwise serve index.html for SPA routes
        return res.sendFile(path.join(__dirname, "public", "index.html"));
    } else {
        // Not authenticated - redirect to login
        return res.redirect("/login.html");
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
    console.log(`🔐 You will see the login page first`);
});
