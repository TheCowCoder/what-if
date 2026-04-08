import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { Home, User, Users, Shield, Heart, Send, Check, Loader2, Sword, Settings, ChevronDown, ArrowLeft, AlertTriangle, Info, Compass, Map, Star, ChevronUp, Maximize2, Minimize2, Target, Beef, GlassWater, Zap, Package, X, Eye, Coins, Orbit } from 'lucide-react';
import { classifyAIError, createAIClient, formatAIError, getAIRetryDelaySeconds } from '../ai';

declare global {
  interface Window {
    aistudio?: {
      openSelectKey: () => Promise<void>;
      hasSelectedApiKey: () => Promise<boolean>;
    };
  }
}

const socket: Socket = io();

type Tab = 'home' | 'profile' | 'social';
type GameState = 'menu' | 'char_creation' | 'matchmaking' | 'battle' | 'post_match' | 'exploration' | 'level_select';

interface Character {
  name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  gold: number;
  profileMarkdown: string;
  imageUrl?: string;
}

interface Message {
  role: 'user' | 'model' | 'system';
  text: string;
  imageUrl?: string;
  playerName?: string;
  streamId?: string;
}

interface WorldLocation {
  id: string;
  name: string;
  description: string;
  x: number;
  y: number;
  islandId: string;
  type: string;
  resources: string[];
  connections: string[];
  npcs: string[];
  enemies: string[];
}

interface ExplorationState {
  locationId: string;
  x: number;
  y: number;
  hunger: number;
  thirst: number;
  stamina: number;
  inventory: Record<string, number>;
  discoveredLocations: string[];
  goals: string[];
  equippedWeapon: string | null;
  equippedArmor: string | null;
}

const DEFAULT_STARTING_GOLD = 25;
const BATTLE_STREAM_THOUGHTS_PREFIX = 'STREAMING_THOUGHTS_';
const BATTLE_STREAM_ANSWER_PREFIX = 'STREAMING_ANSWER_';
const BATTLE_PLAYER_ACTIONS_PREFIX = 'PLAYER_ACTIONS_';
const BATTLE_PENDING_ACTION_PREFIX = 'PENDING_PLAYER_ACTION_';

const normalizeCharacter = (value: any): Character => ({
  ...value,
  name: value?.name || 'Unknown',
  hp: value?.hp ?? 100,
  maxHp: value?.maxHp ?? 100,
  mana: value?.mana ?? 100,
  maxMana: value?.maxMana ?? 100,
  gold: typeof value?.gold === 'number' ? value.gold : DEFAULT_STARTING_GOLD,
  profileMarkdown: value?.profileMarkdown || '',
});

const normalizeCharacters = (values: any[]): Character[] => Array.isArray(values) ? values.map(normalizeCharacter) : [];

const buildBattleActionsLog = (roomPlayers: Record<string, any>): string => (
  BATTLE_PLAYER_ACTIONS_PREFIX + Object.keys(roomPlayers)
    .map(pid => `**${roomPlayers[pid].character.name}:** ${roomPlayers[pid].action}`)
    .join('\n\n')
);

const appendBattleLogIfMissing = (logs: string[], entry: string): string[] => (
  logs.includes(entry) ? logs : [...logs, entry]
);

const buildPendingBattleActionLog = (playerId: string, action: string): string => (
  `${BATTLE_PENDING_ACTION_PREFIX}${playerId}::${action}`
);

const removePendingBattleActionLogs = (logs: string[], playerId?: string): string[] => {
  const prefix = playerId ? `${BATTLE_PENDING_ACTION_PREFIX}${playerId}::` : BATTLE_PENDING_ACTION_PREFIX;
  return logs.filter(log => !log.startsWith(prefix));
};

const ensureBattleStreamLog = (logs: string[], prefix: string): string[] => {
  const firstIndex = logs.findIndex(log => log.startsWith(prefix));
  if (firstIndex === -1) {
    return [...logs, prefix];
  }

  return logs.filter((log, index) => !log.startsWith(prefix) || index === firstIndex);
};

const ensureBattleStreamPlaceholders = (logs: string[]): string[] => {
  const withThoughts = ensureBattleStreamLog(logs, BATTLE_STREAM_THOUGHTS_PREFIX);
  return ensureBattleStreamLog(withThoughts, BATTLE_STREAM_ANSWER_PREFIX);
};

const removeBattleStreamPlaceholders = (logs: string[]): string[] => (
  logs.filter(log => !log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX) && !log.startsWith(BATTLE_STREAM_ANSWER_PREFIX))
);

interface WorldPlayer {
  id: string;
  name: string;
  locationId: string;
  x: number;
  y: number;
  acting?: boolean;
}

interface WorldNpc {
  id: string;
  name: string;
  role: string;
  locationId: string;
  x: number;
  y: number;
  followTargetId?: string | null;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [gameState, setGameState] = useState<GameState>('menu');
  
