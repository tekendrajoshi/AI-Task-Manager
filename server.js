// server.js
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Create connection pool to Railway MySQL (replace with your credentials)
const pool = mysql.createPool({
    host: "mysql.railway.internal",      // YOUR_RAILWAY_HOST → MYSQLHOST
    user: "root",                         // YOUR_DB_USER → MYSQLUSER
    password: "jMNYJWgXozTYlDbPcECyjHBMuTwXwvWU", // YOUR_DB_PASSWORD → MYSQLPASSWORD
    database: "railway",                  // YOUR_DB_NAME → MYSQLDATABASE
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

// Fetch tasks by status (optional)
app.get("/tasks/status/:status", async (req, res) => {
    const status = req.params.status;
    try {
        const [rows] = await pool.query("SELECT * FROM ai_task_manager WHERE Status = ?", [status]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
