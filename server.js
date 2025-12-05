const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
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

// Serve the main page for all routes (SPA)
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});