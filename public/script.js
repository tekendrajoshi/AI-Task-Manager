// Global Variables
let currentPage = 'dashboard';
let tasks = [];
let notifications = [];
let notificationCheckInterval;

// DOM Elements
const pages = {
    dashboard: document.getElementById('dashboard-page'),
    tasks: document.getElementById('tasks-page'),
    chat: document.getElementById('chat-page')
};

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadDashboard();
    checkForNotifications();
    
    // Check for notifications every 30 seconds
    notificationCheckInterval = setInterval(checkForNotifications, 30000);
    
    // Initialize charts (will be loaded when dashboard is shown)
    if (window.Chart) {
        initCharts();
    }
});

// Navigation Functions
function initNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = link.dataset.page;
            switchPage(page);
        });
    });
    
    // Set dashboard as active by default
    switchPage('dashboard');
}

function switchPage(page) {
    // Update active page
    currentPage = page;
    
    // Update navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        if (link.dataset.page === page) {
            link.classList.add('active');
        }
    });
    
    // Show/hide pages
    Object.keys(pages).forEach(key => {
        if (key === page) {
            pages[key].classList.add('active');
        } else {
            pages[key].classList.remove('active');
        }
    });
    
    // Load page-specific content
    switch(page) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'tasks':
            loadTasks();
            break;
        case 'chat':
            loadChat();
            break;
    }
}

// Dashboard Functions
async function loadDashboard() {
    try {
        const response = await fetch('/api/task-stats');
        const stats = await response.json();
        
        updateDashboardStats(stats);
        updateCharts(stats);
        updateNotifications(stats);
    } catch (error) {
        console.error('Error loading dashboard:', error);
        showNotification('Failed to load dashboard data', 'error');
    }
}

function updateDashboardStats(stats) {
    // Update stat cards
    document.getElementById('pending-count').textContent = stats.byStatus['Pending'] || 0;
    document.getElementById('completed-count').textContent = stats.byStatus['Completed'] || 0;
    document.getElementById('not-started-count').textContent = stats.byStatus['Not Started'] || 0;
    document.getElementById('urgent-count').textContent = stats.urgent || 0;
    
    // Update upcoming deadlines
    const deadlinesList = document.getElementById('upcoming-deadlines');
    deadlinesList.innerHTML = '';
    
    if (stats.upcomingDeadlines && stats.upcomingDeadlines.length > 0) {
        stats.upcomingDeadlines.forEach(task => {
            const daysRemaining = Math.ceil((new Date(task.DueDate) - new Date()) / (1000 * 60 * 60 * 24));
            const item = document.createElement('div');
            item.className = 'deadline-item';
            item.innerHTML = `
                <div class="deadline-title">${task.Title}</div>
                <div class="deadline-date ${daysRemaining <= 2 ? 'urgent' : ''}">
                    ${formatDate(task.DueDate)} (${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'})
                </div>
            `;
            deadlinesList.appendChild(item);
        });
    } else {
        deadlinesList.innerHTML = '<div class="no-deadlines">No upcoming deadlines</div>';
    }
}

// Chart Functions
let statusChart, priorityChart;

