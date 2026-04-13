import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { MongoClient, Db } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { classifyAIError, createAIClient, formatAIError, getAIRetryDelaySeconds } from "./ai";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || "";
const JWT_SECRET = process.env.JWT_SECRET || "what-if-secret-key-change-in-prod";

function getPrompt(filename: string) {
  return fs.readFileSync(path.join(process.cwd(), "prompts", filename), "utf8");
}

function logBattleServerDebug(event: string, details: Record<string, unknown> = {}) {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  };

  try {
    console.log('[BattleServerDebug]', JSON.stringify(payload, null, 2));
  } catch {
    console.log('[BattleServerDebug]', payload);
  }
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
    maxHttpBufferSize: 8 * 1024 * 1024,
    pingTimeout: 120_000,   // 2 min — prevents disconnect when phone goes to background
    pingInterval: 30_000,
  });

  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const mergeStoredCharacterAvatars = (storedCharacters: any[], incomingCharacters: any[]) => {
    const storedByName = new Map((storedCharacters || []).map(character => [character.name, character]));
    return incomingCharacters.map(character => {
      const stored = storedByName.get(character.name);
      return {
        ...stored,
        ...character,
        imageUrl: typeof character?.imageUrl === 'string' && character.imageUrl.trim()
          ? character.imageUrl
          : stored?.imageUrl,
      };
    });
  };

  // Load world data
  const worldPath = path.join(process.cwd(), "world.json");
  let worldData: any = null;
  if (fs.existsSync(worldPath)) {
    worldData = JSON.parse(fs.readFileSync(worldPath, "utf-8"));
  }

  // MongoDB connection (optional - app works without it using localStorage)
  let db: Db | null = null;
  if (MONGO_URI) {
    try {
      const mongoClient = new MongoClient(MONGO_URI);
      await mongoClient.connect();
      db = mongoClient.db("what_if");
      console.log("Connected to MongoDB Atlas");
      
      // Ensure indexes
      await db.collection("users").createIndex({ username: 1 }, { unique: true });
    } catch (e) {
      console.error("MongoDB connection failed (app will use localStorage):", e);
    }
  } else {
    console.log("No MONGODB_URI set - accounts disabled, using localStorage");
  }

  // Auth middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: 'Invalid token' });
      req.user = user;
      next();
    });
  };

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", dbConnected: !!db });
  });

  app.get("/api/world", (req, res) => {
    if (!worldData) {
      res.status(404).json({ error: "World not found" });
      return;
    }
    res.json(worldData);
  });

  app.get("/api/prompts/:name", (req, res) => {
    try {
      const prompt = getPrompt(req.params.name);
      res.send(prompt);
    } catch (e) {
      res.status(404).send("Prompt not found");
    }
  });

  const botCharsDir = path.join(process.cwd(), 'bot_characters');
  if (!fs.existsSync(botCharsDir)) {
    fs.mkdirSync(botCharsDir, { recursive: true });
  }

  // Seed bot characters into MongoDB from filesystem (on first run)
  if (db) {
    const botCharsCollection = db.collection("bot_characters");
    const existingCount = await botCharsCollection.countDocuments();
    if (existingCount === 0) {
      try {
        const files = fs.readdirSync(botCharsDir).filter(f => f.endsWith('.md'));
        const docs = files.map(f => {
          const content = fs.readFileSync(path.join(botCharsDir, f), "utf-8");
          const nameMatch = content.match(/^#\s+(.+)$/m);
          const name = nameMatch ? nameMatch[1].trim() : f.replace('.md', '');
          return { _id: f, name, content };
        });
        if (docs.length > 0) {
          await botCharsCollection.insertMany(docs as any[]);
          console.log(`Seeded ${docs.length} bot characters into MongoDB`);
        }
      } catch (e) {
        console.error("Failed to seed bot characters:", e);
      }
    }
  }

  app.get("/api/bot_characters", async (req, res) => {
    try {
      if (db) {
        const chars = await db.collection("bot_characters").find({}).toArray();
        res.json(chars.map(c => ({ id: c._id, name: c.name, content: c.content })));
      } else {
        const files = fs.readdirSync(botCharsDir).filter(f => f.endsWith('.md'));
        const chars = files.map(f => {
          const content = fs.readFileSync(path.join(botCharsDir, f), "utf-8");
          const nameMatch = content.match(/^#\s+(.+)$/m);
          const name = nameMatch ? nameMatch[1].trim() : f.replace('.md', '');
          return { id: f, name, content };
        });
        res.json(chars);
      }
    } catch (e) {
      res.status(500).json({ error: "Failed to load bot characters" });
    }
  });

  app.post("/api/bot_characters", async (req, res) => {
    try {
      const { name, content } = req.body;
      if (!name || !content) return res.status(400).json({ error: "Missing name or content" });
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.md';
      if (db) {
        await db.collection("bot_characters").updateOne(
          { _id: id as any },
          { $set: { name, content, updatedAt: new Date() } },
          { upsert: true }
        );
      } else {
        fs.writeFileSync(path.join(botCharsDir, id), content);
      }
      res.json({ id, name, content });
    } catch (e) {
      res.status(500).json({ error: "Failed to save bot character" });
    }
  });

  // ============ AUTH & ACCOUNT ENDPOINTS ============
  app.post("/api/auth/register", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      
      const existing = await db.collection("users").findOne({ username: username.toLowerCase() });
      if (existing) return res.status(409).json({ error: "Username already taken" });
      
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await db.collection("users").insertOne({
        username: username.toLowerCase(),
        displayName: username,
        password: hashedPassword,
        characters: [],
        activeCharacterIndex: 0,
        createdAt: new Date()
      });
      
      const token = jwt.sign({ userId: result.insertedId.toString(), username: username.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ token, username: username.toLowerCase(), displayName: username });
    } catch (e: any) {
      if (e.code === 11000) return res.status(409).json({ error: "Username already taken" });
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      
      const user = await db.collection("users").findOne({ username: username.toLowerCase() });
      if (!user) {
        console.log(`[AUTH] Login failed: user "${username.toLowerCase()}" not found`);
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        console.log(`[AUTH] Login failed: wrong password for "${username.toLowerCase()}" (hash starts: ${user.password?.slice(0, 7) || 'NO_HASH'})`);
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      const token = jwt.sign({ userId: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
      res.json({ token, username: user.username, displayName: user.displayName, characters: user.characters || [], activeCharacterIndex: user.activeCharacterIndex || 0 });
    } catch (e) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.get("/api/account/characters", authenticateToken, async (req: any, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const user = await db.collection("users").findOne({ username: req.user.username });
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({ characters: user.characters || [], activeCharacterIndex: user.activeCharacterIndex || 0 });
    } catch (e) {
      res.status(500).json({ error: "Failed to load characters" });
    }
  });

  app.post("/api/account/characters", authenticateToken, async (req: any, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const { characters, activeCharacterIndex } = req.body;
      if (!Array.isArray(characters)) return res.status(400).json({ error: "Characters must be an array" });
      const user = await db.collection("users").findOne({ username: req.user.username });
      if (!user) return res.status(404).json({ error: "User not found" });
      const mergedCharacters = mergeStoredCharacterAvatars(user.characters || [], characters);
      
      await db.collection("users").updateOne(
        { username: req.user.username },
        { $set: { characters: mergedCharacters, activeCharacterIndex: activeCharacterIndex || 0, updatedAt: new Date() } }
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to save characters" });
    }
  });

  app.post("/api/account/character-avatar", authenticateToken, async (req: any, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const { name, imageUrl } = req.body;
      if (!name || typeof imageUrl !== 'string' || !imageUrl.trim()) {
        return res.status(400).json({ error: "Character name and imageUrl are required" });
      }

      const user = await db.collection("users").findOne({ username: req.user.username });
      if (!user) return res.status(404).json({ error: "User not found" });

      const characters = (user.characters || []).map((character: any) => (
        character.name === name ? { ...character, imageUrl } : character
      ));

      await db.collection("users").updateOne(
        { username: req.user.username },
        { $set: { characters, updatedAt: new Date() } }
      );

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to save character avatar" });
    }
  });

  // Global game settings (shared across all players)
  app.get("/api/settings", async (req, res) => {
    if (!db) return res.json({});
    try {
      const settings = await db.collection("settings").findOne({ _id: "global" as any });
      res.json({
        ...(settings?.data || {}),
        unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
      });
    } catch (e) {
      res.json({});
    }
  });

  app.post("/api/settings", async (req: any, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const allowedKeys = ['unlimitedTurnTime', 'arenaPreviewSeconds', 'arenaTweakSeconds', 'battleTurnSeconds', 'charModel', 'explorationModel', 'battleModel', 'botModel'];
      const modelKeys = new Set(['charModel', 'explorationModel', 'battleModel', 'botModel']);
      const validModels = new Set(['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']);
      const data: Record<string, any> = {};
      for (const key of allowedKeys) {
        if (req.body[key] === undefined) continue;
        if (modelKeys.has(key)) {
          if (typeof req.body[key] === 'string' && validModels.has(req.body[key])) {
            data[key] = req.body[key];
          }
          continue;
        }
        data[key] = req.body[key];
      }
      const existing = await db.collection("settings").findOne({ _id: "global" as any });
      const mergedData = {
        ...(existing?.data || {}),
        ...data,
        unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
      };
      await db.collection("settings").updateOne(
        { _id: "global" as any },
        { $set: { data: mergedData, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  const buildAIRequestConfig = (rawConfig: any, abortSignal?: AbortSignal) => {
    const config: Record<string, any> = {};

    if (typeof rawConfig?.systemInstruction === 'string' && rawConfig.systemInstruction.trim()) {
      config.systemInstruction = rawConfig.systemInstruction;
    }
    if (typeof rawConfig?.temperature === 'number' && Number.isFinite(rawConfig.temperature)) {
      config.temperature = rawConfig.temperature;
    }
    if (rawConfig?.thinkingConfig && typeof rawConfig.thinkingConfig === 'object') {
      config.thinkingConfig = rawConfig.thinkingConfig;
    }
    if (Array.isArray(rawConfig?.tools)) {
      config.tools = rawConfig.tools;
    }
    if (Array.isArray(rawConfig?.responseModalities)) {
      config.responseModalities = rawConfig.responseModalities.filter((entry: unknown) => typeof entry === 'string');
    }
    if (typeof rawConfig?.topP === 'number' && Number.isFinite(rawConfig.topP)) {
      config.topP = rawConfig.topP;
    }
    if (typeof rawConfig?.topK === 'number' && Number.isFinite(rawConfig.topK)) {
      config.topK = rawConfig.topK;
    }
    if (typeof rawConfig?.candidateCount === 'number' && Number.isFinite(rawConfig.candidateCount)) {
      config.candidateCount = rawConfig.candidateCount;
    }
    if (typeof rawConfig?.maxOutputTokens === 'number' && Number.isFinite(rawConfig.maxOutputTokens)) {
      config.maxOutputTokens = rawConfig.maxOutputTokens;
    }
    if (abortSignal) {
      config.abortSignal = abortSignal;
    }

    return config;
  };

  const buildAIRequestPayload = (body: any, abortSignal?: AbortSignal) => {
    if (typeof body?.model !== 'string' || !body.model.trim()) {
      throw new Error('Model is required');
    }

    return {
      model: body.model,
      contents: body.contents,
      config: buildAIRequestConfig(body.config, abortSignal),
    };
  };

  const AI_RETRY_WINDOW_MS = 120_000;

  const get503FallbackModel = (model: string, errorInfo?: { statusCode?: number; statusText?: string }, attempt = 0) => {
    const isUnavailable = errorInfo?.statusCode === 503 || errorInfo?.statusText === 'UNAVAILABLE';
    if (!isUnavailable || attempt < 1) return model;
    if (model === 'gemini-2.5-pro') return 'gemini-2.5-flash';
    if (model === 'gemini-3.1-pro-preview') return 'gemini-3-flash-preview';
    return model;
  };

  const sleepMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const getServerSideApiKey = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    return process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  };

  const serializeAIError = (error: unknown) => {
    if ((error as any)?.retryWindowExpired) {
      return {
        error: (error as any)?.label || 'Gemini is temporarily unavailable',
        detail: (error as any)?.detail || 'Retry window expired',
        retryable: false,
        retryWindowExpired: true,
        message: (error as any)?.message || 'Retry window expired',
      };
    }

    const errorInfo = classifyAIError(error);
    return {
      error: errorInfo.label,
      detail: errorInfo.detail,
      retryable: errorInfo.retryable,
      statusCode: errorInfo.statusCode,
      statusText: errorInfo.statusText,
      suggestedRetrySeconds: errorInfo.suggestedRetrySeconds,
      message: error instanceof Error ? error.message : String(error),
    };
  };

  const generateContentWithRetryWindow = async (body: any, abortSignal: AbortSignal) => {
    const apiKey = getServerSideApiKey(body?.apiKey);
    if (!apiKey) {
      const missingKey: any = new Error('Gemini API key is not configured');
      missingKey.label = 'Gemini API key is not configured';
      throw missingKey;
    }

    const aiClient = createAIClient(apiKey);
    const startedAt = Date.now();
    let attempts = 0;
    let lastRetryError: { statusCode?: number; statusText?: string } | undefined;

    while (true) {
      if (abortSignal.aborted) {
        throw new Error('Aborted');
      }

      try {
        const requestPayload = buildAIRequestPayload({
          ...body,
          model: get503FallbackModel(body?.model, lastRetryError, attempts),
        }, abortSignal);
        return await aiClient.models.generateContent(requestPayload as any);
      } catch (error) {
        if (abortSignal.aborted) {
          throw error;
        }

        const errorInfo = classifyAIError(error);
        if (!errorInfo.retryable) {
          throw error;
        }

        attempts += 1;
        lastRetryError = errorInfo;
        const remainingMs = AI_RETRY_WINDOW_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          const expiredError: any = new Error(`${errorInfo.label}. Retry window expired.`);
          expiredError.label = errorInfo.label;
          expiredError.detail = errorInfo.detail;
          expiredError.retryWindowExpired = true;
          throw expiredError;
        }

        const retryDelaySeconds = Math.min(
          getAIRetryDelaySeconds(attempts, errorInfo.suggestedRetrySeconds),
          Math.max(1, remainingMs / 1000),
        );
        await sleepMs(retryDelaySeconds * 1000);
      }
    }
  };

  app.post('/api/ai/generate', async (req, res) => {
    const abortController = new AbortController();
    req.on('aborted', () => abortController.abort());
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      const response = await generateContentWithRetryWindow(req.body, abortController.signal);
      res.json({
        text: typeof (response as any)?.text === 'string' ? (response as any).text : '',
        candidates: (response as any)?.candidates || [],
      });
    } catch (error) {
      const payload = serializeAIError(error);
      res.status(payload.statusCode || 500).json(payload);
    }
  });

  app.post('/api/ai/generate-stream', async (req, res) => {
    const apiKey = getServerSideApiKey(req.body?.apiKey);
    if (!apiKey) {
      res.status(400).json({ error: 'Gemini API key is not configured' });
      return;
    }

    const abortController = new AbortController();
    req.on('aborted', () => abortController.abort());
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    try {
      const debugLabel = typeof req.body?.config?.debugLabel === 'string' && req.body.config.debugLabel.trim()
        ? req.body.config.debugLabel.trim()
        : 'ai-generate-stream';
      console.log('[AI Stream]', {
        event: 'start',
        debugLabel,
        model: req.body?.model,
      });
      const aiClient = createAIClient(apiKey);
      const requestPayload = buildAIRequestPayload(req.body, abortController.signal);
      const response = await aiClient.models.generateContentStream(requestPayload as any);
      let chunkCount = 0;
      let thoughtPartCount = 0;
      let textPartCount = 0;
      let functionCallCount = 0;
      let loggedThoughtOnlyChunk = false;
      let loggedVisibleChunk = false;
      for await (const chunk of response as any) {
        if (abortController.signal.aborted) {
          break;
        }
        chunkCount += 1;
        const parts = chunk?.candidates?.[0]?.content?.parts || [];
        const thoughtParts = parts.filter((part: any) => !!part?.thought).length;
        const textParts = parts.filter((part: any) => typeof part?.text === 'string' && part.text.trim()).length;
        const toolParts = parts.filter((part: any) => !!part?.functionCall).length;
        thoughtPartCount += thoughtParts;
        textPartCount += textParts;
        functionCallCount += toolParts;
        if (!loggedThoughtOnlyChunk && thoughtParts > 0 && textParts === 0 && toolParts === 0) {
          loggedThoughtOnlyChunk = true;
          console.log('[AI Stream]', {
            event: 'thought_only_chunk',
            debugLabel,
            model: req.body?.model,
            chunkCount,
          });
        }
        if (!loggedVisibleChunk && (textParts > 0 || toolParts > 0)) {
          loggedVisibleChunk = true;
          console.log('[AI Stream]', {
            event: 'first_visible_chunk',
            debugLabel,
            model: req.body?.model,
            chunkCount,
            textParts,
            toolParts,
          });
        }
        res.write(`${JSON.stringify({ candidates: chunk?.candidates || [] })}\n`);
      }
      console.log('[AI Stream]', {
        event: 'end',
        debugLabel,
        model: req.body?.model,
        chunkCount,
        thoughtPartCount,
        textPartCount,
        functionCallCount,
        aborted: abortController.signal.aborted,
      });
      res.end();
    } catch (error) {
      const payload = serializeAIError(error);
      const debugLabel = typeof req.body?.config?.debugLabel === 'string' && req.body.config.debugLabel.trim()
        ? req.body.config.debugLabel.trim()
        : 'ai-generate-stream';
      console.error('[AI Stream]', {
        event: 'error',
        debugLabel,
        model: req.body?.model,
        statusCode: payload.statusCode,
        statusText: payload.statusText,
        error: payload.error,
        detail: payload.detail,
      });
      res.write(`${JSON.stringify({ error: payload })}\n`);
      res.end();
    }
  });

  // Socket.io logic
  interface QueuePlayer {
    id: string;
    character: any;
    isReady: boolean;
    apiKey?: string;
    unlimitedTurnTime?: boolean;
    arenaPreviewSeconds?: number;
    arenaTweakSeconds?: number;
    battleTurnSeconds?: number;
    modelSettings?: { charModel?: string; explorationModel?: string; battleModel?: string; botModel?: string } | null;
  }
  let matchmakingQueue: Record<string, QueuePlayer> = {};
  const rooms: Record<string, any> = {};
  const roomTimers: Record<string, { interval: NodeJS.Timeout; remaining: number }> = {};
  const arenaPreparationTimers: Record<string, { interval: NodeJS.Timeout | null; stage: 'preview' | 'tweak'; remaining: number | null; skipVotes: string[]; playerPaused: Record<string, boolean>; playerBonusSeconds: Record<string, number>; tweakDuration: number | null; unlimited: boolean }> = {};
  const typingChannelMembers: Record<string, Set<string>> = {};
  const typingChannelBySocket: Record<string, string> = {};
  const typingTimeouts: Record<string, NodeJS.Timeout> = {};
  const TURN_TIMER_SECONDS = 90;
  const ARENA_PREVIEW_SECONDS = 15;
  const ARENA_TWEAK_SECONDS = 120;
  const ALWAYS_UNLIMITED_TURN_TIME = true;
  const BATTLE_RETRY_WINDOW_MS = 120_000;
  const BATTLE_STREAM_THOUGHTS_PREFIX = 'STREAMING_THOUGHTS_';
  const BATTLE_STREAM_ANSWER_PREFIX = 'STREAMING_ANSWER_';
  const BATTLE_PENDING_ACTION_PREFIX = 'PENDING_PLAYER_ACTION_';
  const BATTLE_PLAYER_ACTIONS_PREFIX = 'PLAYER_ACTIONS_';
  const SESSION_RECONNECT_GRACE_MS = 45_000;
  const socketSessionIds: Record<string, string> = {};
  const sessionSocketIds: Record<string, string> = {};
  const pendingDisconnects: Record<string, { socketId: string; timer: NodeJS.Timeout; explorationInterrupted: boolean }> = {};

  function startRoomTimer(roomId: string, startingRemaining?: number | null) {
    clearRoomTimer(roomId);
    const room = rooms[roomId];
    if (!room) return;

    if (room.unlimitedTurnTime) {
      io.to(roomId).emit("turnTimerTick", { remaining: null });
      return;
    }

    const defaultTurnDuration = (typeof room.battleTurnSeconds === 'number' && room.battleTurnSeconds >= 10) ? room.battleTurnSeconds : TURN_TIMER_SECONDS;
    const turnDuration = typeof startingRemaining === 'number' && startingRemaining > 0
      ? Math.ceil(startingRemaining)
      : defaultTurnDuration;
    delete room.pausedTurnRemaining;
    roomTimers[roomId] = { interval: null as any, remaining: turnDuration };

    logBattleServerDebug('turn_timer_started', {
      roomId,
      turnDuration,
      startingRemaining: startingRemaining ?? null,
      playerIds: Object.keys(room.players || {}),
      pendingReadyPlayers: Array.from(room.pendingReadyPlayers || []),
    });

    io.to(roomId).emit("turnTimerTick", { remaining: turnDuration });

    roomTimers[roomId].interval = setInterval(() => {
      const timer = roomTimers[roomId];
      if (!timer) return;

      timer.remaining -= 1;
      io.to(roomId).emit("turnTimerTick", { remaining: timer.remaining });

      if (timer.remaining <= 0) {
        clearRoomTimer(roomId);
        autoLockIdlePlayers(roomId);
      }
    }, 1000);
  }

  function clearRoomTimer(roomId: string) {
    const timer = roomTimers[roomId];
    if (timer) {
      clearInterval(timer.interval);
      delete roomTimers[roomId];
    }
    io.to(roomId).emit("turnTimerTick", { remaining: null });
  }

  function appendRoomHistory(roomId: string, entries: string | string[]) {
    const room = rooms[roomId];
    if (!room) return;

    if (!Array.isArray(room.history)) {
      room.history = [];
    }

    const normalizedEntries = Array.isArray(entries) ? entries : [entries];
    for (const entry of normalizedEntries) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      if (room.history[room.history.length - 1] === entry) continue;
      room.history.push(entry);
    }

    if (room.history.length > 200) {
      room.history = room.history.slice(-200);
    }
  }

  function appendBattleMediaLogs(roomId: string, actorName: string, imageUrl: string) {
    const room = rooms[roomId];
    if (!room || typeof imageUrl !== 'string' || !imageUrl.trim()) return;

    if (!Array.isArray(room.battleMediaLogs)) {
      room.battleMediaLogs = [];
    }

    const entries = [
      `STATUS_IMAGE::🎨 **${actorName || 'Someone'}** visualized the scene`,
      `STATUS_IMAGE_URL::${imageUrl}`,
    ];

    for (const entry of entries) {
      if (room.battleMediaLogs[room.battleMediaLogs.length - 1] === entry) continue;
      room.battleMediaLogs.push(entry);
    }

    if (room.battleMediaLogs.length > 8) {
      room.battleMediaLogs = room.battleMediaLogs.slice(-8);
    }

    logBattleServerDebug('battle_media_logs_updated', {
      roomId,
      actorName,
      mediaLogCount: room.battleMediaLogs.length,
      imageUrlLength: imageUrl.length,
    });
  }

  function emitBattleActionsSubmitted(roomId: string, room: { players: Record<string, any> }) {
    const playerIds = Object.keys(room.players);
    const orderedPlayerIds = [...playerIds].sort((leftId, rightId) => {
      const leftSequence = room.players[leftId]?.actionSequence ?? Number.MAX_SAFE_INTEGER;
      const rightSequence = room.players[rightId]?.actionSequence ?? Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return playerIds.indexOf(leftId) - playerIds.indexOf(rightId);
    });

    const log = orderedPlayerIds
      .map(pid => `**${room.players[pid].character.name}:** ${room.players[pid].action}`)
      .join("\n\n");

    const payload = `PLAYER_ACTIONS_${log}`;
    appendRoomHistory(roomId, payload);
    io.to(roomId).emit("battleActionsSubmitted", { log: payload });
  }

  function requestTurnResolutionIfReady(roomId: string, options?: { reissue?: boolean }) {
    const room = rooms[roomId];
    if (!room) return;

    const playerIds = Object.keys(room.players || {});
    if (playerIds.length === 0) return;

    const allLockedIn = playerIds.every((id) => room.players[id].lockedIn);
    if (!allLockedIn) return;

    const isReissue = !!options?.reissue && !!room.awaitingTurnResolution;
    if (room.awaitingTurnResolution && !isReissue) {
      return;
    }
    if (room.battleResolutionTaskActive) {
      return;
    }

    const now = Date.now();
    if (typeof room.lastResolutionRequestAt === 'number' && now - room.lastResolutionRequestAt < 3_000) {
      return;
    }

    room.lastResolutionRequestAt = now;
    room.awaitingTurnResolution = true;
    clearRoomTimer(roomId);
    if (!isReissue) {
      emitBattleActionsSubmitted(roomId, room);
    }

    room.resolutionRequestNonce = (room.resolutionRequestNonce || 0) + 1;
    void runBattleTurnResolution(roomId, { reissue: isReissue });
  }

  function endBattleDueToInactivity(roomId: string, room: { players: Record<string, any> }) {
    clearRoomTimer(roomId);
    const inactivityLog = "**BATTLE ENDED.** Both fighters missed the turn, so the duel is called off.";
    appendRoomHistory(roomId, inactivityLog);
    io.to(roomId).emit("battleEndedByInactivity", {
      log: inactivityLog,
    });

    for (const pid of Object.keys(room.players)) {
      if (players[pid]) {
        delete players[pid].room;
      }
    }

    delete rooms[roomId];
  }

  function autoLockIdlePlayers(roomId: string) {
    const room = rooms[roomId];
    if (!room) return;

    const playerIds = Object.keys(room.players);
    let anyAutoLocked = false;

    for (const pid of playerIds) {
      if (!room.players[pid].lockedIn) {
        room.players[pid].lockedIn = true;
        room.players[pid].autoLockedThisTurn = true;
        room.players[pid].action = `${room.players[pid].character.name} hesitates and takes a defensive stance, bracing for impact.`;
        room.battleActionSequence = (room.battleActionSequence || 0) + 1;
        room.players[pid].actionSequence = room.battleActionSequence;
        io.to(roomId).emit("playerLockedIn", pid);
        io.to(roomId).emit("turnTimerAutoLocked", { playerId: pid, playerName: room.players[pid].character.name });
        appendRoomHistory(roomId, `⏰ **${room.players[pid].character.name}** ran out of time and took a defensive stance!`);
        anyAutoLocked = true;
      }
    }

    if (anyAutoLocked) {
      const allLockedIn = playerIds.every((id) => room.players[id].lockedIn);
      if (allLockedIn) {
        const everyoneMissedTurn = playerIds.every((id) => room.players[id].autoLockedThisTurn);
        if (everyoneMissedTurn) {
          endBattleDueToInactivity(roomId, room);
          return;
        }
        requestTurnResolutionIfReady(roomId);
      }
    }
  }

  const players: Record<string, any> = {};
  // Exploration: track players in the world
  const explorationPlayers: Record<string, { socketId: string; character: any; locationId: string; subZoneId: string | null; x: number; y: number }> = {};
  // Track locked-in exploration actions: playerId -> action text
  const explorationLockedActions: Record<string, string> = {};
  // Track active exploration AI requests for abort-on-disconnect
  const activeExplorationRequests: Record<string, AbortController> = {};

  interface ExplorationSubmittedAction {
    playerId: string;
    playerName: string;
    action: string;
    locationId: string;
  }

  interface ExplorationNpcState {
    id: string;
    name: string;
    role: string;
    locationId: string;
    subZoneId: string | null;
    x: number;
    y: number;
    homeLocationId: string;
    followTargetId: string | null;
  }

  interface BattleMapPlayerState {
    id: string;
    name: string;
    locationId: string;
    x: number;
    y: number;
  }

  interface BattleMapNpcState {
    id: string;
    name: string;
    role: string;
    locationId: string;
    x: number;
    y: number;
    followTargetId: string | null;
  }

  interface BattleMapState {
    discoveredLocations: string[];
    players: BattleMapPlayerState[];
    npcs: BattleMapNpcState[];
    zones?: { id: string; name: string; description: string; connections: string[] }[];
    combatantZones?: Record<string, string>;
  }

  const getExplorationPlayersPayload = () => (
    Object.values(explorationPlayers).map(p => ({
      id: p.socketId,
      name: p.character.name,
      locationId: p.locationId,
      x: p.x,
      y: p.y,
    }))
  );

  const emitExplorationPlayersUpdated = () => {
    io.to("exploration_world").emit("explorationPlayersUpdated", getExplorationPlayersPayload());
  };

  const getExplorationLockStatusPayload = () => {
    const allPlayers = Object.entries(explorationPlayers);
    if (allPlayers.length <= 1) {
      return [];
    }

    return allPlayers.map(([id, player]) => ({
      id,
      name: player.character?.name || 'Unknown',
      lockedIn: !!explorationLockedActions[id],
    }));
  };

  const emitExplorationLockStatuses = () => {
    io.to("exploration_world").emit("explorationLockStatus", getExplorationLockStatusPayload());
  };

  const getNpcOffset = (npcId: string) => {
    const seed = npcId.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const x = ((seed % 5) - 2) * 0.35;
    const y = (((Math.floor(seed / 5)) % 5) - 2) * 0.35;
    return { x, y };
  };

  const createExplorationNpcStates = () => {
    const npcStates: Record<string, ExplorationNpcState> = {};
    for (const [npcId, npc] of Object.entries(worldData?.npcs || {})) {
      const location = worldData?.locations?.find((loc: any) => loc.id === (npc as any).locationId);
      if (!location) continue;
      const offset = getNpcOffset(npcId);
      npcStates[npcId] = {
        id: npcId,
        name: (npc as any).name,
        role: (npc as any).role || 'npc',
        locationId: location.id,
        subZoneId: location.subZones?.[0]?.id || null,
        homeLocationId: location.id,
        x: location.x + offset.x,
        y: location.y + offset.y,
        followTargetId: null,
      };
    }
    return npcStates;
  };

  const explorationNpcs: Record<string, ExplorationNpcState> = createExplorationNpcStates();

  const getExplorationNpcStatesPayload = () => (
    Object.values(explorationNpcs).map(npc => ({
      id: npc.id,
      name: npc.name,
      role: npc.role,
      locationId: npc.locationId,
      subZoneId: npc.subZoneId,
      x: npc.x,
      y: npc.y,
      followTargetId: npc.followTargetId,
    }))
  );

  const emitExplorationNpcStatesUpdated = () => {
    io.to("exploration_world").emit("explorationNpcStatesUpdated", getExplorationNpcStatesPayload());
  };

  const setNpcFollowState = (npcId: string, followTargetId: string | null) => {
    const npc = explorationNpcs[npcId];
    if (!npc) return false;

    npc.followTargetId = followTargetId;
    if (followTargetId && explorationPlayers[followTargetId]) {
      const target = explorationPlayers[followTargetId];
      const offset = getNpcOffset(npcId);
      npc.locationId = target.locationId;
      npc.subZoneId = target.subZoneId;
      npc.x = target.x + offset.x;
      npc.y = target.y + offset.y;
    } else {
      const homeLocation = worldData?.locations?.find((loc: any) => loc.id === npc.homeLocationId);
      const offset = getNpcOffset(npcId);
      if (homeLocation) {
        npc.locationId = homeLocation.id;
        npc.subZoneId = homeLocation.subZones?.[0]?.id || null;
        npc.x = homeLocation.x + offset.x;
        npc.y = homeLocation.y + offset.y;
      }
    }

    emitExplorationNpcStatesUpdated();
    return true;
  };

  const getBattleSpawnLocations = () => {
    const worldLocations = worldData?.locations || [];
    const spawnLocations = (worldData?.meta?.spawnPoints || [])
      .map((spawn: any) => worldLocations.find((loc: any) => loc.id === spawn.locationId))
      .filter(Boolean);

    if (spawnLocations.length > 0) {
      return spawnLocations;
    }

    return worldLocations.slice(0, 4);
  };

  const getWorldLocation = (locationId: string) => (
    worldData?.locations?.find((entry: any) => entry.id === locationId) || null
  );

  const getLocationHopDistance = (startLocationId: string, endLocationId: string) => {
    if (!startLocationId || !endLocationId) return Number.POSITIVE_INFINITY;
    if (startLocationId === endLocationId) return 0;

    const visited = new Set<string>([startLocationId]);
    const queue: Array<{ locationId: string; distance: number }> = [{ locationId: startLocationId, distance: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      const location = getWorldLocation(current.locationId);
      for (const connectionId of location?.connections || []) {
        if (visited.has(connectionId)) continue;
        if (connectionId === endLocationId) return current.distance + 1;
        visited.add(connectionId);
        queue.push({ locationId: connectionId, distance: current.distance + 1 });
      }
    }

    return Number.POSITIVE_INFINITY;
  };

  const expandBattleDiscoveredLocations = (locationIds: string[]) => {
    const discovered = new Set<string>();

    for (const locationId of locationIds) {
      const location = worldData?.locations?.find((entry: any) => entry.id === locationId);
      if (!location) continue;
      discovered.add(location.id);
      for (const connectionId of location.connections || []) {
        discovered.add(connectionId);
      }
    }

    return Array.from(discovered);
  };

  const buildArenaBattleMapState = (roomPlayers: Record<string, any>): BattleMapState => {
    const spawnLocations = getBattleSpawnLocations();
    const participantIds = Object.keys(roomPlayers);
    const battlePlayers: BattleMapPlayerState[] = [];
    const battleNpcs: BattleMapNpcState[] = [];

    participantIds.forEach((participantId, index) => {
      const participant = roomPlayers[participantId];
      const spawnLocation = spawnLocations[index % Math.max(spawnLocations.length, 1)];
      if (!participant || !spawnLocation) return;

      if (participant.character?.isNpcAlly) {
        battleNpcs.push({
          id: participantId,
          name: participant.character.name,
          role: 'ally',
          locationId: spawnLocation.id,
          x: spawnLocation.x,
          y: spawnLocation.y,
          followTargetId: null,
        });
        return;
      }

      battlePlayers.push({
        id: participantId,
        name: participant.character?.name || 'Unknown',
        locationId: spawnLocation.id,
        x: spawnLocation.x,
        y: spawnLocation.y,
      });
    });

    return {
      discoveredLocations: expandBattleDiscoveredLocations([
        ...battlePlayers.map(player => player.locationId),
        ...battleNpcs.map(npc => npc.locationId),
      ]),
      players: battlePlayers,
      npcs: battleNpcs,
    };
  };

  const sanitizeBattleMapState = (nextMapState: any, previousMapState: BattleMapState): BattleMapState => {
    const gridWidth = worldData?.meta?.gridSize?.width ?? 0;
    const gridHeight = worldData?.meta?.gridSize?.height ?? 0;
    const validLocationIds = new Set((worldData?.locations || []).map((location: any) => location.id));
    const clampCoordinate = (value: unknown, max: number, fallback: number) => (
      typeof value === 'number' && Number.isFinite(value)
        ? (max > 0 ? Math.min(max, Math.max(0, value)) : value)
        : fallback
    );
    const resolveLocationId = (value: unknown, fallback: string) => (
      typeof value === 'string' && validLocationIds.has(value) ? value : fallback
    );

    const nextPlayersById = new Map(
      Array.isArray(nextMapState?.players)
        ? nextMapState.players
            .filter((player: any) => player?.id)
            .map((player: any) => [player.id, player])
        : []
    );
    const nextNpcsById = new Map(
      Array.isArray(nextMapState?.npcs)
        ? nextMapState.npcs
            .filter((npc: any) => npc?.id)
            .map((npc: any) => [npc.id, npc])
        : []
    );

    const players = previousMapState.players.map((player) => {
      const incoming: any = nextPlayersById.get(player.id) || {};
      return {
        ...player,
        name: typeof incoming.name === 'string' && incoming.name.trim() ? incoming.name : player.name,
        locationId: resolveLocationId(incoming.locationId, player.locationId),
        x: clampCoordinate(incoming.x, gridWidth, player.x),
        y: clampCoordinate(incoming.y, gridHeight, player.y),
      };
    });

    const npcs = previousMapState.npcs.map((npc) => {
      const incoming: any = nextNpcsById.get(npc.id) || {};
      return {
        ...npc,
        name: typeof incoming.name === 'string' && incoming.name.trim() ? incoming.name : npc.name,
        role: typeof incoming.role === 'string' && incoming.role.trim() ? incoming.role : npc.role,
        followTargetId: typeof incoming.followTargetId === 'string' || incoming.followTargetId === null
          ? incoming.followTargetId
          : npc.followTargetId,
        locationId: resolveLocationId(incoming.locationId, npc.locationId),
        x: clampCoordinate(incoming.x, gridWidth, npc.x),
        y: clampCoordinate(incoming.y, gridHeight, npc.y),
      };
    });

    return {
      discoveredLocations: expandBattleDiscoveredLocations([
        ...players.map((player) => player.locationId),
        ...npcs.map((npc) => npc.locationId),
      ]),
      players,
      npcs,
      zones: nextMapState?.zones ?? previousMapState.zones,
      combatantZones: nextMapState?.combatantZones ?? previousMapState.combatantZones,
    };
  };

  const getWorldIsland = (islandId: string) => (
    worldData?.islands?.find((entry: any) => entry.id === islandId) || null
  );

  const appendBattleLogIfMissing = (logs: string[], entry: string): string[] => (
    logs.includes(entry) ? logs : [...logs, entry]
  );

  const sanitizeBattleHistoryForJudge = (logs: string[]): string[] => logs.filter(log => (
    !log.startsWith('> **Judge\'s Thoughts:**')
    && !log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX)
    && !log.startsWith(BATTLE_STREAM_ANSWER_PREFIX)
    && !log.startsWith(BATTLE_PENDING_ACTION_PREFIX)
    && !log.startsWith('STATUS_')
  ));

  const extractRecentBattleNarrative = (logs: string[]): string[] => logs.filter(log => (
    !log.startsWith(BATTLE_PLAYER_ACTIONS_PREFIX)
    && !log.startsWith('NPC_ALLY_ACTION_')
    && log !== '**Match Found!** The battle begins.'
  )).slice(-2);

  const renderPromptTemplate = (template: string, values: Record<string, string>) => (
    template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? '')
  );

  const buildInlineImagePartFromDataUrl = (imageUrl?: string | null) => {
    if (!imageUrl || !imageUrl.startsWith('data:image/')) return null;

    const match = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;

    return {
      inlineData: {
        mimeType: match[1],
        data: match[2],
      },
    };
  };

  const extractInlineImageFrames = (parts: any[]): string[] => parts.flatMap(part => {
    if (!(part as any)?.inlineData) return [];
    const imageData = (part as any).inlineData;
    return [`data:${imageData.mimeType};base64,${imageData.data}`];
  });

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const extractTransformationCueForCombatant = (narrative: string, combatantName: string): string | null => {
    const trimmedNarrative = narrative.trim();
    const trimmedName = combatantName.trim();
    if (!trimmedNarrative || !trimmedName) return null;

    const escapedName = escapeRegExp(trimmedName);
    const patterns = [
      new RegExp(`${escapedName}[^.!?\n]{0,160}\\b(?:turns?|turned|becomes?|became|transforms?|transformed|morphs?|morphed|shapeshifts?|shapeshifted|mutates?|mutated|changes?|changed|polymorphs?|polymorphed)\\b[^.!?\n]{0,180}`, 'i'),
      new RegExp(`${escapedName}[^.!?\n]{0,160}\\b(?:into|as)\\b[^.!?\n]{0,180}\\b(?:fish|goldfish|frog|toad|wolf|dragon|serpent|bird|eagle|beast|monster|blob|slime|ooze|creature|form)\\b[^.!?\n]{0,120}`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = trimmedNarrative.match(pattern);
      if (match?.[0]) {
        return match[0].replace(/\s+/g, ' ').trim();
      }
    }

    return null;
  };

  const buildTransformationRenderDirective = (combatantName: string, cue: string) => {
    const loweredCue = cue.toLowerCase();

    if (loweredCue.includes('goldfish')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show a literal goldfish with fins, scales, tail, gills, fish eyes, and true fish anatomy. Not a humanoid, god-form, blob, or abstract magical being.`;
    }
    if (loweredCue.includes('fish')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show a literal fish with fins, scales, tail, gills, fish eyes, and true fish anatomy. Not a humanoid, god-form, blob, or abstract magical being.`;
    }
    if (loweredCue.includes('frog') || loweredCue.includes('toad')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show a literal frog or toad with amphibian anatomy, limbs, skin texture, and true creature proportions. Not a humanoid, blob, or abstract magical being.`;
    }
    if (loweredCue.includes('wolf')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show a literal wolf with canine anatomy, fur, muzzle, paws, and tail. Not a humanoid, blob, or abstract magical being.`;
    }
    if (loweredCue.includes('dragon') || loweredCue.includes('serpent')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show the named creature with true monster anatomy. Not a humanoid, blob, or abstract magical being.`;
    }
    if (loweredCue.includes('blob') || loweredCue.includes('slime') || loweredCue.includes('ooze')) {
      return `- ${combatantName}: ${cue}. Mandatory rendering: show the named amorphous form literally, but still make the creature readable and specific instead of turning it into a generic glowing mass.`;
    }

    return `- ${combatantName}: ${cue}. Mandatory rendering: show the named transformed form literally, not ${combatantName}'s original body and not a vague blob, godlike figure, or abstract magical being.`;
  };

  const buildBattleMapContext = (mapState?: BattleMapState, roomPlayers?: Record<string, any>) => {
    if (!worldData || !mapState || mapState.players.length === 0) return '';

    let context = 'BATTLE MAP STATE:\n';
    for (const player of mapState.players) {
      const location = getWorldLocation(player.locationId);
      const island = getWorldIsland(location?.islandId);
      const playerName = roomPlayers?.[player.id]?.character?.name || player.name;
      context += `- ${playerName} is at grid (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) on ${island?.name || location?.islandId || 'an unknown island'} near ${location?.name || player.locationId}. Connected routes: ${(location?.connections || []).join(', ') || 'none'}.\n`;
    }

    if (mapState.players.length >= 2) {
      for (let index = 0; index < mapState.players.length; index += 1) {
        for (let innerIndex = index + 1; innerIndex < mapState.players.length; innerIndex += 1) {
          const left = mapState.players[index];
          const right = mapState.players[innerIndex];
          const leftLocation = getWorldLocation(left.locationId);
          const rightLocation = getWorldLocation(right.locationId);
          const distance = getLocationHopDistance(left.locationId, right.locationId);
          const leftName = roomPlayers?.[left.id]?.character?.name || left.name;
          const rightName = roomPlayers?.[right.id]?.character?.name || right.name;
          if (leftLocation?.islandId && rightLocation?.islandId && leftLocation.islandId !== rightLocation.islandId) {
            context += `- ${leftName} and ${rightName} are on different islands with water between them.\n`;
          }
          const distanceLabel = distance === 0
            ? 'sharing the same location'
            : distance === 1
              ? 'one move apart'
              : Number.isFinite(distance)
                ? `${distance} moves apart`
                : 'positionally disconnected';
          context += `- ${leftName} and ${rightName} are ${distanceLabel}.\n`;
        }
      }
    }

    context += '\nARENA MOVEMENT RULES:\n';
    context += '- Current positions are authoritative at turn start. Resolve any new movement this turn by returning updated battlePositions in the tool call.\n';
    context += '- Water between islands is traversable. Swimming or sailing can move fighters to fractional x/y coordinates between named locations.\n';
    context += '- If fighters share a location, melee, grapples, and close-range attacks can connect normally.\n';
    context += '- If fighters are one move apart, melee must spend the turn closing distance or chasing before it can land. Ranged pressure and spells may still connect with positioning tradeoffs.\n';
    context += '- If fighters are two or more moves apart, melee cannot land this turn unless the action is entirely about pursuit. Favor ranged attacks, traps, mobility, scouting, or escape.\n';
    context += '- Use chase, flee, pursuit, and terrain-aware narration naturally in the resolution.\n';
    context += '- When movement happens, update exact x/y positions so the minimap reflects mid-route travel accurately.\n';

    return context;
  };

  const mergeBattlePositionUpdates = (
    currentMapState: BattleMapState | undefined,
    positionUpdates: Record<string, { x?: number; y?: number; locationId?: string }> | null | undefined,
    roomPlayers: Record<string, any>,
  ): BattleMapState | undefined => {
    if (!currentMapState || !positionUpdates) return currentMapState;

    const gridWidth = worldData?.meta?.gridSize?.width ?? 0;
    const gridHeight = worldData?.meta?.gridSize?.height ?? 0;
    const discoveredLocations = new Set(currentMapState.discoveredLocations);
    const clampCoordinate = (value: number, max: number) => (
      max > 0 ? Math.min(max, Math.max(0, value)) : value
    );

    const applyUpdate = <T extends { id: string; name: string; locationId: string; x: number; y: number }>(
      entity: T,
      preferredName?: string,
    ) => {
      const update = positionUpdates[preferredName || entity.name] || positionUpdates[entity.name] || positionUpdates[entity.id];
      if (!update) return entity;

      const nextLocationId = typeof update.locationId === 'string' && update.locationId.trim()
        ? update.locationId
        : entity.locationId;
      const nextLocation = getWorldLocation(nextLocationId);
      if (nextLocation) {
        discoveredLocations.add(nextLocation.id);
        for (const connectionId of nextLocation.connections || []) {
          discoveredLocations.add(connectionId);
        }
      }

      return {
        ...entity,
        locationId: nextLocationId,
        x: typeof update.x === 'number' && Number.isFinite(update.x)
          ? clampCoordinate(update.x, gridWidth)
          : entity.x,
        y: typeof update.y === 'number' && Number.isFinite(update.y)
          ? clampCoordinate(update.y, gridHeight)
          : entity.y,
      };
    };

    const players = currentMapState.players.map(player => {
      const playerName = roomPlayers?.[player.id]?.character?.name || player.name;
      return applyUpdate(player, playerName);
    });

    const npcs = currentMapState.npcs.map(npc => applyUpdate(npc));

    return sanitizeBattleMapState({
      ...currentMapState,
      discoveredLocations: Array.from(discoveredLocations),
      players,
      npcs,
    }, currentMapState);
  };

  const applyTurnResolution = (roomId: string, data: { log?: string; thoughts?: string; state?: any; mapState?: any }) => {
    const room = rooms[roomId];
    if (!room) return;

    delete room.lastResolutionRequestAt;
    room.awaitingTurnResolution = false;
    delete room.activeBattleStream;
    delete room.resolutionRequestNonce;
    delete room.battleRetryWindowStartedAt;
    room.battleRetryRestartAvailable = false;
    room.battleImageSharedThisTurn = false;
    room.battleActionSequence = 0;

    const newState = data.state;

    const resolvedTurnActions = Object.values(room.players || {})
      .map((player: any) => {
        const actionText = typeof player?.action === 'string' ? player.action.trim() : '';
        if (!actionText) return null;
        return `${player.character?.name || 'Combatant'}: ${actionText}`;
      })
      .filter((entry): entry is string => !!entry);

    if (newState) {
      for (const pid of Object.keys(room.players)) {
        const charName = room.players[pid].character.name;
        const stateData = newState[charName] || Object.values(newState).find((s: any) => s && typeof s === 'object' && s.name === charName);

        const applyResolvedCharacterState = (incomingState: any) => {
          if (!incomingState || typeof incomingState !== 'object') return;
          const nextCharacter = {
            ...room.players[pid].character,
          } as Record<string, any>;

          for (const [key, value] of Object.entries(incomingState)) {
            if (value === undefined || value === null || key === 'imageUrl') continue;
            nextCharacter[key] = value;
          }

          if (typeof nextCharacter.name === 'string' && nextCharacter.name.trim()) {
            nextCharacter.name = nextCharacter.name.trim();
          } else {
            nextCharacter.name = room.players[pid].character.name;
          }

          if (!nextCharacter.profileMarkdown) {
            nextCharacter.profileMarkdown = room.players[pid].character.profileMarkdown;
          }

          room.players[pid].character = nextCharacter;
        };

        if (stateData) {
          applyResolvedCharacterState(stateData);
        } else {
          const pIndex = Object.keys(room.players).indexOf(pid) + 1;
          const fallbackData = newState[`Player${pIndex}`];
          if (fallbackData) {
            applyResolvedCharacterState(fallbackData);
          }
        }
      }
    }

    if (room.mapState && data.mapState) {
      room.mapState = sanitizeBattleMapState(data.mapState, room.mapState);
    }

    for (const pid of Object.keys(room.players)) {
      room.players[pid].lockedIn = false;
      room.players[pid].autoLockedThisTurn = false;
      room.players[pid].action = '';
      delete room.players[pid].actionSequence;
    }

    const historyEntries: string[] = [];
    if (typeof data.thoughts === 'string' && data.thoughts.trim()) {
      historyEntries.push(`> **Judge's Thoughts:**\n> ${data.thoughts.replace(/\n/g, '\n> ')}`);
    }
    if (typeof data.log === 'string' && data.log.trim()) {
      historyEntries.push(data.log);
    }

    io.to(room.id).emit('turnResolved', {
      log: data.log,
      thoughts: data.thoughts,
      state: newState,
      players: room.players,
      mapState: room.mapState,
    });
    io.to(room.id).emit('battleRetryStatus', { attempt: 0 });

    const alivePlayers = Object.values(room.players).filter((p: any) => p.character.hp > 0);
    if (alivePlayers.length <= 1) {
      const winner = alivePlayers[0] as any;
      historyEntries.push(`**GAME OVER!** ${winner ? winner.character.name : 'No one'} is victorious!`);
    }
    appendRoomHistory(roomId, historyEntries);
    if (historyEntries.length > 0) {
      room.battleImageRequestNonce = (room.battleImageRequestNonce || 0) + 1;
      room.pendingBattleImageRequest = {
        requestNonce: room.battleImageRequestNonce,
        turnLog: typeof data.log === 'string' ? data.log : '',
        actionSummaries: resolvedTurnActions,
      };
      if (!room.battleImageTaskActive) {
        void generateBattleImageForRoom(roomId);
      }
    }

    if (alivePlayers.length > 1) {
      room.pendingReadyPlayers = new Set(Object.keys(room.players).filter(pid => alivePlayers.some((a: any) => a === room.players[pid])));
      logBattleServerDebug('waiting_for_next_turn_ready', {
        roomId,
        alivePlayerNames: alivePlayers.map((player: any) => player.character?.name || 'Unknown'),
        pendingReadyPlayers: Array.from(room.pendingReadyPlayers),
      });
      room.readyTimeout = setTimeout(() => {
        logBattleServerDebug('ready_for_next_turn_timeout', {
          roomId,
          pendingReadyPlayers: Array.from(room.pendingReadyPlayers || []),
        });
        delete room.pendingReadyPlayers;
        delete room.readyTimeout;
        if (rooms[roomId]) startRoomTimer(roomId);
      }, 30_000);
    } else {
      clearRoomTimer(roomId);
    }
  };

  const getBattleResolutionApiKey = (room: any) => (
    (typeof room?.apiKey === 'string' && room.apiKey.trim())
      ? room.apiKey.trim()
      : (process.env.GEMINI_API_KEY || process.env.API_KEY || '')
  );

  const getBattleFallbackNarrative = (room: any) => {
    const submittedActions = Object.values(room.players || {})
      .map((player: any) => `- **${player.character.name}:** ${player.action || 'No action submitted.'}`)
      .join('\n');
    return [
      '⚠️ The judge returned a state update without narrative text.',
      '',
      '**Submitted actions**',
      submittedActions,
    ].join('\n');
  };

  const get503FallbackBattleModel = (model: string, errorInfo?: { statusCode?: number; statusText?: string }, attempt = 0) => {
    const isUnavailable = errorInfo?.statusCode === 503 || errorInfo?.statusText === 'UNAVAILABLE';
    if (!isUnavailable || attempt < 1) return model;
    if (model === 'gemini-2.5-pro') return 'gemini-2.5-flash';
    if (model === 'gemini-3.1-pro-preview') return 'gemini-3-flash-preview';
    return model;
  };

  const emitBattleStreamStart = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;
    room.activeBattleStream = { thoughts: '', answer: '' };
    io.to(roomId).emit('streamTurnResolutionStart');
  };

  const emitBattleStreamRefresh = (roomId: string, type: 'thought' | 'answer', text: string) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.activeBattleStream) {
      room.activeBattleStream = { thoughts: '', answer: '' };
    }
    if (type === 'thought') {
      room.activeBattleStream.thoughts = text;
    } else {
      room.activeBattleStream.answer = text;
    }
    io.to(roomId).emit('streamTurnResolutionChunk', { type, text: `REFRESH:${text}` });
  };

  const emitBattleToolChunk = (roomId: string, text: string) => {
    io.to(roomId).emit('streamTurnResolutionChunk', { type: 'tool', text });
  };

  async function generateBattleImageForRoom(roomId: string) {
    const room = rooms[roomId];
    if (!room || room.battleImageTaskActive || room.battleImageSharedThisTurn || !room.pendingBattleImageRequest) return;

    const apiKey = getBattleResolutionApiKey(room);
    if (!apiKey) return;

    const imageRequest = room.pendingBattleImageRequest;
    room.pendingBattleImageRequest = null;
    room.battleImageTaskActive = true;
    room.activeBattleImageRequestNonce = imageRequest.requestNonce;

    try {
      const imageNarrativeLogs = extractRecentBattleNarrative(sanitizeBattleHistoryForJudge(Array.isArray(room.history) ? room.history : []));
      const latestTurnNarrative = typeof imageRequest?.turnLog === 'string' && imageRequest.turnLog.trim()
        ? imageRequest.turnLog.trim()
        : (imageNarrativeLogs[imageNarrativeLogs.length - 1] || imageNarrativeLogs.join('\n\n') || '');
      const latestTurnActions = Array.isArray(imageRequest?.actionSummaries)
        ? imageRequest.actionSummaries.filter((entry: unknown): entry is string => typeof entry === 'string' && !!entry.trim()).map((entry: string) => entry.trim())
        : [];
      const recentLogs = [
        latestTurnNarrative || 'The battle has just begun.',
        latestTurnActions.length > 0
          ? `Current submitted actions for this resolved turn:\n${latestTurnActions.map((action: string) => `- ${action}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n\n').substring(0, 1200);
      const playerNames = Object.values(room.players || {}).map((player: any) => player.character?.name || 'Combatant').join(' vs ');
      const battleMapImageContext = buildBattleMapContext(room.mapState, room.players)
        .replace('BATTLE MAP STATE:\n', '')
        .substring(0, 1200);
      const battleLocationSummary = (room.mapState?.players || []).map((player: any) => {
        const location = getWorldLocation(player.locationId);
        const island = getWorldIsland(location?.islandId);
        const playerName = room.players?.[player.id]?.character?.name || player.name;
        return `${playerName} is on ${island?.name || location?.islandId || 'an unknown island'}, near ${location?.name || player.locationId} at (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`;
      }).join('; ');

      const orderedCombatants = Object.values(room.players || {})
        .filter((player: any) => !player.character?.isNpcAlly)
        .slice(0, 2);
      if (orderedCombatants.length === 0) return;

      const combatantAnchors = orderedCombatants.map((participant: any, idx: number) => {
        const mapPlayer = room.mapState?.players?.find((entry: any) => entry.id === participant.id);
        const location = getWorldLocation(mapPlayer?.locationId);
        const island = getWorldIsland(location?.islandId);

        return {
          side: idx === 0 ? 'LEFT' : 'RIGHT',
          name: participant.character?.name || `Combatant ${idx + 1}`,
          locationId: mapPlayer?.locationId || null,
          locationName: location?.name || mapPlayer?.locationId || 'unknown location',
          islandId: island?.id || location?.islandId || null,
          islandName: island?.name || location?.islandId || 'unknown island',
        };
      });
      const leftLocationId = combatantAnchors[0]?.locationId || null;
      const rightLocationId = combatantAnchors[1]?.locationId || null;
      const combatantHopDistance = leftLocationId && rightLocationId
        ? getLocationHopDistance(leftLocationId, rightLocationId)
        : Number.POSITIVE_INFINITY;
      const separatedIslands = !!combatantAnchors[0]?.islandId && !!combatantAnchors[1]?.islandId && combatantAnchors[0].islandId !== combatantAnchors[1].islandId;
      const compositionDirective = separatedIslands
        ? `COMPOSITION MODE: split view or a wide establishing shot with both islands visible. ${combatantAnchors[0]?.name || 'Combatant 1'} must remain on ${combatantAnchors[0]?.islandName || 'their island'} and ${combatantAnchors[1]?.name || 'Combatant 2'} must remain on ${combatantAnchors[1]?.islandName || 'their island'}. Show visible ocean, distance, or distinct landmasses between them. Do NOT place both fighters on the same ground plane, beach, bridge, arena floor, or cliff.`
        : combatantHopDistance > 0
          ? `COMPOSITION MODE: single-island wide view. Both fighters are on ${combatantAnchors[0]?.islandName || 'the same island'} but separated across the terrain. Preserve that distance with a broad island view instead of staging them shoulder-to-shoulder.`
          : 'COMPOSITION MODE: shared close battlefield. A tighter duel frame is allowed because the combatants are currently close together.';
      const combatantAnchorSummary = combatantAnchors
        .map(anchor => `- ${anchor.side}: ${anchor.name} is on ${anchor.islandName} near ${anchor.locationName}.`)
        .join('\n');
      const transformationCuesByName = new Map(orderedCombatants.map((participant: any) => {
        const participantName = participant.character?.name || 'Combatant';
        return [participantName, extractTransformationCueForCombatant(latestTurnNarrative || recentLogs, participantName)];
      }));
      const transformationSummary = orderedCombatants
        .map((participant: any) => {
          const participantName = participant.character?.name || 'Combatant';
          const cue = transformationCuesByName.get(participantName);
          return cue ? buildTransformationRenderDirective(participantName, cue) : null;
        })
        .filter(Boolean)
        .join('\n');

      const avatarReferenceParts = orderedCombatants.flatMap((participant: any, idx: number) => {
        const participantName = participant.character?.name || 'Combatant';
        const transformationCue = transformationCuesByName.get(participantName);
        if (transformationCue) {
          return [{ text: buildTransformationRenderDirective(participantName, transformationCue) }];
        }

        const avatarPart = buildInlineImagePartFromDataUrl(participant.character?.imageUrl);
        if (!avatarPart) return [];
        const side = idx === 0 ? 'LEFT side' : 'RIGHT side';
        return [
          { text: `Reference avatar for ${participantName} — use for identity, colors, and face continuity on the ${side} of the image and bottom panel. If the narrative says this character transformed, the transformed form overrides this portrait's anatomy.` },
          avatarPart,
        ];
      });

      const leftName = (orderedCombatants[0] as any)?.character?.name || 'Combatant 1';
      const rightName = (orderedCombatants[1] as any)?.character?.name || 'Combatant 2';
      const posterLayoutDirective = [
        '- Build the artwork as a fresh original battle poster for this turn only.',
        '- Put a bold comic-style headline at the top, but choose a new framing and scene composition from the current narrative instead of imitating any stock layout.',
        '- Add at least one small floating location callout tied to a real battlefield position from this turn.',
        `- Add a bottom split result banner with ${leftName} locked on the LEFT and ${rightName} locked on the RIGHT. Each side must show the character name, a strong icon, the move name, and a short outcome.`,
        '- Keep typography readable and energetic, but do not let the text treatment force repeated camera angles, repeated horizons, or repeated combatant poses.',
      ].join('\n');
      const prompt = renderPromptTemplate(getPrompt('battle_image.txt'), {
        PLAYER_NAMES: playerNames,
        RECENT_LOGS: recentLogs || 'The battle has just begun.',
        BATTLE_LOCATION_SUMMARY: battleLocationSummary || 'Use the active battlefield state.',
        BATTLE_MAP_CONTEXT: battleMapImageContext || 'Use the active battlefield state.',
        LEFT_NAME: leftName,
        RIGHT_NAME: rightName,
        TRANSFORMATION_SUMMARY: transformationSummary || '- No explicit transformation override detected in the latest narrative.',
        COMPOSITION_DIRECTIVE: compositionDirective,
        COMBATANT_ANCHOR_SUMMARY: combatantAnchorSummary || '- Use the authoritative battlefield state to anchor each fighter.',
        POSTER_LAYOUT_DIRECTIVE: posterLayoutDirective,
      });

      logBattleServerDebug('battle_image_prompt_context', {
        roomId,
        latestTurnNarrative: latestTurnNarrative.substring(0, 240),
        latestTurnActions,
        playerNames,
      });

      const response = await generateContentWithRetryWindow({
        apiKey,
        model: 'gemini-2.5-flash-image',
        contents: [{ role: 'user', parts: [{ text: prompt }, ...avatarReferenceParts] }],
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      }, new AbortController().signal);

      const parts = (response as any)?.candidates?.[0]?.content?.parts || [];
      const imageFrames = extractInlineImageFrames(parts);
      const imageUrl = imageFrames[imageFrames.length - 1];
      if (!imageUrl) return;

      const activeRoom = rooms[roomId];
      if (!activeRoom || activeRoom.battleImageSharedThisTurn) return;
      if (activeRoom.activeBattleImageRequestNonce !== imageRequest.requestNonce) {
        logBattleServerDebug('battle_image_generation_discarded_stale', {
          roomId,
          requestNonce: imageRequest.requestNonce,
          activeBattleImageRequestNonce: activeRoom.activeBattleImageRequestNonce,
          pendingBattleImageRequestNonce: activeRoom.pendingBattleImageRequest?.requestNonce || null,
        });
        return;
      }
      activeRoom.battleImageSharedThisTurn = true;
      appendBattleMediaLogs(roomId, 'Arena', imageUrl);
      io.to(roomId).emit('battleImageShared', {
        fromName: 'Arena',
        imageUrl,
      });
    } catch (error) {
      logBattleServerDebug('battle_image_generation_failed', {
        roomId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (rooms[roomId]) {
        rooms[roomId].battleImageTaskActive = false;
        delete rooms[roomId].activeBattleImageRequestNonce;
        if (rooms[roomId].pendingBattleImageRequest && !rooms[roomId].battleImageSharedThisTurn) {
          void generateBattleImageForRoom(roomId);
        }
      }
    }
  }

  const runBattleTurnResolution = async (roomId: string, options?: { reissue?: boolean }) => {
    const room = rooms[roomId];
    if (!room || room.battleResolutionTaskActive) return;

    room.battleResolutionTaskActive = true;

    try {
      const apiKey = getBattleResolutionApiKey(room);
      if (!apiKey) {
        room.battleRetryRestartAvailable = true;
        io.to(roomId).emit('battleRetryStatus', {
          attempt: 0,
          label: 'Gemini API key is not configured',
          restartAvailable: true,
        });
        io.to(roomId).emit('error', 'Turn resolution failed. Gemini API key is not configured on the server or in the room settings.');
        return;
      }

      const unsortedPlayerIds = Object.keys(room.players || {});
      const playerIds = [...unsortedPlayerIds].sort((leftId, rightId) => {
        const leftSequence = room.players[leftId]?.actionSequence ?? Number.MAX_SAFE_INTEGER;
        const rightSequence = room.players[rightId]?.actionSequence ?? Number.MAX_SAFE_INTEGER;
        if (leftSequence !== rightSequence) return leftSequence - rightSequence;
        return unsortedPlayerIds.indexOf(leftId) - unsortedPlayerIds.indexOf(rightId);
      });
      if (playerIds.length === 0) return;

      const baseLogs = sanitizeBattleHistoryForJudge(Array.isArray(room.history) ? room.history : []);
      const judgeHistoryLogs = baseLogs.slice();
      const fullLogText = judgeHistoryLogs.join('\n\n');
      const logLines = fullLogText.split('\n');
      const totalLines = logLines.length;
      const recentNarrativeLogs = extractRecentBattleNarrative(baseLogs);

      let profiles = '';
      for (const pid of playerIds) {
        const pData = room.players[pid];
        profiles += `Profile for ${pData.character.name}:\n${pData.character.profileMarkdown}\n\n`;
      }

      const sysPrompt = getPrompt('battle_judge.txt');
      const fullSysPrompt = `${sysPrompt}\n\n${profiles}`;

      let prompt = 'BATTLE STATE (TURN START):\n';
      for (const pid of playerIds) {
        const pData = room.players[pid];
        prompt += `Player (${pData.character.name}):\nHP: ${pData.character.hp}, Mana: ${pData.character.mana}\nAction: ${pData.action}\n\n`;
      }
      prompt += buildBattleMapContext(room.mapState, room.players);
      if (recentNarrativeLogs.length > 0) {
        prompt += `LATEST RESOLVED BATTLE NARRATIVE:\n${recentNarrativeLogs.join('\n\n')}\n\n`;
      }
      prompt += 'The BATTLE MAP STATE above is authoritative. Do not invent new zones, do not remap the battlefield, and do not call any zone-setup tool. Treat the provided named locations and connections as the active combat zones.\n';
      prompt += `The battle log currently has ${totalLines} lines. You can use the read_battle_history tool to read it if you need context from previous turns. Otherwise, resolve the turn simultaneously. When you call submit_battle_result, include the full markdown turn narration in battleLog. If an action is vague, resolve it as the simplest plausible action for the current distance instead of over-interpreting it.`;

      const readBattleHistory = {
        name: 'read_battle_history',
        description: 'Read the battle history markdown log. Provide start and end lines to read a specific section. The log contains all previous turns.',
        parameters: {
          type: 'OBJECT',
          properties: {
            startLine: { type: 'INTEGER', description: 'The line number to start reading from (1-indexed).' },
            endLine: { type: 'INTEGER', description: 'The line number to end reading at (inclusive).' },
          },
          required: ['startLine', 'endLine'],
        },
      };

      const submitBattleResult = {
        name: 'submit_battle_result',
        description: 'Submit the updated character states and final markdown battle log after resolving the turn. Always include the full turn narration in battleLog. Include battlePositions whenever movement, pursuit, swimming, sailing, or fleeing changes exact map coordinates.',
        parameters: {
          type: 'OBJECT',
          properties: {
            battleLog: {
              type: 'STRING',
              description: 'The complete markdown narration for this turn. Include the full battle log text that should be shown to players.',
            },
            characterStates: {
              type: 'STRING',
              description: 'JSON string of character states. Format: {"CharName1": {"hp": number, "mana": number, "profileMarkdown": "optional updated markdown"}, "CharName2": {"hp": number, "mana": number}}',
            },
            battlePositions: {
              type: 'STRING',
              description: 'Optional JSON string of per-character map positions. Format: {"CharName1": {"x": number, "y": number, "locationId": "nearest_or_tactical_location_id"}, "CharName2": {"x": number, "y": number, "locationId": "..."}}. Update this every turn when movement changes positions, including water travel between islands.',
            },
          },
          required: ['battleLog', 'characterStates'],
        },
      };

      const aiClient = createAIClient(apiKey);
      let contents: any[] = [{ role: 'user', parts: [{ text: prompt }] }];
      let hasEmittedStart = false;
      let finalThoughts = '';
      let finalAnswer = '';
      let displayedThoughts = '';
      let displayedAnswer = '';
      let suppressThoughtStreamAfterRecovery = false;
      let attempts = 0;
      let lastRetryError: any = null;
      const hasVisibleBattleStreamOutput = () => (
        displayedThoughts.trim().length > 0 || displayedAnswer.trim().length > 0
      );

      io.to(roomId).emit('battleRetryStatus', { attempt: 0, restartAvailable: false });
      room.battleRetryRestartAvailable = false;
      if (!options?.reissue) {
        delete room.battleRetryWindowStartedAt;
      }

      while (true) {
        const activeRoom = rooms[roomId];
        if (!activeRoom) return;

        const battleAbort = new AbortController();
        const selectedModel = activeRoom.modelSettings?.battleModel || 'gemini-2.5-pro';
        const model = get503FallbackBattleModel(selectedModel, lastRetryError || undefined, attempts);
        const BATTLE_STREAM_STALL_MS = 120_000;
        let battleStallAborted = false;
        let battleStallTimer: ReturnType<typeof setTimeout> | null = null;
        const clearBattleStallTimer = () => {
          if (battleStallTimer) {
            clearTimeout(battleStallTimer);
            battleStallTimer = null;
          }
        };
        const resetBattleStallTimer = () => {
          clearBattleStallTimer();
          battleStallTimer = setTimeout(() => {
            battleStallAborted = true;
            battleAbort.abort();
          }, BATTLE_STREAM_STALL_MS);
        };

        try {
          while (true) {
            resetBattleStallTimer();

            let hasToolCall = false;
            let toolCallPart: any = null;
            let modelParts: any[] = [];
            let streamedThoughts = '';
            let streamedAnswer = '';

            const appendModelPart = (part: any) => {
              modelParts.push(part);
              if (part.functionCall) {
                hasToolCall = true;
                toolCallPart = part;
                return;
              }

              if (hasToolCall) return;

              const isThought = !!part?.thought;
              const text = typeof part?.thought === 'string' ? part.thought : (part?.text || '');
              if (!text) return;

              if (!hasEmittedStart) {
                emitBattleStreamStart(roomId);
                hasEmittedStart = true;
              }

              if (isThought) {
                if (suppressThoughtStreamAfterRecovery) return;
                streamedThoughts += text;
              } else {
                streamedAnswer += text;
              }

              const nextDisplayedThoughts = finalThoughts + streamedThoughts;
              const nextDisplayedAnswer = (finalAnswer + streamedAnswer).trim();

              if (nextDisplayedThoughts.length >= displayedThoughts.length) {
                displayedThoughts = nextDisplayedThoughts;
                emitBattleStreamRefresh(roomId, 'thought', displayedThoughts);
              }
              if (nextDisplayedAnswer.length >= displayedAnswer.length) {
                displayedAnswer = nextDisplayedAnswer;
                emitBattleStreamRefresh(roomId, 'answer', displayedAnswer);
              }
            };

            const apiConfig = {
              model,
              contents,
              config: {
                systemInstruction: fullSysPrompt,
                temperature: 1.5,
                thinkingConfig: {
                  includeThoughts: true,
                  thinkingBudget: 4096,
                },
                tools: [{ functionDeclarations: [readBattleHistory as any, submitBattleResult as any] }],
                abortSignal: battleAbort.signal,
              },
            };

            try {
              const responseStream = await aiClient.models.generateContentStream(apiConfig as any);
              for await (const chunk of responseStream as any) {
                resetBattleStallTimer();
                const parts = chunk?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  appendModelPart(part);
                }
              }
            } catch (streamError: any) {
              if (battleAbort.signal.aborted) {
                throw streamError;
              }

              const streamErrorInfo = classifyAIError(streamError);
              if (hasVisibleBattleStreamOutput()) {
                suppressThoughtStreamAfterRecovery = true;
              }
              const fallbackRes = await aiClient.models.generateContent({
                ...apiConfig,
                model: get503FallbackBattleModel(model, streamErrorInfo, attempts + 1),
              } as any);
              const fallbackParts = fallbackRes?.candidates?.[0]?.content?.parts || [];
              modelParts = [];
              hasToolCall = false;
              toolCallPart = null;
              streamedThoughts = '';
              streamedAnswer = '';
              for (const part of fallbackParts) {
                appendModelPart(part);
              }
            } finally {
              clearBattleStallTimer();
            }

            if (battleAbort.signal.aborted) {
              if (battleStallAborted) {
                throw new DOMException('Battle stream stalled', 'AbortError');
              }
              return;
            }

            finalThoughts += streamedThoughts;
            finalAnswer += streamedAnswer;
            displayedThoughts = finalThoughts;
            displayedAnswer = finalAnswer.trim();

            if (hasToolCall && toolCallPart?.functionCall) {
              const functionCall = toolCallPart.functionCall;
              const funcName = functionCall.name;
              const args = functionCall.args as any;

              if (funcName === 'read_battle_history') {
                const start = Math.max(1, args.startLine || 1);
                const end = Math.min(totalLines, args.endLine || totalLines);
                const resultText = logLines.slice(start - 1, end).join('\n');

                emitBattleToolChunk(roomId, `⚙️ Judge called read_battle_history(${start}, ${end})`);

                contents.push({ role: 'model', parts: modelParts });
                contents.push({
                  role: 'user',
                  parts: [{
                    functionResponse: {
                      name: 'read_battle_history',
                      response: { result: resultText },
                    },
                  }],
                });
                continue;
              }

              if (funcName === 'submit_battle_result') {
                let newState = null;
                try {
                  newState = typeof args.characterStates === 'string'
                    ? JSON.parse(args.characterStates)
                    : args.characterStates;
                } catch (error) {
                  console.error('Failed to parse battle state from tool call', error);
                }

                let battlePositionUpdates = null;
                try {
                  battlePositionUpdates = typeof args.battlePositions === 'string'
                    ? JSON.parse(args.battlePositions)
                    : args.battlePositions;
                } catch (error) {
                  console.error('Failed to parse battle positions from tool call', error);
                }

                const currentRoom = rooms[roomId];
                if (!currentRoom) return;
                const resolvedMapState = mergeBattlePositionUpdates(
                  currentRoom.mapState,
                  battlePositionUpdates,
                  currentRoom.players,
                );
                const toolBattleLog = typeof args.battleLog === 'string' ? args.battleLog.trim() : '';
                applyTurnResolution(roomId, {
                  log: toolBattleLog || finalAnswer.trim() || getBattleFallbackNarrative(currentRoom),
                  thoughts: finalThoughts.trim(),
                  state: newState,
                  mapState: resolvedMapState ?? currentRoom.mapState,
                });
                return;
              }
            }

            const combinedOutput = `${finalThoughts}\n${finalAnswer}`;
            const stateMatch = combinedOutput.match(/<BATTLE_STATE>([\s\S]*?)(?:<\/BATTLE_STATE>|$)/);
            let newState = null;
            if (stateMatch) {
              try {
                newState = JSON.parse(stateMatch[1]);
              } catch (error) {
                console.error('Failed to parse battle state', error);
              }
            }

            const positionMatch = combinedOutput.match(/<BATTLE_POSITIONS>([\s\S]*?)(?:<\/BATTLE_POSITIONS>|$)/);
            let battlePositionUpdates = null;
            if (positionMatch) {
              try {
                battlePositionUpdates = JSON.parse(positionMatch[1]);
              } catch (error) {
                console.error('Failed to parse battle positions', error);
              }
            }

            const currentRoom = rooms[roomId];
            if (!currentRoom) return;
            const resolvedMapState = mergeBattlePositionUpdates(
              currentRoom.mapState,
              battlePositionUpdates,
              currentRoom.players,
            );

            applyTurnResolution(roomId, {
              log: finalAnswer
                .replace(/<BATTLE_STATE>[\s\S]*?(?:<\/BATTLE_STATE>|$)/, '')
                .replace(/<BATTLE_POSITIONS>[\s\S]*?(?:<\/BATTLE_POSITIONS>|$)/, '')
                .trim() || getBattleFallbackNarrative(currentRoom),
              thoughts: finalThoughts.trim(),
              state: newState,
              mapState: resolvedMapState ?? currentRoom.mapState,
            });
            return;
          }
        } catch (error: any) {
          clearBattleStallTimer();
          const hadVisibleStreamOutput = hasVisibleBattleStreamOutput();
          if (hadVisibleStreamOutput) {
            suppressThoughtStreamAfterRecovery = true;
          }

          if (error?.name === 'AbortError' && battleStallAborted) {
            attempts += 1;
            lastRetryError = { label: 'Model stream stalled' };
            const retryDelay = getAIRetryDelaySeconds(attempts);
            if (!hadVisibleStreamOutput) {
              io.to(roomId).emit('battleRetryStatus', {
                attempt: attempts,
                label: 'Model stream stalled',
                delay: Math.round(retryDelay),
                restartAvailable: false,
              });
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay * 1000));
            continue;
          }

          if (error?.name === 'AbortError') {
            return;
          }

          const errorInfo = classifyAIError(error);
          lastRetryError = errorInfo;

          if (!errorInfo.retryable) {
            delete activeRoom.lastResolutionRequestAt;
            activeRoom.awaitingTurnResolution = false;
            delete activeRoom.activeBattleStream;
            delete activeRoom.resolutionRequestNonce;
            delete activeRoom.battleRetryWindowStartedAt;
            activeRoom.battleRetryRestartAvailable = false;
            io.to(roomId).emit('battleRetryStatus', { attempt: 0, restartAvailable: false });
            io.to(roomId).emit('error', `Turn resolution failed (${selectedModel}). ${formatAIError(errorInfo)}`);
            return;
          }

          attempts += 1;
          const now = Date.now();
          if (typeof activeRoom.battleRetryWindowStartedAt !== 'number') {
            activeRoom.battleRetryWindowStartedAt = now;
          }
          const elapsed = now - activeRoom.battleRetryWindowStartedAt;
          const remainingMs = Math.max(0, BATTLE_RETRY_WINDOW_MS - elapsed);

          if (remainingMs <= 0) {
            activeRoom.battleRetryRestartAvailable = true;
            io.to(roomId).emit('battleRetryStatus', {
              attempt: hadVisibleStreamOutput ? 0 : attempts,
              label: errorInfo.label,
              statusCode: errorInfo.statusCode,
              statusText: errorInfo.statusText,
              restartAvailable: true,
              delay: 0,
            });
            return;
          }

          const retryDelay = Math.min(
            getAIRetryDelaySeconds(attempts, errorInfo.suggestedRetrySeconds),
            Math.max(1, remainingMs / 1000),
          );
          activeRoom.battleRetryRestartAvailable = false;
          if (!hadVisibleStreamOutput) {
            io.to(roomId).emit('battleRetryStatus', {
              attempt: attempts,
              label: errorInfo.label,
              delay: Math.round(retryDelay),
              statusCode: errorInfo.statusCode,
              statusText: errorInfo.statusText,
              restartAvailable: false,
            });
          }
          await new Promise(resolve => setTimeout(resolve, retryDelay * 1000));
          continue;
        }
      }
    } finally {
      if (rooms[roomId]) {
        rooms[roomId].battleResolutionTaskActive = false;
      }
    }
  };

  const emitBattleMapState = (roomId: string) => {
    const room = rooms[roomId];
    if (!room?.mapState) return;
    io.to(roomId).emit("battleMapStateUpdated", room.mapState);
  };

  const getTypingChannel = (socketId: string) => {
    const roomId = players[socketId]?.room;
    if (roomId && rooms[roomId]) {
      return `room:${roomId}`;
    }
    if (explorationPlayers[socketId]) {
      return 'exploration_world';
    }
    return null;
  };

  const emitTypingStatus = (channel: string) => {
    const typingIds = Array.from(typingChannelMembers[channel] || []);
    if (channel.startsWith('room:')) {
      io.to(channel.slice('room:'.length)).emit('typingStatusUpdated', { context: 'room', typingIds });
      return;
    }
    if (channel === 'exploration_world') {
      io.to('exploration_world').emit('typingStatusUpdated', { context: 'exploration', typingIds });
    }
  };

  const clearTypingForSocket = (socketId: string) => {
    if (typingTimeouts[socketId]) {
      clearTimeout(typingTimeouts[socketId]);
      delete typingTimeouts[socketId];
    }

    const currentChannel = typingChannelBySocket[socketId];
    if (!currentChannel) return;

    typingChannelMembers[currentChannel]?.delete(socketId);
    if (typingChannelMembers[currentChannel]?.size === 0) {
      delete typingChannelMembers[currentChannel];
    }
    delete typingChannelBySocket[socketId];
    emitTypingStatus(currentChannel);
  };

  const setTypingForSocket = (socketId: string, isTyping: boolean) => {
    const nextChannel = getTypingChannel(socketId);
    const currentChannel = typingChannelBySocket[socketId];

    if (currentChannel && currentChannel !== nextChannel) {
      clearTypingForSocket(socketId);
    }

    if (!isTyping || !nextChannel) {
      clearTypingForSocket(socketId);
      return;
    }

    if (!typingChannelMembers[nextChannel]) {
      typingChannelMembers[nextChannel] = new Set<string>();
    }
    typingChannelMembers[nextChannel].add(socketId);
    typingChannelBySocket[socketId] = nextChannel;

    if (typingTimeouts[socketId]) {
      clearTimeout(typingTimeouts[socketId]);
    }
    typingTimeouts[socketId] = setTimeout(() => {
      clearTypingForSocket(socketId);
    }, 1800);

    emitTypingStatus(nextChannel);
  };

  const clearArenaPreparationTimer = (roomId: string) => {
    const timer = arenaPreparationTimers[roomId];
    if (!timer) return;
    if (timer.interval) {
      clearInterval(timer.interval);
    }
    delete arenaPreparationTimers[roomId];
  };

  const emitRoomPlayersUpdated = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('roomPlayersUpdated', {
      players: room.players,
      phase: room.phase || 'battle',
      modelSettings: room.modelSettings || null,
    });
  };

  const getArenaPreparationSnapshot = (roomId: string) => {
    const room = rooms[roomId];
    const timer = arenaPreparationTimers[roomId] || room?.pausedArenaPreparation;
    if (!room || !timer) return null;

    const playerRemaining: Record<string, number | null> = {};
    if (timer.unlimited) {
      const participantIds = getArenaPreparationParticipantIds(room);
      for (const playerId of participantIds) {
        playerRemaining[playerId] = null;
      }
    } else if (timer.stage === 'tweak') {
      const participantIds = getArenaPreparationParticipantIds(room);
      for (const playerId of participantIds) {
        const bonus = timer.playerBonusSeconds[playerId] || 0;
        playerRemaining[playerId] = Math.max(0, (timer.remaining || 0) + bonus);
      }
    }

    return {
      stage: timer.stage,
      remaining: timer.remaining,
      playerRemaining,
      tweakDuration: timer.tweakDuration,
      skipVotes: timer.skipVotes,
      unlimited: !!timer.unlimited,
    };
  };

  const emitArenaPreparationState = (roomId: string) => {
    const room = rooms[roomId];
    const timer = getArenaPreparationSnapshot(roomId);
    if (!room || !timer) return;

    io.to(roomId).emit('arenaPreparationState', {
      roomId,
      players: room.players,
      isBotMatch: !!room.isBotMatch,
      stage: timer.stage,
      remaining: timer.remaining,
      playerRemaining: timer.playerRemaining,
      tweakDuration: timer.tweakDuration,
      skipVotes: timer.skipVotes,
      unlimited: !!timer.unlimited,
    });
  };

  const getArenaPreparationParticipantIds = (room: any) => (
    Object.keys(room.players).filter(playerId => !room.players[playerId]?.character?.isNpcAlly)
  );

  const maybeAdvanceArenaPreparation = (roomId: string) => {
    const room = rooms[roomId];
    if (!room || (room.phase !== 'preview' && room.phase !== 'tweak')) return;

    const participantIds = getArenaPreparationParticipantIds(room);
    if (participantIds.length === 0) {
      startBattleRoom(roomId);
      return;
    }

    const allHaveRewriteAccess = participantIds.every(playerId => room.phase === 'tweak' || !!room.players[playerId]?.prepSkippedPreview);
    const allLockedIn = participantIds.every(playerId => !!room.players[playerId]?.lockedIn);
    if (allHaveRewriteAccess && allLockedIn) {
      // Brief delay to let any pending AI streams finish rendering on clients
      setTimeout(() => {
        const r = rooms[roomId];
        if (r && (r.phase === 'preview' || r.phase === 'tweak')) {
          startBattleRoom(roomId);
        }
      }, 2500);
    }
  };

  const lockArenaPreparationPlayer = (roomId: string, playerId: string) => {
    const room = rooms[roomId];
    if (!room?.players?.[playerId]) return;
    room.players[playerId].lockedIn = true;
    emitRoomPlayersUpdated(roomId);
    maybeAdvanceArenaPreparation(roomId);
  };

  const resolveControlledRoomPlayerId = (room: any, requesterId: string, requestedPlayerId?: string) => {
    if (!requestedPlayerId || requestedPlayerId === requesterId) return requesterId;
    if (!room?.isBotMatch || room.host !== requesterId || !room.players?.[requestedPlayerId]) return null;
    if (requestedPlayerId.startsWith('bot_') || requestedPlayerId.startsWith('npc_ally_')) return requestedPlayerId;
    return null;
  };

  const applyPreparationCharacterUpdate = (roomId: string, playerId: string, normalizedState: any) => {
    const room = rooms[roomId];
    if (!room?.players?.[playerId] || room.phase === 'battle') return;

    room.players[playerId].character = normalizedState;
    if (room.phase === 'tweak' || room.players[playerId]?.prepSkippedPreview) {
      clearTypingForSocket(playerId);
      lockArenaPreparationPlayer(roomId, playerId);
      return;
    }

    emitRoomPlayersUpdated(roomId);
  };

  const applyPlayerLockedAction = (roomId: string, playerId: string, actionText: string, options?: { emitNpcAction?: boolean }) => {
    const room = rooms[roomId];
    if (!room?.players?.[playerId]) return;

    clearTypingForSocket(playerId);
    room.players[playerId].lockedIn = true;
    room.players[playerId].autoLockedThisTurn = false;
    room.players[playerId].action = actionText;
    room.battleActionSequence = (room.battleActionSequence || 0) + 1;
    room.players[playerId].actionSequence = room.battleActionSequence;
    io.to(roomId).emit("playerLockedIn", playerId);

    if (options?.emitNpcAction) {
      appendRoomHistory(roomId, `NPC_ALLY_ACTION_**${room.players[playerId].character?.name || 'NPC Ally'}:** ${actionText}`);
      io.to(roomId).emit("npcAllyAction", {
        npcId: playerId,
        npcName: room.players[playerId].character?.name || 'NPC Ally',
        action: actionText,
      });
    }

    const playerIds = Object.keys(room.players);
    const allLockedIn = playerIds.every((id) => room.players[id].lockedIn);
    if (allLockedIn) {
      requestTurnResolutionIfReady(roomId);
    }
  };

  const autoLockPendingNpcAllies = (roomId: string, room: any, npcActions?: Record<string, string>) => {
    if (!room?.isBotMatch) return;

    const npcAllyIds = Array.isArray(room.npcAllyIds) ? room.npcAllyIds : [];
    for (const npcId of npcAllyIds) {
      if (!room.players?.[npcId] || room.players[npcId].lockedIn) continue;

      const npcName = room.players[npcId].character?.name || 'NPC Ally';
      const requestedAction = typeof npcActions?.[npcId] === 'string' ? npcActions[npcId].trim() : '';
      const npcAction = requestedAction || `${npcName} attacks the enemy with their signature ability.`;

      applyPlayerLockedAction(roomId, npcId, npcAction, { emitNpcAction: true });
    }
  };

  const getHumanRoomParticipantIds = (room: any) => (
    Object.keys(room?.players || {}).filter(playerId => !playerId.startsWith('bot_') && !room.players[playerId]?.character?.isNpcAlly)
  );

  const syncArenaPreparationTimerPlayerId = (timer: any, oldPlayerId: string, newPlayerId: string) => {
    if (!timer) return;

    if (Array.isArray(timer.skipVotes)) {
      timer.skipVotes = timer.skipVotes.map((playerId: string) => playerId === oldPlayerId ? newPlayerId : playerId);
    }

    if (timer.playerPaused?.[oldPlayerId] !== undefined) {
      timer.playerPaused[newPlayerId] = timer.playerPaused[oldPlayerId];
      delete timer.playerPaused[oldPlayerId];
    }

    if (timer.playerBonusSeconds?.[oldPlayerId] !== undefined) {
      timer.playerBonusSeconds[newPlayerId] = timer.playerBonusSeconds[oldPlayerId];
      delete timer.playerBonusSeconds[oldPlayerId];
    }
  };

  const startArenaPreparationInterval = (roomId: string) => {
    const timer = arenaPreparationTimers[roomId];
    if (!timer) return;

    if (timer.unlimited) {
      emitArenaPreparationState(roomId);
      return;
    }

    timer.interval = setInterval(() => {
      const activeTimer = arenaPreparationTimers[roomId];
      const activeRoom = rooms[roomId];
      if (!activeTimer || !activeRoom) return;

      activeTimer.remaining = (activeTimer.remaining || 0) - 1;

      if (activeTimer.stage === 'tweak') {
        for (const playerId of Object.keys(activeTimer.playerPaused)) {
          if (activeTimer.playerPaused[playerId]) {
            activeTimer.playerBonusSeconds[playerId] = (activeTimer.playerBonusSeconds[playerId] || 0) + 1;
          }
        }
      }

      if ((activeTimer.remaining || 0) <= 0) {
        if (activeTimer.stage === 'preview') {
          startArenaPreparationTweakStage(roomId);
          return;
        }

        const participantIds = getArenaPreparationParticipantIds(activeRoom);
        const allExpired = participantIds.every(playerId => {
          const bonus = activeTimer.playerBonusSeconds[playerId] || 0;
          const effectiveRemaining = (activeTimer.remaining || 0) + bonus;
          return effectiveRemaining <= 0 && !activeTimer.playerPaused[playerId];
        });

        if (allExpired) {
          startBattleRoom(roomId);
          return;
        }
      }

      emitArenaPreparationState(roomId);
    }, 1000);
  };

  const pauseRoomForReconnect = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.readyTimeout) {
      clearTimeout(room.readyTimeout);
      delete room.readyTimeout;
    }

    const prepTimer = arenaPreparationTimers[roomId];
    if (prepTimer) {
      room.pausedArenaPreparation = {
        stage: prepTimer.stage,
        remaining: prepTimer.remaining,
        skipVotes: [...prepTimer.skipVotes],
        playerPaused: { ...prepTimer.playerPaused },
        playerBonusSeconds: { ...prepTimer.playerBonusSeconds },
        tweakDuration: prepTimer.tweakDuration,
        unlimited: !!prepTimer.unlimited,
      };
      clearArenaPreparationTimer(roomId);
    }

    const battleTimer = roomTimers[roomId];
    if (battleTimer) {
      room.pausedTurnRemaining = battleTimer.remaining;
      clearRoomTimer(roomId);
    }
  };

  const resumeRoomAfterReconnect = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.disconnectedParticipantIds instanceof Set && room.disconnectedParticipantIds.size > 0) {
      return;
    }

    if (room.pendingReadyPlayers instanceof Set && room.pendingReadyPlayers.size > 0 && !room.readyTimeout) {
      room.readyTimeout = setTimeout(() => {
        delete room.pendingReadyPlayers;
        delete room.readyTimeout;
        if (rooms[roomId]) {
          startRoomTimer(roomId);
        }
      }, 30_000);
      return;
    }

    if (room.pausedArenaPreparation) {
      arenaPreparationTimers[roomId] = {
        interval: null,
        stage: room.pausedArenaPreparation.stage,
        remaining: room.pausedArenaPreparation.remaining,
        skipVotes: [...room.pausedArenaPreparation.skipVotes],
        playerPaused: { ...room.pausedArenaPreparation.playerPaused },
        playerBonusSeconds: { ...room.pausedArenaPreparation.playerBonusSeconds },
        tweakDuration: room.pausedArenaPreparation.tweakDuration,
        unlimited: !!room.pausedArenaPreparation.unlimited,
      };
      delete room.pausedArenaPreparation;
      emitArenaPreparationState(roomId);
      startArenaPreparationInterval(roomId);
      return;
    }

    if (typeof room.pausedTurnRemaining === 'number' && !room.pendingReadyPlayers) {
      const remaining = room.pausedTurnRemaining;
      delete room.pausedTurnRemaining;
      startRoomTimer(roomId, remaining);
    }
  };

  const startArenaPreparationTweakStage = (roomId: string) => {
    const room = rooms[roomId];
    const timer = arenaPreparationTimers[roomId];
    if (!room || !timer) return;

    timer.stage = 'tweak';
    timer.unlimited = !!room.unlimitedTurnTime;
    const tweakDuration = (typeof room.arenaTweakSeconds === 'number' && room.arenaTweakSeconds >= 1) ? room.arenaTweakSeconds : ARENA_TWEAK_SECONDS;
    timer.remaining = timer.unlimited ? null : tweakDuration;
    timer.tweakDuration = timer.unlimited ? null : tweakDuration;
    timer.skipVotes = [];
    timer.playerPaused = {};
    timer.playerBonusSeconds = {};
    room.phase = 'tweak';
    for (const playerId of Object.keys(room.players)) {
      const p = room.players[playerId];
      // Preserve existing lock-in for humans; keep bots locked if already locked
      if (!p.lockedIn) {
        p.lockedIn = !!p?.character?.isNpcAlly || (playerId.startsWith('bot_') && false);
      }
      p.prepSkippedPreview = true;
    }
    emitRoomPlayersUpdated(roomId);
    maybeAdvanceArenaPreparation(roomId);
    emitArenaPreparationState(roomId);
  };

  const startBattleRoom = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;

    clearArenaPreparationTimer(roomId);
    delete room.pausedArenaPreparation;
    room.phase = 'battle';
    room.awaitingTurnResolution = false;
    delete room.activeBattleStream;
    room.history = ['**Match Found!** The battle begins.'];
    room.battleMediaLogs = [];
    room.battleImageSharedThisTurn = false;
    room.battleActionSequence = 0;
    for (const playerId of Object.keys(room.players)) {
      room.players[playerId].lockedIn = false;
      room.players[playerId].action = "";
      room.players[playerId].autoLockedThisTurn = false;
      room.players[playerId].prepSkippedPreview = false;
      delete room.players[playerId].actionSequence;
    }
    emitTypingStatus(`room:${roomId}`);
    io.to(roomId).emit('matchFound', {
      roomId,
      players: room.players,
      mapState: room.mapState,
      isBotMatch: !!room.isBotMatch,
      isPvpExploration: !!room.isPvpExploration,
    });
    startRoomTimer(roomId);
  };

  const startArenaPreparation = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;

    clearArenaPreparationTimer(roomId);
    room.phase = 'preview';
    for (const playerId of Object.keys(room.players)) {
      room.players[playerId].lockedIn = false;
      room.players[playerId].action = "";
      room.players[playerId].autoLockedThisTurn = false;
      room.players[playerId].prepSkippedPreview = !!room.isBotMatch && playerId.startsWith('bot_');
    }
    const previewDuration = (typeof room.arenaPreviewSeconds === 'number' && room.arenaPreviewSeconds >= 1) ? room.arenaPreviewSeconds : ARENA_PREVIEW_SECONDS;
    arenaPreparationTimers[roomId] = {
      interval: null,
      stage: 'preview',
      remaining: room.unlimitedTurnTime ? null : previewDuration,
      skipVotes: [],
      playerPaused: {},
      playerBonusSeconds: {},
      tweakDuration: room.unlimitedTurnTime ? null : 0,
      unlimited: !!room.unlimitedTurnTime,
    };

    emitArenaPreparationState(roomId);
    startArenaPreparationInterval(roomId);
  };

  const startExplorationPvpBattle = (challengerId: string, targetId: string, ambushTargetId?: string, openingStrikeDamage?: number) => {
    if (challengerId === targetId) return null;

    const challenger = explorationPlayers[challengerId];
    const targetPlayer = explorationPlayers[targetId];
    if (!challenger || !targetPlayer) return null;

    delete explorationPlayers[challengerId];
    delete explorationPlayers[targetId];
    delete explorationLockedActions[challengerId];
    delete explorationLockedActions[targetId];
    clearTypingForSocket(challengerId);
    clearTypingForSocket(targetId);
    emitExplorationPlayersUpdated();

    const challengerCharacter = { ...challenger.character };
    const targetCharacter = { ...targetPlayer.character };
    if (ambushTargetId === targetId) {
      const openingStrike = typeof openingStrikeDamage === 'number'
        ? Math.max(1, Math.floor(openingStrikeDamage))
        : Math.max(5, Math.ceil((targetCharacter.maxHp || targetCharacter.hp || 100) * 0.15));
      targetCharacter.hp = Math.max(1, (targetCharacter.hp || targetCharacter.maxHp || 100) - openingStrike);
    }

    const roomId = `pvp_room_${challengerId}_${targetId}`;
    rooms[roomId] = {
      id: roomId,
      host: challengerId,
      isBotMatch: false,
      isPvpExploration: true,
      phase: 'battle',
      unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
      battleTurnSeconds: TURN_TIMER_SECONDS,
      players: {
        [challengerId]: { lockedIn: false, action: "", character: challengerCharacter },
        [targetId]: { lockedIn: false, action: "", character: targetCharacter },
      },
      history: ['**Match Found!** The battle begins.'],
      battleMediaLogs: [],
    };

    const matchData = {
      roomId,
      players: rooms[roomId].players,
      isBotMatch: false,
      isPvpExploration: true,
    };

    const challengerSocket = io.sockets.sockets.get(challengerId);
    if (challengerSocket) {
      challengerSocket.join(roomId);
      players[challengerId] = { ...players[challengerId], room: roomId };
      challengerSocket.emit("matchFound", matchData);
    }

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.join(roomId);
      players[targetId] = { ...players[targetId], room: roomId };
      targetSocket.emit("matchFound", matchData);
    }

    return matchData;
  };

  const normalizeExplorationText = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  interface TradeStack {
    kind: 'gold' | 'item';
    key: string;
    label: string;
    quantity: number;
  }

  interface PendingTradeOffer {
    id: string;
    fromId: string;
    toId: string;
    fromName: string;
    toName: string;
    give: TradeStack;
    receive: TradeStack;
  }

  const pendingTradeOffers: Record<string, PendingTradeOffer> = {};

  const npcTradeCatalogs: Record<string, Record<string, { label: string; buyPrice: number; sellPrice: number }>> = {
    merchant_lira: {
      health_potion: { label: 'Health Potion', buyPrice: 12, sellPrice: 6 },
      rope: { label: 'Rope', buyPrice: 8, sellPrice: 4 },
      iron_dagger: { label: 'Iron Dagger', buyPrice: 24, sellPrice: 12 },
      map_fragment: { label: 'Map Fragment', buyPrice: 36, sellPrice: 18 },
    },
    wandering_merchant_ori: {
      map_of_the_isles: { label: 'Map of the Isles', buyPrice: 28, sellPrice: 14 },
      climbing_gear: { label: 'Climbing Gear', buyPrice: 22, sellPrice: 11 },
      fire_resistance_potion: { label: 'Fire Resistance Potion', buyPrice: 18, sellPrice: 9 },
    },
  };

  const ensureExplorationState = (socketId: string) => {
    const ep = explorationPlayers[socketId] as any;
    if (!ep) return null;
    if (!ep._state) {
      ep._state = {
        locationId: ep.locationId,
        x: ep.x,
        y: ep.y,
        hunger: 100,
        thirst: 100,
        stamina: 100,
        inventory: {},
        discoveredLocations: [ep.locationId],
        goals: [],
        equippedWeapon: null,
        equippedArmor: null,
      };
    }
    if (!ep._state.inventory) ep._state.inventory = {};
    return ep._state;
  };

  const getPlayerGold = (socketId: string) => {
    const ep = explorationPlayers[socketId];
    return typeof ep?.character?.gold === 'number' ? ep.character.gold : 25;
  };

  const setPlayerGold = (socketId: string, gold: number) => {
    const nextGold = Math.max(0, gold);
    if (explorationPlayers[socketId]) {
      explorationPlayers[socketId].character = { ...explorationPlayers[socketId].character, gold: nextGold };
    }
    players[socketId] = { ...players[socketId], character: { ...players[socketId]?.character, gold: nextGold } };
  };

  const normalizeTradeItemKey = (value: string) => normalizeExplorationText(value).replace(/\s+/g, '_');

  const formatTradeStack = (stack: TradeStack) => stack.kind === 'gold'
    ? `${stack.quantity} gold`
    : `${stack.quantity} ${stack.label}`;

  const parseTradeStack = (value: string): TradeStack | null => {
    const match = value.trim().match(/^(\d+)\s+(.+)$/i);
    if (!match) return null;

    const quantity = Math.max(1, Number(match[1]));
    const label = match[2].trim();
    const normalized = normalizeExplorationText(label);
    if (normalized.includes('gold') || normalized.includes('coin')) {
      return { kind: 'gold', key: 'gold', label: 'gold', quantity };
    }

    return { kind: 'item', key: normalizeTradeItemKey(label), label, quantity };
  };

  const hasTradeStack = (socketId: string, stack: TradeStack) => {
    if (stack.kind === 'gold') return getPlayerGold(socketId) >= stack.quantity;
    const state = ensureExplorationState(socketId);
    return (state?.inventory?.[stack.key] || 0) >= stack.quantity;
  };

  const buildTradeUpdateArgs = (removeStack?: TradeStack | null, addStack?: TradeStack | null) => {
    const args: Record<string, any> = {};
    if (removeStack) {
      if (removeStack.kind === 'gold') args.goldChange = (args.goldChange || 0) - removeStack.quantity;
      else args.removeItems = JSON.stringify({ [removeStack.key]: removeStack.quantity });
    }
    if (addStack) {
      if (addStack.kind === 'gold') args.goldChange = (args.goldChange || 0) + addStack.quantity;
      else args.addItems = JSON.stringify({ [addStack.key]: addStack.quantity });
    }
    return args;
  };

  const applyTradeUpdate = (socketId: string, removeStack?: TradeStack | null, addStack?: TradeStack | null) => {
    const state = ensureExplorationState(socketId);
    if (!state) return;

    if (removeStack) {
      if (removeStack.kind === 'gold') {
        setPlayerGold(socketId, getPlayerGold(socketId) - removeStack.quantity);
      } else {
        state.inventory[removeStack.key] = Math.max(0, (state.inventory[removeStack.key] || 0) - removeStack.quantity);
        if (state.inventory[removeStack.key] === 0) delete state.inventory[removeStack.key];
      }
    }

    if (addStack) {
      if (addStack.kind === 'gold') {
        setPlayerGold(socketId, getPlayerGold(socketId) + addStack.quantity);
      } else {
        state.inventory[addStack.key] = (state.inventory[addStack.key] || 0) + addStack.quantity;
      }
    }
  };

  const findNearbyPlayerByName = (actorId: string, targetName: string) => {
    const actor = explorationPlayers[actorId];
    if (!actor) return null;
    return Object.entries(explorationPlayers)
      .find(([id, player]) => id !== actorId && player.locationId === actor.locationId && player.character?.name?.toLowerCase() === targetName.toLowerCase()) || null;
  };

  const findNearbyTraderForItem = (actorId: string, itemKey: string, traderName?: string) => {
    const actor = explorationPlayers[actorId];
    if (!actor) return null;
    return Object.entries(explorationNpcs).find(([npcId, npc]) => {
      if (npc.locationId !== actor.locationId || npc.role !== 'trader') return false;
      if (traderName && npc.name.toLowerCase() !== traderName.toLowerCase()) return false;
      return !!npcTradeCatalogs[npcId]?.[itemKey];
    }) || null;
  };

  const emitExplorationResult = (socketId: string, requestId: string, text: string, toolCalls: any[] = [], thoughts = "") => {
    io.to(socketId).emit("explorationActionResult", { requestId, text, thoughts, toolCalls });
  };

  const findPendingOfferForTarget = (targetId: string, fromName?: string) => {
    const candidates = Object.values(pendingTradeOffers).filter(offer => offer.toId === targetId);
    if (!fromName) return candidates[0] || null;
    return candidates.find(offer => offer.fromName.toLowerCase() === fromName.toLowerCase()) || null;
  };

  const tryHandleDirectTradeAction = (requestId: string, actionEntry: ExplorationSubmittedAction) => {
    const actorId = actionEntry.playerId;

    const buyMatch = actionEntry.action.match(/^(?:buy|purchase)\s+(?:(\d+)\s+)?(.+?)(?:\s+from\s+(.+))?$/i);
    if (buyMatch) {
      const quantity = Math.max(1, Number(buyMatch[1] || 1));
      const itemKey = normalizeTradeItemKey(buyMatch[2]);
      const traderName = buyMatch[3]?.trim();
      const trader = findNearbyTraderForItem(actorId, itemKey, traderName);
      if (!trader) {
        emitExplorationResult(actorId, requestId, `No nearby trader has **${buyMatch[2].trim()}** for sale right now.`);
        return true;
      }

      const [npcId, npc] = trader;
      const listing = npcTradeCatalogs[npcId][itemKey];
      const cost = listing.buyPrice * quantity;
      const goldStack: TradeStack = { kind: 'gold', key: 'gold', label: 'gold', quantity: cost };
      const itemStack: TradeStack = { kind: 'item', key: itemKey, label: listing.label, quantity };

      if (!hasTradeStack(actorId, goldStack)) {
        emitExplorationResult(actorId, requestId, `**${npc.name}** quotes **${cost} gold**, but you only have **${getPlayerGold(actorId)} gold**.`);
        return true;
      }

      applyTradeUpdate(actorId, goldStack, itemStack);
      emitExplorationResult(actorId, requestId, `**${npc.name}** sells you ${formatTradeStack(itemStack)} for **${cost} gold**.`, [{ name: 'update_player_state', args: buildTradeUpdateArgs(goldStack, itemStack) }]);
      return true;
    }

    const sellMatch = actionEntry.action.match(/^(?:sell)\s+(?:(\d+)\s+)?(.+?)(?:\s+to\s+(.+))?$/i);
    if (sellMatch) {
      const quantity = Math.max(1, Number(sellMatch[1] || 1));
      const itemKey = normalizeTradeItemKey(sellMatch[2]);
      const traderName = sellMatch[3]?.trim();
      const actor = explorationPlayers[actorId];
      const nearbyTrader = Object.entries(explorationNpcs).find(([_, npc]) => npc.locationId === actor?.locationId && npc.role === 'trader' && (!traderName || npc.name.toLowerCase() === traderName.toLowerCase()));
      if (!nearbyTrader) {
        emitExplorationResult(actorId, requestId, `No nearby trader is ready to buy **${sellMatch[2].trim()}** right now.`);
        return true;
      }

      const [npcId, npc] = nearbyTrader;
      const itemStack: TradeStack = { kind: 'item', key: itemKey, label: sellMatch[2].trim(), quantity };
      if (!hasTradeStack(actorId, itemStack)) {
        emitExplorationResult(actorId, requestId, `You do not have ${formatTradeStack(itemStack)} to sell.`);
        return true;
      }

      const listing = npcTradeCatalogs[npcId]?.[itemKey];
      const sellPrice = (listing?.sellPrice || 1) * quantity;
      const goldStack: TradeStack = { kind: 'gold', key: 'gold', label: 'gold', quantity: sellPrice };
      applyTradeUpdate(actorId, itemStack, goldStack);
      emitExplorationResult(actorId, requestId, `**${npc.name}** buys ${formatTradeStack(itemStack)} for **${sellPrice} gold**.`, [{ name: 'update_player_state', args: buildTradeUpdateArgs(itemStack, goldStack) }]);
      return true;
    }

    const offerMatch = actionEntry.action.match(/^(?:offer|trade)\s+(.+?)\s+(?:to|with)\s+(.+?)\s+for\s+(.+)$/i);
    if (offerMatch) {
      const give = parseTradeStack(offerMatch[1]);
      const targetName = offerMatch[2].trim();
      const receive = parseTradeStack(offerMatch[3]);
      if (!give || !receive) {
        emitExplorationResult(actorId, requestId, `Use trades like **offer 10 gold to Jonas for 2 pearl**.`);
        return true;
      }

      const targetMatch = findNearbyPlayerByName(actorId, targetName);
      if (!targetMatch) {
        emitExplorationResult(actorId, requestId, `**${targetName}** is not close enough to trade with right now.`);
        return true;
      }

      if (!hasTradeStack(actorId, give)) {
        emitExplorationResult(actorId, requestId, `You do not have ${formatTradeStack(give)} to offer.`);
        return true;
      }

      const [targetId, targetPlayer] = targetMatch;
      const offer: PendingTradeOffer = {
        id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        fromId: actorId,
        toId: targetId,
        fromName: explorationPlayers[actorId]?.character?.name || actionEntry.playerName,
        toName: targetPlayer.character?.name || targetName,
        give,
        receive,
      };
      pendingTradeOffers[offer.id] = offer;

      emitExplorationResult(actorId, requestId, `You offer **${offer.toName}** ${formatTradeStack(give)} for ${formatTradeStack(receive)}.`);
      io.to(targetId).emit('tradeOfferReceived', {
        offerId: offer.id,
        fromName: offer.fromName,
        text: `**${offer.fromName}** offers ${formatTradeStack(give)} for ${formatTradeStack(receive)}. Type **accept trade** or **decline trade**.`,
      });
      return true;
    }

    const acceptMatch = actionEntry.action.match(/^(?:accept)(?:\s+trade)?(?:\s+from\s+(.+))?$/i);
    if (acceptMatch) {
      const offer = findPendingOfferForTarget(actorId, acceptMatch[1]?.trim());
      if (!offer) {
        emitExplorationResult(actorId, requestId, `There is no pending trade offer for you right now.`);
        return true;
      }

      if (!hasTradeStack(offer.fromId, offer.give)) {
        delete pendingTradeOffers[offer.id];
        emitExplorationResult(actorId, requestId, `**${offer.fromName}** can no longer cover that trade.`);
        io.to(offer.fromId).emit('tradeOfferUpdate', { text: `Your trade offer to **${offer.toName}** expired because you no longer had ${formatTradeStack(offer.give)}.` });
        return true;
      }

      if (!hasTradeStack(actorId, offer.receive)) {
        emitExplorationResult(actorId, requestId, `You do not have ${formatTradeStack(offer.receive)} to complete that trade.`);
        return true;
      }

      applyTradeUpdate(offer.fromId, offer.give, offer.receive);
      applyTradeUpdate(actorId, offer.receive, offer.give);

      emitExplorationResult(offer.fromId, requestId, `**${offer.toName}** accepts your trade. You hand over ${formatTradeStack(offer.give)} and receive ${formatTradeStack(offer.receive)}.`, [{ name: 'update_player_state', args: buildTradeUpdateArgs(offer.give, offer.receive) }]);
      emitExplorationResult(actorId, requestId, `You accept **${offer.fromName}**'s trade. You hand over ${formatTradeStack(offer.receive)} and receive ${formatTradeStack(offer.give)}.`, [{ name: 'update_player_state', args: buildTradeUpdateArgs(offer.receive, offer.give) }]);
      delete pendingTradeOffers[offer.id];
      return true;
    }

    const declineMatch = actionEntry.action.match(/^(?:decline)(?:\s+trade)?(?:\s+from\s+(.+))?$/i);
    if (declineMatch) {
      const offer = findPendingOfferForTarget(actorId, declineMatch[1]?.trim());
      if (!offer) {
        emitExplorationResult(actorId, requestId, `There is no pending trade offer to decline.`);
        return true;
      }

      delete pendingTradeOffers[offer.id];
      emitExplorationResult(actorId, requestId, `You decline **${offer.fromName}**'s trade offer.`);
      io.to(offer.fromId).emit('tradeOfferUpdate', { text: `**${offer.toName}** declines your trade offer.` });
      return true;
    }

    return false;
  };

  // Tool declarations for exploration AI
  const explorationTools = [
    {
      name: "update_player_state",
      description: "Update the player's stats, inventory, or equipment after an action.",
      parameters: {
        type: "OBJECT",
        properties: {
          hungerChange: { type: "INTEGER", description: "Change to hunger (negative = decrease)" },
          thirstChange: { type: "INTEGER", description: "Change to thirst (negative = decrease)" },
          staminaChange: { type: "INTEGER", description: "Change to stamina (negative = decrease)" },
          hpChange: { type: "INTEGER", description: "Change to HP (negative = damage)" },
          manaChange: { type: "INTEGER", description: "Change to mana" },
          goldChange: { type: "INTEGER", description: "Change to gold coins" },
          addItems: { type: "STRING", description: "JSON object of items to add, e.g. {\"wood\":2, \"stone\":1}" },
          removeItems: { type: "STRING", description: "JSON object of items to remove" },
          equipWeapon: { type: "STRING", description: "Weapon name to equip" },
          equipArmor: { type: "STRING", description: "Armor name to equip" }
        }
      }
    },
    {
      name: "update_goals",
      description: "Update the player's goal list. Provide all 5 goals.",
      parameters: {
        type: "OBJECT",
        properties: {
          goals: { type: "STRING", description: "JSON array of 5 goal strings" }
        },
        required: ["goals"]
      }
    },
    {
      name: "trigger_combat",
      description: "Start combat with an enemy at the current location. Can optionally include NPC allies who fight alongside the player.",
      parameters: {
        type: "OBJECT",
        properties: {
          enemyId: { type: "STRING", description: "The enemy type ID to fight" },
          enemyName: { type: "STRING", description: "Display name of the enemy" },
          npcAllyIds: { type: "STRING", description: "Optional JSON array of NPC IDs who join as allies, e.g. [\"elder_kai\"]" }
        },
        required: ["enemyId", "enemyName"]
      }
    },
    {
      name: "move_to_location",
      description: "Move the player to a connected location. MUST be called whenever the player moves to a new location.",
      parameters: {
        type: "OBJECT",
        properties: {
          locationId: { type: "STRING", description: "The ID of the connected location to move to" }
        },
        required: ["locationId"]
      }
    },
    {
      name: "move_to_subzone",
      description: "Move the player to a connected sub-zone within the current location. Call when the player moves between sub-zones.",
      parameters: {
        type: "OBJECT",
        properties: {
          subZoneId: { type: "STRING", description: "The ID of the sub-zone to move to (must be connected to current sub-zone)" }
        },
        required: ["subZoneId"]
      }
    },
    {
      name: "trigger_pvp_duel",
      description: "Challenge another player to a PVP duel. Use when players want to fight, spar, or duel each other.",
      parameters: {
        type: "OBJECT",
        properties: {
          targetPlayerName: { type: "STRING", description: "The name of the player to challenge" },
          surprisedPlayerName: { type: "STRING", description: "Optional player name who is caught off-guard before the battle begins" },
          openingStrikeDamage: { type: "INTEGER", description: "Optional pre-battle damage for a surprise attack before the duel formally starts" }
        },
        required: ["targetPlayerName"]
      }
    },
    {
      name: "set_npc_follow_state",
      description: "Have a nearby NPC start following a player, or stop following and return home.",
      parameters: {
        type: "OBJECT",
        properties: {
          npcId: { type: "STRING", description: "The NPC ID to update" },
          mode: { type: "STRING", description: "Either 'follow' or 'stop'" },
          followPlayerName: { type: "STRING", description: "The player name to follow when mode is 'follow'" }
        },
        required: ["npcId", "mode"]
      }
    }
  ];

  // Server-side exploration AI call
  async function handleExplorationAI(
    io: Server,
    action: string,
    playerContexts: { socketId: string; playerName: string; locationId: string; character: any; explorationState: any; recentLog: string[]; summary?: string }[],
    apiKey: string,
    model: string,
    abortSignal?: AbortSignal,
    submittedActions?: ExplorationSubmittedAction[]
  ) {
    const sysPrompt = getPrompt("exploration_guide.txt");
    const aiClient = createAIClient(apiKey);

    // Build context from the first player's perspective (or combined for multiplayer)
    const primary = playerContexts[0];
    const currentLoc = worldData?.locations?.find((l: any) => l.id === primary.locationId);
    const connectedIds = currentLoc?.connections || [];
    const connectedLocs = connectedIds.map((cid: string) => worldData?.locations?.find((l: any) => l.id === cid)).filter(Boolean);
    const npcsAtLocation = currentLoc?.npcs?.map((npcId: string) => worldData?.npcs?.[npcId]).filter(Boolean) || [];
    const enemiesAtLocation = currentLoc?.enemies?.map((eid: string) => worldData?.enemies?.[eid]).filter(Boolean) || [];

    // Get other players at same location
    const otherPlayersHere = Object.values(explorationPlayers)
      .filter(p => p.locationId === primary.locationId && !playerContexts.find(pc => pc.socketId === p.socketId))
      .map(p => p.character?.name).filter(Boolean);

    const es = primary.explorationState;
    const c = primary.character;

    // Get NPCs following this player
    const followingNpcs = Object.values(explorationNpcs)
      .filter(npc => npc.followTargetId === primary.socketId);

    // Sub-zone context
    const subZones = currentLoc?.subZones || [];
    const currentSubZoneId = es?.subZoneId || (subZones.length > 0 ? subZones[0].id : null);
    const currentSubZone = subZones.find((sz: any) => sz.id === currentSubZoneId);
    const connectedSubZones = currentSubZone
      ? (currentSubZone.connections || []).map((cid: string) => subZones.find((sz: any) => sz.id === cid)).filter(Boolean)
      : [];

    const subZoneContext = subZones.length > 0 ? `
CURRENT SUB-ZONE: ${currentSubZone?.name || 'Entry'} (${currentSubZoneId})
SUB-ZONE DESCRIPTION: ${currentSubZone?.description || ''}
CONNECTED SUB-ZONES: ${connectedSubZones.map((sz: any) => `${sz.name} (${sz.id})`).join(', ') || 'none'}
ALL SUB-ZONES HERE: ${subZones.map((sz: any) => `${sz.name} (${sz.id})`).join(', ')}` : '';

    const worldContext = `
CURRENT LOCATION: ${currentLoc?.name || 'Unknown'} (${currentLoc?.id})
DESCRIPTION: ${currentLoc?.description || ''}
TYPE: ${currentLoc?.type || ''}
AVAILABLE RESOURCES: ${currentLoc?.resources?.join(', ') || 'none'}
EXITS: ${connectedLocs.map((l: any) => `${l.name} (${l.id})`).join(', ')}
NPCs HERE: ${npcsAtLocation.map((n: any) => `${n?.name} - ${n?.role}`).join(', ') || 'none'}
ENEMIES HERE: ${enemiesAtLocation.map((e: any) => `${e?.name} (HP:${e?.hp}, DMG:${e?.damage})`).join(', ') || 'none'}
OTHER PLAYERS HERE: ${[...otherPlayersHere, ...playerContexts.slice(1).map(p => p.playerName)].join(', ') || 'none'}
NPC FOLLOWERS (with you): ${followingNpcs.map(n => `${n.name} (${n.id})`).join(', ') || 'none'}
${subZoneContext}
PLAYER STATE:
- HP: ${c?.hp}/${c?.maxHp}, Mana: ${c?.mana}/${c?.maxMana}
- Hunger: ${es?.hunger}/100, Thirst: ${es?.thirst}/100, Stamina: ${es?.stamina}/100
- Inventory: ${Object.entries(es?.inventory || {}).map(([k, v]) => `${k}(${v})`).join(', ') || 'empty'}
- Equipped Weapon: ${es?.equippedWeapon || 'none'}
- Current Goals: ${(es?.goals || []).join('; ')}

NEARBY LOCATIONS:
${connectedLocs.map((l: any) => `- ${l.name}: ${l.description}`).join('\n')}

${npcsAtLocation.map((n: any) => `NPC PROFILE - ${n?.name}:\n${n?.profileMarkdown}`).join('\n\n')}
`;

    const recentLog = primary.recentLog.slice(-10).map((m: string) => m).join('\n');
    const summaryPrefix = primary.summary ? `CONVERSATION SUMMARY (earlier events):\n${primary.summary}\n\n` : '';
    const prompt = `${worldContext}\n\n${summaryPrefix}RECENT CONVERSATION:\n${recentLog}\n\nPLAYER ACTION: ${action}`;

    const apiConfig = {
      model,
      contents: prompt,
      config: {
        abortSignal,
        systemInstruction: sysPrompt,
        temperature: 0.8,
        thinkingConfig: { includeThoughts: true },
        tools: [{ functionDeclarations: explorationTools as any }]
      },
    };

    const requestId = `explore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const firstSubmittedAction = submittedActions?.[0] || { playerId: primary.socketId, playerName: primary.playerName, action, locationId: primary.locationId };
    if (tryHandleDirectTradeAction(requestId, firstSubmittedAction)) {
      return;
    }

    let attempts = 0;
    const retryWindowStartedAt = Date.now();

    for (const pc of playerContexts) {
      io.to(pc.socketId).emit("explorationStreamStart", { requestId });
    }

    while (true) {
      if (abortSignal?.aborted) throw new Error("Aborted");

      try {
        let fullText = "";
        let fullThoughts = "";
        let toolCalls: any[] = [];

        const appendExplorationPart = (part: any) => {
          if (part.functionCall) {
            toolCalls.push(part.functionCall);
            return;
          }

          const text = typeof part.thought === 'string' ? part.thought : (part.text || "");
          if (!text) {
            return;
          }

          if (part.thought) {
            fullThoughts += text;
          } else {
            fullText += text;
          }
        };

        const emitExplorationStreamState = () => {
          for (const pc of playerContexts) {
            if (fullThoughts.trim()) {
              io.to(pc.socketId).emit("explorationStreamChunk", { requestId, type: "thought", text: fullThoughts.trim() });
            }
            if (fullText.trim()) {
              io.to(pc.socketId).emit("explorationStreamChunk", { requestId, type: "answer", text: fullText.trim() });
            }
          }
        };

        try {
          const response = await aiClient.models.generateContentStream(apiConfig);
          for await (const chunk of response) {
            if (abortSignal?.aborted) throw new Error("Aborted");
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              appendExplorationPart(part as any);
            }
            emitExplorationStreamState();
          }
        } catch (streamError: any) {
          if (abortSignal?.aborted) throw new Error("Aborted");
          // Fallback to non-streaming
          console.warn("Streaming failed, falling back to non-streaming:", streamError.message);
          fullText = "";
          fullThoughts = "";
          toolCalls = [];
          const fallbackRes = await aiClient.models.generateContent(apiConfig);
          const parts = fallbackRes.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            appendExplorationPart(part as any);
          }
        }

        // Retry once if empty response
        if (!fullText.trim() && !fullThoughts.trim() && toolCalls.length === 0) {
          console.warn("Empty response, retrying non-streaming...");
          const retryRes = await aiClient.models.generateContent(apiConfig);
          const retryParts = retryRes.candidates?.[0]?.content?.parts || [];
          for (const part of retryParts) {
            appendExplorationPart(part as any);
          }
        }

        // Process server-side tool calls (move_to_location, trigger_combat, trigger_pvp_duel)
        const processedToolCalls: any[] = [];
        for (const tc of toolCalls) {
          if (tc.name === 'move_to_location') {
            const locId = tc.args?.locationId;
            const loc = worldData?.locations?.find((l: any) => l.id === locId);
            if (loc) {
              // Move the primary player on server
              const ep = explorationPlayers[primary.socketId];
              if (ep) {
                ep.locationId = locId;
                ep.subZoneId = null;
                ep.x = loc.x;
                ep.y = loc.y;
                for (const npc of Object.values(explorationNpcs)) {
                  if (npc.followTargetId === primary.socketId) {
                    const offset = getNpcOffset(npc.id);
                    npc.locationId = locId;
                    npc.subZoneId = null;
                    npc.x = loc.x + offset.x;
                    npc.y = loc.y + offset.y;
                  }
                }
                io.to(primary.socketId).emit("playerMoved", { locationId: locId, x: loc.x, y: loc.y });
                emitExplorationPlayersUpdated();
                emitExplorationNpcStatesUpdated();
              }
            }
            processedToolCalls.push({ name: tc.name, args: tc.args });
          } else if (tc.name === 'move_to_subzone') {
            const subZoneId = tc.args?.subZoneId;
            const ep = explorationPlayers[primary.socketId];
            if (ep) {
              // Validate sub-zone exists in the current location
              const currentLoc = worldData?.locations?.find((l: any) => l.id === ep.locationId);
              const validSubZone = currentLoc?.subZones?.find((sz: any) => sz.id === subZoneId);
              if (validSubZone) {
                ep.subZoneId = subZoneId;
                for (const npc of Object.values(explorationNpcs)) {
                  if (npc.followTargetId === primary.socketId) {
                    npc.locationId = ep.locationId;
                    npc.subZoneId = subZoneId;
                  }
                }
                emitExplorationNpcStatesUpdated();
              } else {
                console.warn(`[SubZone] Invalid subZoneId "${subZoneId}" for location "${ep.locationId}" — ignoring`);
              }
            }
            processedToolCalls.push({ name: tc.name, args: tc.args });
          } else if (tc.name === 'set_npc_follow_state') {
            const npcIdentifier = tc.args?.npcId;
            const resolvedNpcByName = Object.values(worldData?.npcs || {}).find((npc: any) => npc?.name?.toLowerCase() === String(npcIdentifier || '').toLowerCase()) as any;
            const npcId = worldData?.npcs?.[npcIdentifier]?.id || resolvedNpcByName?.id;
            const mode = tc.args?.mode;
            const followPlayerName = tc.args?.followPlayerName;
            let followTargetId: string | null = null;

            if (mode === 'follow') {
              const targetPlayer = playerContexts.find(pc => pc.playerName?.toLowerCase() === followPlayerName?.toLowerCase())
                || Object.values(explorationPlayers).find(p => p.character?.name?.toLowerCase() === followPlayerName?.toLowerCase());
              followTargetId = targetPlayer?.socketId || primary.socketId;
            }

            if (npcId && setNpcFollowState(npcId, mode === 'follow' ? followTargetId : null)) {
              processedToolCalls.push({ name: tc.name, args: { ...tc.args, npcId, followPlayerName: followPlayerName || primary.playerName } });
            }
          } else if (tc.name === 'trigger_pvp_duel') {
            const targetName = tc.args?.targetPlayerName;
            const surprisedPlayerName = tc.args?.surprisedPlayerName;
            const openingStrikeDamage = typeof tc.args?.openingStrikeDamage === 'number' ? tc.args.openingStrikeDamage : undefined;
            // Find target player in exploration
            const target = Object.entries(explorationPlayers).find(([, p]) => 
              p.character?.name?.toLowerCase() === targetName?.toLowerCase()
            );
            if (target) {
              const [targetId, targetPlayer] = target;
              const surprisedTarget = surprisedPlayerName?.toLowerCase() === targetPlayer.character?.name?.toLowerCase() ? targetId : undefined;
              const startedMatch = startExplorationPvpBattle(primary.socketId, targetId, surprisedTarget, openingStrikeDamage);
              if (startedMatch) {
                processedToolCalls.push({
                  name: tc.name,
                  args: {
                    ...tc.args,
                    targetPlayerName: targetPlayer.character?.name || targetName,
                    surprisedPlayerName: surprisedTarget ? targetPlayer.character?.name || targetName : undefined,
                    openingStrikeDamage,
                  }
                });
              }
            }
          } else if (tc.name === 'trigger_combat') {
            const explicitNpcAllyIds = (() => {
              try {
                if (!tc.args?.npcAllyIds) return [];
                return typeof tc.args.npcAllyIds === 'string' ? JSON.parse(tc.args.npcAllyIds) : tc.args.npcAllyIds;
              } catch {
                return [];
              }
            })();

            const followerNpcIds = followingNpcs.map(npc => npc.id);
            const npcAllyIds = Array.from(new Set([...(explicitNpcAllyIds || []), ...followerNpcIds]));

            // Forward to client for processing (startBotMatch), always carrying current followers.
            console.log('[FollowerBattle][server] trigger_combat', {
              playerId: primary.socketId,
              enemyId: tc.args?.enemyId,
              npcAllyIds,
            });
            processedToolCalls.push({
              name: tc.name,
              args: {
                ...tc.args,
                npcAllyIds,
              },
            });
          } else {
            // update_player_state, update_goals — forward to client
            processedToolCalls.push({ name: tc.name, args: tc.args });
          }
        }

        // Send final result to ALL involved players
        for (const pc of playerContexts) {
          io.to(pc.socketId).emit("explorationActionResult", {
            requestId,
            text: fullText.trim(),
            thoughts: fullThoughts.trim(),
            toolCalls: processedToolCalls,
          });
        }

        return; // Success — exit retry loop

      } catch (error: any) {
        if (error.message === "Aborted") throw error;

        const errorInfo = classifyAIError(error);
        if (!errorInfo.retryable) {
          for (const pc of playerContexts) {
            io.to(pc.socketId).emit('explorationActionError', {
              requestId,
              message: formatAIError(errorInfo),
            });
          }
          throw error;
        }

        attempts++;
        const remainingMs = AI_RETRY_WINDOW_MS - (Date.now() - retryWindowStartedAt);
        if (remainingMs <= 0) {
          for (const pc of playerContexts) {
            io.to(pc.socketId).emit("explorationRetry", {
              requestId,
              attempt: attempts,
              delay: 0,
              label: errorInfo.label,
              statusCode: errorInfo.statusCode,
              statusText: errorInfo.statusText,
              restartAvailable: true,
            });
            io.to(pc.socketId).emit('explorationActionError', {
              requestId,
              message: `${errorInfo.label}. Retry window expired. Start a new 2-minute retry session when ready.`,
            });
          }
          return;
        }

        const delay = Math.min(
          getAIRetryDelaySeconds(attempts, errorInfo.suggestedRetrySeconds),
          Math.max(1, remainingMs / 1000),
        );
        // Notify players retrying
        for (const pc of playerContexts) {
          io.to(pc.socketId).emit("explorationRetry", {
            requestId,
            attempt: attempts,
            delay,
            label: errorInfo.label,
            statusCode: errorInfo.statusCode,
            statusText: errorInfo.statusText,
          });
        }
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        continue;
      }
    }
  }

  const buildSessionResumePayload = (socketId: string, explorationInterrupted = false) => {
    const roomId = players[socketId]?.room;
    const room = roomId ? rooms[roomId] : null;
    const explorationPlayer = explorationPlayers[socketId] as any;

    return {
      room: room ? {
        roomId,
        host: room.host,
        phase: room.phase || 'battle',
        players: room.players,
        mapState: room.mapState,
        isBotMatch: !!room.isBotMatch,
        isPvpExploration: !!room.isPvpExploration,
        history: Array.isArray(room.history) ? room.history : [],
        battleMediaLogs: Array.isArray(room.battleMediaLogs) ? room.battleMediaLogs : [],
        activeBattleStream: room.activeBattleStream && (room.activeBattleStream.thoughts || room.activeBattleStream.answer)
          ? room.activeBattleStream
          : null,
        battleRetryRestartAvailable: !!room.battleRetryRestartAvailable,
        turnTimerRemaining: room.unlimitedTurnTime
          ? null
          : roomTimers[roomId!]?.remaining ?? room.pausedTurnRemaining ?? null,
        arenaPreparation: getArenaPreparationSnapshot(roomId!),
        awaitingNextTurnReady: !!room.pendingReadyPlayers?.has(socketId),
        needsTurnResolution: room.phase === 'battle'
          && Object.keys(room.players || {}).length > 0
          && Object.keys(room.players || {}).every(playerId => !!room.players[playerId]?.lockedIn)
          && !room.pendingReadyPlayers,
      } : null,
      exploration: explorationPlayer ? {
        state: {
          ...(explorationPlayer._state || {}),
          locationId: explorationPlayer.locationId,
          subZoneId: explorationPlayer.subZoneId,
          x: explorationPlayer.x,
          y: explorationPlayer.y,
        },
        character: explorationPlayer.character,
        worldPlayers: getExplorationPlayersPayload(),
        npcStates: getExplorationNpcStatesPayload(),
        lockStatus: getExplorationLockStatusPayload(),
        interruptedAction: explorationInterrupted,
      } : null,
      queue: matchmakingQueue[socketId]
        ? {
            inQueue: true,
            players: Object.values(matchmakingQueue),
          }
        : null,
    };
  };

  const migrateSocketState = (oldSocketId: string, newSocketId: string, socket: any) => {
    if (matchmakingQueue[oldSocketId]) {
      matchmakingQueue[newSocketId] = {
        ...matchmakingQueue[oldSocketId],
        id: newSocketId,
      };
      delete matchmakingQueue[oldSocketId];
      socket.join("matchmaking_lobby");
    }

    if (players[oldSocketId]) {
      players[newSocketId] = { ...players[oldSocketId] };
      delete players[oldSocketId];
    }

    const roomId = players[newSocketId]?.room;
    const room = roomId ? rooms[roomId] : null;
    if (roomId && room?.players?.[oldSocketId]) {
      room.players[newSocketId] = room.players[oldSocketId];
      delete room.players[oldSocketId];

      if (room.host === oldSocketId) {
        room.host = newSocketId;
      }

      if (room.disconnectedParticipantIds instanceof Set) {
        room.disconnectedParticipantIds.delete(oldSocketId);
        if (room.disconnectedParticipantIds.size === 0) {
          delete room.disconnectedParticipantIds;
        }
      }

      if (room.pendingReadyPlayers instanceof Set && room.pendingReadyPlayers.has(oldSocketId)) {
        room.pendingReadyPlayers.delete(oldSocketId);
        room.pendingReadyPlayers.add(newSocketId);
      }

      if (room.mapState?.players) {
        room.mapState.players = room.mapState.players.map((player: any) => (
          player.id === oldSocketId ? { ...player, id: newSocketId } : player
        ));
      }

      syncArenaPreparationTimerPlayerId(arenaPreparationTimers[roomId], oldSocketId, newSocketId);
      syncArenaPreparationTimerPlayerId(room.pausedArenaPreparation, oldSocketId, newSocketId);
      socket.join(roomId);
    }

    if (explorationPlayers[oldSocketId]) {
      explorationPlayers[newSocketId] = {
        ...explorationPlayers[oldSocketId],
        socketId: newSocketId,
      };
      delete explorationPlayers[oldSocketId];
      socket.join("exploration_world");
    }

    if (explorationLockedActions[oldSocketId]) {
      explorationLockedActions[newSocketId] = explorationLockedActions[oldSocketId];
      delete explorationLockedActions[oldSocketId];
    }

    if (activeExplorationRequests[oldSocketId]) {
      delete activeExplorationRequests[oldSocketId];
    }

    for (const npc of Object.values(explorationNpcs)) {
      if (npc.followTargetId === oldSocketId) {
        npc.followTargetId = newSocketId;
      }
    }
  };

  const finalizeSocketDisconnect = (socketId: string, sessionId?: string) => {
    clearTypingForSocket(socketId);

    if (matchmakingQueue[socketId]) {
      delete matchmakingQueue[socketId];
      io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));
    }

    if (explorationPlayers[socketId]) {
      if (activeExplorationRequests[socketId]) {
        activeExplorationRequests[socketId].abort();
        delete activeExplorationRequests[socketId];
      }
      for (const npc of Object.values(explorationNpcs)) {
        if (npc.followTargetId === socketId) {
          setNpcFollowState(npc.id, null);
        }
      }
      delete explorationLockedActions[socketId];
      delete explorationPlayers[socketId];
      emitExplorationPlayersUpdated();
      emitExplorationNpcStatesUpdated();
      emitExplorationLockStatuses();
    }

    const roomId = players[socketId]?.room;
    if (roomId) {
      const room = rooms[roomId];
      clearRoomTimer(roomId);
      clearArenaPreparationTimer(roomId);
      if (room?.readyTimeout) {
        clearTimeout(room.readyTimeout);
        delete room.readyTimeout;
      }
      if (room) {
        io.to(roomId).emit("opponentDisconnected", {
          playerId: socketId,
          playerName: room.players?.[socketId]?.character?.name || 'Opponent',
        });
        delete rooms[roomId];
      }
    }

    delete players[socketId];
    delete socketSessionIds[socketId];
    if (sessionId && sessionSocketIds[sessionId] === socketId) {
      delete sessionSocketIds[sessionId];
    }
  };

  io.on("connection", (socket) => {
    const requestedSessionId = typeof socket.handshake.auth?.sessionId === 'string' && socket.handshake.auth.sessionId.trim()
      ? socket.handshake.auth.sessionId.trim()
      : `anon_${socket.id}`;
    socketSessionIds[socket.id] = requestedSessionId;
    sessionSocketIds[requestedSessionId] = socket.id;

    let reconnectContext = { explorationInterrupted: false };
    const pendingDisconnect = pendingDisconnects[requestedSessionId];
    if (pendingDisconnect?.socketId && pendingDisconnect.socketId !== socket.id) {
      clearTimeout(pendingDisconnect.timer);
      reconnectContext = { explorationInterrupted: pendingDisconnect.explorationInterrupted };
      delete pendingDisconnects[requestedSessionId];

      const oldSocketId = pendingDisconnect.socketId;
      migrateSocketState(oldSocketId, socket.id, socket);

      const roomId = players[socket.id]?.room;
      const room = roomId ? rooms[roomId] : null;
      if (roomId && room) {
        emitRoomPlayersUpdated(roomId);
        emitBattleMapState(roomId);
        socket.to(roomId).emit("participantConnectionState", {
          playerId: socket.id,
          previousPlayerId: oldSocketId,
          playerName: room.players?.[socket.id]?.character?.name || 'Opponent',
          state: 'rejoined',
        });
        resumeRoomAfterReconnect(roomId);

        const shouldReissueTurnResolution = room.phase === 'battle'
          && (
            room.awaitingTurnResolution
            || Object.keys(room.players || {}).every((playerId) => !!room.players[playerId]?.lockedIn)
          )
          && !room.pendingReadyPlayers
          && !room.battleRetryRestartAvailable;
        if (shouldReissueTurnResolution) {
          delete room.lastResolutionRequestAt;
          setTimeout(() => requestTurnResolutionIfReady(roomId, { reissue: true }), 250);
        }
      }

      if (explorationPlayers[socket.id]) {
        emitExplorationPlayersUpdated();
        emitExplorationNpcStatesUpdated();
        emitExplorationLockStatuses();
      }

      if (matchmakingQueue[socket.id]) {
        io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));
      }
    }

    console.log("User connected:", socket.id, { sessionId: requestedSessionId });

    socket.on("resumeSession", () => {
      const payload = buildSessionResumePayload(socket.id, reconnectContext.explorationInterrupted);
      logBattleServerDebug('session_resumed_emit', {
        socketId: socket.id,
        roomId: payload?.room?.roomId || null,
        historyCount: payload?.room?.history?.length || 0,
        mediaLogCount: payload?.room?.battleMediaLogs?.length || 0,
        turnTimerRemaining: payload?.room?.turnTimerRemaining ?? null,
      });
      socket.emit("sessionResumed", payload);
      reconnectContext = { explorationInterrupted: false };
    });

    socket.on("characterCreated", (state) => {
      const roomId = players[socket.id]?.room;
      const requestedPlayerId = typeof state?.playerId === 'string' ? state.playerId : socket.id;
      const normalizedState = { ...state, gold: typeof state?.gold === 'number' ? state.gold : 25 };
      delete normalizedState.playerId;

      const room = roomId ? rooms[roomId] : null;
      const targetPlayerId = room
        ? resolveControlledRoomPlayerId(room, socket.id, requestedPlayerId)
        : requestedPlayerId === socket.id
          ? socket.id
          : null;
      if (!targetPlayerId) return;

      if (targetPlayerId === socket.id) {
        players[socket.id] = { ...players[socket.id], character: normalizedState };
        if (explorationPlayers[socket.id]) {
          explorationPlayers[socket.id].character = normalizedState;
          emitExplorationPlayersUpdated();
        }
      }

      if (roomId && rooms[roomId]?.players?.[targetPlayerId]) {
        applyPreparationCharacterUpdate(roomId, targetPlayerId, normalizedState);
      }

      if (targetPlayerId === socket.id) {
        socket.emit("characterSaved", normalizedState);
        socket.emit("characterSynced");
      }
    });

    // Exploration events
    socket.on("enterExploration", (data) => {
      if (!players[socket.id]?.character) {
        socket.emit("error", "Create a character first.");
        return;
      }
      const spawnPoints = worldData?.meta?.spawnPoints || [];
      const spawn = spawnPoints[Math.floor(Math.random() * spawnPoints.length)] || { x: 5, y: 10, locationId: "driftwood_beach" };
      
      explorationPlayers[socket.id] = {
        socketId: socket.id,
        character: players[socket.id].character,
        locationId: spawn.locationId,
        subZoneId: null,
        x: spawn.x,
        y: spawn.y
      };
      (explorationPlayers[socket.id] as any)._state = {
        locationId: spawn.locationId,
        x: spawn.x,
        y: spawn.y,
        hunger: 100,
        thirst: 100,
        stamina: 100,
        inventory: {},
        discoveredLocations: [spawn.locationId],
        goals: ['Find a water source', 'Talk to a local', 'Gather some wood', 'Explore a new area', 'Craft your first tool'],
        equippedWeapon: null,
        equippedArmor: null,
      };
      
      socket.join("exploration_world");
      
      // Send initial state to the player
      socket.emit("explorationStarted", {
        locationId: spawn.locationId,
        x: spawn.x,
        y: spawn.y,
        worldPlayers: Object.values(explorationPlayers).map(p => ({
          id: p.socketId,
          name: p.character.name,
          locationId: p.locationId,
          x: p.x,
          y: p.y
        })),
        npcStates: Object.values(explorationNpcs).map(npc => ({
          id: npc.id,
          name: npc.name,
          role: npc.role,
          locationId: npc.locationId,
          subZoneId: npc.subZoneId,
          x: npc.x,
          y: npc.y,
          followTargetId: npc.followTargetId,
        }))
      });
      
      // Notify all explorers of the new player
      emitExplorationPlayersUpdated();
      emitExplorationNpcStatesUpdated();
      
      emitExplorationLockStatuses();
    });

    socket.on("moveToLocation", (data: { locationId: string }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      
      const location = worldData?.locations?.find((l: any) => l.id === data.locationId);
      if (!location) return;
      
      delete explorationLockedActions[socket.id];
      ep.locationId = data.locationId;
      ep.subZoneId = null;
      ep.x = location.x;
      ep.y = location.y;
      for (const npc of Object.values(explorationNpcs)) {
        if (npc.followTargetId === socket.id) {
          const offset = getNpcOffset(npc.id);
          npc.locationId = data.locationId;
          npc.subZoneId = null;
          npc.x = location.x + offset.x;
          npc.y = location.y + offset.y;
        }
      }
      
      socket.emit("playerMoved", { locationId: data.locationId, x: location.x, y: location.y });
      emitExplorationPlayersUpdated();
      emitExplorationNpcStatesUpdated();
      emitExplorationLockStatuses();
    });

    socket.on("battleMoveToLocation", (data: { roomId?: string; locationId: string }) => {
      const roomId = players[socket.id]?.room || data.roomId;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room?.mapState) return;

      const battlePlayer = room.mapState.players.find((player: BattleMapPlayerState) => player.id === socket.id);
      if (!battlePlayer) return;

      const currentLocation = worldData?.locations?.find((entry: any) => entry.id === battlePlayer.locationId);
      if (!currentLocation?.connections?.includes(data.locationId)) return;

      const nextLocation = worldData?.locations?.find((entry: any) => entry.id === data.locationId);
      if (!nextLocation) return;

      battlePlayer.locationId = nextLocation.id;
      battlePlayer.x = nextLocation.x;
      battlePlayer.y = nextLocation.y;
      room.mapState.discoveredLocations = expandBattleDiscoveredLocations([
        ...room.mapState.players.map((player: BattleMapPlayerState) => player.locationId),
        ...room.mapState.npcs.map((npc: BattleMapNpcState) => npc.locationId),
      ]);

      const opponentDistances = room.mapState.players
        .filter((player: BattleMapPlayerState) => player.id !== socket.id)
        .map((player: BattleMapPlayerState) => getLocationHopDistance(nextLocation.id, player.locationId))
        .filter((distance: number) => Number.isFinite(distance));
      const nearestOpponentDistance = opponentDistances.length > 0 ? Math.min(...opponentDistances) : Number.POSITIVE_INFINITY;
      const moverName = room.players[socket.id]?.character?.name || 'A fighter';
      const distanceLabel = nearestOpponentDistance === 0
        ? 'now shares the same ground as the opponent'
        : nearestOpponentDistance === 1
          ? 'is now one move away from the opponent'
          : Number.isFinite(nearestOpponentDistance)
            ? `is now ${nearestOpponentDistance} moves away from the opponent`
            : 'has an uncertain distance to the opponent';

      const movementLog = `🗺️ **${moverName}** repositions to **${nextLocation.name}** and ${distanceLabel}.`;
      appendRoomHistory(roomId, movementLog);
      io.to(roomId).emit('battleMapMovementLog', {
        log: movementLog,
      });
      emitBattleMapState(roomId);
    });

    socket.on("syncExplorationState", (data: { explorationState?: any; character?: any }) => {
      const ep = explorationPlayers[socket.id] as any;
      if (!ep) return;
      if (data.explorationState) {
        ep._state = data.explorationState;
      }
      if (data.character) {
        ep.character = { ...ep.character, ...data.character };
        players[socket.id] = { ...players[socket.id], character: { ...players[socket.id]?.character, ...data.character } };
        emitExplorationPlayersUpdated();
      }
    });

    socket.on("explorationActing", (data: { acting: boolean }) => {
      socket.to("exploration_world").emit("playerActing", { id: socket.id, acting: data.acting });
    });

    // Player chat in exploration — broadcast to nearby players (same island or within hearing range)
    socket.on("explorationChat", (data: { message: string }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      const charName = ep.character?.name || 'Unknown';
      // Broadcast to all players in same location or nearby (within ~5 grid units)
      for (const [id, player] of Object.entries(explorationPlayers)) {
        if (id === socket.id) continue;
        const dx = player.x - ep.x;
        const dy = player.y - ep.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= 8) {
          io.to(id).emit("explorationChatMessage", {
            fromId: socket.id,
            fromName: charName,
            message: data.message
          });
        }
      }
    });

    // Solo exploration action — client sends action + context, server makes AI call
    socket.on("explorationAction", (data: { action: string; apiKey: string; model: string; explorationState: any; recentLog: string[]; summary?: string }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      (ep as any)._state = data.explorationState;
      ep.character = { ...ep.character, gold: typeof ep.character?.gold === 'number' ? ep.character.gold : 25 };

      // Abort any existing request for this player
      if (activeExplorationRequests[socket.id]) {
        activeExplorationRequests[socket.id].abort();
      }
      const abortController = new AbortController();
      activeExplorationRequests[socket.id] = abortController;

      const apiKey = data.apiKey?.trim() || process.env.GEMINI_API_KEY || process.env.API_KEY || '';
      
      handleExplorationAI(
        io,
        data.action,
        [{
          socketId: socket.id,
          playerName: ep.character?.name || 'Unknown',
          locationId: ep.locationId,
          character: ep.character,
          explorationState: data.explorationState,
          recentLog: data.recentLog || [],
          summary: data.summary
        }],
        apiKey,
        data.model || 'gemini-3-flash-preview',
        abortController.signal,
        [{ playerId: socket.id, playerName: ep.character?.name || 'Unknown', action: data.action, locationId: ep.locationId }]
      ).finally(() => {
        delete activeExplorationRequests[socket.id];
      });
    });

    socket.on("explorationLockIn", (data: { action: string; apiKey?: string; model?: string; explorationState?: any; recentLog?: string[]; summary?: string }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      explorationLockedActions[socket.id] = data.action;
      
      // Store context for when all lock in
      (ep as any)._lockContext = {
        apiKey: data.apiKey,
        model: data.model,
        explorationState: data.explorationState,
        recentLog: data.recentLog,
        summary: data.summary
      };
      
      const allPlayers = Object.entries(explorationPlayers);
      emitExplorationLockStatuses();

      const allLockedIn = allPlayers.every(([id]) => !!explorationLockedActions[id]);
      console.log('[LOCK] Lock check:', allPlayers.map(([id]) => `${id.slice(0,6)}:${!!explorationLockedActions[id]}`).join(', '), '=> allLocked:', allLockedIn);
      if (allLockedIn) {
        // Collect all actions with player info
        const allActions = allPlayers.map(([id, p]) => ({
          playerId: id,
          playerName: p.character?.name || 'Unknown',
          action: explorationLockedActions[id],
          locationId: p.locationId
        }));

        // Notify all players that everyone locked in (show other players' actions)
        for (const [id] of allPlayers) {
          io.to(id).emit("explorationAllLockedIn", { 
            action: explorationLockedActions[id],
            allActions
          });
          delete explorationLockedActions[id];
        }
        emitExplorationLockStatuses();
        
        // Server makes the unified AI call
        const combinedAction = allActions.map(a => `[${a.playerName}]: ${a.action}`).join('\n');
        
        // Use first player's API key/model, build contexts for all
        const firstPlayer = allPlayers[0][1] as any;
        const lockCtx = firstPlayer._lockContext || {};
        const apiKey = lockCtx.apiKey?.trim() || process.env.GEMINI_API_KEY || process.env.API_KEY || '';
        
        const playerContexts = allPlayers.map(([id, p]) => {
          const ctx = (p as any)._lockContext || {};
          return {
            socketId: id,
            playerName: p.character?.name || 'Unknown',
            locationId: p.locationId,
            character: p.character,
            explorationState: ctx.explorationState || {},
            recentLog: ctx.recentLog || [],
            summary: ctx.summary
          };
        });

        // Abort any existing requests for these players
        for (const [id] of allPlayers) {
          if (activeExplorationRequests[id]) {
            activeExplorationRequests[id].abort();
          }
        }
        const abortController = new AbortController();
        for (const [id] of allPlayers) {
          activeExplorationRequests[id] = abortController;
        }

        handleExplorationAI(
          io,
          combinedAction,
          playerContexts,
          apiKey,
          lockCtx.model || 'gemini-3-flash-preview',
          abortController.signal,
          allActions
        ).finally(() => {
          for (const [id] of allPlayers) {
            delete activeExplorationRequests[id];
          }
        });
      }
    });

    socket.on("explorationUnlock", () => {
      delete explorationLockedActions[socket.id];
      emitExplorationLockStatuses();
    });

    socket.on("leaveExploration", () => {
      // Abort any active AI request for this player
      if (activeExplorationRequests[socket.id]) {
        activeExplorationRequests[socket.id].abort();
        delete activeExplorationRequests[socket.id];
      }

      for (const npc of Object.values(explorationNpcs)) {
        if (npc.followTargetId === socket.id) {
          setNpcFollowState(npc.id, null);
        }
      }
      
      delete explorationPlayers[socket.id];
      delete explorationLockedActions[socket.id];
      socket.leave("exploration_world");
      
      const remaining = Object.entries(explorationPlayers);
      emitExplorationPlayersUpdated();
      
      if (remaining.length === 0) {
        return;
      }

      emitExplorationLockStatuses();
    });

    socket.on("shareSceneImage", (data: { locationId: string; imageUrl: string; locationName: string }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      // Broadcast to all other players at the same location
      for (const [id, player] of Object.entries(explorationPlayers)) {
        if (id !== socket.id && player.locationId === data.locationId) {
          io.to(id).emit("sceneImageShared", {
            fromName: ep.character?.name || 'Someone',
            locationName: data.locationName,
            imageUrl: data.imageUrl,
          });
        }
      }
    });

    socket.on("shareBattleImage", (data: { roomId: string; imageUrl: string }) => {
      const p = players[socket.id];
      if (!p) return;
      const room = rooms[data.roomId];
      if (room?.battleImageSharedThisTurn) return;
      if (room) {
        room.battleImageSharedThisTurn = true;
      }
      const actorName = room?.players?.[socket.id]?.character?.name || p.character?.name || 'Someone';
      appendBattleMediaLogs(data.roomId, actorName, data.imageUrl);
      logBattleServerDebug('battle_image_shared', {
        roomId: data.roomId,
        socketId: socket.id,
        fromName: actorName,
        imageUrlLength: data.imageUrl?.length || 0,
      });
      io.to(data.roomId).emit("battleImageShared", {
        fromName: actorName,
        imageUrl: data.imageUrl,
      });
    });

    // PVP Challenge in exploration
    socket.on("challengePlayer", (data: { targetId: string }) => {
      const challenger = explorationPlayers[socket.id];
      const target = explorationPlayers[data.targetId];
      if (!challenger || !target) return;
      if (challenger.locationId !== target.locationId) {
        socket.emit("error", "Player is not at your location.");
        return;
      }
      // Notify the target
      const targetSocket = io.sockets.sockets.get(data.targetId);
      if (targetSocket) {
        targetSocket.emit("pvpChallengeReceived", {
          challengerId: socket.id,
          challengerName: challenger.character.name
        });
      }
    });

    socket.on("acceptPvpChallenge", (data: { challengerId: string }) => {
      const accepter = explorationPlayers[socket.id];
      const challenger = explorationPlayers[data.challengerId];
      if (!accepter || !challenger) return;

      // Remove both from exploration temporarily
      delete explorationPlayers[socket.id];
      delete explorationPlayers[data.challengerId];
      clearTypingForSocket(socket.id);
      clearTypingForSocket(data.challengerId);

      const roomId = `pvp_room_${socket.id}_${data.challengerId}`;
      
      rooms[roomId] = {
        id: roomId,
        host: data.challengerId,
        isBotMatch: false,
        isPvpExploration: true,
        phase: 'battle',
        unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
        battleTurnSeconds: TURN_TIMER_SECONDS,
        players: {
          [data.challengerId]: { lockedIn: false, action: "", character: challenger.character },
          [socket.id]: { lockedIn: false, action: "", character: accepter.character },
        },
        history: ['**Match Found!** The battle begins.'],
        battleMediaLogs: [],
      };

      const challengerSocket = io.sockets.sockets.get(data.challengerId);
      if (challengerSocket) {
        challengerSocket.join(roomId);
        players[data.challengerId] = { ...players[data.challengerId], room: roomId };
      }
      socket.join(roomId);
      players[socket.id] = { ...players[socket.id], room: roomId };

      io.to(roomId).emit("matchFound", {
        roomId,
        players: rooms[roomId].players,
        isBotMatch: false,
        isPvpExploration: true,
      });
      startRoomTimer(roomId);
    });

    socket.on("declinePvpChallenge", (data: { challengerId: string }) => {
      const challengerSocket = io.sockets.sockets.get(data.challengerId);
      if (challengerSocket) {
        challengerSocket.emit("pvpChallengeDeclined", { declinedBy: explorationPlayers[socket.id]?.character?.name || 'Player' });
      }
    });

    socket.on("startBotMatch", (data) => {
      const difficulty = data.difficulty || 'Medium';
      const botProfile = data.botProfile || `## Bot Profile\n\n**Class:** Automaton\n\n**Difficulty:** ${difficulty}\n\n**Abilities:**\n- Basic Attack\n- Defend\n\n**Inventory:**\n- Health Potion`;
      const botName = data.botName || `Bot (${difficulty})`;

      if (!players[socket.id]?.character) {
        socket.emit("error", "Create a character first.");
        return;
      }

      const roomId = `bot_room_${socket.id}`;
      const botId = `bot_${socket.id}`;

      const botCharacter = {
        name: botName,
        hp: 100,
        maxHp: 100,
        mana: 50,
        maxMana: 50,
        profileMarkdown: botProfile
      };

      const roomPlayers: Record<string, any> = {
        [socket.id]: { lockedIn: false, action: "", character: players[socket.id].character },
        [botId]: { lockedIn: false, action: "", character: botCharacter },
      };

      // Add explicit NPC allies from the client plus any NPCs currently following this player in exploration.
      const explicitNpcAllies = Array.isArray(data.npcAllies) ? data.npcAllies : [];
      const followingNpcAllies = Object.values(explorationNpcs)
        .filter((npc) => npc.followTargetId === socket.id)
        .map((npc) => {
          const npcProfile = worldData?.npcs?.[npc.id];
          return {
            id: npc.id,
            name: npc.name,
            hp: npcProfile?.hp || 60,
            mana: npcProfile?.mana || 40,
            profileMarkdown: npcProfile?.profileMarkdown || `# ${npc.name}`,
          };
        });
      const npcAlliesById = new Map<string, any>();
      for (const npc of [...explicitNpcAllies, ...followingNpcAllies]) {
        if (!npc?.id) continue;
        npcAlliesById.set(npc.id, npc);
      }
      const npcAllies = Array.from(npcAlliesById.values());
      console.log('[FollowerBattle][server] startBotMatch ally merge', {
        socketId: socket.id,
        explicitNpcAllies: explicitNpcAllies.map((npc: any) => npc?.id),
        followingNpcAllies: followingNpcAllies.map((npc) => npc.id),
        mergedNpcAllies: npcAllies.map((npc: any) => npc.id),
      });

      for (const npc of npcAllies) {
        const npcId = `npc_ally_${npc.id}`;
        roomPlayers[npcId] = {
          lockedIn: false,
          action: "",
          character: {
            name: npc.name,
            hp: npc.hp || 60,
            maxHp: npc.hp || 60,
            mana: npc.mana || 40,
            maxMana: npc.mana || 40,
            profileMarkdown: npc.profileMarkdown,
            isNpcAlly: true
          }
        };
      }

      rooms[roomId] = {
        id: roomId,
        host: socket.id,
        apiKey: typeof data?.apiKey === 'string' ? data.apiKey.trim() : '',
        isBotMatch: true,
        botCharacterId: data.botCharacterId || null,
        unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
        arenaPreviewSeconds: typeof data.arenaPreviewSeconds === 'number' ? data.arenaPreviewSeconds : ARENA_PREVIEW_SECONDS,
        arenaTweakSeconds: typeof data.arenaTweakSeconds === 'number' ? data.arenaTweakSeconds : ARENA_TWEAK_SECONDS,
        battleTurnSeconds: typeof data.battleTurnSeconds === 'number' ? data.battleTurnSeconds : TURN_TIMER_SECONDS,
        botDifficulty: difficulty,
        npcAllyIds: npcAllies.map((n: any) => `npc_ally_${n.id}`),
        players: roomPlayers,
        mapState: buildArenaBattleMapState(roomPlayers),
        phase: 'preview',
        history: [],
        battleMediaLogs: [],
        modelSettings: data.modelSettings || null,
      };

      socket.join(roomId);
      players[socket.id].room = roomId;

      startArenaPreparation(roomId);
    });

    socket.on("attachNpcAlliesToBattle", (data: { npcIds?: string[] }) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room?.isBotMatch || room.host !== socket.id) return;

      const requestedNpcIds = Array.isArray(data?.npcIds) ? data.npcIds : [];
      let attachedAny = false;

      for (const npcId of requestedNpcIds) {
        const resolvedNpcByName = Object.values(worldData?.npcs || {}).find((npc: any) => npc?.name?.toLowerCase() === String(npcId || '').toLowerCase()) as any;
        const canonicalNpcId = worldData?.npcs?.[npcId]?.id || resolvedNpcByName?.id;
        if (!canonicalNpcId) continue;

        const roomNpcId = `npc_ally_${canonicalNpcId}`;
        if (room.players[roomNpcId]) continue;

        const npcProfile: any = worldData?.npcs?.[canonicalNpcId];
        if (!npcProfile) continue;

        room.players[roomNpcId] = {
          lockedIn: false,
          action: "",
          character: {
            name: npcProfile.name,
            hp: npcProfile.hp || 60,
            maxHp: npcProfile.hp || 60,
            mana: npcProfile.mana || 40,
            maxMana: npcProfile.mana || 40,
            profileMarkdown: npcProfile.profileMarkdown,
            isNpcAlly: true,
          },
        };
        room.npcAllyIds = Array.from(new Set([...(room.npcAllyIds || []), roomNpcId]));
        attachedAny = true;
      }

      if (!attachedAny) return;

      room.mapState = buildArenaBattleMapState(room.players);
      console.log('[FollowerBattle][server] attached missing battle allies', {
        roomId,
        socketId: socket.id,
        npcAllyIds: room.npcAllyIds,
      });
      emitRoomPlayersUpdated(roomId);
      emitBattleMapState(roomId);
    });

    socket.on("enterArena", (data?: { apiKey?: string; unlimitedTurnTime?: boolean; arenaPreviewSeconds?: number; arenaTweakSeconds?: number; battleTurnSeconds?: number; modelSettings?: { charModel?: string; explorationModel?: string; battleModel?: string; botModel?: string } | null }) => {
      if (!players[socket.id]?.character) {
        socket.emit("error", "Create a character first.");
        return;
      }

      matchmakingQueue[socket.id] = {
        id: socket.id,
        character: players[socket.id].character,
        isReady: false,
        apiKey: typeof data?.apiKey === 'string' ? data.apiKey.trim() : '',
        unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
        arenaPreviewSeconds: typeof data?.arenaPreviewSeconds === 'number' ? data.arenaPreviewSeconds : undefined,
        arenaTweakSeconds: typeof data?.arenaTweakSeconds === 'number' ? data.arenaTweakSeconds : undefined,
        battleTurnSeconds: typeof data?.battleTurnSeconds === 'number' ? data.battleTurnSeconds : undefined,
        modelSettings: data?.modelSettings || null,
      };
      socket.join("matchmaking_lobby");
      io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));
      socket.emit("waitingForOpponent");
    });

    socket.on("lockInQueue", () => {
      if (matchmakingQueue[socket.id]) {
        matchmakingQueue[socket.id].isReady = true;
        io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));

        const queueList = Object.values(matchmakingQueue);
        const allReady = queueList.length >= 2 && queueList.every(p => p.isReady);

        if (allReady) {
          const roomId = "room_" + Math.random().toString(36).substring(2, 9);
          const roomPlayers: Record<string, any> = {};
          
          queueList.forEach(p => {
            roomPlayers[p.id] = { lockedIn: false, action: "", character: p.character };
            const pSocket = io.sockets.sockets.get(p.id);
            if (pSocket) {
              pSocket.leave("matchmaking_lobby");
              pSocket.join(roomId);
              players[p.id].room = roomId;
            }
          });

          rooms[roomId] = {
            id: roomId,
            host: queueList[0].id,
            apiKey: queueList.find(p => typeof p.apiKey === 'string' && p.apiKey.trim())?.apiKey?.trim() || '',
            players: roomPlayers,
            unlimitedTurnTime: ALWAYS_UNLIMITED_TURN_TIME,
            arenaPreviewSeconds: queueList.find(p => typeof p.arenaPreviewSeconds === 'number')?.arenaPreviewSeconds ?? ARENA_PREVIEW_SECONDS,
            arenaTweakSeconds: queueList.find(p => typeof p.arenaTweakSeconds === 'number')?.arenaTweakSeconds ?? ARENA_TWEAK_SECONDS,
            battleTurnSeconds: queueList.find(p => typeof p.battleTurnSeconds === 'number')?.battleTurnSeconds ?? TURN_TIMER_SECONDS,
            isBotMatch: false,
            mapState: buildArenaBattleMapState(roomPlayers),
            phase: 'preview',
            history: [],
            battleMediaLogs: [],
            modelSettings: queueList[0].modelSettings || null,
          };

          startArenaPreparation(roomId);

          matchmakingQueue = {}; // Clear queue
        }
      }
    });

    socket.on("leaveQueue", () => {
      clearTypingForSocket(socket.id);
      if (matchmakingQueue[socket.id]) {
        delete matchmakingQueue[socket.id];
        socket.leave("matchmaking_lobby");
        io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));
      }
    });

    socket.on("typing", (data?: { isTyping?: boolean }) => {
      setTypingForSocket(socket.id, data?.isTyping !== false);
    });

    socket.on("passArenaPreparation", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room || !room.players[socket.id] || (room.phase !== 'tweak' && !room.players[socket.id].prepSkippedPreview)) return;

      clearTypingForSocket(socket.id);
      lockArenaPreparationPlayer(roomId, socket.id);
    });

    socket.on("skipArenaPreparationPreview", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      const timer = arenaPreparationTimers[roomId];
      if (!room || !timer || room.phase !== 'preview' || timer.stage !== 'preview' || !room.players[socket.id]) return;

      const participantIds = getArenaPreparationParticipantIds(room);
      if (!participantIds.includes(socket.id)) return;

      if (!timer.skipVotes.includes(socket.id)) {
        timer.skipVotes.push(socket.id);
      }

      room.players[socket.id].prepSkippedPreview = true;
      emitRoomPlayersUpdated(roomId);

      const allReadyToSkip = participantIds.length > 0 && participantIds.every(playerId => timer.skipVotes.includes(playerId));
      if (allReadyToSkip) {
        startArenaPreparationTweakStage(roomId);
        return;
      }

      emitArenaPreparationState(roomId);
    });

    socket.on("prepTimerPause", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const timer = arenaPreparationTimers[roomId];
      if (!timer || timer.stage !== 'tweak') return;
      timer.playerPaused[socket.id] = true;
    });

    socket.on("prepTimerResume", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const timer = arenaPreparationTimers[roomId];
      if (!timer || timer.stage !== 'tweak') return;
      timer.playerPaused[socket.id] = false;
    });

    socket.on("updateBotPreparationProfile", async (data: { roomId?: string; botId: string; profileMarkdown: string }) => {
      const roomId = players[socket.id]?.room || data.roomId;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room?.isBotMatch || (room.phase !== 'tweak' && !room.players?.[data.botId]?.prepSkippedPreview)) return;

      const botPlayer = room.players[data.botId];
      if (!botPlayer?.character || typeof data.profileMarkdown !== 'string' || !data.profileMarkdown.trim()) return;

      const newProfile = data.profileMarkdown.trim();

      applyPreparationCharacterUpdate(roomId, data.botId, {
        ...botPlayer.character,
        profileMarkdown: newProfile,
      });

      // Persist rewritten bot profile to MongoDB
      if (db && room.botCharacterId) {
        try {
          await db.collection("bot_characters").updateOne(
            { _id: room.botCharacterId as any },
            { $set: { content: newProfile, updatedAt: new Date() } }
          );
        } catch (e) {
          console.error("Failed to persist bot rewrite:", e);
        }
      }
    });

    socket.on("botAction", (data) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || !room.isBotMatch) return;

      const botId = Object.keys(room.players).find(playerId => playerId.startsWith('bot_'));
      if (!botId) return;
      applyPlayerLockedAction(roomId, botId, data.action);
      autoLockPendingNpcAllies(roomId, room, data?.npcActions);
    });

    socket.on("updateRoomSettings", (data: { charModel?: string; explorationModel?: string; battleModel?: string; botModel?: string }) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || room.host !== socket.id) return;
      const validModels = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
      const sanitized: Record<string, string> = {};
      for (const key of ['charModel', 'explorationModel', 'battleModel', 'botModel'] as const) {
        const val = (data as any)[key];
        if (typeof val === 'string' && validModels.includes(val)) sanitized[key] = val;
      }
      room.modelSettings = { ...(room.modelSettings || {}), ...sanitized };
      io.to(roomId).emit('roomSettingsUpdated', room.modelSettings);
    });

    socket.on("battleRetryStatus", (data: { attempt: number; label?: string; delay?: number; statusCode?: number; statusText?: string }) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      io.to(roomId).emit("battleRetryStatus", data);
    });

    socket.on('restartBattleRetryWindow', () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room?.awaitingTurnResolution || !room.battleRetryRestartAvailable || room.battleResolutionTaskActive) return;

      room.battleRetryWindowStartedAt = Date.now();
      room.battleRetryRestartAvailable = false;
      delete room.lastResolutionRequestAt;
      io.to(roomId).emit('battleRetryStatus', { attempt: 0, restartAvailable: false });
      void runBattleTurnResolution(roomId, { reissue: true });
    });

    socket.on("playerAction", (payload) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room) return;

      const actionText = typeof payload === 'string' ? payload : payload?.action;
      if (typeof actionText !== 'string' || !actionText.trim()) return;

      const requestedPlayerId = typeof payload === 'object' && typeof payload?.playerId === 'string'
        ? payload.playerId
        : socket.id;
      const targetPlayerId = resolveControlledRoomPlayerId(room, socket.id, requestedPlayerId);
      if (!targetPlayerId) return;

      if (targetPlayerId.startsWith('npc_ally_')) {
        console.log('[FollowerBattle][server] npc ally action received', {
          roomId,
          requesterId: socket.id,
          npcId: targetPlayerId,
          action: actionText.trim(),
        });
      }

      applyPlayerLockedAction(roomId, targetPlayerId, actionText.trim(), {
        emitNpcAction: targetPlayerId.startsWith('npc_ally_'),
      });

      if (room.isBotMatch && targetPlayerId.startsWith('bot_')) {
        autoLockPendingNpcAllies(roomId, room, payload?.npcActions);
      }
    });

    socket.on("playerUnlock", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room) return;

      room.players[socket.id].lockedIn = false;
  room.players[socket.id].autoLockedThisTurn = false;
      io.to(roomId).emit("playerUnlocked", socket.id);
      startRoomTimer(roomId);
    });

    socket.on("readyForNextTurn", () => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room?.pendingReadyPlayers) return;
      const pendingBefore = Array.from(room.pendingReadyPlayers);
      room.pendingReadyPlayers.delete(socket.id);
      // For bot matches, also mark autonomous combatants as ready
      for (const pid of Object.keys(room.players)) {
        if (pid.startsWith('bot_') || pid.startsWith('npc_ally_')) room.pendingReadyPlayers.delete(pid);
      }
      const pendingAfter = Array.from(room.pendingReadyPlayers);
      logBattleServerDebug('ready_for_next_turn_received', {
        roomId,
        socketId: socket.id,
        pendingBefore,
        pendingAfter,
      });
      if (room.pendingReadyPlayers.size === 0) {
        if (room.readyTimeout) { clearTimeout(room.readyTimeout); delete room.readyTimeout; }
        delete room.pendingReadyPlayers;
        logBattleServerDebug('ready_for_next_turn_all_ready', {
          roomId,
          socketId: socket.id,
        });
        startRoomTimer(roomId);
      }
    });

    socket.on("battleZonesSetup", (data: { zones: any[]; combatantZones: Record<string, string> }) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room?.mapState) return;
      room.mapState.zones = data.zones;
      room.mapState.combatantZones = data.combatantZones;
      emitBattleMapState(roomId);
    });

    socket.on("submitTurnResolution", (data) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room || !room.awaitingTurnResolution || room.battleResolutionTaskActive) return;

      applyTurnResolution(roomId, data || {});
    });

    socket.on("streamTurnResolutionStart", () => {
      const roomId = players[socket.id]?.room;
      if (roomId) {
        const room = rooms[roomId];
        if (room) {
          room.activeBattleStream = { thoughts: '', answer: '' };
        }
        io.to(roomId).emit("streamTurnResolutionStart");
      }
    });

    socket.on("streamTurnResolutionChunk", (data) => {
      const roomId = players[socket.id]?.room;
      if (roomId) {
        const room = rooms[roomId];
        if (room) {
          if (!room.activeBattleStream) {
            room.activeBattleStream = { thoughts: '', answer: '' };
          }
          const isRefresh = typeof data?.text === 'string' && data.text.startsWith('REFRESH:');
          const text = isRefresh ? String(data.text).slice('REFRESH:'.length) : String(data?.text || '');
          if (data?.type === 'thought') {
            room.activeBattleStream.thoughts = isRefresh ? text : `${room.activeBattleStream.thoughts || ''}${text}`;
          } else if (data?.type === 'answer') {
            room.activeBattleStream.answer = isRefresh ? text : `${room.activeBattleStream.answer || ''}${text}`;
          }
        }
        io.to(roomId).emit("streamTurnResolutionChunk", data);
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      const sessionId = socketSessionIds[socket.id];
      if (sessionId && sessionSocketIds[sessionId] === socket.id) {
        delete sessionSocketIds[sessionId];
      }

      const roomId = players[socket.id]?.room;
      const room = roomId ? rooms[roomId] : null;
      const queueState = !!matchmakingQueue[socket.id];
      const hasExplorationState = !!explorationPlayers[socket.id];
      const hasResumableRoomState = !!room;
      let explorationInterrupted = false;

      if (activeExplorationRequests[socket.id]) {
        activeExplorationRequests[socket.id].abort();
        delete activeExplorationRequests[socket.id];
        explorationInterrupted = true;
      }

      if (roomId && hasResumableRoomState) {
        if (!(room.disconnectedParticipantIds instanceof Set)) {
          room.disconnectedParticipantIds = new Set<string>();
        }
        room.disconnectedParticipantIds.add(socket.id);
        pauseRoomForReconnect(roomId);
        socket.to(roomId).emit("participantConnectionState", {
          playerId: socket.id,
          playerName: room.players?.[socket.id]?.character?.name || 'Opponent',
          state: 'reconnecting',
          graceSeconds: Math.floor(SESSION_RECONNECT_GRACE_MS / 1000),
        });
      }

      const shouldHoldForReconnect = !!sessionId && (queueState || hasExplorationState || hasResumableRoomState);
      if (!shouldHoldForReconnect) {
        finalizeSocketDisconnect(socket.id, sessionId);
        return;
      }

      if (pendingDisconnects[sessionId]) {
        clearTimeout(pendingDisconnects[sessionId].timer);
      }

      pendingDisconnects[sessionId] = {
        socketId: socket.id,
        explorationInterrupted,
        timer: setTimeout(() => {
          const pending = pendingDisconnects[sessionId];
          if (!pending || pending.socketId !== socket.id) {
            return;
          }
          delete pendingDisconnects[sessionId];
          finalizeSocketDisconnect(socket.id, sessionId);
        }, SESSION_RECONNECT_GRACE_MS),
      };
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
