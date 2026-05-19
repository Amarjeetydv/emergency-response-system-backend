const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');
const db = require('./config/db'); // This will run the connection check
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

// Load env vars
dotenv.config();

// Route files
const authRoutes = require('./routes/authRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { processEscalations } = require('./controllers/emergencyController');
const Message = require('./models/messageModel');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isOriginAllowed = (origin) => {
  // Allow non-browser and same-origin requests with no Origin header.
  if (!origin) return true;
  if (!allowedOrigins.length) return true;
  return allowedOrigins.includes(origin);
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  }
});

// Redis Setup for Horizontal Scaling
if (process.env.REDIS_URL) {
  const pubClient = createClient({ 
    url: process.env.REDIS_URL,
    socket: {
      // Reconnect strategy prevents infinite immediate retries if Redis is unavailable locally
      reconnectStrategy: (retries) => {
        if (retries > 5) return new Error('Redis connection failed permanently');
        return Math.min(retries * 200, 2000);
      }
    }
  });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err.message || 'Connection refused'));
  subClient.on('error', (err) => console.error('Redis Sub Client Error:', err.message || 'Connection refused'));

  Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('Redis Adapter connected');
  }).catch((err) => {
    console.error('Redis connection failed. Horizontal scaling with Socket.io will not work.', err.message);
  });
} else {
  console.log('REDIS_URL not set in .env. Skipping Redis Adapter for Socket.io (using default memory adapter).');
}

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health Check for Render/Monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});

// Make io accessible to our router
app.set('socketio', io);

// Background Tasks: Escalation Cron (Runs every minute)
cron.schedule('* * * * *', () => {
  processEscalations(io);
});

// Mount routers
app.use('/api/auth', authRoutes);
app.use('/api/emergencies', emergencyRoutes);
app.use('/api/admin', adminRoutes);

// Socket.io connection
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });

  // Example: Listen for location updates from responders
  socket.on('updateLocation', (data) => {
    // data should contain { responderId, latitude, longitude }
    console.log('Location update:', data);
    // Broadcast the location update to other clients (e.g., a dispatcher dashboard)
    io.emit('responderLocationUpdate', data);
  });

  // Chat System
  socket.on('joinChat', (emergencyId) => {
    socket.join(`chat_${emergencyId}`);
    console.log(`User ${socket.id} joined chat_${emergencyId}`);
  });

  socket.on('sendMessage', async (data) => {
    const { emergencyId, senderId, message, senderName } = data;
    try {
      await Message.create(emergencyId, senderId, message);
      io.to(`chat_${emergencyId}`).emit('receiveMessage', { senderId, message, senderName, timestamp: new Date() });
    } catch (err) {
      console.error('Chat error:', err);
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server initialized in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🗄️  Attempting connection to Database Host: ${process.env.DB_HOST || 'Not Set'}`);
});

// Graceful shutdown for production
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server shut down gracefully');
    process.exit(0);
  });
});
