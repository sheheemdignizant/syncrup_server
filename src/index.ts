import './config/env'; // Load environment variables first
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { ProjectController } from './controllers/ProjectController';
import { AIController } from './controllers/AIController';
import { WebhookController } from './controllers/WebhookController';
import { setIO } from './services/SocketService';

import { ImpactController } from './controllers/ImpactController';

const app = express();
const httpServer = createServer(app);



// IMPORTANT: Body parser MUST come before routes
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:5174'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' })); // Increased limit for large payloads
app.use(express.urlencoded({ extended: true }));

// Setup Socket.IO with CORS
// Setup Socket.IO with CORS
const io = new Server(httpServer, {
    cors: {
        origin: ['http://localhost:5173', 'http://localhost:5174'],
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Set io instance in SocketService
setIO(io);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('[WEBSOCKET] Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('[WEBSOCKET] Client disconnected:', socket.id);
    });
});

// Routes
app.post('/projects', ProjectController.createProject);
app.get('/projects', ProjectController.getProjects);
app.post('/repos', ProjectController.addRepo);
app.get('/graph', ProjectController.getGraph);
app.post('/dependencies', ProjectController.createDependency);
app.delete('/dependencies', ProjectController.deleteDependency);

// Webhook Routes
app.post('/webhook/github', WebhookController.handleGitHub);
app.post('/webhook/gitlab', WebhookController.handleGitLab);

// AI Routes
app.post('/ai/enrich', AIController.enrichNode);
app.post('/ai/analyze-impact', AIController.analyzeImpact);
app.post('/ai/classify-change', AIController.classifyChange);

// Impact Routes
app.patch('/impacts/file/:id/status', ImpactController.updateFileStatus);

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server ready`);
});