  // Auth state
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('duo_auth_token'));
  const [authUser, setAuthUser] = useState<string | null>(() => localStorage.getItem('duo_auth_user'));
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [dbAvailable, setDbAvailable] = useState(false);

  const [characters, setCharacters] = useState<Character[]>(() => {
    const saved = localStorage.getItem('duo_characters');
    return saved ? normalizeCharacters(JSON.parse(saved)) : [];
  });
  const [character, setCharacter] = useState<Character | null>(() => {
    const saved = localStorage.getItem('duo_character');
    return saved ? normalizeCharacter(JSON.parse(saved)) : null;
  });
  
  const [settings, setSettings] = useState(() => {
    const defaultSettings = {
      apiKey: '',
      charModel: 'gemini-2.5-flash',
      explorationModel: 'gemini-3-flash-preview',
      battleModel: 'gemini-2.5-pro',
      botModel: 'gemini-2.5-flash'
    };
    const saved = localStorage.getItem('duo_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const validModels = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];
        
        // Ensure any old/invalid models are reset to defaults so we don't silently request a maxed out model
        if (parsed.charModel && !validModels.includes(parsed.charModel)) parsed.charModel = defaultSettings.charModel;
        if (parsed.explorationModel && !validModels.includes(parsed.explorationModel)) parsed.explorationModel = defaultSettings.explorationModel;
        if (parsed.battleModel && !validModels.includes(parsed.battleModel)) parsed.battleModel = defaultSettings.battleModel;
        if (parsed.botModel && !validModels.includes(parsed.botModel)) parsed.botModel = defaultSettings.botModel;
        
        return { ...defaultSettings, ...parsed };
      } catch (e) {
        return defaultSettings;
      }
    }
    return defaultSettings;
  });
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem('duo_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (character) {
      localStorage.setItem('duo_character', JSON.stringify(character));
      setCharacters(prev => {
        const index = prev.findIndex(c => c.name === character.name);
        let newChars;
        if (index >= 0) {
          newChars = [...prev];
          newChars[index] = character;
        } else {
          newChars = [...prev, character];
        }
        localStorage.setItem('duo_characters', JSON.stringify(newChars));
        return newChars;
      });
    }
  }, [character]);

  const getAIClient = () => {
    const customKey = settingsRef.current.apiKey?.trim();
    if (customKey) {
      console.log(`Using custom API key ending in ...${customKey.slice(-4)}`);
      return createAIClient(customKey);
    }
    
    // If the user selected a key via the platform dialog, it might be injected here
    // We create a new instance to ensure we pick up any dynamically injected keys
    console.log("Using platform-provided API key");
    return createAIClient(process.env.API_KEY || process.env.GEMINI_API_KEY);
  };

  const upsertExplorationStreamMessage = useCallback((streamId: string, text: string) => {
    setExplorationLog(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streamId === streamId) {
          next[i] = { ...next[i], role: 'model', text, streamId };
          return next;
        }
      }
      return [...prev, { role: 'model', text, streamId }];
    });
  }, []);

  const clearExplorationStreamMessage = useCallback((streamId: string) => {
    setExplorationLog(prev => prev.filter(message => message.streamId !== streamId));
  }, []);

  const upsertChatStatusMessage = useCallback((statusId: string, text: string) => {
    setMessages(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streamId === statusId) {
          next[i] = { ...next[i], role: 'system', text, streamId: statusId };
          return next;
        }
      }
      return [...prev, { role: 'system', text, streamId: statusId }];
    });
  }, []);

  const clearChatStatusMessage = useCallback((statusId: string) => {
    setMessages(prev => prev.filter(message => message.streamId !== statusId));
  }, []);

  const upsertExplorationStatusMessage = useCallback((statusId: string, text: string) => {
    setExplorationLog(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streamId === statusId) {
          next[i] = { ...next[i], role: 'system', text, streamId: statusId };
          return next;
        }
      }
      return [...prev, { role: 'system', text, streamId: statusId }];
    });
  }, []);

  const clearExplorationStatusMessage = useCallback((statusId: string) => {
    setExplorationLog(prev => prev.filter(message => message.streamId !== statusId));
  }, []);

  const upsertBattleStatusLog = useCallback((statusId: string, text: string) => {
    const prefix = `STATUS_${statusId}::`;
    setBattleLogs(prev => {
      const next = prev.filter(log => !log.startsWith(prefix));
      return [...next, `${prefix}${text}`];
    });
  }, []);

  const clearBattleStatusLog = useCallback((statusId: string) => {
    const prefix = `STATUS_${statusId}::`;
    setBattleLogs(prev => prev.filter(log => !log.startsWith(prefix)));
  }, []);
  
  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isWaitingForChar, setIsWaitingForChar] = useState(false);
  const [charCreatorRetryAttempt, setCharCreatorRetryAttempt] = useState(0);
  const [charCreatorError, setCharCreatorError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // World & Exploration state
  const [worldData, setWorldData] = useState<any>(null);
  const [explorationState, setExplorationState] = useState<ExplorationState>({
    locationId: '',
    x: 0,
    y: 0,
    hunger: 100,
    thirst: 100,
    stamina: 100,
    inventory: {},
    discoveredLocations: [],
    goals: ['Find a water source', 'Talk to a local', 'Gather some wood', 'Explore a new area', 'Craft your first tool'],
    equippedWeapon: null,
    equippedArmor: null,
  });
  const [explorationLog, setExplorationLog] = useState<Message[]>([]);
  const [explorationInput, setExplorationInput] = useState('');
  const [isExplorationProcessing, setIsExplorationProcessing] = useState(false);
  const [worldPlayers, setWorldPlayers] = useState<WorldPlayer[]>([]);
  const [worldNpcs, setWorldNpcs] = useState<WorldNpc[]>([]);
  const [explorationLockStatus, setExplorationLockStatus] = useState<{id: string; name: string; lockedIn: boolean}[]>([]);
  const [isExplorationLockedIn, setIsExplorationLockedIn] = useState(false);
  const [showGoalsModal, setShowGoalsModal] = useState(false);
  const [showFullMap, setShowFullMap] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const mapDragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({ dragging: false, lastX: 0, lastY: 0 });
  const [showInventory, setShowInventory] = useState(false);
  const [showCharImage, setShowCharImage] = useState(false);
  const [isGeneratingCharImage, setIsGeneratingCharImage] = useState(false);
  const [explorationCombatReturn, setExplorationCombatReturn] = useState(false);
  const explorationEndRef = useRef<HTMLDivElement>(null);
  const explorationInputRef = useRef<HTMLTextAreaElement>(null);
  const worldDataRef = useRef<any>(null);
  const activeExplorationStreamIdRef = useRef<string | null>(null);
  const [explorationRetryAttempt, setExplorationRetryAttempt] = useState(0);
  const [explorationError, setExplorationError] = useState<string | null>(null);

  const moveExplorationStateToLocation = useCallback((locationId: string, x: number, y: number) => {
    setExplorationState(prev => {
      const newDiscovered = [...prev.discoveredLocations];
      if (!newDiscovered.includes(locationId)) newDiscovered.push(locationId);
      const loc = worldDataRef.current?.locations?.find((l: any) => l.id === locationId);
      if (loc?.connections) {
        for (const connId of loc.connections) {
          if (!newDiscovered.includes(connId)) newDiscovered.push(connId);
        }
      }
      return {
        ...prev,
        locationId,
        x,
        y,
        discoveredLocations: newDiscovered,
      };
    });
  }, []);

  useEffect(() => {
    if (gameState !== 'exploration' || !character) return;
    socket.emit('syncExplorationState', {
      explorationState,
      character: {
        hp: character.hp,
        maxHp: character.maxHp,
        mana: character.mana,
        maxMana: character.maxMana,
        gold: character.gold,
      },
    });
  }, [gameState, explorationState, character]);

  // Battle state
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Record<string, any>>({});
  const [battleLogs, setBattleLogs] = useState<string[]>([]);
  const battleLogsRef = useRef<string[]>([]);
  const [battleInput, setBattleInput] = useState('');
  const [battleError, setBattleError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [expandedThoughts, setExpandedThoughts] = useState<Set<number>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isLockedIn, setIsLockedIn] = useState(false);
  const [opponentTyping, setOpponentTyping] = useState(false);
  const battleEndRef = useRef<HTMLDivElement>(null);
  const charInputRef = useRef<HTMLTextAreaElement>(null);
  const battleInputRef = useRef<HTMLTextAreaElement>(null);
  const handleGenerateBattleImageRef = useRef<(() => void) | null>(null);

  const [showBotModal, setShowBotModal] = useState(false);
  const [botDifficulty, setBotDifficulty] = useState<number>(1);
  const [botCharacters, setBotCharacters] = useState<any[]>([]);
  const [selectedBotCharacter, setSelectedBotCharacter] = useState<string>('');
  const [isGeneratingBot, setIsGeneratingBot] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const lastSyncedCharRef = useRef<string>('');
  const [queuePlayers, setQueuePlayers] = useState<any[]>([]);
  const [isBotMatch, setIsBotMatch] = useState(false);
  const [isGeneratingBattleImage, setIsGeneratingBattleImage] = useState(false);
  const [hasVisualizedThisTurn, setHasVisualizedThisTurn] = useState(false);
  const [turnTimerRemaining, setTurnTimerRemaining] = useState<number | null>(null);
  const [isVisualizingScene, setIsVisualizingScene] = useState(false);
  const isBotMatchRef = useRef(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileToView, setProfileToView] = useState<string | null>(null);
  useEffect(() => { isBotMatchRef.current = isBotMatch; }, [isBotMatch]);
  const difficultyLabels = ['Easy', 'Medium', 'Hard', 'Superintelligent'];

  useEffect(() => {
    socket.on('characterSynced', () => setIsSynced(true));
    socket.on('disconnect', () => setIsSynced(false));
    return () => {
      socket.off('characterSynced');
      socket.off('disconnect');
    };
  }, []);

  useEffect(() => {
    const sync = () => {
      const charStr = JSON.stringify(character);
      if (character && charStr !== lastSyncedCharRef.current) {
        socket.emit('characterCreated', character);
        lastSyncedCharRef.current = charStr;
      }
    };

    socket.on('connect', sync);
    if (socket.connected) {
      sync();
    }

    return () => {
      socket.off('connect', sync);
    };
  }, [character]);

  useEffect(() => {
    fetch('/api/bot_characters')
      .then(res => res.json())
      .then(data => {
        setBotCharacters(data);
        if (data.length > 0) {
          setSelectedBotCharacter(data[0].id);
        }
      })
      .catch(err => console.error("Failed to load bot characters", err));
    
    // Load world data  
    fetch('/api/world')
      .then(res => res.json())
      .then(data => { setWorldData(data); worldDataRef.current = data; })
      .catch(err => console.error("Failed to load world data", err));
  }, []);

  useEffect(() => {
    battleLogsRef.current = battleLogs;
  }, [battleLogs]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    battleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [battleLogs]);

  useEffect(() => {
    explorationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [explorationLog]);

  const roomIdRef = useRef(roomId);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  const botDifficultyRef = useRef(botDifficulty);
  useEffect(() => { botDifficultyRef.current = botDifficulty; }, [botDifficulty]);

  const generateBotAction = async (currentRoom: any) => {
    if (!currentRoom || !currentRoom.isBotMatch) return;
    
    const playerIds = Object.keys(currentRoom.players);
    const botId = playerIds.find(id => id.startsWith('bot_'));
    const playerId = playerIds.find(id => !id.startsWith('bot_'));
    
    if (!botId || !playerId) return;

    const p1Data = currentRoom.players[playerId];
    const p2Data = currentRoom.players[botId];

    if (p2Data.lockedIn) return;

    setOpponentTyping(true);
    try {
      const aiClient = getAIClient();
      const botPromptRes = await fetch('/api/prompts/bot_player.txt');
      const botSysPrompt = await botPromptRes.text();
      
      const cleanLogs = battleLogsRef.current.filter(log => !log.startsWith("> **Judge's Thoughts:**"));
      const fullLogText = cleanLogs.join('\n\n');
      const logLines = fullLogText.split('\n');
      const totalLines = logLines.length;

      const botPrompt = `
DIFFICULTY: ${currentRoom.botDifficulty}
YOU ARE PLAYING AS: ${p2Data.character.name}
YOUR STATE: ${JSON.stringify(p2Data.character)}
OPPONENT STATE: ${JSON.stringify(p1Data.character)}
LATEST BATTLE EVENTS:
${totalLines > 0 ? logLines.slice(Math.max(0, totalLines - 15)).join('\n') : "The battle has just begun."}

What is your action? Keep it short and tactical. Remember, you are ${p2Data.character.name}.
`;
      const botRes = await aiClient.models.generateContent({
        model: settingsRef.current.botModel,
        contents: botPrompt,
        config: {
          systemInstruction: botSysPrompt,
          temperature: 0.8,
        },
      });
      
      const action = botRes.text || "I do nothing.";
      socket.emit('botAction', { action });
    } catch (error) {
      console.error("Error generating bot action:", error);
      // Fallback: send a generic attack so the battle doesn't stall
      socket.emit('botAction', { action: `${currentRoom.players[botId!]?.character?.name || 'The enemy'} attacks with a basic strike!` });
    } finally {
      setOpponentTyping(false);
    }
  };

  useEffect(() => {
    socket.on('characterSaved', (state: Character) => {
      const normalizedState = normalizeCharacter(state);
      const stateStr = JSON.stringify(normalizedState);
      if (stateStr !== lastSyncedCharRef.current) {
        setCharacter(normalizedState);
        const isUpdate = characters.some(c => c.name === normalizedState.name);
      setMessages(prev => [...prev, { role: 'system', text: isUpdate ? `Updated character: ${normalizedState.name}!` : `Created character: ${normalizedState.name}!` }]);
        lastSyncedCharRef.current = stateStr;
        // Auto-generate character portrait
        if (!normalizedState.imageUrl) {
          setTimeout(async () => {
            try {
              console.log("[Portrait Auto] Starting generation for:", state.name);
              setMessages(prev => [...prev, { role: 'system', text: '🎨 Generating portrait...' }]);
              const aiClient = getAIClient();
              const prompt = `Generate a fantasy character portrait for: ${state.name}. ${state.profileMarkdown.substring(0, 500)}. Style: detailed digital art, fantasy RPG character portrait, vibrant colors.`;
              const imgRes = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash-image',
                contents: prompt,
                config: { responseModalities: ['IMAGE', 'TEXT'] },
              });
              const imgParts = imgRes.candidates?.[0]?.content?.parts || [];
              for (const p of imgParts) {
                if ((p as any).inlineData) {
                  const imgData = (p as any).inlineData;
                  const imgUrl = `data:${imgData.mimeType};base64,${imgData.data}`;
                  setCharacter(prev => prev ? { ...prev, imageUrl: imgUrl } : prev);
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.text !== '🎨 Generating portrait...');
                    return [...filtered, { role: 'system', text: '🎨 Portrait generated!' }];
                  });
                  console.log("[Portrait Auto] Success!");
                  return;
                }
              }
              console.warn("[Portrait Auto] No image in response");
            } catch (err: any) {
              console.error("[Portrait Auto] Error:", err.message);
            }
          }, 500);
        }
      }
    });

    socket.on('queueUpdated', (queue) => {
      setQueuePlayers(queue);
    });

    socket.on('waitingForOpponent', () => {
      setGameState('matchmaking');
    });

    socket.on('matchFound', (data) => {
      setRoomId(data.roomId);
      setPlayers(data.players);
      setIsBotMatch(data.isBotMatch);
      setIsExplorationProcessing(false);
      setExplorationLockStatus([]);
      setExplorationRetryAttempt(0);
      setExplorationError(null);
      activeExplorationStreamIdRef.current = null;
      socket.emit('explorationActing', { acting: false });
      if (data.isPvpExploration) setExplorationCombatReturn(true);
      setGameState('battle');
      setBattleLogs(['**Match Found!** The battle begins.']);
      setIsLockedIn(false);
      setHasVisualizedThisTurn(false);
      if (data.isBotMatch) {
        generateBotAction(data);
      }
    });

    socket.on('battleActionsSubmitted', (data: { log: string }) => {
      setBattleLogs(prev => appendBattleLogIfMissing(removePendingBattleActionLogs(prev), data.log));
    });

    socket.on('opponentTyping', (id) => {
      if (id !== socket.id) {
        setOpponentTyping(true);
        setTimeout(() => setOpponentTyping(false), 3000);
      }
    });

    socket.on('playerLockedIn', (id) => {
      setPlayers(prev => ({
        ...prev,
        [id]: { ...prev[id], lockedIn: true }
      }));
    });

    socket.on('playerUnlocked', (id) => {
      setPlayers(prev => ({
        ...prev,
        [id]: { ...prev[id], lockedIn: false }
      }));
      setBattleLogs(prev => removePendingBattleActionLogs(prev, id));
      if (id === socket.id) {
        setIsLockedIn(false);
      }
    });

    socket.on('requestTurnResolution', async (room) => {
      if (socket.id !== room.host) return;
      
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      const playerIds = Object.keys(room.players);
      const actionsLog = buildBattleActionsLog(room.players);
      const baseLogs = appendBattleLogIfMissing(battleLogsRef.current, actionsLog);
      setBattleLogs(prev => appendBattleLogIfMissing(prev, actionsLog));

      const cleanLogs = baseLogs.filter(log => !log.startsWith("> **Judge's Thoughts:**"));
      const fullLogText = cleanLogs.join('\n\n');
      const logLines = fullLogText.split('\n');
      const totalLines = logLines.length;

      let profiles = "";
      for (const pid of playerIds) {
        const pData = room.players[pid];
        profiles += `Profile for ${pData.character.name}:\n${pData.character.profileMarkdown}\n\n`;
      }

      const sysPromptRes = await fetch('/api/prompts/battle_judge.txt');
      const sysPrompt = await sysPromptRes.text();
      const fullSysPrompt = sysPrompt + "\n\n" + profiles;

      let prompt = `BATTLE STATE (TURN START):\n`;
      for (const pid of playerIds) {
        const pData = room.players[pid];
        prompt += `Player (${pData.character.name}):\nHP: ${pData.character.hp}, Mana: ${pData.character.mana}\nAction: ${pData.action}\n\n`;
      }
      prompt += `The battle log currently has ${totalLines} lines. You can use the read_battle_history tool to read it if you need context from previous turns. Otherwise, resolve the turn simultaneously.`;

      const readBattleHistory = {
        name: "read_battle_history",
        description: "Read the battle history markdown log. Provide start and end lines to read a specific section. The log contains all previous turns.",
        parameters: {
          type: "OBJECT",
          properties: {
            startLine: { type: "INTEGER", description: "The line number to start reading from (1-indexed)." },
            endLine: { type: "INTEGER", description: "The line number to end reading at (inclusive)." }
          },
          required: ["startLine", "endLine"]
        }
      };

      const submitBattleResult = {
        name: "submit_battle_result",
        description: "Submit the updated character states after resolving the turn. Call this AFTER writing the battle log narrative.",
        parameters: {
          type: "OBJECT",
          properties: {
            characterStates: {
              type: "STRING",
              description: "JSON string of character states. Format: {\"CharName1\": {\"hp\": number, \"mana\": number, \"profileMarkdown\": \"optional updated markdown\"}, \"CharName2\": {\"hp\": number, \"mana\": number}}"
            }
          },
          required: ["characterStates"]
        }
      };

      const aiClient = getAIClient();
      let contents: any[] = [{ role: 'user', parts: [{ text: prompt }] }];
      let hasEmittedStart = false;
      let finalThoughts = "";
      let finalAnswer = "";

      let attempts = 0;
      clearBattleStatusLog('battle-retry');

      while (true) {
        if (signal.aborted) break;
        setBattleError(null);
        setRetryAttempt(attempts);

        try {
          while (true) {
            if (signal.aborted) break;
            const responseStream = await aiClient.models.generateContentStream({
              model: settingsRef.current.battleModel,
              contents: contents,
              config: {
                systemInstruction: fullSysPrompt,
                temperature: 1.5,
                thinkingConfig: {
                  includeThoughts: true,
                  thinkingBudget: 8192
                },
                tools: [{ functionDeclarations: [readBattleHistory as any, submitBattleResult as any] }]
              },
            });

            let hasToolCall = false;
            let toolCallPart = null;
            let modelParts = [];
            let streamedThoughts = "";
            let streamedAnswer = "";

            for await (const chunk of responseStream) {
              if (signal.aborted) break;
              const parts = chunk.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                modelParts.push(part);
                if (part.functionCall) {
                  hasToolCall = true;
                  toolCallPart = part;
                } else if (!hasToolCall) {
                  const p = part as any;
                  const isThought = !!p.thought;
                  const text = typeof p.thought === 'string' ? p.thought : (p.text || "");

                  if (text) {
                    if (!hasEmittedStart) {
                      socket.emit('streamTurnResolutionStart');
                      hasEmittedStart = true;
                    }
                    
                    if (isThought) {
                      streamedThoughts += text;
                    } else {
                      streamedAnswer += text;
                    }
                    
                    // With native tool calling, the answer text IS the battle log directly (no XML tags)
                    let displayThoughts = finalThoughts + streamedThoughts;
                    let displayAnswer = (finalAnswer + streamedAnswer).trim();
                    
                    socket.emit('streamTurnResolutionChunk', { type: 'thought', text: "REFRESH:" + displayThoughts });
                    socket.emit('streamTurnResolutionChunk', { type: 'answer', text: "REFRESH:" + displayAnswer });
                  }
                }
              }
            }
            if (signal.aborted) break;

            finalThoughts += streamedThoughts;
            finalAnswer += streamedAnswer;

            if (hasToolCall && toolCallPart) {
              const functionCall = toolCallPart.functionCall;
              if (!functionCall) {
                continue;
              }

              const funcName = functionCall.name;
              const args = functionCall.args as any;
              
              if (funcName === 'read_battle_history') {
                const start = Math.max(1, args.startLine || 1);
                const end = Math.min(totalLines, args.endLine || totalLines);
                const resultText = logLines.slice(start - 1, end).join('\n');
                
                contents.push({ role: 'model', parts: modelParts });
                contents.push({
                  role: 'user',
                  parts: [{
                    functionResponse: {
                      name: "read_battle_history",
                      response: { result: resultText }
                    }
                  }]
              });
              // Loop again to let the model continue
              } else if (funcName === 'submit_battle_result') {
                // Native tool call for battle state update
                let newState = null;
                try {
                  newState = typeof args.characterStates === 'string' 
                    ? JSON.parse(args.characterStates) 
                    : args.characterStates;
                } catch (e) {
                  console.error("Failed to parse battle state from tool call", e);
                }
                
                let thoughts = finalThoughts.trim();
                let markdownLog = finalAnswer.trim();
                
                socket.emit('submitTurnResolution', {
                  log: markdownLog,
                  thoughts: thoughts,
                  state: newState
                });
                clearBattleStatusLog('battle-retry');
                setRetryAttempt(0);
                setBattleError(null);
                return;
              }
            } else {
              // Done — no tool call, extract state from text as fallback
              const combinedOutput = finalThoughts + "\n" + finalAnswer;
              
              const stateMatch = combinedOutput.match(/<BATTLE_STATE>([\s\S]*?)(?:<\/BATTLE_STATE>|$)/);
              let newState = null;
              if (stateMatch) {
                try {
                  newState = JSON.parse(stateMatch[1]);
                } catch (e) {
                  console.error("Failed to parse battle state", e);
                }
              }

              let thoughts = finalThoughts.trim();
              let markdownLog = finalAnswer
                .replace(/<BATTLE_STATE>[\s\S]*?(?:<\/BATTLE_STATE>|$)/, "")
                .trim();
              
              socket.emit('submitTurnResolution', {
                log: markdownLog,
                thoughts: thoughts,
                state: newState
              });
              clearBattleStatusLog('battle-retry');
              setRetryAttempt(0);
              setBattleError(null);
              return;
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') return;
          console.error("Error resolving turn:", error);

          const errorInfo = classifyAIError(error);

          if (errorInfo.retryable) {
            attempts++;
            const delay = getAIRetryDelaySeconds(attempts);
            setRetryAttempt(attempts);
            setBattleError(`${errorInfo.label}. Retrying in ${delay}s...`);
            upsertBattleStatusLog('battle-retry', `⚠️ ${errorInfo.label}. Retrying in **${delay}s**. Attempt **#${attempts}**...`);
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
            continue;
          }

          const formattedError = formatAIError(errorInfo);
          socket.emit('error', `Turn resolution failed (Model: ${settingsRef.current.battleModel}). ${formattedError}`);
          setBattleError(formattedError);
          upsertBattleStatusLog('battle-retry', `⚠️ Battle resolution error: ${formattedError}`);
          setRetryAttempt(0);
          break;
        }
      }
    });

    socket.on('turnResolved', (data) => {
      setHasVisualizedThisTurn(false);
      setBattleLogs(prev => {
        const filtered = removePendingBattleActionLogs(removeBattleStreamPlaceholders(prev));
        const thoughts = data.thoughts || "";
        return [...filtered, `> **Judge's Thoughts:**\n> ${thoughts.replace(/\n/g, '\n> ')}`, data.log];
      });
      if (data.state) {
        setPlayers(data.players);
        
        // Check win condition
        const alivePlayers = Object.values(data.players).filter((p: any) => p.character.hp > 0);
        if (alivePlayers.length <= 1) {
          const winner = alivePlayers[0] as any;
          const winnerName = winner ? winner.character.name : "No one";
          setBattleLogs(prev => [...prev, `**GAME OVER!** ${winnerName} is victorious!`]);
        } else {
          // If it's a bot match, trigger next bot action
          const room = { id: roomIdRef.current, players: data.players, isBotMatch: isBotMatchRef.current, botDifficulty: botDifficultyRef.current };
          if (room.isBotMatch) {
            generateBotAction(room);
          }
        }
      }
      setIsLockedIn(false);
      setOpponentTyping(false);
      // Auto-generate battle scene image after turn resolution (only resolver generates)
      const playerIds = Object.keys(data.players);
      const isFirstPlayer = playerIds[0] === socket.id;
      if (isFirstPlayer) {
        setTimeout(() => handleGenerateBattleImageRef.current?.(), 500);
      }
    });

    socket.on('battleEndedByInactivity', (data: { log: string }) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      setBattleLogs(prev => [...removePendingBattleActionLogs(removeBattleStreamPlaceholders(prev)), data.log]);
      setBattleError(null);
      setRetryAttempt(0);
      setIsLockedIn(false);
      setOpponentTyping(false);
      setTurnTimerRemaining(null);
      setRoomId(null);
      setBattleInput('');
      setGameState('post_match');
    });

    socket.on('streamTurnResolutionStart', () => {
      setBattleLogs(prev => ensureBattleStreamPlaceholders(prev));
    });

    socket.on('streamTurnResolutionChunk', (data: { type: 'thought' | 'answer', text: string }) => {
      setBattleLogs(prev => {
        const newLogs = ensureBattleStreamPlaceholders(prev);
        const isRefresh = data.text.startsWith('REFRESH:');
        const textToAppend = isRefresh ? data.text.substring('REFRESH:'.length) : data.text;

        if (data.type === 'thought') {
          const idx = newLogs.findIndex(l => l.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX));
          if (idx !== -1) {
            if (isRefresh) {
              newLogs[idx] = BATTLE_STREAM_THOUGHTS_PREFIX + textToAppend;
            } else {
              const current = newLogs[idx].substring(BATTLE_STREAM_THOUGHTS_PREFIX.length);
              newLogs[idx] = BATTLE_STREAM_THOUGHTS_PREFIX + current + textToAppend;
            }
          }
        } else {
          const idx = newLogs.findIndex(l => l.startsWith(BATTLE_STREAM_ANSWER_PREFIX));
          if (idx !== -1) {
            if (isRefresh) {
              newLogs[idx] = BATTLE_STREAM_ANSWER_PREFIX + textToAppend;
            } else {
              const current = newLogs[idx].substring(BATTLE_STREAM_ANSWER_PREFIX.length);
              newLogs[idx] = BATTLE_STREAM_ANSWER_PREFIX + current + textToAppend;
            }
          }
        }
        return newLogs;
      });
    });

    socket.on('battleImageShared', (data: { imageUrl: string }) => {
      setBattleLogs(prev => [...prev, `![Battle Scene](${data.imageUrl})`]);
    });

    socket.on('turnTimerTick', (data: { remaining: number | null }) => {
      setTurnTimerRemaining(data.remaining);
    });

    socket.on('turnTimerAutoLocked', (data: { playerId: string; playerName: string }) => {
      setBattleLogs(prev => [...prev, `⏰ **${data.playerName}** ran out of time and took a defensive stance!`]);
      if (data.playerId === socket.id) {
        setIsLockedIn(true);
      }
    });

    socket.on('opponentDisconnected', () => {
      setBattleLogs(prev => [...prev, '**Opponent disconnected.** You win by default!']);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    });

    socket.on('npcAllyAction', (data: { npcId: string; npcName: string; action: string }) => {
      setBattleLogs(prev => [...prev, `NPC_ALLY_ACTION_**${data.npcName}:** ${data.action}`]);
    });

    socket.on('error', (msg) => {
      alert(msg);
      setIsWaitingForChar(false);
    });

    // Exploration events
    socket.on('explorationStarted', (data) => {
      setExplorationState(prev => {
        const newDiscovered = [data.locationId];
        const loc = worldDataRef.current?.locations?.find((l: any) => l.id === data.locationId);
        if (loc?.connections) {
          for (const connId of loc.connections) {
            if (!newDiscovered.includes(connId)) newDiscovered.push(connId);
          }
        }
        return {
          ...prev,
          locationId: data.locationId,
          x: data.x,
          y: data.y,
          discoveredLocations: newDiscovered,
        };
      });
      setWorldPlayers(data.worldPlayers || []);
      setWorldNpcs(data.npcStates || []);
    });

    socket.on('playerMoved', (data) => {
      moveExplorationStateToLocation(data.locationId, data.x, data.y);
    });

    socket.on('explorationPlayersUpdated', (players) => {
      setWorldPlayers(players);
    });

    socket.on('explorationNpcStatesUpdated', (npcs) => {
      setWorldNpcs(npcs || []);
    });

    socket.on('playerActing', (data: { id: string; acting: boolean }) => {
      setWorldPlayers(prev => prev.map(p => p.id === data.id ? { ...p, acting: data.acting } : p));
    });

    socket.on('sceneImageShared', (data: { fromName: string; locationName: string; imageUrl: string }) => {
      setExplorationLog(prev => [...prev, { role: 'system', text: `🎨 ${data.fromName} visualized **${data.locationName}**`, imageUrl: data.imageUrl }]);
    });

    socket.on('explorationLockStatus', (status: {id: string; name: string; lockedIn: boolean}[]) => {
      setExplorationLockStatus(status);
      // If lock status cleared (player left, now solo), reset lock state
      if (status.length === 0) {
        setIsExplorationLockedIn(false);
      }
    });

    socket.on('explorationAllLockedIn', (data: { action: string; allActions: {playerId: string; playerName: string; action: string; locationId: string}[] }) => {
      console.log('[LOCK] All locked in! allActions:', data.allActions.length);
      setIsExplorationLockedIn(false);
      setIsExplorationProcessing(true);
      setExplorationError(null);
      setExplorationRetryAttempt(0);
      
      // Show all players' actions in the log
      for (const a of data.allActions) {
        if (a.playerId !== socket.id) {
          setExplorationLog(prev => [...prev, { role: 'user' as const, text: `🔒 ${a.action}`, playerName: a.playerName }]);
        }
      }
      // Server handles the unified AI call — results arrive via explorationStreamStart/Chunk/ActionResult
    });

    // Server-side AI streaming events
    socket.on('explorationStreamStart', (data: { requestId: string }) => {
      activeExplorationStreamIdRef.current = data.requestId;
      upsertExplorationStreamMessage(data.requestId, '');
    });

    socket.on('explorationStreamChunk', (data: { requestId: string; text: string }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      if (!data.text) return;
      upsertExplorationStreamMessage(data.requestId, data.text);
    });

    socket.on('explorationActionResult', (data: { requestId: string; text: string; toolCalls: any[] }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      activeExplorationStreamIdRef.current = null;
      console.log('[SERVER AI] Result received, text length:', data.text?.length, 'tools:', data.toolCalls?.length);
      setIsExplorationProcessing(false);
      setExplorationLockStatus([]);
      setExplorationRetryAttempt(0);
      setExplorationError(null);
      clearExplorationStatusMessage('exploration-retry');
      socket.emit('explorationActing', { acting: false });

      if (data.text) {
        upsertExplorationStreamMessage(data.requestId, data.text);
      } else {
        clearExplorationStreamMessage(data.requestId);
      }

      // Process tool calls locally
      if (data.toolCalls?.length > 0) {
        const toolBadges: string[] = [];
        for (const tc of data.toolCalls) {
          if (tc.name === 'update_player_state') {
            const args = tc.args as any;
            const changes: string[] = [];
            setExplorationState(prev => {
              const newState = { ...prev };
              if (args.hungerChange) { newState.hunger = Math.min(100, Math.max(0, prev.hunger + args.hungerChange)); changes.push(`hunger ${args.hungerChange > 0 ? '+' : ''}${args.hungerChange}`); }
              if (args.thirstChange) { newState.thirst = Math.min(100, Math.max(0, prev.thirst + args.thirstChange)); changes.push(`thirst ${args.thirstChange > 0 ? '+' : ''}${args.thirstChange}`); }
              if (args.staminaChange) { newState.stamina = Math.min(100, Math.max(0, prev.stamina + args.staminaChange)); changes.push(`stamina ${args.staminaChange > 0 ? '+' : ''}${args.staminaChange}`); }
              if (args.addItems) {
                try {
                  const items = typeof args.addItems === 'string' ? JSON.parse(args.addItems) : args.addItems;
                  const newInv = { ...newState.inventory };
                  for (const [k, v] of Object.entries(items)) {
                    newInv[k] = (newInv[k] || 0) + (v as number);
                    changes.push(`+${v} ${k}`);
                  }
                  newState.inventory = newInv;
                } catch (e) { console.error("Failed to parse addItems", e); }
              }
              if (args.removeItems) {
                try {
                  const items = typeof args.removeItems === 'string' ? JSON.parse(args.removeItems) : args.removeItems;
                  const newInv = { ...newState.inventory };
                  for (const [k, v] of Object.entries(items)) {
                    newInv[k] = Math.max(0, (newInv[k] || 0) - (v as number));
                    if (newInv[k] === 0) delete newInv[k];
                    changes.push(`-${v} ${k}`);
                  }
                  newState.inventory = newInv;
                } catch (e) { console.error("Failed to parse removeItems", e); }
              }
              if (args.equipWeapon) { newState.equippedWeapon = args.equipWeapon; changes.push(`equipped ${args.equipWeapon}`); }
              if (args.equipArmor) { newState.equippedArmor = args.equipArmor; changes.push(`equipped ${args.equipArmor}`); }
              return newState;
            });
            if (args.hpChange) {
              setCharacter(prev => prev ? { ...prev, hp: Math.min(prev.maxHp, Math.max(0, prev.hp + args.hpChange)) } : prev);
              changes.push(`hp ${args.hpChange > 0 ? '+' : ''}${args.hpChange}`);
            }
            if (args.manaChange) {
              setCharacter(prev => prev ? { ...prev, mana: Math.min(prev.maxMana, Math.max(0, prev.mana + args.manaChange)) } : prev);
              changes.push(`mana ${args.manaChange > 0 ? '+' : ''}${args.manaChange}`);
            }
            if (args.goldChange) {
              setCharacter(prev => prev ? { ...prev, gold: Math.max(0, prev.gold + args.goldChange) } : prev);
              changes.push(`gold ${args.goldChange > 0 ? '+' : ''}${args.goldChange}`);
            }
            if (changes.length > 0) {
              toolBadges.push(`📊 **Stats Updated** — ${changes.join(', ')}`);
            }
          } else if (tc.name === 'update_goals') {
            try {
              const goals = typeof tc.args.goals === 'string' ? JSON.parse(tc.args.goals) : tc.args.goals;
              if (Array.isArray(goals)) {
                setExplorationState(prev => ({ ...prev, goals: goals.slice(0, 5) }));
                toolBadges.push(`🎯 **Goals Updated** — refreshed quest objectives`);
              }
            } catch (e) { console.error("Failed to parse goals", e); }
          } else if (tc.name === 'trigger_combat') {
            const enemyName = tc.args.enemyName || 'Unknown Enemy';
            setExplorationCombatReturn(true);
            const enemyProfile = `# ${enemyName}\n\nA dangerous creature encountered in the wild.`;
            
            // Parse NPC allies
            let npcAllies: any[] = [];
            if (tc.args.npcAllyIds) {
              try {
                const allyIds = typeof tc.args.npcAllyIds === 'string' ? JSON.parse(tc.args.npcAllyIds) : tc.args.npcAllyIds;
                const wd = worldDataRef.current;
                npcAllies = (allyIds || []).map((npcId: string) => {
                  const npc = wd?.npcs?.[npcId];
                  return npc ? { id: npcId, name: npc.name, hp: 80, profileMarkdown: npc.profileMarkdown } : null;
                }).filter(Boolean);
              } catch (e) { console.error("Failed to parse npcAllyIds", e); }
            }
            
            // Build enemy profile from world data if available
            const wd = worldDataRef.current;
            const enemy = wd?.enemies?.[tc.args.enemyId];
            const fullProfile = enemy
              ? `# ${enemy.name}\n\n**HP:** ${enemy.hp}\n**Damage:** ${enemy.damage}\n\n${enemy.description}\n\n### Loot\n${enemy.loot?.map((l: string) => `- ${l}`).join('\n') || 'None'}`
              : enemyProfile;

            socket.emit('startBotMatch', {
              difficulty: 'Medium',
              botProfile: fullProfile,
              botName: enemyName,
              npcAllies
            });
            toolBadges.push(`⚔️ **Combat Initiated** — engaging ${enemyName}!`);
          } else if (tc.name === 'move_to_location') {
            const loc = worldDataRef.current?.locations?.find((l: any) => l.id === tc.args.locationId);
            if (loc) {
              moveExplorationStateToLocation(loc.id, loc.x, loc.y);
            }
            toolBadges.push(`🗺️ **Moved** — traveled to ${loc?.name || tc.args.locationId}`);
          } else if (tc.name === 'trigger_pvp_duel') {
            // Server already handled PVP — just show badge
            if (tc.args.surprisedPlayerName && tc.args.openingStrikeDamage) {
              toolBadges.push(`⚔️ **PVP Duel** — ${tc.args.targetPlayerName} was ambushed for ${tc.args.openingStrikeDamage} HP before the battle.`);
            } else {
              toolBadges.push(`⚔️ **PVP Duel** — ${tc.args.targetPlayerName}`);
            }
          } else if (tc.name === 'set_npc_follow_state') {
            const npcName = worldDataRef.current?.npcs?.[tc.args.npcId]?.name || tc.args.npcId;
            if (tc.args.mode === 'follow') {
              toolBadges.push(`🤝 **Follower Joined** — ${npcName} is now following ${tc.args.followPlayerName || 'you'}`);
            } else {
              toolBadges.push(`👋 **Follower Left** — ${npcName} returned to their own route`);
            }
          }
        }

        if (toolBadges.length > 0) {
          setExplorationLog(prev => [...prev, ...toolBadges.map(badge => ({ role: 'system' as const, text: badge }))]);
        }
      }

      // Survival: starvation/dehydration HP drain
      setExplorationState(prev => {
        let hpDrain = 0;
        if (prev.hunger <= 0) hpDrain += 5;
        if (prev.thirst <= 0) hpDrain += 5;
        if (hpDrain > 0) {
          setCharacter(c => c ? { ...c, hp: Math.max(0, c.hp - hpDrain) } : c);
          setExplorationLog(logs => [...logs, { role: 'system', text: `💀 You lost ${hpDrain} HP from ${prev.hunger <= 0 && prev.thirst <= 0 ? 'starvation and dehydration' : prev.hunger <= 0 ? 'starvation' : 'dehydration'}!` }]);
        }
        return prev;
      });
    });

    socket.on('explorationRetry', (data: { requestId: string; attempt: number; delay: number; label: string }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      setExplorationRetryAttempt(data.attempt);
      setExplorationError(`${data.label}. Retrying in ${data.delay}s...`);
      upsertExplorationStatusMessage('exploration-retry', `⚠️ ${data.label}. Retrying in **${data.delay}s**. Attempt **#${data.attempt}**...`);
      upsertExplorationStreamMessage(data.requestId, '');
    });

    socket.on('explorationActionError', (data: { requestId: string; message: string }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      activeExplorationStreamIdRef.current = null;
      setIsExplorationProcessing(false);
      setExplorationLockStatus([]);
      setExplorationRetryAttempt(0);
      setExplorationError(`Error: ${data.message}`);
      socket.emit('explorationActing', { acting: false });
      clearExplorationStreamMessage(data.requestId);
      upsertExplorationStatusMessage('exploration-retry', `⚠️ Exploration error: ${data.message}`);
    });

    socket.on('pvpChallengeReceived', (data: { challengerId: string; challengerName: string }) => {
      // Auto-accept PVP challenges — battles are unavoidable
      socket.emit('acceptPvpChallenge', { challengerId: data.challengerId });
      setExplorationLog(prev => [...prev, { role: 'system', text: `⚔️ ${data.challengerName} challenges you to battle!` }]);
    });

    socket.on('pvpChallengeDeclined', (data: { declinedBy: string }) => {
      setExplorationLog(prev => [...prev, { role: 'system', text: `${data.declinedBy} declined your challenge.` }]);
    });

    socket.on('explorationChatMessage', (data: { fromId: string; fromName: string; message: string }) => {
      setExplorationLog(prev => [...prev, { role: 'user' as const, text: data.message, playerName: data.fromName }]);
    });

    socket.on('tradeOfferReceived', (data: { offerId: string; fromName: string; text: string }) => {
      setExplorationLog(prev => [...prev, { role: 'system', text: `💱 ${data.text}` }]);
    });

    socket.on('tradeOfferUpdate', (data: { text: string }) => {
      setExplorationLog(prev => [...prev, { role: 'system', text: `💱 ${data.text}` }]);
    });

    return () => {
      socket.off('characterSaved');
      socket.off('waitingForOpponent');
      socket.off('matchFound');
      socket.off('battleActionsSubmitted');
      socket.off('opponentTyping');
      socket.off('playerLockedIn');
      socket.off('requestTurnResolution');
      socket.off('turnResolved');
      socket.off('battleEndedByInactivity');
      socket.off('opponentDisconnected');
      socket.off('battleImageShared');
      socket.off('turnTimerTick');
      socket.off('turnTimerAutoLocked');
      socket.off('error');
      socket.off('explorationStarted');
      socket.off('playerMoved');
      socket.off('explorationPlayersUpdated');
      socket.off('explorationNpcStatesUpdated');
      socket.off('playerActing');
      socket.off('sceneImageShared');
      socket.off('explorationLockStatus');
      socket.off('explorationAllLockedIn');
      socket.off('explorationStreamStart');
      socket.off('explorationStreamChunk');
      socket.off('explorationActionResult');
      socket.off('explorationActionError');
      socket.off('explorationRetry');
      socket.off('explorationChatMessage');
      socket.off('pvpChallengeReceived');
      socket.off('pvpChallengeDeclined');
      socket.off('tradeOfferReceived');
      socket.off('tradeOfferUpdate');
      socket.off('npcAllyAction');
    };
  }, []);

  // Check DB availability and load cloud characters on auth
  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => setDbAvailable(!!d.dbConnected)).catch(() => {});
  }, []);

  useEffect(() => {
    if (authToken) {
      // Load characters from cloud
      fetch('/api/account/characters', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
        .then(r => { if (!r.ok) throw new Error('Auth expired'); return r.json(); })
        .then(data => {
          if (data.characters?.length > 0) {
            const normalizedCharacters = normalizeCharacters(data.characters);
            setCharacters(normalizedCharacters);
            setCharacter(normalizedCharacters[data.activeCharacterIndex || 0] || normalizedCharacters[0]);
          }
        })
        .catch(() => {
          // Token expired, clear auth
          localStorage.removeItem('duo_auth_token');
          localStorage.removeItem('duo_auth_user');
          setAuthToken(null);
          setAuthUser(null);
        });
    }
  }, [authToken]);

  const handleAuth = async () => {
    setAuthError('');
    setAuthLoading(true);
    try {
      const res = await fetch(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authUsername, password: authPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Auth failed');
      
      localStorage.setItem('duo_auth_token', data.token);
      localStorage.setItem('duo_auth_user', data.displayName || data.username);
      setAuthToken(data.token);
      setAuthUser(data.displayName || data.username);
      setShowAuthModal(false);
      setAuthUsername('');
      setAuthPassword('');
      
      // If server returned characters, load them
      if (data.characters?.length > 0) {
        const normalizedCharacters = normalizeCharacters(data.characters);
        setCharacters(normalizedCharacters);
        setCharacter(normalizedCharacters[data.activeCharacterIndex || 0] || normalizedCharacters[0]);
      }
    } catch (e: any) {
      setAuthError(e.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('duo_auth_token');
    localStorage.removeItem('duo_auth_user');
    setAuthToken(null);
    setAuthUser(null);
  };

  // Sync characters to cloud when they change
  const syncCharactersToCloud = useCallback(async () => {
    if (!authToken || characters.length === 0) return;
    const activeIndex = character ? characters.findIndex(c => c.name === character.name) : 0;
    try {
      const res = await fetch('/api/account/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ characters, activeCharacterIndex: Math.max(0, activeIndex) })
      });
      if (!res.ok) console.error("[Sync] Failed:", res.status, await res.text());
      else console.log("[Sync] Characters synced to cloud successfully");
    } catch (e) {
      console.error("[Sync] Failed to sync characters to cloud", e);
    }
  }, [authToken, characters, character]);

  // Sync to cloud when characters change
  useEffect(() => {
    if (authToken && characters.length > 0) {
      const timeout = setTimeout(() => syncCharactersToCloud(), 1000);
      return () => clearTimeout(timeout);
    }
  }, [characters, authToken, syncCharactersToCloud]);

  const handleSendCharMessage = async () => {
    if (!inputText.trim() || isWaitingForChar) return;
    
    const sentText = inputText.trim();
    const newMessages = [...messages, { role: 'user' as const, text: sentText }];
    setMessages(newMessages);
    setInputText('');
    if (charInputRef.current) charInputRef.current.style.height = 'auto';
    setIsWaitingForChar(true);
    setCharCreatorError(null);
    setCharCreatorRetryAttempt(0);
    clearChatStatusMessage('char-creator-retry');
    
    const sysPromptRes = await fetch('/api/prompts/char_creator.txt');
    const sysPrompt = await sysPromptRes.text();

    let fullSysPrompt = sysPrompt;
    if (character) {
      fullSysPrompt += `\n\nExisting Character Profile (The user is tweaking this):\n${JSON.stringify(character)}\n\nIMPORTANT: The user is TWEAKING an existing character. Ask clarifying questions about what they want to change before outputting a new state. Do NOT jump straight to creating — iterate with the user. When you do save the character, this is an UPDATE, not a creation.`;
    }

    // Function declaration for native tool calling
    const saveCharacterTool = {
      name: "save_character",
      description: "Save or update the character state. Call this when the character is fully defined.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "The character's name" },
          hp: { type: "INTEGER", description: "Current HP (default 100)" },
          maxHp: { type: "INTEGER", description: "Max HP (default 100)" },
          mana: { type: "INTEGER", description: "Current Mana (default 100)" },
          maxMana: { type: "INTEGER", description: "Max Mana (default 100)" },
          gold: { type: "INTEGER", description: `Current gold coins (default ${DEFAULT_STARTING_GOLD})` },
          profileMarkdown: { type: "STRING", description: "Comprehensive markdown character profile with stats, abilities, inventory, etc." }
        },
        required: ["name", "hp", "maxHp", "mana", "maxMana", "profileMarkdown"]
      }
    };

    // Format history for Gemini
    const contents = newMessages.map(m => `${m.role === 'user' ? 'User' : 'Model'}: ${m.text}`).join('\n');
    const aiClient = getAIClient();

    const charApiConfig = {
      model: settingsRef.current.charModel,
      contents: contents,
      config: {
        systemInstruction: fullSysPrompt,
        temperature: 0.7,
        thinkingConfig: { includeThoughts: true },
        tools: [{ functionDeclarations: [saveCharacterTool as any] }]
      },
    };

    let attempts = 0;

    while (true) {
      setCharCreatorError(null);
      setCharCreatorRetryAttempt(attempts);

      try {
        const responseStream = await aiClient.models.generateContentStream(charApiConfig);
        
        let fullText = "";
        let currentModelMessage = "";
        let toolCallData: any = null;
        
        // Add a placeholder for the model's response
        setMessages(prev => [...prev, { role: 'model', text: "" }]);
        
        for await (const chunk of responseStream) {
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.functionCall) {
              toolCallData = part.functionCall;
            } else if ((part as any).thought) {
              // Skip thought parts
            } else {
              fullText += (part as any).text || "";
            }
          }
          
          const displayText = fullText.trim();
          if (displayText !== currentModelMessage) {
            currentModelMessage = displayText;
            setMessages(prev => {
              const newMsgs = [...prev];
              newMsgs[newMsgs.length - 1] = { role: 'model', text: displayText };
              return newMsgs;
            });
          }
        }
        
        // Handle tool call (native function calling)
        if (toolCallData && toolCallData.name === 'save_character') {
          const state = toolCallData.args as any;
          socket.emit('characterCreated', {
            name: state.name,
            hp: state.hp || 100,
            maxHp: state.maxHp || 100,
            mana: state.mana || 100,
            maxMana: state.maxMana || 100,
            gold: state.gold ?? DEFAULT_STARTING_GOLD,
            profileMarkdown: state.profileMarkdown || ""
          });
        } else {
          // Fallback: check for XML tags in case the model didn't use tool calling
          const stateMatch = fullText.match(/<CHAR_STATE>([\s\S]*?)<\/CHAR_STATE>/);
          if (stateMatch) {
            try {
              const state = JSON.parse(stateMatch[1]);
              socket.emit('characterCreated', normalizeCharacter(state));
            } catch (e) {
              console.error("Failed to parse char state", e);
            }
          }
        }

        // Success
        clearChatStatusMessage('char-creator-retry');
        setCharCreatorRetryAttempt(0);
        setCharCreatorError(null);
        break;

      } catch (error: any) {
        console.error("Error creating character:", error);

        const errorInfo = classifyAIError(error);

        if (errorInfo.retryable) {
          // Remove the empty model placeholder from failed attempt
          setMessages(prev => {
            const newMsgs = [...prev];
            if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'model' && !newMsgs[newMsgs.length - 1].text) {
              newMsgs.pop();
            }
            return newMsgs;
          });
          attempts++;
          const delay = getAIRetryDelaySeconds(attempts);
          setCharCreatorRetryAttempt(attempts);
          setCharCreatorError(`${errorInfo.label}. Retrying in ${delay}s...`);
          upsertChatStatusMessage('char-creator-retry', `⚠️ ${errorInfo.label}. Retrying in **${delay}s**. Attempt **#${attempts}**...`);
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          continue;
        }

        const formattedError = formatAIError(errorInfo);
        const errorMsg = `[SYSTEM ERROR]: Failed to generate response using model ${settingsRef.current.charModel}. ${formattedError}`;
        setMessages(prev => {
          const newMsgs = [...prev];
          if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'model' && !newMsgs[newMsgs.length - 1].text) {
            newMsgs.pop();
          }
          return [...newMsgs, { role: 'system', text: errorMsg }];
        });
        setCharCreatorRetryAttempt(0);
        setCharCreatorError(formattedError);
        upsertChatStatusMessage('char-creator-retry', `⚠️ Character creator error: ${formattedError}`);
        break;
      }
    }

    setIsWaitingForChar(false);
  };

  // ============ EXPLORATION HANDLERS ============

  const getCurrentLocation = (): WorldLocation | null => {
    if (!worldData) return null;
    return worldData.locations.find((l: WorldLocation) => l.id === explorationState.locationId) || null;
  };

  const getConnectedLocations = (): WorldLocation[] => {
    if (!worldData) return [];
    const current = getCurrentLocation();
    if (!current) return [];
    return current.connections
      .map((id: string) => worldData.locations.find((l: WorldLocation) => l.id === id))
      .filter(Boolean);
  };

  const handleEnterExploration = () => {
    if (!character) {
      setActiveTab('profile');
      setGameState('char_creation');
      return;
    }
    socket.emit('enterExploration', {});
    setGameState('exploration');
    setExplorationLog([]);
    setExplorationState(prev => ({
      ...prev,
      hunger: 100,
      thirst: 100,
      stamina: 100,
      inventory: {},
      goals: ['Find a water source', 'Talk to a local', 'Gather some wood', 'Explore a new area', 'Craft your first tool'],
    }));
  };

  const handleExplorationMove = (locationId: string) => {
    socket.emit('moveToLocation', { locationId });
    setIsExplorationLockedIn(false);
    setExplorationLockStatus([]);
    
    setExplorationState(prev => ({
      ...prev,
      stamina: Math.max(0, prev.stamina - 5),
      hunger: Math.max(0, prev.hunger - 3),
      thirst: Math.max(0, prev.thirst - 4),
    }));

    const location = worldData?.locations?.find((l: WorldLocation) => l.id === locationId);
    if (location) {
      // Instant movement — just update log with a system message, no LLM call
      setExplorationLog(prev => [...prev, { role: 'system', text: `🗺️ Moved to **${location.name}**` }]);
    }
  };

  // Exploration actions are now handled server-side via socket events
  // (explorationAction for solo, explorationLockIn for multiplayer)

  // Exploration AI is now handled entirely server-side

  const getExplorationContext = () => ({
    apiKey: settingsRef.current.apiKey?.trim() || '',
    model: settingsRef.current.explorationModel,
    explorationState,
    recentLog: explorationLog.slice(-10).map(m => `${m.role === 'user' ? 'Player' : 'Guide'}: ${m.text}`)
  });

  const isImmediateExplorationAction = (action: string) => {
    const normalized = action.toLowerCase();
    const directTradeVerb = /^(?:buy|purchase|sell|offer|trade|accept(?:\s+trade)?|decline(?:\s+trade)?)/i;
    if (directTradeVerb.test(normalized)) return true;
    return false;
  };

  const handleExplorationSend = () => {
    const action = explorationInput.trim();
    if (!action || isExplorationProcessing || isExplorationLockedIn) return;
    
    // Detect chat messages — bypass LLM and broadcast directly
    const chatMatch = action.match(/^(?:i\s+(?:say|chat|tell|shout|whisper|yell|call\s+out)|".*"$|'.*'$)/i);
    if (chatMatch) {
      // Extract the spoken text
      let chatText = action;
      // Remove "I say/chat/tell..." prefix to get the actual message
      const prefixMatch = action.match(/^i\s+(?:say|chat|tell|shout|whisper|yell|call\s+out)\s*(?:to\s+\w+\s*)?[":]\s*/i);
      if (prefixMatch) {
        chatText = action.slice(prefixMatch[0].length).replace(/^["']|["']$/g, '');
      } else {
        chatText = action.replace(/^["']|["']$/g, '');
      }
      
      setExplorationInput('');
      if (explorationInputRef.current) explorationInputRef.current.style.height = 'auto';
      
      // Show locally as own chat message
      setExplorationLog(prev => [...prev, { role: 'user' as const, text: chatText }]);
      // Broadcast to nearby players
      socket.emit('explorationChat', { message: chatText });
      return;
    }
    
    setExplorationInput('');
    if (explorationInputRef.current) explorationInputRef.current.style.height = 'auto';
    
    const othersHere = worldPlayers.filter(p => p.id !== socket.id && p.locationId === explorationState.locationId);
    const isImmediateAction = isImmediateExplorationAction(action);
    if (othersHere.length > 0 && !isImmediateAction) {
      // Multiplayer: lock in action and wait for others
      setIsExplorationLockedIn(true);
      setExplorationLog(prev => [...prev, { role: 'user', text: `🔒 ${action}` }]);
      socket.emit('explorationLockIn', { action, ...getExplorationContext() });
    } else {
      // Solo or immediate deterministic action: send action to server now
      setExplorationLog(prev => [...prev, { role: 'user', text: action }]);
      setIsExplorationProcessing(true);
      setExplorationError(null);
      setExplorationRetryAttempt(0);
      clearExplorationStatusMessage('exploration-retry');
      socket.emit('explorationActing', { acting: true });
      socket.emit('explorationAction', { action, ...getExplorationContext() });
    }
  };

  const handleExplorationUnlock = () => {
    setIsExplorationLockedIn(false);
    socket.emit('explorationUnlock');
    // Remove the last locked-in user message
    setExplorationLog(prev => {
      const logs = [...prev];
      for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].role === 'user' && logs[i].text.startsWith('🔒 ')) {
          const originalText = logs[i].text.slice(2).trim();
          logs.splice(i, 1);
          setExplorationInput(originalText);
          break;
        }
      }
      return logs;
    });
  };

  const handleGenerateCharImage = async () => {
    if (!character || isGeneratingCharImage) return;
    setIsGeneratingCharImage(true);
    console.log("[Portrait] Starting generation for:", character.name);
    setMessages(prev => [...prev, { role: 'system', text: '🎨 Generating portrait... this may take a moment.' }]);
    try {
      const aiClient = getAIClient();
      const prompt = `Generate a fantasy character portrait for: ${character.name}. ${character.profileMarkdown.substring(0, 500)}. Style: detailed digital art, fantasy RPG character portrait, vibrant colors.`;
      
      console.log("[Portrait] Sending request to gemini-3.1-pro-image-preview");
      const response = await aiClient.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: prompt,
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      console.log("[Portrait] Response received, checking parts...");
      const parts = response.candidates?.[0]?.content?.parts || [];
      console.log("[Portrait] Parts count:", parts.length);
      for (const part of parts) {
        if ((part as any).inlineData) {
          const imageData = (part as any).inlineData;
          const imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
          setCharacter(prev => prev ? { ...prev, imageUrl } : prev);
          // Remove the "generating" message and add success
          setMessages(prev => {
            const filtered = prev.filter(m => m.text !== '🎨 Generating portrait... this may take a moment.');
            return [...filtered, { role: 'system', text: '🎨 Portrait generated!', imageUrl }];
          });
          console.log("[Portrait] Success! Image generated.");
          return;
        }
      }
      console.warn("[Portrait] No image data in response parts:", parts.map(p => Object.keys(p)));
      setMessages(prev => [...prev, { role: 'system', text: '⚠️ No image was generated. Try again.' }]);
    } catch (error: any) {
      console.error("[Portrait] Generation error:", error);
      setMessages(prev => [...prev, { role: 'system', text: `⚠️ Image generation failed: ${error.message}` }]);
    } finally {
      setIsGeneratingCharImage(false);
    }
  };

  const handleVisualizeScene = async () => {
    if (!worldData || !explorationState.locationId || isVisualizingScene) return;
    const loc = getCurrentLocation();
    if (!loc) return;
    setIsVisualizingScene(true);
    
    try {
      const aiClient = getAIClient();
      const prompt = `Generate a scenic landscape illustration of: ${loc.name}. ${loc.description}. Style: fantasy RPG environment art, wide landscape, atmospheric lighting, detailed.`;
      
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: prompt,
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if ((part as any).inlineData) {
          const imageData = (part as any).inlineData;
          const imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
          setExplorationLog(prev => [...prev, { role: 'system', text: `🎨 Scene: **${loc.name}**`, imageUrl }]);
          // Share with other players at the same location
          socket.emit('shareSceneImage', { locationId: explorationState.locationId, imageUrl, locationName: loc.name });
          return;
        }
      }
    } catch (error: any) {
      console.error("Scene visualization error:", error);
      setExplorationLog(prev => [...prev, { role: 'system', text: `[ERROR]: Scene visualization failed: ${error.message}` }]);
    } finally {
      setIsVisualizingScene(false);
    }
  };

  // ============ END EXPLORATION HANDLERS ============

  const handleGenerateBattleImage = async () => {
    if (isGeneratingBattleImage || hasVisualizedThisTurn) return;
    setIsGeneratingBattleImage(true);
    try {
      const aiClient = getAIClient();
      // Get the last few battle log entries for scene context
      const recentLogs = battleLogs
        .filter(l => !l.startsWith('STREAMING_') && !l.startsWith('>') && !l.startsWith('PLAYER_ACTIONS_') && !l.startsWith(BATTLE_PENDING_ACTION_PREFIX))
        .slice(-3)
        .join('\n')
        .substring(0, 500);
      const playerNames = Object.values(players).map((p: any) => p.character.name).join(' vs ');
      const prompt = `Generate a dynamic battle scene illustration: ${playerNames}. Recent events: ${recentLogs}. Style: fantasy RPG battle art, dramatic action poses, magical effects, vibrant colors.`;
      
      const response = await aiClient.models.generateContent({
        model: 'gemini-3.1-pro-image-preview',
        contents: prompt,
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if ((part as any).inlineData) {
          const imageData = (part as any).inlineData;
          const imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
          setBattleLogs(prev => [...prev, `STATUS_IMAGE::🎨 **${character?.name || 'You'}** visualized the scene`, `STATUS_IMAGE_URL::${imageUrl}`]);
          setHasVisualizedThisTurn(true);
          // Share with opponent
          if (roomId) {
            socket.emit('shareBattleImage', { roomId, imageUrl });
          }
          return;
        }
      }
    } catch (error: any) {
      console.error("Battle image error:", error);
    } finally {
      setIsGeneratingBattleImage(false);
    }
  };
  handleGenerateBattleImageRef.current = handleGenerateBattleImage;

  const handleBattleUnlock = () => {
    socket.emit('playerUnlock');
    setIsLockedIn(false);
  };

  const handleEnterArena = () => {
    if (!character) {
      setActiveTab('profile');
      setGameState('char_creation');
      if (messages.length === 0) {
        setMessages([{ role: 'model', text: "Welcome to the Arena! What kind of character do you want to create?" }]);
      }
      return;
    }
    socket.emit('enterArena');
  };

  const handleNewCharacter = () => {
    setCharacter(null);
    setMessages([{ role: 'model', text: "Let's build a new legend. What kind of character do you want to create?" }]);
    setGameState('char_creation');
    setActiveTab('profile');
  };

  const handleSelectCharacter = (name: string) => {
    const selected = characters.find(c => c.name === name);
    if (selected) {
      setCharacter(selected);
      setMessages([{ role: 'model', text: `Switched to ${selected.name}. Ready for action!` }]);
    }
  };

  const handleSendBattleAction = () => {
    const action = battleInput.trim();
    if (!action || isLockedIn) return;

    const socketId = socket.id;
    if (socketId) {
      setBattleLogs(prev => [...removePendingBattleActionLogs(prev, socketId), buildPendingBattleActionLog(socketId, action)]);
    }

    socket.emit('playerAction', action);
    setIsLockedIn(true);
    setBattleInput('');
    if (battleInputRef.current) battleInputRef.current.style.height = 'auto';
  };

  const handleTyping = () => {
    socket.emit('typing');
  };

  const getThoughtTitle = (content: string) => {
    const lines = content.split('\n').filter(l => l.trim());
    // Look for the last header-like line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#') || (line.startsWith('**') && line.endsWith('**'))) {
        return line.replace(/[#*]/g, '').trim();
      }
    }
    // Fallback to first few words of last line
    const lastLine = lines[lines.length - 1] || "Thinking...";
    const words = lastLine.replace(/[#*]/g, '').trim().split(' ');
    if (words.length <= 4) return words.join(' ');
    return words.slice(0, 4).join(' ') + '...';
  };

  const renderTopBar = () => {
    // If in battle, show battle stats, else show own stats
    let hp = 100;
    let mana = 100;
    let gold = DEFAULT_STARTING_GOLD;
    let charName = 'No Character';
    const currentBattlePlayer = socket.id ? players[socket.id] : undefined;

    if (gameState === 'battle' && currentBattlePlayer) {
      hp = currentBattlePlayer.character.hp;
      mana = currentBattlePlayer.character.mana;
      gold = currentBattlePlayer.character.gold ?? character?.gold ?? DEFAULT_STARTING_GOLD;
      charName = currentBattlePlayer.character.name;
    } else if (character) {
      hp = character.hp;
      mana = character.mana;
      gold = character.gold;
      charName = character.name;
    }

    return (
      <div className="sticky top-0 z-20 bg-white border-b-2 border-duo-gray shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-duo-gray-dark font-bold">
            {(gameState === 'battle' || gameState === 'post_match') && (
              <button onClick={() => {
                setGameState('menu');
                socket.emit('leaveQueue');
              }} className="mr-1 hover:text-duo-blue transition-colors">
                <ArrowLeft className="w-6 h-6" />
              </button>
            )}
            <Shield className="w-6 h-6" />
            <span className="uppercase text-sm truncate max-w-[120px]">{charName}</span>
          </div>
          <div className="flex items-center gap-4 font-bold text-lg">
            <div className="flex items-center gap-1 text-amber-500">
              <Coins className="w-6 h-6" />
              <span>{gold}</span>
            </div>
            <div className="flex items-center gap-1 text-fuchsia-600">
              <Orbit className="w-6 h-6" />
              <span>{mana}</span>
            </div>
            <div className="flex items-center gap-1 text-duo-red">
              <Heart className="w-6 h-6 fill-current" />
              <span>{hp}</span>
            </div>
            <button onClick={() => setShowSettings(true)} className="text-duo-gray-dark hover:text-duo-blue transition-colors ml-2">
              <Settings className="w-6 h-6" />
            </button>
          </div>
        </div>
        {gameState === 'battle' && (
          <>
            <div className="px-4 py-2 border-t border-duo-gray/30 flex flex-wrap gap-2">
              {Object.keys(players).map(id => {
                const p = players[id];
                const isMe = id === socket.id;
                return (
                  <div key={id} className="flex-1 min-w-[120px] space-y-1">
                    <div className="flex justify-between text-[10px] font-bold text-duo-gray-dark uppercase gap-2 items-center">
                      <button 
                        onClick={() => {
                          setProfileToView(p.character.profileMarkdown);
                          setShowProfileModal(true);
                        }}
                        className="truncate flex-1 hover:text-duo-blue transition-colors text-left"
                      >
                        {isMe ? 'You' : p.character.name}
                      </button>
                      <div className="flex gap-2 whitespace-nowrap">
                        <span className="text-duo-blue">{p.character.mana} MNA</span>
                        <span>{p.character.hp} HP</span>
                      </div>
                    </div>
                    <div className="h-2 bg-duo-gray rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${isMe ? 'bg-duo-green' : 'bg-duo-red'}`}
                        style={{ width: `${Math.max(0, p.character.hp)}%` }} 
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-2 py-1 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-duo-gray/50 bg-gray-50/50">
            </div>
          </>
        )}
      </div>
    );
  };

  const renderBottomBar = () => {
    if (gameState === 'battle' || gameState === 'matchmaking' || gameState === 'exploration' || gameState === 'level_select') return null;

    return (
      <div className="w-full max-w-md bg-white border-t-2 border-duo-gray flex justify-around py-3 pb-safe mt-auto">
        <button 
          onClick={() => { setActiveTab('home'); setGameState('menu'); }}
          className={`flex flex-col items-center gap-1 ${activeTab === 'home' ? 'text-duo-green' : 'text-duo-gray-dark'}`}
        >
          <Home className={`w-8 h-8 ${activeTab === 'home' ? 'fill-current' : ''}`} />
        </button>
        <button 
          onClick={() => { 
            setActiveTab('profile'); 
            setGameState('char_creation');
            if (messages.length === 0) {
              setMessages([{ role: 'model', text: "Welcome to the Arena! What kind of character do you want to create?" }]);
            }
            setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
          }}
          className={`flex flex-col items-center gap-1 ${activeTab === 'profile' ? 'text-duo-green' : 'text-duo-gray-dark'}`}
        >
          <User className={`w-8 h-8 ${activeTab === 'profile' ? 'fill-current' : ''}`} />
        </button>
        <button 
          onClick={() => setActiveTab('social')}
          className={`flex flex-col items-center gap-1 ${activeTab === 'social' ? 'text-duo-green' : 'text-duo-gray-dark'}`}
        >
          <Users className={`w-8 h-8 ${activeTab === 'social' ? 'fill-current' : ''}`} />
        </button>
      </div>
    );
  };

  const handleGenerateBot = async () => {
    setIsGeneratingBot(true);
    try {
      const aiClient = getAIClient();
      const prompt = `Generate a new, unique character for a text-based PvP game. 
Return ONLY the markdown profile.
It must start with "# [Character Name]".
Include Class, Description, Abilities (3), and Inventory (3 items).
Be creative and concise.`;

      const response = await aiClient.models.generateContent({
        model: settingsRef.current.charModel,
        contents: prompt,
        config: {
          temperature: 0.9,
        },
      });

      const content = response.text || "";
      const nameMatch = content.match(/^#\s+(.+)$/m);
      const name = nameMatch ? nameMatch[1].trim() : `Bot_${Date.now()}`;

      const res = await fetch('/api/bot_characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content })
      });
      const newChar = await res.json();
      
      setBotCharacters(prev => [...prev, newChar]);
      setSelectedBotCharacter(newChar.id);
    } catch (err: any) {
      console.error("Failed to generate bot", err);
      alert(`Failed to generate bot using model ${settingsRef.current.botModel}. Error: ${err.message}`);
    } finally {
      setIsGeneratingBot(false);
    }
  };

  const renderMenu = () => (
    <div className="flex-1 flex flex-col items-center p-6 gap-8 overflow-y-auto">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-black text-duo-text tracking-tight">Arena Clash</h1>
        <p className="text-duo-gray-dark font-bold">Learn to fight. Forever.</p>
      </div>

      <div className="flex flex-col gap-6 w-full max-w-xs">
        <div className="flex flex-col items-center gap-3">
          <div 
            className="w-24 h-24 rounded-full bg-duo-gray flex items-center justify-center border-4 border-white shadow-md overflow-hidden cursor-pointer"
            onClick={() => character?.imageUrl && setShowCharImage(true)}
          >
            {character?.imageUrl ? (
              <img src={character.imageUrl} alt={character.name} className="w-full h-full object-cover" />
            ) : (
              <User className="w-12 h-12 text-duo-gray-dark" />
            )}
          </div>
          {character && (
            <button
              onClick={handleGenerateCharImage}
              disabled={isGeneratingCharImage}
              className="text-[10px] font-bold text-duo-blue hover:underline disabled:opacity-50 flex items-center gap-1"
            >
              {isGeneratingCharImage ? <><Loader2 className="w-3 h-3 animate-spin" /> Generating...</> : '🎨 Generate Portrait'}
            </button>
          )}
          
          {characters.length > 0 && (
            <div className="w-full space-y-2">
              <label className="block text-xs font-black text-duo-gray-dark uppercase tracking-wider text-center">Active Legend</label>
              <div className="flex gap-2">
                <select 
                  value={character?.name || ''}
                  onChange={(e) => handleSelectCharacter(e.target.value)}
                  className="flex-1 bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none border-b-4 border-gray-200"
                >
                  {characters.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
                {character && (
                  <button 
                    onClick={() => {
                      setProfileToView(character.profileMarkdown);
                      setShowProfileModal(true);
                    }}
                    className="p-2 bg-duo-gray rounded-xl border-b-4 border-gray-200 text-duo-blue hover:bg-gray-100"
                    title="View Profile"
                  >
                    <Info className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2 w-full">
            <button 
              onClick={() => {
                setActiveTab('profile');
                setGameState('char_creation');
                if (messages.length === 0) {
                  setMessages([{ role: 'model', text: "Welcome back! How should we tweak your legend?" }]);
                }
              }}
              className="duo-btn duo-btn-blue flex-1 py-3 text-sm"
            >
              {character ? 'Tweak' : 'Create'}
            </button>
            <button 
              onClick={handleNewCharacter}
              className="duo-btn duo-btn-blue flex-1 py-3 text-sm"
            >
              New
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div className="w-24 h-24 rounded-full bg-duo-gray flex items-center justify-center border-4 border-white shadow-md">
            <Sword className="w-12 h-12 text-duo-gray-dark" />
          </div>
          <button 
            onClick={handleEnterArena}
            disabled={!!character && !isSynced}
            className="duo-btn duo-btn-green w-full py-3 text-lg disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {character && !isSynced && <Loader2 className="w-5 h-5 animate-spin" />}
            {character && !isSynced ? 'Syncing...' : 'Enter Arena'}
          </button>
          <button 
            onClick={() => setShowBotModal(true)}
            disabled={!!character && !isSynced}
            className="duo-btn duo-btn-blue w-full py-3 text-lg mt-2 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {character && !isSynced && <Loader2 className="w-5 h-5 animate-spin" />}
            {character && !isSynced ? 'Syncing...' : 'Play vs Bot'}
          </button>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div className="w-24 h-24 rounded-full bg-duo-gray flex items-center justify-center border-4 border-white shadow-md">
            <Compass className="w-12 h-12 text-duo-gray-dark" />
          </div>
          <button 
            onClick={handleEnterExploration}
            disabled={!character || (character && !isSynced)}
            className="duo-btn duo-btn-green w-full py-3 text-lg disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {character && !isSynced && <Loader2 className="w-5 h-5 animate-spin" />}
            Explore World
          </button>
          <button
            onClick={() => setGameState('level_select')}
            disabled={!character}
            className="duo-btn duo-btn-blue w-full py-3 text-lg disabled:opacity-50 flex items-center justify-center gap-2"
          >
            Level Path
          </button>
        </div>
      </div>

      {showBotModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-gray-200">
            <h3 className="text-2xl font-black text-duo-text mb-6 text-center">Bot Match</h3>
            
            <div className="mb-6">
              <label className="block text-sm font-bold text-duo-gray-dark mb-2">Select Persona</label>
              <div className="flex gap-2">
                <select 
                  value={selectedBotCharacter}
                  onChange={e => setSelectedBotCharacter(e.target.value)}
                  className="flex-1 bg-duo-gray rounded-xl px-3 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                >
                  {botCharacters.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button 
                  onClick={() => {
                    const selectedChar = botCharacters.find(c => c.id === selectedBotCharacter);
                    if (selectedChar) {
                      setProfileToView(selectedChar.content);
                      setShowProfileModal(true);
                    }
                  }}
                  disabled={!selectedBotCharacter}
                  className="duo-btn duo-btn-blue px-4 flex items-center justify-center disabled:opacity-50"
                  title="View Profile"
                >
                  <Info className="w-5 h-5" />
                </button>
                <button 
                  onClick={handleGenerateBot}
                  disabled={isGeneratingBot}
                  className="duo-btn duo-btn-blue px-4 flex items-center justify-center disabled:opacity-50"
                  title="Generate New Persona"
                >
                  {isGeneratingBot ? <Loader2 className="w-5 h-5 animate-spin" /> : <User className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="mb-8 px-2">
              <label className="block text-sm font-bold text-duo-gray-dark mb-4">Difficulty</label>
              <input 
                type="range" 
                min="0" 
                max="3" 
                step="1"
                value={botDifficulty}
                onChange={(e) => setBotDifficulty(parseInt(e.target.value))}
                className="w-full h-4 bg-duo-gray rounded-full appearance-none cursor-pointer accent-duo-blue"
              />
              <div className="flex justify-between mt-4 text-sm font-bold text-duo-gray-dark">
                <span className={botDifficulty === 0 ? 'text-duo-blue' : ''}>Easy</span>
                <span className={botDifficulty === 1 ? 'text-duo-blue' : ''}>Med</span>
                <span className={botDifficulty === 2 ? 'text-duo-blue' : ''}>Hard</span>
                <span className={botDifficulty === 3 ? 'text-duo-blue' : ''}>God</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={() => setShowBotModal(false)}
                className="duo-btn duo-btn-gray flex-1 py-3"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  setShowBotModal(false);
                  const selectedChar = botCharacters.find(c => c.id === selectedBotCharacter);
                  socket.emit('startBotMatch', {
                    difficulty: difficultyLabels[botDifficulty],
                    botProfile: selectedChar?.content,
                    botName: selectedChar?.name
                  });
                }}
                disabled={!selectedBotCharacter}
                className="duo-btn duo-btn-green flex-1 py-3 disabled:opacity-50"
              >
                Start Match
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderCharCreation = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-4 bg-white border-b-2 border-duo-gray flex justify-between items-center">
        <button 
          onClick={() => setGameState('menu')}
          className="text-duo-gray-dark hover:text-duo-text flex items-center gap-1 font-bold"
        >
          <ArrowLeft className="w-5 h-5" /> Back
        </button>
        <h2 className="text-lg font-black text-duo-text">Character Architect</h2>
        {character ? (
          <button 
            onClick={() => {
              setProfileToView(character.profileMarkdown);
              setShowProfileModal(true);
            }}
            className="text-duo-blue hover:text-duo-blue-dark flex items-center gap-1 font-bold text-sm"
          >
            <Info className="w-4 h-4" /> Profile
          </button>
        ) : <div className="w-16" />}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, i) => {
          if (!msg.text && msg.role === 'model') return null;
          return (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'system' ? (
                <div className="w-full text-center text-sm font-bold text-red-500 bg-red-50 border border-red-100 rounded-lg py-2 px-4 my-2">
                  {msg.text}
                </div>
              ) : (
                <div className={msg.role === 'user' ? 'chat-bubble-me' : 'chat-bubble-them'}>
                  <div className="markdown-body">
                    <Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {isWaitingForChar && (messages.length === 0 || messages[messages.length - 1].role === 'user' || !messages[messages.length - 1].text) && (
          <div className="flex justify-start">
            <div className="chat-bubble-them flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="font-bold text-sm">Thinking...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="p-4 bg-white border-t-2 border-duo-gray flex gap-2">
        <textarea
          ref={charInputRef}
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendCharMessage();
            }
          }}
          placeholder="Type your response..."
          className="flex-1 bg-duo-gray rounded-2xl px-4 py-3 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue resize-none overflow-y-auto"
          rows={1}
          style={{ minHeight: '48px', maxHeight: '50vh' }}
        />
        <button 
          onClick={handleSendCharMessage}
          disabled={isWaitingForChar || !inputText.trim()}
          className="duo-btn duo-btn-blue px-6 flex items-center justify-center disabled:opacity-50"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );

  const renderMatchmaking = () => (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gray-50 relative">
      <h2 className="text-2xl font-black text-duo-gray-dark uppercase mb-8 tracking-wider">Arena Queue</h2>
      
      <div className="flex flex-wrap justify-center gap-6 mb-20">
        {queuePlayers.map(p => (
          <div key={p.id} className="relative flex flex-col items-center gap-2">
            {/* Blur background if ready */}
            {p.isReady && (
              <div className="absolute inset-0 bg-duo-green blur-xl opacity-50 rounded-full" />
            )}
            
            <div className={`relative w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold border-4 transition-colors ${p.isReady ? 'bg-duo-green/20 border-duo-green text-duo-green' : 'bg-white border-duo-gray text-duo-gray-dark'}`}>
              {p.character.name.charAt(0).toUpperCase()}
              {p.isReady && (
                <div className="absolute inset-0 bg-duo-green/20 rounded-full" />
              )}
            </div>
            <span className="text-xs font-bold text-duo-gray-dark truncate max-w-[80px] text-center">
              {p.character.name}
            </span>
          </div>
        ))}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-white border-t-2 border-duo-gray">
        <button 
          onClick={() => socket.emit('lockInQueue')}
          disabled={queuePlayers.find(p => p.id === socket.id)?.isReady}
          className="w-full duo-button-green py-4 text-lg"
        >
          {queuePlayers.find(p => p.id === socket.id)?.isReady ? 'READY' : 'START'}
        </button>
        <button 
          onClick={() => { socket.emit('leaveQueue'); setGameState('menu'); }}
          className="w-full mt-2 duo-button-gray py-2"
        >
          Leave Queue
        </button>
      </div>
    </div>
  );

  const renderBattle = () => {
    return (
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <h1 className="text-2xl font-black text-duo-text mb-2">{explorationCombatReturn && getCurrentLocation()?.name ? `⚔️ ${getCurrentLocation()?.name}` : 'The Battle'}</h1>
          {battleLogs.map((log, i) => {
            const isStreamingThoughts = log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX);
            const isStreamingAnswer = log.startsWith(BATTLE_STREAM_ANSWER_PREFIX);
            const isThoughts = log.startsWith("> **Judge's Thoughts:**") || isStreamingThoughts;
            const isStatusLog = log.startsWith('STATUS_');
            const isImageUrl = log.startsWith('STATUS_IMAGE_URL::');
            
            // Check if it's a Player Actions bubble
            const isPlayerActions = log.startsWith(BATTLE_PLAYER_ACTIONS_PREFIX);
            const isPendingPlayerAction = log.startsWith(BATTLE_PENDING_ACTION_PREFIX);
            const isNpcAllyAction = log.startsWith('NPC_ALLY_ACTION_');
            
            let content = log;
            if (isStatusLog && !isImageUrl) content = log.replace(/^STATUS_[^:]+::/, '');
            if (isImageUrl) content = log.substring('STATUS_IMAGE_URL::'.length);
            if (isPlayerActions) content = log.substring(BATTLE_PLAYER_ACTIONS_PREFIX.length);
            if (isPendingPlayerAction) content = log.substring(log.indexOf('::') + 2);
            if (isNpcAllyAction) content = log.substring('NPC_ALLY_ACTION_'.length);
            if (isStreamingThoughts) content = log.substring(BATTLE_STREAM_THOUGHTS_PREFIX.length);
            if (isStreamingAnswer) content = log.substring(BATTLE_STREAM_ANSWER_PREFIX.length);

            if (isImageUrl) {
              return (
                <div key={i} className="rounded-lg overflow-hidden border-2 border-duo-gray shadow-md my-2">
                  <img src={content} alt="Battle Scene" className="w-full" />
                </div>
              );
            }

            if (isStatusLog) {
              return (
                <div key={i} className="flex justify-start">
                  <div className="chat-bubble-them max-w-[85%]">
                    <div className="markdown-body text-sm">
                      <Markdown rehypePlugins={[rehypeRaw]}>{content}</Markdown>
                    </div>
                  </div>
                </div>
              );
            }

            if (isNpcAllyAction) {
              return (
                <div key={i} className="duo-card p-3 text-sm bg-gray-100 border-gray-300 text-gray-500 italic">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="w-4 h-4 text-gray-400" />
                    <span className="text-[9px] font-bold text-gray-400 uppercase">NPC Ally</span>
                  </div>
                  <div className="markdown-body">
                    <Markdown rehypePlugins={[rehypeRaw]}>{content}</Markdown>
                  </div>
                </div>
              );
            }

            if (isThoughts) {
              const cleanContent = content.replace(/^> \*\*Judge's Thoughts:\*\*\n> /, "").replace(/\n> /g, "\n");
              if (!cleanContent && isStreamingThoughts) return null;
              
              const isExpanded = expandedThoughts.has(i);
              const thoughtTitle = getThoughtTitle(cleanContent);

              return (
                <div key={i} className="duo-card p-3 bg-duo-gray/20 border-dashed text-xs text-duo-text">
                  <div 
                    className="flex items-center gap-2 cursor-pointer select-none" 
                    onClick={() => {
                      const next = new Set(expandedThoughts);
                      if (isExpanded) next.delete(i);
                      else next.add(i);
                      setExpandedThoughts(next);
                    }}
                  >
                    <Loader2 className={`w-3 h-3 flex-shrink-0 ${isStreamingThoughts ? 'animate-spin' : ''}`} />
                    <span className="font-bold text-duo-gray-dark flex-1">
                      {thoughtTitle}
                    </span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                  </div>
                  {isExpanded && (
                    <div className="markdown-body mt-2 pt-2 border-t border-duo-gray/30">
                      <Markdown rehypePlugins={[rehypeRaw]}>{cleanContent}</Markdown>
                    </div>
                  )}
                </div>
              );
            }

            if (!content.trim() && (isStreamingAnswer || isStreamingThoughts)) return null;

            if (isPendingPlayerAction) {
              return (
                <div key={i} className="flex justify-end">
                  <div className="flex items-start gap-2 max-w-[80%] flex-row-reverse">
                    <div className="w-7 h-7 rounded-full bg-duo-green flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 overflow-hidden">
                      {character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full object-cover" /> : character?.name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div>
                      <span className="text-[10px] font-bold text-duo-gray-dark block text-right">Queued Action</span>
                      <div className="chat-bubble-me">
                        <div className="markdown-body text-sm">
                          <Markdown rehypePlugins={[rehypeRaw]}>{content}</Markdown>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            if (isPlayerActions) {
              // Parse individual player actions and render as chat bubbles
              const actionLines = content.split('\n\n').filter(Boolean);
              return (
                <div key={i} className="space-y-2">
                  {actionLines.map((line, j) => {
                    const nameMatch = line.match(/^\*\*(.+?):\*\*\s*(.*)$/s);
                    const pName = nameMatch ? nameMatch[1] : '';
                    const pAction = nameMatch ? nameMatch[2] : line;
                    const isMyAction = pName === character?.name;
                    return (
                      <div key={j} className={`flex ${isMyAction ? 'justify-end' : 'justify-start'}`}>
                        <div className={`flex items-start gap-2 max-w-[80%] ${isMyAction ? 'flex-row-reverse' : ''}`}>
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 ${isMyAction ? 'bg-duo-green' : 'bg-duo-blue'}`}>
                            {isMyAction && character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full rounded-full object-cover" /> : pName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            {!isMyAction && <span className="text-[10px] font-bold text-duo-gray-dark">{pName}</span>}
                            <div className={isMyAction ? 'chat-bubble-me' : 'chat-bubble-them'}>
                              <div className="markdown-body text-sm">
                                <Markdown rehypePlugins={[rehypeRaw]}>{pAction}</Markdown>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            }

            return (
              <div key={i} className="duo-card p-3 text-sm">
                <div className="markdown-body">
                  <Markdown rehypePlugins={[rehypeRaw]}>{content}</Markdown>
                  {isStreamingAnswer && <span className="inline-block w-2 h-4 ml-1 bg-duo-blue animate-pulse" />}
                </div>
              </div>
            );
          })}
          <div ref={battleEndRef} />
        </div>

        <div className="px-3 py-1.5 bg-yellow-50 border-t-2 border-yellow-200 flex flex-wrap items-center justify-center gap-2">
          {turnTimerRemaining != null && (
            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${turnTimerRemaining <= 10 ? 'bg-red-100 text-red-700 border-red-200 animate-pulse' : turnTimerRemaining <= 20 ? 'bg-orange-100 text-orange-700 border-orange-200' : 'bg-blue-100 text-blue-700 border-blue-200'}`}>
              ⏱️ {turnTimerRemaining}s
            </span>
          )}
          <span className="text-[10px] font-black text-yellow-700 uppercase">Turn Status:</span>
          {Object.keys(players).map(id => {
            const p = players[id];
            const isMe = id === socket.id;
            const isLocked = p.lockedIn;
            return (
              <span key={id} className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${isLocked ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                {isLocked ? '🔒' : (id !== socket.id && opponentTyping) ? '✍️' : '⏳'} {isMe ? 'You' : p.character.name}
              </span>
            );
          })}
        </div>

        <div className="p-3 bg-white border-t-2 border-duo-gray">
          {/* Compact inventory in battle */}
          {Object.keys(explorationState.inventory).length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              <span className="text-[9px] font-black text-duo-gray-dark">🎒</span>
              {Object.entries(explorationState.inventory).map(([item, qty]) => (
                <span key={item} className="text-[9px] font-bold bg-duo-gray rounded-full px-1.5 py-0.5 text-duo-gray-dark">{item}({qty})</span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
          <button
            onClick={handleGenerateBattleImage}
            disabled={isGeneratingBattleImage || hasVisualizedThisTurn || battleLogs.length < 2}
            className={`duo-btn px-3 flex items-center justify-center disabled:opacity-50 transition-all ${isGeneratingBattleImage ? 'bg-duo-gray border-b-0 translate-y-1' : (hasVisualizedThisTurn ? 'bg-duo-gray cursor-not-allowed grayscale' : 'duo-btn-gray')}`}
            title={hasVisualizedThisTurn ? "Already visualized this turn" : "Visualize Battle"}
          >
            {isGeneratingBattleImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
          </button>
          <textarea
            ref={battleInputRef}
            value={battleInput}
            onChange={(e) => {
              setBattleInput(e.target.value);
              handleTyping();
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendBattleAction();
              }
            }}
            placeholder={isLockedIn ? "Waiting for opponent..." : "Describe your action..."}
            className="flex-1 bg-duo-gray rounded-2xl px-3 py-2 text-sm font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue resize-none overflow-y-auto"
            rows={1}
            style={{ minHeight: '40px', maxHeight: '50vh' }}
            disabled={isLockedIn}
          />
          {isLockedIn ? (
            <button 
              onClick={handleBattleUnlock}
              className="duo-btn duo-btn-gray px-4 flex items-center justify-center gap-1 text-xs font-bold"
            >
              🔓 Unlock
            </button>
          ) : (
            <button 
              onClick={handleSendBattleAction}
              disabled={isLockedIn || !battleInput.trim()}
              className="duo-btn duo-btn-blue px-4 flex items-center justify-center disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
          </div>
        </div>
      </div>
    );
  };

  // ============ EXPLORATION RENDER ============
  const getNpcRoleEmoji = (role: string) => {
    if (role === 'trader') return '🪙';
    if (role === 'crafter') return '🔨';
    if (role === 'mystic') return '✨';
    if (role === 'quest_giver') return '❗';
    return '🙂';
  };

  const renderMinimap = () => {
    if (!worldData) return null;
    const currentLoc = getCurrentLocation();
    const gridSize = worldData.meta.gridSize;
    const mapW = 140;
    const mapH = 140;

    const playerScaleX = mapW / gridSize.width;
    const playerScaleY = mapH / gridSize.height;
    const playerPixelX = currentLoc ? currentLoc.x * playerScaleX : mapW / 2;
    const playerPixelY = currentLoc ? currentLoc.y * playerScaleY : mapH / 2;
    const miniOffsetX = mapW / 2 - playerPixelX;
    const miniOffsetY = mapH / 2 - playerPixelY;

    return (
      <div className="relative" style={{ width: mapW, height: mapH }}>
        {/* Small minimap (always visible as click target) */}
        {!showFullMap && (
          <div 
            className="bg-blue-900/80 rounded-xl border-2 border-duo-gray overflow-hidden relative cursor-pointer"
            style={{ width: mapW, height: mapH }}
            onClick={() => {
              const cl = getCurrentLocation();
              if (cl && worldData?.meta?.gridSize) {
                const gs = worldData.meta.gridSize;
                const containerW = window.innerWidth - 32;
                const containerH = window.innerHeight - 32;
                setMapPan({ x: containerW / 2 - cl.x * (containerW / gs.width), y: containerH / 2 - cl.y * (containerH / gs.height) });
                setMapZoom(1);
              }
              setShowFullMap(true);
            }}
          >
            <div style={{ transform: `translate(${miniOffsetX}px, ${miniOffsetY}px)`, position: 'absolute', inset: 0 }}>
            {worldData.islands.map((island: any) => {
              const fScaleX = mapW / gridSize.width;
              const fScaleY = mapH / gridSize.height;
              return (
                <div key={island.id} className="absolute rounded opacity-40" style={{
                  left: island.bounds.x * fScaleX, top: island.bounds.y * fScaleY,
                  width: island.bounds.width * fScaleX, height: island.bounds.height * fScaleY,
                  backgroundColor: island.biome === 'volcanic' ? '#8B4513' : island.biome === 'enchanted_forest' ? '#2d5a27' : island.biome === 'coral_reef' ? '#00CED1' : '#228B22',
                }}>
                  <span className="absolute inset-0 flex items-center justify-center text-[4px] font-black text-white/60 pointer-events-none whitespace-nowrap overflow-hidden">{island.name}</span>
                </div>
              );
            })}
            {worldData.locations
              .filter((l: WorldLocation) => explorationState.discoveredLocations.includes(l.id))
              .map((loc: WorldLocation) => {
                const fScaleX = mapW / gridSize.width;
                const fScaleY = mapH / gridSize.height;
                const isCurrent = loc.id === explorationState.locationId;
                return (
                  <div key={loc.id} className="absolute flex flex-col items-center pointer-events-none"
                    style={{ left: loc.x * fScaleX, top: loc.y * fScaleY, transform: 'translate(-50%, -50%)' }}
                    title={loc.name}
                  >
                    <span className="text-[5px] leading-none">{loc.type === 'village' ? '🏘️' : loc.type === 'ruins' ? '🏚️' : loc.type === 'cave' ? '🕳️' : '·'}</span>
                    <div className={`rounded-full ${isCurrent ? 'bg-duo-green animate-pulse' : 'bg-white/60'}`}
                      style={{ width: isCurrent ? 4 : 3, height: isCurrent ? 4 : 3 }}
                    />
                  </div>
                );
              })}
            {worldNpcs
              .filter(npc => explorationState.discoveredLocations.includes(npc.locationId) || npc.followTargetId === socket.id)
              .map(npc => {
                const fScaleX = mapW / gridSize.width;
                const fScaleY = mapH / gridSize.height;
                return (
                  <div key={npc.id} className="absolute flex flex-col items-center pointer-events-none"
                    style={{ left: npc.x * fScaleX, top: npc.y * fScaleY, transform: 'translate(-50%, -50%)' }}
                    title={npc.name}
                  >
                    <span className="text-[6px] leading-none">{getNpcRoleEmoji(npc.role)}</span>
                    <span className="text-[5px] font-bold text-yellow-200 whitespace-nowrap">{npc.name}</span>
                  </div>
                );
              })}
            </div>
            {/* Center crosshair */}
            <div className="absolute rounded-full border-2 border-duo-green/70" style={{ left: mapW/2 - 4, top: mapH/2 - 4, width: 8, height: 8, pointerEvents: 'none' }} />
            {/* Compass */}
            <span className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[8px] font-black text-red-400/80 pointer-events-none">N</span>
            <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-black text-white/50 pointer-events-none">S</span>
            <span className="absolute left-0.5 top-1/2 -translate-y-1/2 text-[8px] font-black text-white/50 pointer-events-none">W</span>
            <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-[8px] font-black text-white/50 pointer-events-none">E</span>
            <div className="absolute bottom-1 right-1 bg-white/80 rounded px-1">
              <Maximize2 className="w-3 h-3 text-blue-900" />
            </div>
          </div>
        )}

        {/* Full-screen map overlay */}
        {showFullMap && (
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowFullMap(false)}>
            <div 
              className="absolute inset-4 bg-blue-900/95 rounded-3xl border-2 border-duo-gray overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const oldZoom = mapZoom;
                const newZoom = Math.min(5, Math.max(0.5, oldZoom + (e.deltaY > 0 ? -0.15 : 0.15)));
                const scale = newZoom / oldZoom;
                setMapZoom(newZoom);
                setMapPan(p => ({
                  x: mouseX - scale * (mouseX - p.x),
                  y: mouseY - scale * (mouseY - p.y)
                }));
              }}
              onPointerDown={(e) => {
                mapDragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!mapDragRef.current.dragging) return;
                const dx = e.clientX - mapDragRef.current.lastX;
                const dy = e.clientY - mapDragRef.current.lastY;
                mapDragRef.current.lastX = e.clientX;
                mapDragRef.current.lastY = e.clientY;
                setMapPan(p => ({ x: p.x + dx, y: p.y + dy }));
              }}
              onPointerUp={() => { mapDragRef.current.dragging = false; }}
            >
              <div className="absolute top-2 left-2 z-10 flex gap-1">
                <button onClick={() => setMapZoom(z => Math.min(5, z + 0.3))} className="bg-white/90 rounded-full w-7 h-7 text-sm font-black text-blue-900 shadow">+</button>
                <button onClick={() => setMapZoom(z => Math.max(0.5, z - 0.3))} className="bg-white/90 rounded-full w-7 h-7 text-sm font-black text-blue-900 shadow">−</button>
                <button onClick={() => {
                  const cl = getCurrentLocation();
                  if (cl && gridSize) {
                    const containerW = window.innerWidth - 32;
                    const containerH = window.innerHeight - 32;
                    setMapPan({ x: containerW / 2 - cl.x * (containerW / gridSize.width) * mapZoom, y: containerH / 2 - cl.y * (containerH / gridSize.height) * mapZoom });
                  }
                }} className="bg-white/90 rounded-full px-2 h-7 text-[10px] font-bold text-blue-900 shadow flex items-center gap-1">
                  <Target className="w-3 h-3" /> Center
                </button>
              </div>
              <button onClick={() => setShowFullMap(false)} className="absolute top-2 right-2 z-10 bg-white rounded-full p-1.5 shadow">
                <X className="w-4 h-4" />
              </button>
              {/* Pannable/zoomable content */}
              <div style={{ transform: `translate(${mapPan.x}px, ${mapPan.y}px) scale(${mapZoom})`, transformOrigin: '0 0', position: 'absolute', inset: 0 }}>
                {/* Islands */}
                {worldData.islands.map((island: any) => {
                  const fMapW = window.innerWidth - 32;
                  const fMapH = window.innerHeight - 32;
                  const fScaleX = fMapW / gridSize.width;
                  const fScaleY = fMapH / gridSize.height;
                  return (
                    <div key={island.id} className="absolute rounded opacity-30" style={{
                      left: island.bounds.x * fScaleX, top: island.bounds.y * fScaleY,
                      width: island.bounds.width * fScaleX, height: island.bounds.height * fScaleY,
                      backgroundColor: island.biome === 'volcanic' ? '#8B4513' : island.biome === 'enchanted_forest' ? '#2d5a27' : island.biome === 'coral_reef' ? '#00CED1' : '#228B22',
                    }}>
                      <span className="absolute inset-0 flex items-center justify-center text-[20px] font-black text-white/40 pointer-events-none whitespace-nowrap">{island.name}</span>
                    </div>
                  );
                })}
                {/* Discovered locations with labels */}
                {worldData.locations
                  .filter((l: WorldLocation) => explorationState.discoveredLocations.includes(l.id))
                  .map((loc: WorldLocation) => {
                    const fMapW = window.innerWidth - 32;
                    const fMapH = window.innerHeight - 32;
                    const fScaleX = fMapW / gridSize.width;
                    const fScaleY = fMapH / gridSize.height;
                    const isCurrent = loc.id === explorationState.locationId;
                    const isConnected = getConnectedLocations().find(c => c.id === loc.id);
                    return (
                      <div key={loc.id} className="absolute flex flex-col items-center" style={{ left: loc.x * fScaleX, top: loc.y * fScaleY, transform: 'translate(-50%, -50%)' }}>
                        {isCurrent && (
                          <Target className="w-5 h-5 text-duo-green animate-pulse mb-0.5" />
                        )}
                        <div
                          className={`rounded-full cursor-pointer transition-all ${isCurrent ? 'bg-duo-green ring-2 ring-duo-green/50' : isConnected ? 'bg-yellow-400 hover:bg-yellow-300' : 'bg-white/60'}`}
                          style={{ width: isCurrent ? 12 : 8, height: isCurrent ? 12 : 8 }}
                          onClick={() => {
                            if (!isCurrent && isConnected) {
                              handleExplorationMove(loc.id);
                              setShowFullMap(false);
                            }
                          }}
                        />
                        <span className={`text-[8px] font-bold mt-0.5 whitespace-nowrap ${isCurrent ? 'text-duo-green' : 'text-white/80'}`}>
                          {loc.type === 'village' ? '🏘️' : loc.type === 'ruins' ? '🏚️' : loc.type === 'cave' ? '🕳️' : ''} {loc.name}
                        </span>
                        {(loc.npcs?.length > 0 || loc.enemies?.length > 0) && (
                          <span className="text-[8px] font-bold whitespace-nowrap">
                            {loc.npcs?.length > 0 && <span className="text-yellow-300/80">👤{loc.npcs.length} NPC{loc.npcs.length > 1 ? 's' : ''} </span>}
                            {loc.enemies?.length > 0 && <span className="text-red-400/80">⚔️{loc.enemies.length} Enem{loc.enemies.length > 1 ? 'ies' : 'y'}</span>}
                          </span>
                        )}
                      </div>
                    );
                  })}
                {worldNpcs
                  .filter(npc => explorationState.discoveredLocations.includes(npc.locationId) || npc.followTargetId === socket.id)
                  .map(npc => {
                    const fMapW = window.innerWidth - 32;
                    const fMapH = window.innerHeight - 32;
                    const fScaleX = fMapW / gridSize.width;
                    const fScaleY = fMapH / gridSize.height;
                    return (
                      <div key={npc.id} className="absolute flex flex-col items-center" style={{ left: npc.x * fScaleX, top: npc.y * fScaleY, transform: 'translate(-50%, -50%)' }}>
                        <div className="text-sm">{getNpcRoleEmoji(npc.role)}</div>
                        <span className="text-[8px] font-bold mt-0.5 whitespace-nowrap text-yellow-200">{npc.name}</span>
                      </div>
                    );
                  })}
                {/* Other players */}
                {worldPlayers
                  .filter(p => p.id !== socket.id)
                  .map(p => {
                    const fMapW = window.innerWidth - 32;
                    const fMapH = window.innerHeight - 32;
                    const fScaleX = fMapW / gridSize.width;
                    const fScaleY = fMapH / gridSize.height;
                    return (
                      <div key={p.id} className="absolute flex flex-col items-center" style={{ left: p.x * fScaleX, top: p.y * fScaleY, transform: 'translate(-50%, -50%)' }}>
                        <div className="rounded-full bg-duo-blue" style={{ width: 6, height: 6 }} />
                        <span className="text-[7px] font-bold text-duo-blue mt-0.5 whitespace-nowrap">{p.name}</span>
                      </div>
                    );
                  })}
              </div>
              <div className="absolute bottom-2 left-2 text-[10px] font-bold text-white/50">Scroll to zoom · Drag to pan</div>
              {/* Compass rose */}
              <div className="absolute bottom-3 right-3 z-10 w-12 h-12 rounded-full bg-black/40 border border-white/20 flex items-center justify-center pointer-events-none">
                <span className="absolute top-0.5 text-[10px] font-black text-red-400">N</span>
                <span className="absolute bottom-0.5 text-[10px] font-black text-white/60">S</span>
                <span className="absolute left-1 text-[10px] font-black text-white/60">W</span>
                <span className="absolute right-1 text-[10px] font-black text-white/60">E</span>
                <div className="w-1 h-1 rounded-full bg-white/80" />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderSurvivalBars = () => (
    <div className="flex gap-2 px-3 py-1.5 bg-gray-50 border-b border-duo-gray">
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-1 text-[9px] font-bold text-duo-gray-dark">
          <Beef className="w-3 h-3" /> {explorationState.hunger}
        </div>
        <div className="h-1.5 bg-duo-gray rounded-full overflow-hidden">
          <div className="h-full bg-orange-400 transition-all duration-500" style={{ width: `${explorationState.hunger}%` }} />
        </div>
      </div>
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-1 text-[9px] font-bold text-duo-gray-dark">
          <GlassWater className="w-3 h-3" /> {explorationState.thirst}
        </div>
        <div className="h-1.5 bg-duo-gray rounded-full overflow-hidden">
          <div className="h-full bg-blue-400 transition-all duration-500" style={{ width: `${explorationState.thirst}%` }} />
        </div>
      </div>
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-1 text-[9px] font-bold text-duo-gray-dark">
          <Zap className="w-3 h-3" /> {explorationState.stamina}
        </div>
        <div className="h-1.5 bg-duo-gray rounded-full overflow-hidden">
          <div className="h-full bg-yellow-400 transition-all duration-500" style={{ width: `${explorationState.stamina}%` }} />
        </div>
      </div>
    </div>
  );

  const renderExploration = () => {
    const currentLoc = getCurrentLocation();
    const connected = getConnectedLocations();
    const activeExplorationStreamText = activeExplorationStreamIdRef.current
      ? explorationLog.find(msg => msg.streamId === activeExplorationStreamIdRef.current)?.text || ''
      : '';
    const showExplorationThinking = isExplorationProcessing && !activeExplorationStreamText.trim();

    return (
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        {/* Exploration header with minimap */}
        <div className="p-3 bg-white border-b-2 border-duo-gray flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <button onClick={() => { setGameState('menu'); socket.emit('leaveExploration'); }} className="text-duo-gray-dark hover:text-duo-text">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-sm font-black text-duo-text truncate">🗺️ {currentLoc?.name || 'Loading...'}</h2>
            </div>
            <p className="text-[10px] text-duo-gray-dark line-clamp-2">{currentLoc?.description || ''}</p>
            <div className="flex gap-1 mt-1.5 flex-wrap">
              <button 
                onClick={() => setShowGoalsModal(true)}
                className="flex items-center gap-1 bg-yellow-100 border border-yellow-300 rounded-full px-2 py-0.5 text-[9px] font-bold text-yellow-700 hover:bg-yellow-200 transition-colors"
              >
                <Star className="w-3 h-3 fill-yellow-500 text-yellow-500" />
                {explorationState.goals[0] || 'No goals'}
              </button>
              <button 
                onClick={() => setShowInventory(true)}
                className="flex items-center gap-1 bg-duo-gray/50 rounded-full px-2 py-0.5 text-[9px] font-bold text-duo-gray-dark hover:bg-duo-gray transition-colors"
              >
                <Package className="w-3 h-3" />
                {Object.keys(explorationState.inventory).length} items
              </button>
              <button 
                onClick={handleVisualizeScene}
                disabled={isVisualizingScene}
                className="flex items-center gap-1 bg-purple-100 border border-purple-200 rounded-full px-2 py-0.5 text-[9px] font-bold text-purple-700 hover:bg-purple-200 transition-colors disabled:opacity-50"
              >
                {isVisualizingScene ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                {isVisualizingScene ? 'Generating...' : 'Visualize'}
              </button>
            </div>
          </div>
          {renderMinimap()}
        </div>

        {renderSurvivalBars()}

        {/* Direction buttons */}
        <div className="px-3 py-2 bg-white border-b border-duo-gray">
          <div className="flex gap-1.5 flex-wrap">
            {connected.map(loc => (
              <button
                key={loc.id}
                onClick={() => handleExplorationMove(loc.id)}
                disabled={isExplorationProcessing}
                className="text-[10px] font-bold bg-duo-green/10 text-duo-green-dark border border-duo-green/30 rounded-lg px-2 py-1 hover:bg-duo-green/20 transition-colors disabled:opacity-50"
              >
                → {loc.name}
              </button>
            ))}
          </div>
          {/* Nearby players */}
          {worldPlayers.filter(p => p.id !== socket.id && p.locationId === explorationState.locationId).length > 0 && (
            <div className="flex gap-1.5 flex-wrap mt-1.5 pt-1.5 border-t border-duo-gray/50">
              <span className="text-[9px] font-bold text-duo-gray-dark self-center">Players here:</span>
              {worldPlayers.filter(p => p.id !== socket.id && p.locationId === explorationState.locationId).map(p => (
                <button
                  key={p.id}
                  onClick={() => {
                    const draftedAction = `attack ${p.name}`;
                    setExplorationInput(draftedAction);
                    requestAnimationFrame(() => {
                      if (explorationInputRef.current) {
                        explorationInputRef.current.focus();
                        explorationInputRef.current.style.height = 'auto';
                        explorationInputRef.current.style.height = Math.min(explorationInputRef.current.scrollHeight, window.innerHeight / 4) + 'px';
                      }
                    });
                  }}
                  className="text-[10px] font-bold bg-red-50 text-red-600 border border-red-200 rounded-lg px-2 py-1 hover:bg-red-100 transition-colors flex items-center gap-1"
                >
                  ⚔️ Target {p.name}
                  {p.acting && <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" title="Acting..." />}
                </button>
              ))}
            </div>
          )}
          {worldNpcs.filter(npc => npc.locationId === explorationState.locationId).length > 0 && (
            <div className="flex gap-1.5 flex-wrap mt-1.5 pt-1.5 border-t border-duo-gray/50">
              <span className="text-[9px] font-bold text-duo-gray-dark self-center">NPCs here:</span>
              {worldNpcs.filter(npc => npc.locationId === explorationState.locationId).map(npc => (
                <span
                  key={npc.id}
                  className="text-[10px] font-bold bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-lg px-2 py-1 flex items-center gap-1"
                >
                  <span>{getNpcRoleEmoji(npc.role)}</span>
                  {npc.name}
                  {npc.followTargetId === socket.id && <span className="text-[9px] text-duo-green-dark">Following</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Exploration log */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {explorationLog.filter(msg => msg.text.trim() !== '').map((msg, i) => {
            const isOtherPlayer = msg.role === 'user' && msg.playerName;
            const isMe = msg.role === 'user' && !msg.playerName;
            return (
            <div key={i} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'system' ? (
                <div className="w-full">
                  <div className="text-center text-sm font-bold text-duo-blue bg-duo-blue/5 border border-duo-blue/10 rounded-lg py-2 px-4 my-1 markdown-body">
                    <Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown>
                  </div>
                  {msg.imageUrl && (
                    <div className="mt-2 rounded-lg overflow-hidden border-2 border-duo-gray">
                      <img src={msg.imageUrl} alt="Scene" className="w-full" />
                    </div>
                  )}
                </div>
              ) : isOtherPlayer ? (
                <div className="flex items-start gap-2 max-w-[80%]">
                  <div className="w-7 h-7 rounded-full bg-duo-blue flex items-center justify-center text-white text-[10px] font-black flex-shrink-0">
                    {msg.playerName!.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <span className="text-[10px] font-bold text-duo-gray-dark">{msg.playerName}</span>
                    <div className="chat-bubble-them w-fit min-w-[12rem]">
                      <div className="markdown-body">
                        <Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown>
                      </div>
                    </div>
                  </div>
                </div>
              ) : isMe ? (
                <div className="flex items-start gap-2 max-w-[80%] flex-row-reverse">
                  <div className="w-7 h-7 rounded-full bg-duo-green flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 overflow-hidden">
                    {character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full object-cover" /> : character?.name?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="chat-bubble-me w-fit min-w-[12rem]">
                    <div className="markdown-body">
                      <Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={msg.role === 'model' ? 'chat-bubble-them' : 'chat-bubble-me'}>
                  <div className="markdown-body">
                    <Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown>
                  </div>
                </div>
              )}
            </div>
            );
          })}
          {showExplorationThinking && (
            <div className="flex justify-start">
              <div className="chat-bubble-them flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="font-bold text-sm">Thinking...</span>
              </div>
            </div>
          )}
          <div ref={explorationEndRef} />
        </div>

        {/* Lock-in status bar (multiplayer) */}
        {explorationLockStatus.length > 0 && (
          <div className="px-3 py-1.5 bg-yellow-50 border-t-2 border-yellow-200 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black text-yellow-700">TURN:</span>
            {explorationLockStatus.map(p => (
              <span key={p.id} className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${p.lockedIn ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {p.lockedIn ? '🔒' : '⏳'} {p.id === socket.id ? 'You' : p.name}
              </span>
            ))}
            {explorationLockStatus.every(p => p.lockedIn) && (
              <span className="text-[10px] font-bold text-duo-blue animate-pulse ml-auto">Processing...</span>
            )}
          </div>
        )}

        {/* Input */}
        <div className="p-3 bg-white border-t-2 border-duo-gray flex gap-2">
          <textarea
            ref={explorationInputRef}
            value={explorationInput}
            onChange={(e) => {
              setExplorationInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleExplorationSend();
              }
            }}
            placeholder={isExplorationLockedIn ? "Waiting for other players..." : "What do you do? (gather, craft, talk, explore...)"}
            className="flex-1 bg-duo-gray rounded-2xl px-3 py-2 text-sm font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue resize-none overflow-y-auto"
            rows={1}
            style={{ minHeight: '40px', maxHeight: '50vh' }}
            disabled={isExplorationLockedIn}
          />
          {isExplorationLockedIn ? (
            <button 
              onClick={handleExplorationUnlock}
              className="duo-btn duo-btn-gray px-4 flex items-center justify-center gap-1 text-xs font-bold"
            >
              🔓 Unlock
            </button>
          ) : (
            <button 
              onClick={handleExplorationSend}
              disabled={isExplorationProcessing || !explorationInput.trim()}
              className="duo-btn duo-btn-blue px-4 flex items-center justify-center disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Goals Modal */}
        {showGoalsModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowGoalsModal(false)}>
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-yellow-300" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-xl font-black text-duo-text mb-4 flex items-center gap-2">
                <Star className="w-6 h-6 fill-yellow-500 text-yellow-500" /> Active Goals
              </h3>
              <div className="space-y-3">
                {explorationState.goals.map((goal, i) => (
                  <div key={i} className={`flex items-start gap-3 p-3 rounded-xl ${i === 0 ? 'bg-yellow-50 border-2 border-yellow-300' : 'bg-gray-50 border border-duo-gray'}`}>
                    <span className="text-lg font-black text-duo-gray-dark w-6 text-center">{i + 1}</span>
                    <span className="font-bold text-sm text-duo-text flex-1">{goal}</span>
                    {i === 0 && <Star className="w-5 h-5 fill-yellow-500 text-yellow-500 flex-shrink-0" />}
                  </div>
                ))}
              </div>
              <button onClick={() => setShowGoalsModal(false)} className="duo-btn duo-btn-blue w-full py-3 mt-6">Close</button>
            </div>
          </div>
        )}

        {/* Inventory Modal */}
        {showInventory && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowInventory(false)}>
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-gray-200 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-xl font-black text-duo-text mb-4 flex items-center gap-2">
                <Package className="w-6 h-6" /> Inventory
              </h3>
              {Object.keys(explorationState.inventory).length === 0 ? (
                <p className="text-duo-gray-dark font-bold text-sm text-center py-4">Your inventory is empty. Try gathering resources!</p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(explorationState.inventory).map(([item, count]) => (
                    <div key={item} className="bg-gray-50 rounded-xl p-3 border border-duo-gray">
                      <div className="font-bold text-sm text-duo-text capitalize">{item.replace(/_/g, ' ')}</div>
                      <div className="text-xs font-bold text-duo-gray-dark">×{count}</div>
                    </div>
                  ))}
                </div>
              )}
              {explorationState.equippedWeapon && (
                <div className="mt-4 p-3 bg-red-50 rounded-xl border border-red-200">
                  <div className="text-xs font-bold text-red-500 uppercase">Equipped Weapon</div>
                  <div className="font-bold text-sm text-duo-text capitalize">{explorationState.equippedWeapon.replace(/_/g, ' ')}</div>
                </div>
              )}
              {explorationState.equippedArmor && (
                <div className="mt-2 p-3 bg-blue-50 rounded-xl border border-blue-200">
                  <div className="text-xs font-bold text-blue-500 uppercase">Equipped Armor</div>
                  <div className="font-bold text-sm text-duo-text capitalize">{explorationState.equippedArmor.replace(/_/g, ' ')}</div>
                </div>
              )}
              <button onClick={() => setShowInventory(false)} className="duo-btn duo-btn-blue w-full py-3 mt-6">Close</button>
            </div>
          </div>
        )}

        {/* PVP Challenge Modal */}
      </div>
    );
  };

  // ============ LEVEL SELECT (DUOLINGO STYLE) ============
  const levelBots = [
    { level: 1, name: "Training Dummy", difficulty: "Easy", color: "bg-duo-green", description: "A wooden practice target that barely fights back." },
    { level: 2, name: "Village Brawler", difficulty: "Easy", color: "bg-duo-green", description: "A local tough guy who fights with his fists." },
    { level: 3, name: "Bandit Scout", difficulty: "Easy", color: "bg-duo-green", description: "A sneaky thief with a rusty dagger." },
    { level: 4, name: "Forest Wolf", difficulty: "Medium", color: "bg-duo-green", description: "A cunning predator that hunts in packs." },
    { level: 5, name: "Tribal Warrior", difficulty: "Medium", color: "bg-duo-blue", description: "A seasoned fighter from the Fire Tribe." },
    { level: 6, name: "Coral Guardian", difficulty: "Medium", color: "bg-duo-blue", description: "An animated coral construct that protects the reef." },
    { level: 7, name: "Shadow Assassin", difficulty: "Hard", color: "bg-duo-blue", description: "A deadly killer who strikes from the darkness." },
    { level: 8, name: "Stone Golem", difficulty: "Hard", color: "bg-purple-500", description: "An ancient construct of immovable stone." },
    { level: 9, name: "Dragon Knight", difficulty: "Hard", color: "bg-purple-500", description: "A warrior bonded with dragon fire." },
    { level: 10, name: "The Volcanic Wyrm", difficulty: "Hard", color: "bg-purple-500", description: "A colossal serpent of magma and destruction." },
    { level: 11, name: "Abyssal Leviathan", difficulty: "Superintelligent", color: "bg-red-500", description: "A nightmare from the deepest ocean trenches." },
    { level: 12, name: "The God of the Isles", difficulty: "Superintelligent", color: "bg-yellow-500", description: "The supreme deity. Reality bends to its will." },
  ];

  const renderLevelSelect = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-4 bg-white border-b-2 border-duo-gray flex items-center gap-2">
        <button onClick={() => setGameState('menu')} className="text-duo-gray-dark hover:text-duo-text">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-black text-duo-text">Battle Path</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto flex flex-col items-center py-8 relative">
        {/* Vertical path line */}
        <div className="absolute top-0 bottom-0 w-1 bg-duo-gray left-1/2 -translate-x-1/2" />
        
        {levelBots.map((bot, i) => {
          const isLeft = i % 3 === 0;
          const isRight = i % 3 === 2;
          const offset = isLeft ? -40 : isRight ? 40 : 0;
          const isTreasure = i === 4 || i === 8;
          const isBoss = i === levelBots.length - 1;
          
          return (
            <div key={bot.level} className="relative mb-4 flex flex-col items-center" style={{ marginLeft: offset }}>
              <button
                onClick={() => {
                  const botProfile = `# ${bot.name}\n\n**Class:** Level ${bot.level} Opponent\n\n**Difficulty:** ${bot.difficulty}\n\n${bot.description}\n\n### Abilities\n- Scaled to difficulty level ${bot.level}\n\n### Strategy\n- Fights according to ${bot.difficulty} AI behavior`;
                  socket.emit('startBotMatch', {
                    difficulty: bot.difficulty,
                    botProfile,
                    botName: bot.name
                  });
                }}
                disabled={!character}
                className={`relative w-16 h-16 rounded-full ${bot.color} flex items-center justify-center shadow-lg border-4 border-white hover:scale-110 transition-transform disabled:opacity-50`}
              >
                {isBoss ? (
                  <Star className="w-8 h-8 text-white fill-white" />
                ) : (
                  <span className="text-white font-black text-lg">{bot.level}</span>
                )}
                {isBoss && <div className="absolute inset-0 rounded-full animate-ping bg-yellow-400/30" />}
              </button>
              <span className="text-[10px] font-bold text-duo-gray-dark mt-1 text-center max-w-[100px]">{bot.name}</span>
              {isTreasure && <div className="mt-2 text-2xl">🎁</div>}
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderPostMatch = () => (
    <div className="flex-1 flex flex-col items-center justify-center p-6 gap-8">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-black text-duo-text tracking-tight">Match Over!</h1>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-xs">
        <button 
          onClick={() => {
            // Reset character stats
            if (character) {
              setCharacter({ ...character, hp: 100, mana: 100 });
            }
            handleEnterArena();
          }}
          className="duo-btn duo-btn-green w-full py-4 text-lg"
        >
          New Opponent
        </button>
        
        <button 
          onClick={() => {
            setActiveTab('profile');
            setGameState('char_creation');
            setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
          }}
          className="duo-btn duo-btn-blue w-full py-4 text-lg"
        >
          Tweak Character
        </button>

        <button 
          onClick={() => {
            if (explorationCombatReturn) {
              setExplorationCombatReturn(false);
              if (character) setCharacter({ ...character, hp: Math.max(character.hp, 50), mana: Math.max(character.mana, 30) });
              setGameState('exploration');
              setExplorationLog(prev => [...prev, { role: 'system', text: '🏕️ You return from battle to continue your exploration.' }]);
            } else {
              setActiveTab('home');
              setGameState('menu');
            }
          }}
          className="duo-btn duo-btn-gray w-full py-4 text-lg"
        >
          {explorationCombatReturn ? 'Return to World' : 'Home'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-screen bg-duo-bg flex justify-center overflow-hidden">
      <div className="w-full max-w-md bg-white h-full flex flex-col relative shadow-2xl">
        {renderTopBar()}
        
        {gameState === 'menu' && renderMenu()}
        {gameState === 'char_creation' && renderCharCreation()}
        {gameState === 'matchmaking' && renderMatchmaking()}
        {gameState === 'battle' && renderBattle()}
        {gameState === 'post_match' && renderPostMatch()}
        {gameState === 'exploration' && renderExploration()}
        {gameState === 'level_select' && renderLevelSelect()}

        {renderBottomBar()}

        {showSettings && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-gray-200">
              <h3 className="text-2xl font-black text-duo-text mb-6 text-center">Settings</h3>
              
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-sm font-bold text-duo-gray-dark mb-1">
                    API Key (Optional)
                    {settings.apiKey?.trim() && <span className="ml-2 text-duo-green text-xs">✓ Custom Key Active</span>}
                  </label>
                  <input 
                    type="password" 
                    value={settings.apiKey}
                    onChange={e => setSettings({...settings, apiKey: e.target.value})}
                    className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue mb-2"
                    placeholder="Leave blank to use default"
                  />
                  <button
                    onClick={async () => {
                      if (window.aistudio && window.aistudio.openSelectKey) {
                        await window.aistudio.openSelectKey();
                      } else {
                        alert("Platform API key selection is not available in this environment.");
                      }
                    }}
                    className="w-full bg-duo-blue hover:bg-duo-blue-light text-white font-bold py-2 px-4 rounded-xl transition-colors"
                  >
                    Select AI Studio Platform Key
                  </button>
                  <p className="text-xs text-duo-gray-light mt-2">
                    If you are hitting rate limits, click the button above to link your paid Google Cloud project.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-bold text-duo-gray-dark mb-1">Char Creator Model</label>
                  <select 
                    value={settings.charModel}
                    onChange={e => setSettings({...settings, charModel: e.target.value})}
                    className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                  >
                    <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-duo-gray-dark mb-1">Exploration Model</label>
                  <select 
                    value={settings.explorationModel}
                    onChange={e => setSettings({...settings, explorationModel: e.target.value})}
                    className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                  >
                    <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-duo-gray-dark mb-1">Battle Model</label>
                  <select 
                    value={settings.battleModel}
                    onChange={e => setSettings({...settings, battleModel: e.target.value})}
                    className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                  >
                    <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-bold text-duo-gray-dark mb-1">Bot Model</label>
                  <select 
                    value={settings.botModel}
                    onChange={e => setSettings({...settings, botModel: e.target.value})}
                    className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                  >
                    <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  </select>
                </div>
              </div>

              {/* Account Section */}
              <div className="border-t-2 border-duo-gray pt-4 mt-4">
                <label className="block text-sm font-bold text-duo-gray-dark mb-2">Cloud Account</label>
                {authUser ? (
                  <div className="flex items-center justify-between bg-duo-green/10 border border-duo-green/30 rounded-xl p-3">
                    <div>
                      <div className="font-bold text-sm text-duo-text">Logged in as {authUser}</div>
                      <div className="text-[10px] text-duo-green-dark font-bold">Characters synced to cloud ☁️</div>
                    </div>
                    <button onClick={handleLogout} className="text-xs font-bold text-red-500 hover:underline">Logout</button>
                  </div>
                ) : dbAvailable ? (
                  <button
                    onClick={() => { setShowAuthModal(true); setShowSettings(false); }}
                    className="duo-btn duo-btn-blue w-full py-2 text-sm"
                  >
                    Sign In / Register
                  </button>
                ) : (
                  <p className="text-xs text-duo-gray-dark">Database not connected. Characters saved locally.</p>
                )}
              </div>

              <button 
                onClick={() => setShowSettings(false)}
                className="duo-btn duo-btn-blue w-full py-3 mt-4"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Auth Modal */}
        {showAuthModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowAuthModal(false)}>
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-duo-blue" onClick={e => e.stopPropagation()}>
              <h3 className="text-2xl font-black text-duo-text mb-2 text-center">
                {authMode === 'login' ? 'Sign In' : 'Create Account'}
              </h3>
              <p className="text-xs text-duo-gray-dark text-center mb-6">
                Sync your characters across devices
              </p>
              
              {authError && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-sm font-bold text-red-600">
                  {authError}
                </div>
              )}
              
              <div className="space-y-3 mb-6">
                <input
                  type="text"
                  value={authUsername}
                  onChange={e => setAuthUsername(e.target.value)}
                  placeholder="Username"
                  className="w-full bg-duo-gray rounded-xl px-4 py-3 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                />
                <input
                  type="password"
                  value={authPassword}
                  onChange={e => setAuthPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAuth()}
                  placeholder="Password"
                  className="w-full bg-duo-gray rounded-xl px-4 py-3 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue"
                />
              </div>
              
              <button
                onClick={handleAuth}
                disabled={authLoading || !authUsername.trim() || !authPassword.trim()}
                className="duo-btn duo-btn-green w-full py-3 mb-3 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {authLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {authMode === 'login' ? 'Sign In' : 'Create Account'}
              </button>
              
              <button
                onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(''); }}
                className="w-full text-center text-sm font-bold text-duo-blue hover:underline"
              >
                {authMode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign In'}
              </button>
            </div>
          </div>
        )}
      </div>
      {showProfileModal && profileToView && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4 backdrop-blur-sm">
          <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl border-b-8 border-duo-gray overflow-hidden">
            <div className="p-4 border-b-2 border-duo-gray flex justify-between items-center bg-duo-blue text-white">
              <h3 className="text-xl font-black tracking-tight">Legend Profile</h3>
              <button 
                onClick={() => setShowProfileModal(false)}
                className="p-2 hover:bg-white/20 rounded-full transition-colors"
              >
                <ArrowLeft className="w-6 h-6 rotate-180" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 prose prose-slate max-w-none">
              <div className="markdown-body">
                <Markdown rehypePlugins={[rehypeRaw]}>{profileToView}</Markdown>
              </div>
            </div>
            <div className="p-4 border-t-2 border-duo-gray bg-gray-50 flex justify-end">
              <button 
                onClick={() => setShowProfileModal(false)}
                className="duo-btn duo-btn-blue px-8 py-2"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {showCharImage && character?.imageUrl && (
        <div 
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-6 backdrop-blur-sm cursor-pointer"
          onClick={() => setShowCharImage(false)}
        >
          <div className="relative max-w-full max-h-full animate-in zoom-in-95">
            <img 
              src={character.imageUrl} 
              alt={character.name} 
              className="max-w-full max-h-[80vh] rounded-3xl shadow-2xl border-4 border-white/20 object-contain"
            />
            <div className="absolute bottom-4 left-0 right-0 text-center">
              <span className="bg-black/60 text-white font-black text-lg px-4 py-2 rounded-full">{character.name}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