function initCharts() {
    const statusCtx = document.getElementById('status-chart').getContext('2d');
    const priorityCtx = document.getElementById('priority-chart').getContext('2d');
    
    statusChart = new Chart(statusCtx, {
        type: 'doughnut',
        data: {
            labels: ['Not Started', 'Pending', 'Completed'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: [
                    '#6c757d',
                    '#ff9f1c',
                    '#2ec4b6'
                ],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });
    
    priorityChart = new Chart(priorityCtx, {
        type: 'bar',
        data: {
            labels: ['High', 'Medium', 'Low'],
            datasets: [{
                label: 'Tasks by Priority',
                data: [0, 0, 0],
                backgroundColor: [
                    '#e71d36',
                    '#ff9f1c',
                    '#2ec4b6'
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

function updateCharts(stats) {
    if (!statusChart || !priorityChart) return;
    
    // Update status chart
    statusChart.data.datasets[0].data = [
        stats.byStatus['Not Started'] || 0,
        stats.byStatus['Pending'] || 0,
        stats.byStatus['Completed'] || 0
    ];
    statusChart.update();
    
    // Update priority chart
    priorityChart.data.datasets[0].data = [
        stats.byPriority['High'] || 0,
        stats.byPriority['Medium'] || 0,
        stats.byPriority['Low'] || 0
    ];
    priorityChart.update();
}

// Tasks Functions
async function loadTasks() {
    try {
        showLoading('tasks-container', 'Loading tasks...');
        
        const response = await fetch('/api/tasks');
        tasks = await response.json();
        
        renderTasks();
        setupTaskFilters();
    } catch (error) {
        console.error('Error loading tasks:', error);
        showNotification('Failed to load tasks', 'error');
    }
}

function renderTasks(filter = 'all') {
    const taskLists = {
        'not-started': document.getElementById('not-started-tasks'),
        'pending': document.getElementById('pending-tasks'),
        'completed': document.getElementById('completed-tasks')
    };
    
    // Clear all task lists
    Object.values(taskLists).forEach(list => {
        list.innerHTML = '';
    });
    
    // Filter tasks
    let filteredTasks = tasks;
    if (filter !== 'all') {
        filteredTasks = tasks.filter(task => 
            filter === 'priority' ? task.Priority === filter : 
            filter === 'status' ? task.Status === filter : 
            task.Priority === filter
        );
    }
    
    // Group tasks by status
    const groupedTasks = {
        'Not Started': [],
        'Pending': [],
        'Completed': []
    };
    
    filteredTasks.forEach(task => {
        if (groupedTasks[task.Status]) {
            groupedTasks[task.Status].push(task);
        }
    });
    
    // Render tasks in each column
    Object.keys(groupedTasks).forEach(status => {
        const columnId = status.toLowerCase().replace(' ', '-');
        const taskList = taskLists[columnId];
        
        if (groupedTasks[status].length === 0) {
            taskList.innerHTML = '<div class="no-tasks">No tasks in this category</div>';
            return;
        }
        
        groupedTasks[status].forEach(task => {
            const taskElement = createTaskElement(task);
            taskList.appendChild(taskElement);
        });
    });
    
    // Update task counts
    document.getElementById('not-started-count').textContent = groupedTasks['Not Started'].length;
    document.getElementById('pending-count').textContent = groupedTasks['Pending'].length;
    document.getElementById('completed-count').textContent = groupedTasks['Completed'].length;
}

function createTaskElement(task) {
    const div = document.createElement('div');
    div.className = `task-card priority-${task.Priority ? task.Priority.toLowerCase() : 'medium'}`;
    div.dataset.id = task.TaskID;
    div.draggable = true;
    
    const dueDate = task.DueDate ? new Date(task.DueDate) : null;
    const daysRemaining = dueDate ? Math.ceil((dueDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
    
    div.innerHTML = `
        <div class="task-header">
            <div>
                <div class="task-title">${task.Title || 'Untitled Task'}</div>
                ${task.Description ? `<div class="task-description">${task.Description}</div>` : ''}
            </div>
            <div class="task-priority">${getPriorityIcon(task.Priority)}</div>
        </div>
        <div class="task-footer">
            <div class="task-info">
                ${dueDate ? `<div class="task-due ${daysRemaining <= 2 ? 'urgent' : ''}">
                    ${formatDate(task.DueDate)}
                </div>` : ''}
                <div class="task-created">Created: ${formatDate(task.CreatedAt)}</div>
            </div>
            <div class="task-actions">
                <button class="action-btn" onclick="updateTaskStatus(${task.TaskID}, 'Completed')" title="Mark as completed">
                    ✓
                </button>
                <button class="action-btn" onclick="deleteTask(${task.TaskID})" title="Delete task">
                    ×
                </button>
            </div>
        </div>
    `;
    
    // Add drag and drop event listeners
    div.addEventListener('dragstart', handleDragStart);
    div.addEventListener('dragover', handleDragOver);
    div.addEventListener('drop', handleDrop);
    
    return div;
}

function getPriorityIcon(priority) {
    const icons = {
        'High': '🔴',
        'Medium': '🟡',
        'Low': '🟢'
    };
    return icons[priority] || '⚪';
}

function setupTaskFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderTasks(btn.dataset.filter);
        });
    });
}

// Task Management Functions
async function updateTaskStatus(taskId, status) {
    try {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ Status: status })
        });
        
        if (response.ok) {
            showNotification('Task updated successfully', 'success');
            await loadTasks();
            await loadDashboard(); // Refresh dashboard stats
        }
    } catch (error) {
        console.error('Error updating task:', error);
        showNotification('Failed to update task', 'error');
    }
}

async function deleteTask(taskId) {
    if (!confirm('Are you sure you want to delete this task?')) return;
    
    try {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showNotification('Task deleted successfully', 'success');
            await loadTasks();
            await loadDashboard(); // Refresh dashboard stats
        }
    } catch (error) {
        console.error('Error deleting task:', error);
        showNotification('Failed to delete task', 'error');
    }
}

// Drag and Drop Functions
let draggedTask = null;

function handleDragStart(e) {
    draggedTask = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    this.classList.add('dragging');
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.classList.add('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    this.classList.remove('drag-over');
    
    if (draggedTask !== this) {
        const newStatus = this.closest('.task-column').dataset.status;
        const taskId = draggedTask.dataset.id;
        
        updateTaskStatus(taskId, newStatus);
    }
}

// Chat Functions
let chatMessages = [];

function loadChat() {
    const chatMessagesDiv = document.getElementById('chat-messages');
    chatMessagesDiv.innerHTML = '';
    
    // Load previous messages
    chatMessages.forEach(message => {
        addMessageToChat(message.text, message.sender, message.timestamp);
    });
    
    // Focus on input
    setTimeout(() => {
        document.getElementById('chat-input').focus();
    }, 100);
    
    // Setup send button and enter key
    const sendBtn = document.getElementById('send-btn');
    const chatInput = document.getElementById('chat-input');
    
    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

async function sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    const sendBtn = document.getElementById('send-btn');
    
    if (!message) return;
    
    // Add user message to chat
    addMessageToChat(message, 'user');
    input.value = '';
    sendBtn.disabled = true;
    
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message })
        });
        
        const data = await response.json();
        
        // Extract AI response
        let aiResponse = '';
        if (Array.isArray(data) && data[0]?.output) {
            aiResponse = data[0].output;
        } else if (data.response) {
            aiResponse = data.response;
        } else if (typeof data === 'string') {
            aiResponse = data;
        } else {
            aiResponse = 'I received your message. Let me process that for you.';
        }
        
        // Add AI response to chat
        setTimeout(() => {
            addMessageToChat(aiResponse, 'ai');
            sendBtn.disabled = false;
            input.focus();
        }, 1000); // Simulate thinking time
    } catch (error) {
        console.error('Error sending message:', error);
        addMessageToChat('Sorry, I encountered an error. Please try again.', 'ai');
        sendBtn.disabled = false;
        input.focus();
    }
}

