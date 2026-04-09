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
const JWT_SECRET = process.env.JWT_SECRET || "arena-clash-secret-key-change-in-prod";

function getPrompt(filename: string) {
  return fs.readFileSync(path.join(process.cwd(), "prompts", filename), "utf8");
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
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
      db = mongoClient.db("arena_clash");
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

  app.get("/api/bot_characters", (req, res) => {
    try {
      const files = fs.readdirSync(botCharsDir).filter(f => f.endsWith('.md'));
      const chars = files.map(f => {
        const content = fs.readFileSync(path.join(botCharsDir, f), "utf-8");
        const nameMatch = content.match(/^#\s+(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim() : f.replace('.md', '');
        return { id: f, name, content };
      });
      res.json(chars);
    } catch (e) {
      res.status(500).json({ error: "Failed to load bot characters" });
    }
  });

  app.post("/api/bot_characters", (req, res) => {
    try {
      const { name, content } = req.body;
      if (!name || !content) return res.status(400).json({ error: "Missing name or content" });
      const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.md';
      fs.writeFileSync(path.join(botCharsDir, filename), content);
      res.json({ id: filename, name, content });
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
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return res.status(401).json({ error: "Invalid credentials" });
      
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
      res.json(settings?.data || {});
    } catch (e) {
      res.json({});
    }
  });

  app.post("/api/settings", authenticateToken, async (req: any, res) => {
    if (!db) return res.status(503).json({ error: "Database not available" });
    try {
      const allowedKeys = ['unlimitedTurnTime', 'arenaPreviewSeconds', 'arenaTweakSeconds'];
      const data: Record<string, any> = {};
      for (const key of allowedKeys) {
        if (req.body[key] !== undefined) data[key] = req.body[key];
      }
      await db.collection("settings").updateOne(
        { _id: "global" as any },
        { $set: { data, updatedAt: new Date() } },
        { upsert: true }
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // Socket.io logic
  interface QueuePlayer {
    id: string;
    character: any;
    isReady: boolean;
    unlimitedTurnTime?: boolean;
    arenaPreviewSeconds?: number;
    arenaTweakSeconds?: number;
  }
  let matchmakingQueue: Record<string, QueuePlayer> = {};
  const rooms: Record<string, any> = {};
  const roomTimers: Record<string, { interval: NodeJS.Timeout; remaining: number }> = {};
  const arenaPreparationTimers: Record<string, { interval: NodeJS.Timeout; stage: 'preview' | 'tweak'; remaining: number; skipVotes: string[] }> = {};
  const typingChannelMembers: Record<string, Set<string>> = {};
  const typingChannelBySocket: Record<string, string> = {};
  const typingTimeouts: Record<string, NodeJS.Timeout> = {};
  const TURN_TIMER_SECONDS = 60;
  const ARENA_PREVIEW_SECONDS = 15;
  const ARENA_TWEAK_SECONDS = 120;

  function startRoomTimer(roomId: string) {
    clearRoomTimer(roomId);
    const room = rooms[roomId];
    if (!room) return;

    if (room.unlimitedTurnTime) {
      io.to(roomId).emit("turnTimerTick", { remaining: null });
      return;
    }

    roomTimers[roomId] = { interval: null as any, remaining: TURN_TIMER_SECONDS };

    io.to(roomId).emit("turnTimerTick", { remaining: TURN_TIMER_SECONDS });

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

  function emitBattleActionsSubmitted(roomId: string, room: { players: Record<string, any> }) {
    const log = Object.keys(room.players)
      .map(pid => `**${room.players[pid].character.name}:** ${room.players[pid].action}`)
      .join("\n\n");

    io.to(roomId).emit("battleActionsSubmitted", { log: `PLAYER_ACTIONS_${log}` });
  }

  function endBattleDueToInactivity(roomId: string, room: { players: Record<string, any> }) {
    clearRoomTimer(roomId);
    io.to(roomId).emit("battleEndedByInactivity", {
      log: "**BATTLE ENDED.** Both fighters missed the turn, so the duel is called off.",
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
        io.to(roomId).emit("playerLockedIn", pid);
        io.to(roomId).emit("turnTimerAutoLocked", { playerId: pid, playerName: room.players[pid].character.name });
        anyAutoLocked = true;
      }
    }

    if (anyAutoLocked) {
      const allLockedIn = playerIds.every((id) => room.players[id].lockedIn);
      if (allLockedIn) {
        emitBattleActionsSubmitted(roomId, room);
        const everyoneMissedTurn = playerIds.every((id) => room.players[id].autoLockedThisTurn);
        if (everyoneMissedTurn) {
          endBattleDueToInactivity(roomId, room);
          return;
        }
        io.to(room.host).emit("requestTurnResolution", room);
      }
    }
  }

  const players: Record<string, any> = {};
  // Exploration: track players in the world
  const explorationPlayers: Record<string, { socketId: string; character: any; locationId: string; x: number; y: number }> = {};
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
  }

  const emitExplorationPlayersUpdated = () => {
    io.to("exploration_world").emit(
      "explorationPlayersUpdated",
      Object.values(explorationPlayers).map(p => ({
        id: p.socketId,
        name: p.character.name,
        locationId: p.locationId,
        x: p.x,
        y: p.y,
      }))
    );
  };

  const emitExplorationLockStatuses = () => {
    const allPlayers = Object.entries(explorationPlayers);
    if (allPlayers.length <= 1) {
      io.to("exploration_world").emit("explorationLockStatus", []);
      return;
    }

    io.to("exploration_world").emit(
      "explorationLockStatus",
      allPlayers.map(([id, player]) => ({
        id,
        name: player.character?.name || 'Unknown',
        lockedIn: !!explorationLockedActions[id],
      }))
    );
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
        homeLocationId: location.id,
        x: location.x + offset.x,
        y: location.y + offset.y,
        followTargetId: null,
      };
    }
    return npcStates;
  };

  const explorationNpcs: Record<string, ExplorationNpcState> = createExplorationNpcStates();

  const emitExplorationNpcStatesUpdated = () => {
    io.to("exploration_world").emit("explorationNpcStatesUpdated", Object.values(explorationNpcs).map(npc => ({
      id: npc.id,
      name: npc.name,
      role: npc.role,
      locationId: npc.locationId,
      x: npc.x,
      y: npc.y,
      followTargetId: npc.followTargetId,
    })));
  };

  const setNpcFollowState = (npcId: string, followTargetId: string | null) => {
    const npc = explorationNpcs[npcId];
    if (!npc) return false;

    npc.followTargetId = followTargetId;
    if (followTargetId && explorationPlayers[followTargetId]) {
      const target = explorationPlayers[followTargetId];
      const offset = getNpcOffset(npcId);
      npc.locationId = target.locationId;
      npc.x = target.x + offset.x;
      npc.y = target.y + offset.y;
    } else {
      const homeLocation = worldData?.locations?.find((loc: any) => loc.id === npc.homeLocationId);
      const offset = getNpcOffset(npcId);
      if (homeLocation) {
        npc.locationId = homeLocation.id;
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
    };
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
    clearInterval(timer.interval);
    delete arenaPreparationTimers[roomId];
  };

  const emitRoomPlayersUpdated = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('roomPlayersUpdated', {
      players: room.players,
      phase: room.phase || 'battle',
    });
  };

  const emitArenaPreparationState = (roomId: string) => {
    const room = rooms[roomId];
    const timer = arenaPreparationTimers[roomId];
    if (!room || !timer) return;

    io.to(roomId).emit('arenaPreparationState', {
      roomId,
      players: room.players,
      isBotMatch: !!room.isBotMatch,
      stage: timer.stage,
      remaining: timer.remaining,
      skipVotes: timer.skipVotes,
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
      startBattleRoom(roomId);
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
    if (requestedPlayerId.startsWith('bot_')) return requestedPlayerId;
    return null;
  };

  const applyPreparationCharacterUpdate = (roomId: string, playerId: string, normalizedState: any) => {
    const room = rooms[roomId];
    if (!room?.players?.[playerId] || room.phase === 'battle') return;

    room.players[playerId].character = normalizedState;
    if (room.phase === 'tweak' || room.players[playerId].prepSkippedPreview) {
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
    io.to(roomId).emit("playerLockedIn", playerId);

    if (options?.emitNpcAction) {
      io.to(roomId).emit("npcAllyAction", {
        npcId: playerId,
        npcName: room.players[playerId].character?.name || 'NPC Ally',
        action: actionText,
      });
    }

    const playerIds = Object.keys(room.players);
    const allLockedIn = playerIds.every((id) => room.players[id].lockedIn);
    if (allLockedIn) {
      clearRoomTimer(roomId);
      emitBattleActionsSubmitted(roomId, room);
      io.to(room.host).emit("requestTurnResolution", room);
    }
  };

  const startArenaPreparationTweakStage = (roomId: string) => {
    const room = rooms[roomId];
    const timer = arenaPreparationTimers[roomId];
    if (!room || !timer) return;

    timer.stage = 'tweak';
    const tweakDuration = (typeof room.arenaTweakSeconds === 'number' && room.arenaTweakSeconds >= 1) ? room.arenaTweakSeconds : ARENA_TWEAK_SECONDS;
    timer.remaining = tweakDuration;
    timer.skipVotes = [];
    room.phase = 'tweak';
    for (const playerId of Object.keys(room.players)) {
      room.players[playerId].lockedIn = !!room.players[playerId].lockedIn || !!room.players[playerId]?.character?.isNpcAlly;
      room.players[playerId].prepSkippedPreview = true;
    }
    emitRoomPlayersUpdated(roomId);
    maybeAdvanceArenaPreparation(roomId);
    emitArenaPreparationState(roomId);
  };

  const startBattleRoom = (roomId: string) => {
    const room = rooms[roomId];
    if (!room) return;

    clearArenaPreparationTimer(roomId);
    room.phase = 'battle';
    for (const playerId of Object.keys(room.players)) {
      room.players[playerId].lockedIn = false;
      room.players[playerId].action = "";
      room.players[playerId].autoLockedThisTurn = false;
      room.players[playerId].prepSkippedPreview = false;
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
      interval: null as any,
      stage: 'preview',
      remaining: previewDuration,
      skipVotes: [],
    };

    emitArenaPreparationState(roomId);

    arenaPreparationTimers[roomId].interval = setInterval(() => {
      const timer = arenaPreparationTimers[roomId];
      const activeRoom = rooms[roomId];
      if (!timer || !activeRoom) return;

      timer.remaining -= 1;

      if (timer.remaining <= 0) {
        if (timer.stage === 'preview') {
          startArenaPreparationTweakStage(roomId);
          return;
        }

        startBattleRoom(roomId);
        return;
      }

      emitArenaPreparationState(roomId);
    }, 1000);
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
      players: {
        [challengerId]: { lockedIn: false, action: "", character: challengerCharacter },
        [targetId]: { lockedIn: false, action: "", character: targetCharacter },
      },
      history: [],
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
    playerContexts: { socketId: string; playerName: string; locationId: string; character: any; explorationState: any; recentLog: string[] }[],
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

    const worldContext = `
CURRENT LOCATION: ${currentLoc?.name || 'Unknown'} (${currentLoc?.id})
DESCRIPTION: ${currentLoc?.description || ''}
TYPE: ${currentLoc?.type || ''}
AVAILABLE RESOURCES: ${currentLoc?.resources?.join(', ') || 'none'}
EXITS: ${connectedLocs.map((l: any) => `${l.name} (${l.id})`).join(', ')}
NPCs HERE: ${npcsAtLocation.map((n: any) => `${n?.name} - ${n?.role}`).join(', ') || 'none'}
ENEMIES HERE: ${enemiesAtLocation.map((e: any) => `${e?.name} (HP:${e?.hp}, DMG:${e?.damage})`).join(', ') || 'none'}
OTHER PLAYERS HERE: ${[...otherPlayersHere, ...playerContexts.slice(1).map(p => p.playerName)].join(', ') || 'none'}

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
    const prompt = `${worldContext}\n\nRECENT CONVERSATION:\n${recentLog}\n\nPLAYER ACTION: ${action}`;

    const apiConfig = {
      model,
      contents: prompt,
      config: {
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
                ep.x = loc.x;
                ep.y = loc.y;
                for (const npc of Object.values(explorationNpcs)) {
                  if (npc.followTargetId === primary.socketId) {
                    const offset = getNpcOffset(npc.id);
                    npc.locationId = locId;
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
          } else if (tc.name === 'set_npc_follow_state') {
            const npcId = tc.args?.npcId;
            const mode = tc.args?.mode;
            const followPlayerName = tc.args?.followPlayerName;
            let followTargetId: string | null = null;

            if (mode === 'follow') {
              const targetPlayer = playerContexts.find(pc => pc.playerName?.toLowerCase() === followPlayerName?.toLowerCase())
                || Object.values(explorationPlayers).find(p => p.character?.name?.toLowerCase() === followPlayerName?.toLowerCase());
              followTargetId = targetPlayer?.socketId || primary.socketId;
            }

            if (npcId && setNpcFollowState(npcId, mode === 'follow' ? followTargetId : null)) {
              processedToolCalls.push({ name: tc.name, args: { ...tc.args, followPlayerName: followPlayerName || primary.playerName } });
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
            // Just forward to client for processing (startBotMatch)
            processedToolCalls.push({ name: tc.name, args: tc.args });
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

        if (errorInfo.retryable) {
          attempts++;
          const delay = getAIRetryDelaySeconds(attempts);
          // Notify players retrying
          for (const pc of playerContexts) {
            io.to(pc.socketId).emit("explorationRetry", {
              requestId,
              attempt: attempts,
              delay,
              label: errorInfo.label,
            });
          }
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          continue;
        }

        // Final error — notify all players
        const formattedError = formatAIError(errorInfo);
        for (const pc of playerContexts) {
          io.to(pc.socketId).emit("explorationActionError", { requestId, message: formattedError });
        }
        return;
      }
    }
  }

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

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
      ep.x = location.x;
      ep.y = location.y;
      for (const npc of Object.values(explorationNpcs)) {
        if (npc.followTargetId === socket.id) {
          const offset = getNpcOffset(npc.id);
          npc.locationId = data.locationId;
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

      io.to(roomId).emit('battleMapMovementLog', {
        log: `🗺️ **${moverName}** repositions to **${nextLocation.name}** and ${distanceLabel}.`,
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
    socket.on("explorationAction", (data: { action: string; apiKey: string; model: string; explorationState: any; recentLog: string[] }) => {
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
          recentLog: data.recentLog || []
        }],
        apiKey,
        data.model || 'gemini-3-flash-preview',
        abortController.signal,
        [{ playerId: socket.id, playerName: ep.character?.name || 'Unknown', action: data.action, locationId: ep.locationId }]
      ).finally(() => {
        delete activeExplorationRequests[socket.id];
      });
    });

    socket.on("explorationLockIn", (data: { action: string; apiKey?: string; model?: string; explorationState?: any; recentLog?: string[] }) => {
      const ep = explorationPlayers[socket.id];
      if (!ep) return;
      explorationLockedActions[socket.id] = data.action;
      
      // Store context for when all lock in
      (ep as any)._lockContext = {
        apiKey: data.apiKey,
        model: data.model,
        explorationState: data.explorationState,
        recentLog: data.recentLog
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
            recentLog: ctx.recentLog || []
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
      socket.to(data.roomId).emit("battleImageShared", {
        fromName: p.character?.name || "Someone",
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
        players: {
          [data.challengerId]: { lockedIn: false, action: "", character: challenger.character },
          [socket.id]: { lockedIn: false, action: "", character: accepter.character },
        },
        history: [],
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

      // Add NPC allies if provided
      const npcAllies = data.npcAllies || [];
      for (const npc of npcAllies) {
        const npcId = `npc_ally_${npc.id}`;
        roomPlayers[npcId] = {
          lockedIn: false,
          action: "",
          character: {
            name: npc.name,
            hp: npc.hp || 80,
            maxHp: npc.hp || 80,
            mana: 50,
            maxMana: 50,
            profileMarkdown: npc.profileMarkdown,
            isNpcAlly: true
          }
        };
      }

      rooms[roomId] = {
        id: roomId,
        host: socket.id,
        isBotMatch: true,
        unlimitedTurnTime: !!data.unlimitedTurnTime,
        arenaPreviewSeconds: typeof data.arenaPreviewSeconds === 'number' ? data.arenaPreviewSeconds : ARENA_PREVIEW_SECONDS,
        arenaTweakSeconds: typeof data.arenaTweakSeconds === 'number' ? data.arenaTweakSeconds : ARENA_TWEAK_SECONDS,
        botDifficulty: difficulty,
        npcAllyIds: npcAllies.map((n: any) => `npc_ally_${n.id}`),
        players: roomPlayers,
        mapState: buildArenaBattleMapState(roomPlayers),
        phase: 'preview',
        history: [],
      };

      socket.join(roomId);
      players[socket.id].room = roomId;

      startArenaPreparation(roomId);
    });

    socket.on("enterArena", (data?: { unlimitedTurnTime?: boolean; arenaPreviewSeconds?: number; arenaTweakSeconds?: number }) => {
      if (!players[socket.id]?.character) {
        socket.emit("error", "Create a character first.");
        return;
      }

      matchmakingQueue[socket.id] = {
        id: socket.id,
        character: players[socket.id].character,
        isReady: false,
        unlimitedTurnTime: !!data?.unlimitedTurnTime,
        arenaPreviewSeconds: typeof data?.arenaPreviewSeconds === 'number' ? data.arenaPreviewSeconds : undefined,
        arenaTweakSeconds: typeof data?.arenaTweakSeconds === 'number' ? data.arenaTweakSeconds : undefined,
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
            players: roomPlayers,
            unlimitedTurnTime: queueList.some(p => p.unlimitedTurnTime),
            arenaPreviewSeconds: queueList.find(p => typeof p.arenaPreviewSeconds === 'number')?.arenaPreviewSeconds ?? ARENA_PREVIEW_SECONDS,
            arenaTweakSeconds: queueList.find(p => typeof p.arenaTweakSeconds === 'number')?.arenaTweakSeconds ?? ARENA_TWEAK_SECONDS,
            isBotMatch: false,
            mapState: buildArenaBattleMapState(roomPlayers),
            phase: 'preview',
            history: []
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

    socket.on("updateBotPreparationProfile", (data: { roomId?: string; botId: string; profileMarkdown: string }) => {
      const roomId = players[socket.id]?.room || data.roomId;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room?.isBotMatch || (room.phase !== 'tweak' && !room.players?.[data.botId]?.prepSkippedPreview)) return;

      const botPlayer = room.players[data.botId];
      if (!botPlayer?.character || typeof data.profileMarkdown !== 'string' || !data.profileMarkdown.trim()) return;

      applyPreparationCharacterUpdate(roomId, data.botId, {
        ...botPlayer.character,
        profileMarkdown: data.profileMarkdown.trim(),
      });
    });

    socket.on("botAction", (data) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;
      const room = rooms[roomId];
      if (!room || !room.isBotMatch) return;

      const botId = `bot_${socket.id}`;
      applyPlayerLockedAction(roomId, botId, data.action);

      // Auto-lock NPC allies with auto-generated actions
      const npcAllyIds = room.npcAllyIds || [];
      for (const npcId of npcAllyIds) {
        if (room.players[npcId] && !room.players[npcId].lockedIn) {
          const npcChar = room.players[npcId].character;
          applyPlayerLockedAction(
            roomId,
            npcId,
            data.npcActions?.[npcId] || `${npcChar.name} attacks the enemy with their signature ability.`,
            { emitNpcAction: true }
          );
        }
      }
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

      applyPlayerLockedAction(roomId, targetPlayerId, actionText.trim());

      if (room.isBotMatch && targetPlayerId.startsWith('bot_')) {
        const npcAllyIds = room.npcAllyIds || [];
        for (const npcId of npcAllyIds) {
          if (room.players[npcId] && !room.players[npcId].lockedIn) {
            const npcChar = room.players[npcId].character;
            applyPlayerLockedAction(
              roomId,
              npcId,
              payload?.npcActions?.[npcId] || `${npcChar.name} attacks the enemy with their signature ability.`,
              { emitNpcAction: true }
            );
          }
        }
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

    socket.on("submitTurnResolution", (data) => {
      const roomId = players[socket.id]?.room;
      if (!roomId) return;

      const room = rooms[roomId];
      if (!room) return;

      const newState = data.state;

      if (newState) {
        for (const pid of Object.keys(room.players)) {
          const charName = room.players[pid].character.name;
          // Try to find the state by character name, or fallback to Player1/Player2 logic if the LLM used that
          const stateData = newState[charName] || Object.values(newState).find((s: any) => s && typeof s === 'object' && s.name === charName);
          
          if (stateData) {
            room.players[pid].character.hp = stateData.hp ?? room.players[pid].character.hp;
            room.players[pid].character.mana = stateData.mana ?? room.players[pid].character.mana;
            if (stateData.profileMarkdown) {
              room.players[pid].character.profileMarkdown = stateData.profileMarkdown;
            }
          } else {
            // Fallback for Player1/Player2 if the LLM followed the old format
            const pIndex = Object.keys(room.players).indexOf(pid) + 1;
            const fallbackData = newState[`Player${pIndex}`];
            if (fallbackData) {
              room.players[pid].character.hp = fallbackData.hp ?? room.players[pid].character.hp;
              room.players[pid].character.mana = fallbackData.mana ?? room.players[pid].character.mana;
              if (fallbackData.profileMarkdown) {
                room.players[pid].character.profileMarkdown = fallbackData.profileMarkdown;
              }
            }
          }
        }
      }

      if (room.mapState && data.mapState) {
        room.mapState = sanitizeBattleMapState(data.mapState, room.mapState);
      }

      // Reset locks
      for (const pid of Object.keys(room.players)) {
        room.players[pid].lockedIn = false;
        room.players[pid].autoLockedThisTurn = false;
        room.players[pid].action = "";
      }

      io.to(room.id).emit("turnResolved", {
        log: data.log,
        thoughts: data.thoughts,
        state: newState,
        players: room.players,
        mapState: room.mapState,
      });

      // Start timer for next turn if game continues (more than 1 player alive)
      const alivePlayers = Object.values(room.players).filter((p: any) => p.character.hp > 0);
      if (alivePlayers.length > 1) {
        startRoomTimer(roomId);
      } else {
        clearRoomTimer(roomId);
      }
    });

    socket.on("streamTurnResolutionStart", () => {
      const roomId = players[socket.id]?.room;
      if (roomId) {
        io.to(roomId).emit("streamTurnResolutionStart");
      }
    });

    socket.on("streamTurnResolutionChunk", (data) => {
      const roomId = players[socket.id]?.room;
      if (roomId) {
        io.to(roomId).emit("streamTurnResolutionChunk", data);
      }
    });

    socket.on("shareBattleImage", (data: { imageUrl: string }) => {
      const roomId = players[socket.id]?.room;
      if (roomId) {
        socket.to(roomId).emit("battleImageShared", { imageUrl: data.imageUrl });
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      clearTypingForSocket(socket.id);
      
      if (matchmakingQueue[socket.id]) {
        delete matchmakingQueue[socket.id];
        io.to("matchmaking_lobby").emit("queueUpdated", Object.values(matchmakingQueue));
      }

      // Clean up exploration
      if (explorationPlayers[socket.id]) {
        // Abort any active AI request
        if (activeExplorationRequests[socket.id]) {
          activeExplorationRequests[socket.id].abort();
          delete activeExplorationRequests[socket.id];
        }
        for (const npc of Object.values(explorationNpcs)) {
          if (npc.followTargetId === socket.id) {
            setNpcFollowState(npc.id, null);
          }
        }
        delete explorationLockedActions[socket.id];
        delete explorationPlayers[socket.id];
        emitExplorationPlayersUpdated();
        emitExplorationNpcStatesUpdated();
      }

      const roomId = players[socket.id]?.room;
      if (roomId) {
        clearRoomTimer(roomId);
        clearArenaPreparationTimer(roomId);
        socket.to(roomId).emit("opponentDisconnected");
        delete rooms[roomId];
      }
      delete players[socket.id];
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
