const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY || 'AIzaSyAZnxe66ZIqTWQafOQ1eJUv8DQxfLvD3f4';
const GOOGLE_AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins a room
  socket.on('join-room', (data) => {
    const { roomCode, username, recipe } = data;
    
    // Create room if it doesn't exist
    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, {
        participants: [],
        recipe: recipe,
        startTime: null,
        messages: [],
        currentStep: 0
      });
    }

    const room = rooms.get(roomCode);
    
    // Add user to room (max 8 participants)
    if (room.participants.length < 8) {
      const user = {
        id: socket.id,
        username: username,
        currentStep: 0,
        isReady: false
      };
      
      room.participants.push(user);
      users.set(socket.id, { roomCode, username });
      socket.join(roomCode);
      
      // Notify all participants
      io.to(roomCode).emit('user-joined', {
        participants: room.participants,
        recipe: room.recipe,
        messages: room.messages
      });
      
      console.log(`${username} joined room ${roomCode}`);
    } else {
      socket.emit('room-full', 'Room is full (max 8 participants)');
    }
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const user = users.get(socket.id);
    if (user) {
      const message = {
        id: Date.now(),
        username: user.username,
        message: data.message,
        timestamp: new Date().toLocaleTimeString(),
        type: 'user'
      };
      
      const room = rooms.get(user.roomCode);
      room.messages.push(message);
      
      io.to(user.roomCode).emit('new-message', message);
    }
  });

  // Handle step progression
  socket.on('next-step', (data) => {
    const user = users.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomCode);
      const participant = room.participants.find(p => p.id === socket.id);
      
      if (participant) {
        participant.currentStep = data.step;
        io.to(user.roomCode).emit('step-updated', {
          userId: socket.id,
          username: user.username,
          step: data.step
        });
      }
    }
  });

  // Handle cooking timer sync
  socket.on('start-timer', (data) => {
    const user = users.get(socket.id);
    if (user) {
      io.to(user.roomCode).emit('timer-started', {
        duration: data.duration,
        startedBy: user.username
      });
    }
  });

  // Handle AI chat requests
  socket.on('ai-question', async (data) => {
    const user = users.get(socket.id);
    if (user) {
      try {
        const room = rooms.get(user.roomCode);
        const currentRecipe = room.recipe;
        const userCurrentStep = room.participants.find(p => p.id === socket.id)?.currentStep || 0;
        
        // Create context-aware prompt for the AI
        const contextPrompt = `You are an expert cooking assistant helping users cook ${currentRecipe?.name || 'a recipe'} in real-time. 
        
        Current recipe context:
        ${currentRecipe ? `
        Recipe: ${currentRecipe.name}
        Ingredients: ${currentRecipe.ingredients?.join(', ')}
        Cooking time: ${currentRecipe.cookingTime} minutes
        ` : 'No specific recipe selected'}
        
        User is currently on step: ${userCurrentStep}.
        
        User question: ${data.question}
        
        Please provide helpful, concise cooking advice. Focus on:
        - Cooking techniques and tips
        - Ingredient substitutions if needed  
        - Timing and temperature guidance
        - Troubleshooting cooking issues
        
        Keep responses friendly and practical, as if you're cooking alongside them.`;

        const response = await axios.post(`${GOOGLE_AI_ENDPOINT}?key=${GOOGLE_AI_API_KEY}`, {
          contents: [{
            parts: [{
              text: contextPrompt
            }]
          }]
        }, {
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const aiMessage = response.data.candidates[0].content.parts[0].text;
        
        const aiResponse = {
          id: Date.now(),
          username: 'AI Chef 🤖',
          message: aiMessage,
          timestamp: new Date().toLocaleTimeString(),
          type: 'ai'
        };
        
        room.messages.push(aiResponse);
        io.to(user.roomCode).emit('new-message', aiResponse);
        
      } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        
        const errorResponse = {
          id: Date.now(),
          username: 'AI Chef 🤖',
          message: 'Sorry, I\'m having trouble right now. Try asking other participants or check back in a moment!',
          timestamp: new Date().toLocaleTimeString(),
          type: 'ai'
        };
        
        const room = rooms.get(user.roomCode);
        room.messages.push(errorResponse);
        io.to(user.roomCode).emit('new-message', errorResponse);
      }
    }
  });

  // Handle photo sharing
  socket.on('share-photo', (data) => {
    const user = users.get(socket.id);
    if (user) {
      io.to(user.roomCode).emit('photo-shared', {
        username: user.username,
        photo: data.photo,
        filename: data.filename,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomCode);
      if (room) {
        room.participants = room.participants.filter(p => p.id !== socket.id);
        
        // Notify remaining participants
        io.to(user.roomCode).emit('user-left', {
          username: user.username,
          participants: room.participants
        });
        
        // Clean up empty rooms
        if (room.participants.length === 0) {
          rooms.delete(user.roomCode);
        }
      }
      users.delete(socket.id);
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Recipe Room server running on port ${PORT}`);
});
