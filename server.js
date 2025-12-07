const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser"); // added
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser()); // added

// Serve login at root BEFORE static so visiting / shows login page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Serve static files after explicit root/login routes
app.use(express.static("public"));


// Database configuration - USE EXTERNAL RAILWAY HOST
const pool = mysql.createPool({
    host: "centerbeam.proxy.rlwy.net",   // Use Railway public host
    user: "root",
    password: "jMNYJWgXozTYlDbPcECyjHBMuTwXwvWU",
    database: "railway",
    port: 12008,                         // Port from public URL
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

// API Routes

// Get all tasks
app.get("/api/tasks", async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT * FROM ai_task_manager 
            ORDER BY 
                CASE 
                    WHEN Status = 'Pending' THEN 1
                    WHEN Status = 'Not Started' THEN 2
                    WHEN Status = 'Completed' THEN 3
                    ELSE 4
                END,
                DueDate ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching tasks:", err);
        res.status(500).json({ error: err.message });
    }
});

// Get task counts for dashboard
app.get("/api/task-stats", async (req, res) => {
    try {
        const [result] = await pool.query(`
            SELECT 
                Status,
                COUNT(*) as count,
                Priority,
                SUM(CASE WHEN DueDate <= CURDATE() + INTERVAL 3 DAY AND Status != 'Completed' THEN 1 ELSE 0 END) as urgent
            FROM ai_task_manager 
            GROUP BY Status, Priority
        `);
        
        // Process results for easier frontend consumption
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
        
        result.forEach(row => {
            stats.byStatus[row.Status] = (stats.byStatus[row.Status] || 0) + row.count;
            if (row.Priority) {
                stats.byPriority[row.Priority] = (stats.byPriority[row.Priority] || 0) + row.count;
            }
            stats.total += row.count;
            stats.urgent += row.urgent;
        });
        
        // Get upcoming deadlines
        const [upcoming] = await pool.query(`
            SELECT Title, DueDate, Status 
            FROM ai_task_manager 
            WHERE DueDate BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY 
            AND Status != 'Completed'
            ORDER BY DueDate ASC
            LIMIT 10
        `);
        
        stats.upcomingDeadlines = upcoming;
        
        res.json(stats);
    } catch (err) {
        console.error("Error fetching task stats:", err);
        res.status(500).json({ error: err.message });
    }
});

// Update task status
app.put("/api/tasks/:id", async (req, res) => {
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
        
        query += "WHERE TaskID = ?";
        values.push(id);
        
        await pool.query(query, values);
        res.json({ success: true, message: "Task updated successfully" });
    } catch (err) {
        console.error("Error updating task:", err);
        res.status(500).json({ error: err.message });
    }
});

// Delete task
app.delete("/api/tasks/:id", async (req, res) => {
    const { id } = req.params;
    
    try {
        await pool.query("DELETE FROM ai_task_manager WHERE TaskID = ?", [id]);
        res.json({ success: true, message: "Task deleted successfully" });
    } catch (err) {
        console.error("Error deleting task:", err);
        res.status(500).json({ error: err.message });
    }
});

// Chat with AI (Proxy to n8n webhook)
app.post("/api/chat", async (req, res) => {
    const { message } = req.body;
    const WEBHOOK_URL = "https://n8n-production-be6f.up.railway.app/webhook/17e8f3f1-996f-448c-86df-16a3ee302e96";
    
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message })
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

// Get notifications (tasks due soon or overdue)
app.get("/api/notifications", async (req, res) => {
    try {
        const [notifications] = await pool.query(`
            SELECT 
                TaskID,
                Title,
                DueDate,
                Status,
                Priority,
                DATEDIFF(DueDate, CURDATE()) as days_remaining
            FROM ai_task_manager 
            WHERE 
                Status != 'Completed' 
                AND DueDate IS NOT NULL
                AND DueDate <= CURDATE() + INTERVAL 3 DAY
            ORDER BY DueDate ASC
        `);
        
        // Format notifications
        const formatted = notifications.map(task => {
            let message = '';
            let type = 'info';
            
            if (task.days_remaining < 0) {
                message = `"${task.Title}" is overdue by ${Math.abs(task.days_remaining)} days!`;
                type = 'urgent';
            } else if (task.days_remaining === 0) {
                message = `"${task.Title}" is due today!`;
                type = 'warning';
            } else if (task.days_remaining <= 2) {
                message = `"${task.Title}" is due in ${task.days_remaining} days`;
                type = 'warning';
            }
            
            return {
                ...task,
                message,
                type
            };
        }).filter(n => n.message); // Only include tasks with notifications
        
        res.json(formatted);
    } catch (err) {
        console.error("Error fetching notifications:", err);
        res.status(500).json({ error: err.message });
    }
});

// Serve the main page for all routes (SPA) — redirect unauthenticated users to / (login)
app.get("*", (req, res) => {
    // If you use a cookie named "user_id" to mark logged-in users, check it here.
    if (!req.cookies || !req.cookies.user_id) {
        return res.redirect("/");
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------- AUTH (Google + Register) ---------------------
app.post("/auth/google", async (req, res) => {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ success: false, message: "No id_token provided" });

    try {
        // Verify token with Google
        const googleResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`);
        const googleUser = await googleResp.json();
        if (googleUser.error_description || googleUser.error) {
            return res.status(400).json({ success: false, message: googleUser.error_description || googleUser.error });
        }

        const user_id = googleUser.sub;
        const name = googleUser.name || null;
        const email = googleUser.email || null;
        const picture = googleUser.picture || null;

        // Insert or update user record
        await pool.query(
            `INSERT INTO task_users (user_id, name, email, picture)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), picture = VALUES(picture)`,
            [user_id, name, email, picture]
        );

        // Set httpOnly cookie to mark session (server-side guard)
        res.cookie("user_id", user_id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

        return res.json({ success: true, user: { user_id, name, email, picture } });
    } catch (err) {
        console.error("Auth (google) error:", err);
        return res.status(500).json({ success: false, message: "Google auth failed" });
    }
});

app.post("/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required" });

    try {
        const [exists] = await pool.query("SELECT 1 FROM task_users WHERE email = ? LIMIT 1", [email]);
        if (exists.length > 0) return res.status(400).json({ success: false, message: "Email already registered" });

        const user_id = require("crypto").randomUUID();
        await pool.query("INSERT INTO task_users (user_id, name, email, password) VALUES (?, ?, ?, ?)", [user_id, name, email, password]);

        res.cookie("user_id", user_id, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        return res.json({ success: true, user: { user_id, name, email } });
    } catch (err) {
        console.error("Auth (register) error:", err);
        return res.status(500).json({ success: false, message: "Registration failed" });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});