function addMessageToChat(text, sender, timestamp = new Date()) {
    const chatMessagesDiv = document.getElementById('chat-messages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    
    const timeString = typeof timestamp === 'string' ? timestamp : 
        timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    messageDiv.innerHTML = `
        <div class="message-text">${formatMessage(text)}</div>
        <div class="message-time">${timeString}</div>
    `;
    
    chatMessagesDiv.appendChild(messageDiv);
    chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
    
    // Store message
    chatMessages.push({
        text,
        sender,
        timestamp: timeString
    });
    
    // Keep only last 50 messages
    if (chatMessages.length > 50) {
        chatMessages = chatMessages.slice(-50);
    }
}

function formatMessage(text) {
    // Convert URLs to links
    text = text.replace(
        /(https?:\/\/[^\s]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    
    // Convert newlines to <br>
    text = text.replace(/\n/g, '<br>');
    
    // Convert *bold* to <strong>
    text = text.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
    
    return text;
}

// Notification Functions
async function checkForNotifications() {
    try {
        const response = await fetch('/api/notifications');
        notifications = await response.json();
        
        // Update notification badge
        const badge = document.getElementById('notification-badge');
        if (notifications.length > 0) {
            badge.textContent = notifications.length;
            badge.style.display = 'inline-block';
            
            // Show desktop notifications if granted permission
            if (Notification.permission === 'granted') {
                showDesktopNotifications(notifications);
            }
        } else {
            badge.style.display = 'none';
        }
        
        // Show in-app notifications
        showInAppNotifications(notifications);
    } catch (error) {
        console.error('Error checking notifications:', error);
    }
}

function showInAppNotifications(notifications) {
    const container = document.getElementById('notification-container');
    if (!container) return;
    
    // Clear old notifications
    container.innerHTML = '';
    
    // Show only the 3 most recent notifications
    notifications.slice(0, 3).forEach(notification => {
        const notificationDiv = document.createElement('div');
        notificationDiv.className = `notification ${notification.type}`;
        notificationDiv.innerHTML = `
            <div class="notification-icon">
                ${notification.type === 'urgent' ? '⚠️' : 'ℹ️'}
            </div>
            <div class="notification-content">
                <div class="notification-message">${notification.message}</div>
                <div class="notification-task">${notification.Title}</div>
            </div>
            <button class="notification-close" onclick="this.parentElement.remove()">×</button>
        `;
        
        container.appendChild(notificationDiv);
        
        // Auto-remove after 10 seconds
        setTimeout(() => {
            if (notificationDiv.parentElement) {
                notificationDiv.remove();
            }
        }, 10000);
    });
}

function showDesktopNotifications(notifications) {
    notifications.forEach(notification => {
        new Notification('Task Reminder', {
            body: notification.message,
            icon: '/favicon.ico',
            tag: notification.TaskID
        });
    });
}

function requestNotificationPermission() {
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                console.log('Notification permission granted');
            }
        });
    }
}

// Utility Functions
function formatDate(dateString) {
    if (!dateString) return 'No date';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;
    
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div class="notification-icon">
            ${type === 'success' ? '✓' : type === 'error' ? '⚠️' : 'ℹ️'}
        </div>
        <div class="notification-message">${message}</div>
        <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    container.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.remove();
        }
    }, 5000);
}

function showLoading(containerId, message = 'Loading...') {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = `
        <div class="loading">
            <div class="loading-spinner"></div>
            <div>${message}</div>
        </div>
    `;
}

// Initialize notification permission on page load
if ('Notification' in window) {
    requestNotificationPermission();
}

// Export functions for HTML onclick events
window.updateTaskStatus = updateTaskStatus;
window.deleteTask = deleteTask;
window.sendMessage = sendMessage;