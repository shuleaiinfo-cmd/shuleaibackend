require('dotenv').config();
const path = require('path');
const app = require('./src/app');
const http = require('http');
const socketio = require('socket.io');
const { sequelize } = require('./src/models');
const jwt = require('jsonwebtoken');
const { User } = require('./src/models');
const { ensureRuntimeSchema } = require('./src/utils/schemaSafety');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = socketio(server, {
    cors: { origin: process.env.FRONTEND_URL || '*', credentials: true }
});
global.io = io;

// Socket.IO authentication middleware
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error: No token provided'));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findByPk(decoded.id);
        if (!user || !user.isActive) {
            return next(new Error('Authentication error: Invalid user'));
        }
        socket.userId = user.id;
        socket.userRole = user.role;
        socket.schoolCode = user.schoolCode;
        next();
    } catch (err) {
        next(new Error('Authentication error: Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log(`✅ WebSocket connected: user ${socket.userId} (${socket.userRole})`);

    // Join user's personal room
    socket.join(`user-${socket.userId}`);

    // Join school room if applicable
    if (socket.schoolCode) {
        socket.join(`school-${socket.schoolCode}`);
    }

    socket.on('join', (userId) => {
        if (userId) socket.join(`user-${userId}`);
    });

    socket.on('private-message', (data) => {
        io.to(`user-${data.to}`).emit('private-message', {
            from: socket.userId,
            message: data.message,
            timestamp: new Date()
        });
    });

    socket.on('typing', (data) => {
        socket.to(`user-${data.to}`).emit('typing', {
            from: socket.userId,
            isTyping: data.isTyping
        });
    });

    socket.on('disconnect', () => {
        console.log(`WebSocket disconnected: user ${socket.userId}`);
    });
});

// Test database connection, create missing core tables on clean databases, then run safe schema upgrades.
// IMPORTANT:
// - sequelize.sync({ alter: false }) only creates missing tables. It does NOT rewrite existing tables.
// - This is required for a brand-new Render Postgres database, otherwise core tables like "Users" do not exist.
// - Set DISABLE_DB_SYNC=true only if you are managing schema manually with migrations.
async function startServer() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection test SUCCESSFUL');

    const disableDbSync = process.env.DISABLE_DB_SYNC === 'true';

    if (!disableDbSync) {
      console.log('🧱 Ensuring core database tables exist...');
      await sequelize.sync({ alter: false });
      console.log('✅ Core database tables ready');
    } else {
      console.log('ℹ️ DISABLE_DB_SYNC=true, skipping automatic table creation');
    }

    await ensureRuntimeSchema();

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Database or sync error:', err);
    process.exit(1);
  }
}

startServer();

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});
