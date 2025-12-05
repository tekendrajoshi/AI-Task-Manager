const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// MySQL connection
const pool = mysql.createPool({
    host: "mysql.railway.internal",      // YOUR_RAILWAY_HOST
    user: "root",                        // YOUR_DB_USER
    password: "jMNYJWgXozTYlDbPcECyjHBMuTwXwvWU", // YOUR_DB_PASSWORD
    database: "railway",                 // YOUR_DB_NAME
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Fetch all tasks
app.get("/tasks", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM ai_task_manager");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Optional: fetch tasks by status
app.get("/tasks/status/:status", async (req, res) => {
    const status = req.params.status;
    try {
        const [rows] = await pool.query("SELECT * FROM ai_task_manager WHERE Status = ?", [status]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
