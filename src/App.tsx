import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { Home, User, Users, Heart, Send, Check, Loader2, Sword, Settings, ChevronDown, ArrowLeft, AlertTriangle, Info, Compass, Map, Star, ChevronUp, Maximize2, Minimize2, Target, Beef, GlassWater, Zap, Package, X, Eye, Coins, Orbit } from 'lucide-react';
import { classifyAIError, createAIClient, formatAIError, getAIRetryDelaySeconds } from '../ai';

declare global {
  interface Window {
    aistudio?: {
      openSelectKey: () => Promise<void>;
      hasSelectedApiKey: () => Promise<boolean>;
    };
  }
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';
const CLIENT_SESSION_STORAGE_KEY = 'arena_clash_session_id';
const getClientSessionId = () => {
  try {
    const stored = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (stored) return stored;
    const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
};

const socket: Socket = io(BACKEND_URL || undefined, {
  auth: {
    sessionId: getClientSessionId(),
  },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 5_000,
});

type Tab = 'home' | 'profile' | 'social';
type GameState = 'menu' | 'char_creation' | 'matchmaking' | 'arena_prep' | 'battle' | 'post_match' | 'exploration' | 'level_select';

interface Character {
  name: string;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  gold: number;
  profileMarkdown: string;
  imageUrl?: string;
  battles?: number;
  wins?: number;
  losses?: number;
}

interface Message {
  role: 'user' | 'model' | 'system';
  text: string;
  imageUrl?: string;
  imageFrames?: string[];
  imageFrameFps?: number;
  playerName?: string;
  streamId?: string;
  kind?: 'thought' | 'answer';
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
  subZones?: any[];
}

interface ExplorationState {
  locationId: string;
  subZoneId: string | null;
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

interface WorldPlayer {
  id: string;
  name: string;
  locationId: string;
  x: number;
  y: number;
  acting?: boolean;
  typing?: boolean;
}

interface WorldNpc {
  id: string;
  name: string;
  role: string;
  locationId: string;
  subZoneId?: string | null;
  x: number;
  y: number;
  followTargetId?: string | null;
}

interface BattleZone {
  id: string;
  name: string;
  description: string;
  connections: string[];
}

interface BattleMapState {
  discoveredLocations: string[];
  players: WorldPlayer[];
  npcs: WorldNpc[];
  zones?: BattleZone[];
  combatantZones?: Record<string, string>;
}

interface ArenaPreparationState {
  stage: 'preview' | 'tweak';
  remaining: number;
  playerRemaining: Record<string, number>;
  tweakDuration: number;
  isBotMatch: boolean;
  skipVotes: string[];
}

interface MapMarkerLayoutInput {
  id: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
}

interface MapMarkerLayoutPosition {
  x: number;
  y: number;
}

const DEFAULT_STARTING_GOLD = 25;
const BATTLE_STREAM_THOUGHTS_PREFIX = 'STREAMING_THOUGHTS_';
const BATTLE_STREAM_ANSWER_PREFIX = 'STREAMING_ANSWER_';
const BATTLE_PLAYER_ACTIONS_PREFIX = 'PLAYER_ACTIONS_';
const BATTLE_PENDING_ACTION_PREFIX = 'PENDING_PLAYER_ACTION_';
const BATTLE_TURN_SUMMARY_PREFIX = 'TURN_SUMMARY_';

const EMPTY_BATTLE_MAP_STATE: BattleMapState = {
  discoveredLocations: [],
  players: [],
  npcs: [],
};

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

const pickPreferredCharacter = (values: Character[], preferredName?: string | null, fallbackIndex = 0): Character | null => {
  if (!values.length) return null;
  if (preferredName) {
    const preferredCharacter = values.find(character => character.name === preferredName);
    if (preferredCharacter) return preferredCharacter;
  }
  return values[fallbackIndex] || values[0] || null;
};

const stripCharacterImageForSync = (value: Character | null) => {
  if (!value) return null;
  const { imageUrl, ...rest } = value;
  return rest;
};

const stripCharacterImagesForCloud = (values: Character[]) => values.map(character => {
  const { imageUrl, ...rest } = character;
  return rest;
});

const optimizeCharacterAvatar = async (imageUrl: string) => {
  if (!imageUrl.startsWith('data:image/')) return imageUrl;
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const maxDimension = 768;
      const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(imageUrl);
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        const optimized = canvas.toDataURL('image/webp', 0.82);
        resolve(optimized.length < imageUrl.length ? optimized : imageUrl);
      } catch {
        resolve(imageUrl);
      }
    };
    image.onerror = () => resolve(imageUrl);
    image.src = imageUrl;
  });
};

const extractInlineImageFrames = (parts: any[]): string[] => parts.flatMap(part => {
  if (!(part as any).inlineData) return [];
  const imageData = (part as any).inlineData;
  return [`data:${imageData.mimeType};base64,${imageData.data}`];
});

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
  if (firstIndex === -1) return [...logs, prefix];
  return logs.filter((log, index) => !log.startsWith(prefix) || index === firstIndex);
};

const ensureBattleStreamPlaceholders = (logs: string[]): string[] => {
  const withThoughts = ensureBattleStreamLog(logs, BATTLE_STREAM_THOUGHTS_PREFIX);
  return ensureBattleStreamLog(withThoughts, BATTLE_STREAM_ANSWER_PREFIX);
};

const removeBattleStreamPlaceholders = (logs: string[]): string[] => (
  logs.filter(log => !log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX) && !log.startsWith(BATTLE_STREAM_ANSWER_PREFIX))
);

const clampMapValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const estimateMarkerLabelWidth = (label: string, minWidth: number, maxWidth: number, charWidth: number) => (
  clampMapValue(label.length * charWidth, minWidth, maxWidth)
);

const getWorldLocationById = (worldData: any, locationId?: string | null): WorldLocation | null => (
  worldData?.locations?.find((entry: WorldLocation) => entry.id === locationId) || null
);

const layoutRepelledMarkers = (
  markers: MapMarkerLayoutInput[],
  bounds: { width: number; height: number },
): Record<string, MapMarkerLayoutPosition> => {
  if (markers.length === 0) return {};
  const padding = 8;
  const positions = markers.map(marker => ({ ...marker, x: marker.anchorX, y: marker.anchorY }));
  for (let iteration = 0; iteration < 36; iteration++) {
    const forces = positions.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const left = positions[i];
        const right = positions[j];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const overlapX = (left.width + right.width) / 2 + padding - Math.abs(dx);
        const overlapY = (left.height + right.height) / 2 + padding - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const safeDx = Math.abs(dx) < 0.01 ? (j - i || 1) * 0.01 : dx;
        const safeDy = Math.abs(dy) < 0.01 ? ((i + j) % 2 === 0 ? 0.01 : -0.01) : dy;
        const length = Math.hypot(safeDx, safeDy) || 1;
        const pushStrength = Math.max(overlapX, overlapY) * 0.22;
        const pushX = (safeDx / length) * pushStrength;
        const pushY = (safeDy / length) * pushStrength;
        forces[i].x -= pushX;
        forces[i].y -= pushY;
        forces[j].x += pushX;
        forces[j].y += pushY;
      }
    }
    positions.forEach((marker, index) => {
      forces[index].x += (marker.anchorX - marker.x) * 0.12;
      forces[index].y += (marker.anchorY - marker.y) * 0.12;
      marker.x = clampMapValue(marker.x + forces[index].x, marker.width / 2 + 4, bounds.width - marker.width / 2 - 4);
      marker.y = clampMapValue(marker.y + forces[index].y, marker.height / 2 + 4, bounds.height - marker.height / 2 - 4);
    });
  }
  return Object.fromEntries(positions.map(marker => [marker.id, { x: marker.x, y: marker.y }]));
};

const TypingDots = ({ className = '', dotClassName = 'h-1.5 w-1.5' }: { className?: string; dotClassName?: string }) => (
  <span className={`inline-flex items-end gap-1 text-current ${className}`} aria-label="Typing">
    {[0, 160, 320].map(delay => (
      <span
        key={delay}
        className={`${dotClassName} rounded-full bg-current animate-bounce`}
        style={{ animationDelay: `${delay}ms`, animationDuration: '0.9s' }}
      />
    ))}
  </span>
);

const buildBattleMapContext = (worldData: any, mapState?: BattleMapState, roomPlayers?: Record<string, any>, options?: { isJudge?: boolean }) => {
  if (!worldData || !mapState || mapState.players.length === 0) return '';
  let context = '';
  if (mapState.zones && mapState.zones.length > 0 && mapState.combatantZones) {
    context += 'BATTLE ZONES:\n';
    for (const zone of mapState.zones) {
      const occupants = Object.entries(mapState.combatantZones)
        .filter(([, zoneId]) => zoneId === zone.id)
        .map(([name]) => name);
      context += `- **${zone.name}** [${zone.id}]: ${zone.description}`;
      if (occupants.length > 0) context += ` — Occupied by: ${occupants.join(', ')}`;
      context += `. Connected to: ${zone.connections.join(', ')}.\n`;
    }
    context += '\nCOMBATANT POSITIONS:\n';
    for (const [name, zoneId] of Object.entries(mapState.combatantZones)) {
      const zone = mapState.zones.find(z => z.id === zoneId);
      context += `- ${name} is in ${zone?.name || zoneId}\n`;
    }
    return context;
  }
  context += 'BATTLE MAP STATE:\n';
  for (const player of mapState.players) {
    const location = getWorldLocationById(worldData, player.locationId);
    const playerName = roomPlayers?.[player.id]?.character?.name || player.name;
    context += `- ${playerName} starts near ${location?.name || player.locationId}.\n`;
  }
  return context;
};

const mergeBattlePositionUpdates = (
  worldData: any,
  currentMapState: BattleMapState | undefined,
  positionUpdates: Record<string, { x?: number; y?: number; locationId?: string }> | null | undefined,
  roomPlayers: Record<string, any>,
): BattleMapState | undefined => {
  if (!currentMapState || !positionUpdates) return currentMapState;
  const gridWidth = worldData?.meta?.gridSize?.width ?? 0;
  const gridHeight = worldData?.meta?.gridSize?.height ?? 0;
  const discoveredLocations = new Set(currentMapState.discoveredLocations);
  const clampCoordinate = (value: number, max: number) => (max > 0 ? clampMapValue(value, 0, max) : value);
  const applyUpdate = (entity: any, preferredName?: string) => {
    const update = positionUpdates[preferredName || entity.name] || positionUpdates[entity.name] || positionUpdates[entity.id];
    if (!update) return entity;
    const nextLocId = update.locationId || entity.locationId;
    const loc = getWorldLocationById(worldData, nextLocId);
    if (loc) {
      discoveredLocations.add(loc.id);
      if (loc.connections) loc.connections.forEach(c => discoveredLocations.add(c));
    }
    return {
      ...entity,
      locationId: nextLocId,
      x: typeof update.x === 'number' ? clampCoordinate(update.x, gridWidth) : entity.x,
      y: typeof update.y === 'number' ? clampCoordinate(update.y, gridHeight) : entity.y,
    };
  };
  return {
    ...currentMapState,
    discoveredLocations: Array.from(discoveredLocations),
    players: currentMapState.players.map(p => applyUpdate(p, roomPlayers[p.id]?.character?.name)),
    npcs: currentMapState.npcs.map(n => applyUpdate(n)),
  };
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [gameState, setGameState] = useState<GameState>('menu');
  const gameStateRef = useRef<GameState>('menu');
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
    const savedCharacters = normalizeCharacters(JSON.parse(localStorage.getItem('duo_characters') || '[]'));
    const preferredCharacter = pickPreferredCharacter(savedCharacters, localStorage.getItem('duo_active_character_name'));
    if (preferredCharacter) return preferredCharacter;
    const saved = localStorage.getItem('duo_character');
    return saved ? normalizeCharacter(JSON.parse(saved)) : null;
  });
  const charactersRef = useRef<Character[]>([]);
  const characterRef = useRef<Character | null>(null);
  const activeCharacterNameRef = useRef<string | null>(localStorage.getItem('duo_active_character_name'));
  const hadLocalDurations = useRef(false);
  const [settings, setSettings] = useState(() => {
    const defaultSettings = {
      apiKey: '', charModel: 'gemini-3-flash-preview', explorationModel: 'gemini-3-flash-preview', battleModel: 'gemini-3-flash-preview', botModel: 'gemini-2.5-flash',
      unlimitedTurnTime: false, arenaPreviewSeconds: 15, arenaTweakSeconds: 120, battleTurnSeconds: 90,
    };
    const saved = localStorage.getItem('duo_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        delete parsed.charModel; delete parsed.explorationModel; delete parsed.battleModel; delete parsed.botModel;
        if (parsed.arenaPreviewSeconds !== undefined || parsed.arenaTweakSeconds !== undefined || parsed.battleTurnSeconds !== undefined || parsed.unlimitedTurnTime !== undefined) {
          hadLocalDurations.current = true;
        }
        return { ...defaultSettings, ...parsed };
      } catch (e) { return defaultSettings; }
    }
    return defaultSettings;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'general' | 'debug'>('general');
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    const { charModel, explorationModel, battleModel, botModel, ...persistedSettings } = settings;
    localStorage.setItem('duo_settings', JSON.stringify(persistedSettings));
    fetch(`${BACKEND_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unlimitedTurnTime: settings.unlimitedTurnTime,
        arenaPreviewSeconds: settings.arenaPreviewSeconds,
        arenaTweakSeconds: settings.arenaTweakSeconds,
        battleTurnSeconds: settings.battleTurnSeconds,
      }),
    }).catch(() => {});
  }, [settings]);

  useEffect(() => {
    if (character) {
      localStorage.setItem('duo_character', JSON.stringify(character));
      localStorage.setItem('duo_active_character_name', character.name);
      activeCharacterNameRef.current = character.name;
      setCharacters(prev => {
        const index = prev.findIndex(c => c.name === character.name);
        if (index >= 0) {
          const next = [...prev]; next[index] = character;
          localStorage.setItem('duo_characters', JSON.stringify(next)); return next;
        } else {
          const next = [...prev, character];
          localStorage.setItem('duo_characters', JSON.stringify(next)); return next;
        }
      });
    }
  }, [character]);

  // Socket listeners for game flow
  useEffect(() => {
    socket.on('characterSaved', (state: any) => {
      const normalizedState = normalizeCharacter(state);
      setCharacter(normalizedState);
      setMessages(prev => [...prev, { role: 'system', text: `✓ ${normalizedState.name} saved!` }]);
    });

    socket.on('queueUpdated', (queue) => {
      setQueuePlayers(queue);
    });

    socket.on('waitingForOpponent', () => {
      setGameState('matchmaking');
    });

    socket.on('arenaPreparationState', (data: any) => {
      setRoomId(data.roomId);
      setPlayers(data.players);
      setIsBotMatch(data.isBotMatch);
      setArenaPreparation({
        stage: data.stage,
        remaining: data.remaining,
        playerRemaining: data.playerRemaining || {},
        tweakDuration: data.tweakDuration || 0,
        isBotMatch: data.isBotMatch,
        skipVotes: data.skipVotes || [],
      });
      setBattleLogs([]);
      setBattleInput('');
      setGameState('arena_prep');
    });

    socket.on('roomPlayersUpdated', (data: any) => {
      setPlayers(data.players);
      if (data.phase === 'preview' || data.phase === 'tweak') {
        setArenaPreparation(prev => prev ? { ...prev, stage: data.phase as ArenaPreparationState['stage'] } : prev);
      }
    });

    socket.on('turnResolved', (data: any) => {
      if (data.players) setPlayers(data.players);
      if (data.mapState) setBattleMapState(data.mapState);
      setBattleLogs(prev => [...prev, ...data.logs]);
      setHasVisualizedThisTurn(false);
      setIsLockedIn(false);
    });

    socket.on('battleEnded', (data: any) => {
      setBattleOutcome(data.outcome);
      setGameState('post_match');
    });

    socket.on('explorationStarted', (data: any) => {
      setExplorationState(data.explorationState || explorationState);
      setGameState('exploration');
    });

    socket.on('error', (msg: string) => {
      console.error('Server error:', msg);
      // Show in appropriate context based on gameState
      if (gameStateRef.current === 'char_creation') {
        setMessages(prev => [...prev, { role: 'system', text: `⚠️ Error: ${msg}` }]);
      } else if (gameStateRef.current === 'battle') {
        setBattleError(msg);
      }
    });

    return () => {
      socket.off('characterSaved');
      socket.off('queueUpdated');
      socket.off('waitingForOpponent');
      socket.off('arenaPreparationState');
      socket.off('roomPlayersUpdated');
      socket.off('turnResolved');
      socket.off('battleEnded');
      socket.off('explorationStarted');
      socket.off('error');
    };
  }, []);

  const getAIClient = useCallback(() => {
    const customKey = settingsRef.current.apiKey?.trim();
    if (customKey) return createAIClient(customKey);
    return createAIClient(process.env.API_KEY || process.env.GEMINI_API_KEY);
  }, []);

  const clearTypingPresence = (context: string) => {
    // Clear typing indicator for context ('battle', 'exploration', 'char')
    // This is a no-op stub for now; can be expanded for actual typing notifications
  };

  const getBotSystemPrompt = async (): Promise<string> => {
    // Return a system prompt for bot actions
    return 'You are a skilled RPG combatant. Respond with creative but strategic battle actions.';
  };

  const handleChatScroll = () => {
    if (!chatScrollContainerRef.current) return;
    const el = chatScrollContainerRef.current;
    chatShouldAutoScrollRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  };

  const handleBattleScroll = () => {
    if (!battleScrollContainerRef.current) return;
    const el = battleScrollContainerRef.current;
    battleShouldAutoScrollRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  };

  const handleExplorationScroll = () => {
    if (!explorationScrollContainerRef.current) return;
    const el = explorationScrollContainerRef.current;
    explorationShouldAutoScrollRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  };

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isWaitingForChar, setIsWaitingForChar] = useState(false);
  const [charCreatorRetryAttempt, setCharCreatorRetryAttempt] = useState(0);
  const [charCreatorError, setCharCreatorError] = useState<string | null>(null);
  const charAbortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [worldData, setWorldData] = useState<any>(null);
  const worldDataRef = useRef<any>(null);
  const [explorationState, setExplorationState] = useState<ExplorationState>({
    locationId: '', subZoneId: null, x: 0, y: 0, hunger: 100, thirst: 100, stamina: 100, inventory: {}, discoveredLocations: [], goals: [], equippedWeapon: null, equippedArmor: null,
  });
  const [explorationLog, setExplorationLog] = useState<Message[]>([]);
  const [explorationInput, setExplorationInput] = useState('');
  const [isExplorationProcessing, setIsExplorationProcessing] = useState(false);
  const [worldPlayers, setWorldPlayers] = useState<WorldPlayer[]>([]);
  const [worldNpcs, setWorldNpcs] = useState<WorldNpc[]>([]);
  const followingNpcIdsRef = useRef<Set<string>>(new Set());
  const [explorationLockStatus, setExplorationLockStatus] = useState<{id: string; name: string; lockedIn: boolean}[]>([]);
  const [isExplorationLockedIn, setIsExplorationLockedIn] = useState(false);
  const [explorationSummary, setExplorationSummary] = useState('');
  const [isCompacting, setIsCompacting] = useState(false);
  const [showGoalsModal, setShowGoalsModal] = useState(false);
  const [showFullMap, setShowFullMap] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const mapDragRef = useRef<{ dragging: boolean; pointerId: number; lastX: number; lastY: number }>({ dragging: false, pointerId: -1, lastX: 0, lastY: 0 });
  const mapPinchRef = useRef<{ distance: number; centerX: number; centerY: number }>({ distance: 0, centerX: 0, centerY: 0 });
  const [showInventory, setShowInventory] = useState(false);
  const [showExplorationMeta, setShowExplorationMeta] = useState(false);
  const [showExplorationNearby, setShowExplorationNearby] = useState(false);
  const [showCharImage, setShowCharImage] = useState(false);
  const [isGeneratingCharImage, setIsGeneratingCharImage] = useState(false);
  const [explorationCombatReturn, setExplorationCombatReturn] = useState(false);
  const [combatEnemyLoot, setCombatEnemyLoot] = useState<string[]>([]);
  const explorationEndRef = useRef<HTMLDivElement>(null);
  const explorationInputRef = useRef<HTMLTextAreaElement>(null);
  const activeExplorationStreamIdRef = useRef<string | null>(null);
  const [explorationRetryAttempt, setExplorationRetryAttempt] = useState(0);
  const [explorationError, setExplorationError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<Record<string, any>>({});
  const playersRef = useRef<Record<string, any>>({});
  const [battleMapState, setBattleMapState] = useState<BattleMapState>(EMPTY_BATTLE_MAP_STATE);
  const battleMapStateRef = useRef<BattleMapState>(EMPTY_BATTLE_MAP_STATE);
  const [arenaPreparation, setArenaPreparation] = useState<ArenaPreparationState | null>(null);
  const [battleLogs, setBattleLogs] = useState<string[]>([]);
  const battleLogsRef = useRef<string[]>([]);
  const [battleInput, setBattleInput] = useState('');
  const [battleError, setBattleError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [expandedThoughts, setExpandedThoughts] = useState<Set<number>>(new Set());
  const [expandedExplorationThoughts, setExpandedExplorationThoughts] = useState<Set<string>>(new Set());
  const [showBattleMeta, setShowBattleMeta] = useState(false);
  const [showBattleInventory, setShowBattleInventory] = useState(false);
  const [showArenaRoster, setShowArenaRoster] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isLockedIn, setIsLockedIn] = useState(false);
  const [roomTypingIds, setRoomTypingIds] = useState<string[]>([]);
  const [localRoomTypingIds, setLocalRoomTypingIds] = useState<string[]>([]);
  const [botRewriteAttempt, setBotRewriteAttempt] = useState(0);
  const typingStopTimeoutsRef = useRef<Record<string, number>>({});
  const battleEndRef = useRef<HTMLDivElement>(null);
  const charInputRef = useRef<HTMLTextAreaElement>(null);
  const battleInputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const battleScrollContainerRef = useRef<HTMLDivElement>(null);
  const explorationScrollContainerRef = useRef<HTMLDivElement>(null);
  const chatShouldAutoScrollRef = useRef(true);
  const battleShouldAutoScrollRef = useRef(true);
  const explorationShouldAutoScrollRef = useRef(true);
  const [chatNeedsJump, setChatNeedsJump] = useState(false);
  const [battleNeedsJump, setBattleNeedsJump] = useState(false);
  const [explorationNeedsJump, setExplorationNeedsJump] = useState(false);
  const handleGenerateBattleImageRef = useRef<(() => void) | null>(null);
  const [botCharacters, setBotCharacters] = useState<any[]>([]);
  const [selectedBotCharacter, setSelectedBotCharacter] = useState<string>('');
  const [isGeneratingBot, setIsGeneratingBot] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const [connectionPhase, setConnectionPhase] = useState<'online' | 'reconnecting' | 'resyncing'>('online');
  const connectionPhaseRef = useRef<'online' | 'reconnecting' | 'resyncing'>('online');
  const lastSyncedCharRef = useRef<string>('');
  const hasConnectedOnceRef = useRef(false);
  const [queuePlayers, setQueuePlayers] = useState<any[]>([]);
  const [isBotMatch, setIsBotMatch] = useState(false);
  const [battleOutcome, setBattleOutcome] = useState<'win' | 'loss' | null>(null);
  const [isGeneratingBattleImage, setIsGeneratingBattleImage] = useState(false);
  const battleImageAbortRef = useRef<AbortController | null>(null);
  const [hasVisualizedThisTurn, setHasVisualizedThisTurn] = useState(false);
  const [awaitingBattleImage, setAwaitingBattleImage] = useState(false);
  const pendingBotRoomRef = useRef<any>(null);
  const npcAllyActionsInFlightRef = useRef<Set<string>>(new Set());
  const npcAllyActionRequestIdsRef = useRef<Record<string, number>>({});
  const npcAllyLastActionTurnRef = useRef<Record<string, number>>({});
  const botActionInFlightRef = useRef(false);
  const botLastActionTurnRef = useRef<number | null>(null);
  const autonomousTurnSequenceRef = useRef(0);
  const botSystemPromptRef = useRef<string | null>(null);
  const [turnTimerRemaining, setTurnTimerRemaining] = useState<number | null>(null);
  const [isVisualizingScene, setIsVisualizingScene] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileToView, setProfileToView] = useState<string | null>(null);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);

  const upsertBattleStatusLog = useCallback((statusId: string, text: string) => {
    const prefix = `STATUS_${statusId}::`;
    setBattleLogs(prev => { const next = prev.filter(log => !log.startsWith(prefix)); return [...next, `${prefix}${text}`]; });
  }, []);

  const clearBattleStatusLog = useCallback((statusId: string) => {
    const prefix = `STATUS_${statusId}::`;
    setBattleLogs(prev => prev.filter(log => !log.startsWith(prefix)));
  }, []);

  const upsertExplorationStatusMessage = useCallback((statusId: string, text: string) => {
    setExplorationLog(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) { if (next[i].streamId === statusId) { next[i] = { ...next[i], role: 'system', text, streamId: statusId }; return next; } }
      return [...prev, { role: 'system', text, streamId: statusId }];
    });
  }, []);

  const clearExplorationStatusMessage = useCallback((statusId: string) => {
    setExplorationLog(prev => prev.filter(message => message.streamId !== statusId));
  }, []);

  // Keep refs in sync with state
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  useEffect(() => { playersRef.current = players; }, [players]);
  useEffect(() => { battleLogsRef.current = battleLogs; }, [battleLogs]);
  useEffect(() => { battleMapStateRef.current = battleMapState; }, [battleMapState]);
  useEffect(() => { worldDataRef.current = worldData; }, [worldData]);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  useEffect(() => { characterRef.current = character; }, [character]);

  const handleEnterArena = () => {
    if (!character) { setActiveTab('profile'); setGameState('char_creation'); if (messages.length === 0) setMessages([{ role: 'model', text: "Welcome! character?" }]); return; }
    socket.emit('enterArena', { unlimitedTurnTime: settingsRef.current.unlimitedTurnTime, arenaPreviewSeconds: settingsRef.current.arenaPreviewSeconds, arenaTweakSeconds: settingsRef.current.arenaTweakSeconds, battleTurnSeconds: settingsRef.current.battleTurnSeconds });
  };

  const handlePlayBot = () => {
    if (!character) { setActiveTab('profile'); setGameState('char_creation'); if (messages.length === 0) setMessages([{ role: 'model', text: "Welcome! character?" }]); return; }
    setGameState('matchmaking');
    socket.emit('startBotMatch', { difficulty: 'Medium', unlimitedTurnTime: settingsRef.current.unlimitedTurnTime, arenaPreviewSeconds: settingsRef.current.arenaPreviewSeconds, arenaTweakSeconds: settingsRef.current.arenaTweakSeconds, battleTurnSeconds: settingsRef.current.battleTurnSeconds });
  };

  const handleBattleUnlock = () => { clearTypingPresence('battle'); socket.emit('playerUnlock'); setIsLockedIn(false); };
  
  const handleSendBattleAction = () => {
    const action = battleInput.trim(); if (!action || isLockedIn || awaitingBattleImage) return;
    clearTypingPresence('battle');
    if (socket.id) setBattleLogs(prev => [...removePendingBattleActionLogs(prev, socket.id), buildPendingBattleActionLog(socket.id!, action)]);
    socket.emit('playerAction', action); setIsLockedIn(true); setBattleInput('');
  };

  const getThoughtTitle = (content: string) => {
    const lines = content.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) { const line = lines[i].trim(); if (line.startsWith('#') || (line.startsWith('**') && line.endsWith('**'))) return line.replace(/[#*]/g, '').trim(); }
    const words = (lines[lines.length - 1] || "Thinking...").replace(/[#*]/g, '').trim().split(' ');
    return words.length <= 4 ? words.join(' ') : words.slice(0, 4).join(' ') + '...';
  };

  const handleGenerateBattleImage = async () => {
    if (hasVisualizedThisTurn) { setAwaitingBattleImage(false); setIsLockedIn(false); socket.emit('readyForNextTurn'); return; }
    if (battleImageAbortRef.current) battleImageAbortRef.current.abort();
    const masterAbort = new AbortController();
    battleImageAbortRef.current = masterAbort;
    setIsGeneratingBattleImage(true);
    upsertBattleStatusLog('battle-image-generation', '🎨 Generating battle image...');
    try {
      const aiClient = getAIClient();
      const lastActions = [...battleLogs].reverse().find(l => l.startsWith(BATTLE_PLAYER_ACTIONS_PREFIX));
      const playerActions = lastActions ? lastActions.substring(BATTLE_PLAYER_ACTIONS_PREFIX.length) : '';
      const narrativeLogs = battleLogs.filter(l => !l.startsWith('STREAMING_') && !l.startsWith('>') && !l.startsWith('PLAYER_ACTIONS_') && !l.startsWith(BATTLE_PENDING_ACTION_PREFIX) && !l.startsWith('STATUS_IMAGE')).slice(-2).join('\n').substring(0, 800);
      const playerDescriptions = Object.values(players).map((p: any) => `${p.character.name} (HP: ${p.character.hp}/${p.character.maxHp}, Mana: ${p.character.mana}/${p.character.maxMana})`).join(' vs ');
      const prompt = `Generate a dynamic RPG battle art scene. Combatants: ${playerDescriptions}\n\nActions: ${playerActions}\n\nResult: ${narrativeLogs}\n\nStyle: Dynamic fantasy battle, cinematic. No text.`;
      const contentParts: any[] = [{ text: prompt }];
      Object.values(players).forEach((p: any) => {
        const avatarUrl = p.character?.imageUrl;
        if (avatarUrl && avatarUrl.startsWith('data:')) {
          const match = avatarUrl.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) contentParts.push({ text: `Ref for ${p.character.name}:` }, { inlineData: { mimeType: match[1], data: match[2] } });
        }
      });
      let attempts = 0;
      while (true) {
        if (masterAbort.signal.aborted) break;
        const attemptAbort = new AbortController();
        const onMasterAbort = () => attemptAbort.abort();
        masterAbort.signal.addEventListener('abort', onMasterAbort);
        let timeoutId: any = setTimeout(() => attemptAbort.abort(), 60_000);
        try {
          const res = await aiClient.models.generateContent({ model: 'gemini-3-pro-image-preview', contents: [{ role: 'user', parts: contentParts }], config: { responseModalities: ['IMAGE', 'TEXT'], abortSignal: attemptAbort.signal } });
          if (timeoutId) clearTimeout(timeoutId);
          masterAbort.signal.removeEventListener('abort', onMasterAbort);
          if (masterAbort.signal.aborted) break;
          const parts = res.candidates?.[0]?.content?.parts || [];
          let foundImage = false;
          for (const part of parts) {
            if ((part as any).inlineData) {
              const imageData = (part as any).inlineData;
              const imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;
              setBattleLogs(prev => [...prev, `STATUS_IMAGE::🎨 The scene takes shape...`, `STATUS_IMAGE_URL::${imageUrl}`]);
              setHasVisualizedThisTurn(true); foundImage = true; break;
            }
          }
          break;
        } catch (error: any) {
          if (timeoutId) clearTimeout(timeoutId);
          masterAbort.signal.removeEventListener('abort', onMasterAbort);
          if (masterAbort.signal.aborted) break;
          const errorInfo = classifyAIError(error);
          if (errorInfo.retryable) {
            attempts++; const delay = getAIRetryDelaySeconds(attempts);
            upsertBattleStatusLog('battle-image-generation', `🎨 Generating battle image... (Attempt ${attempts + 1}: ${errorInfo.label})`);
            await new Promise(resolve => setTimeout(resolve, delay * 1000)); continue;
          }
          upsertBattleStatusLog('battle-image-generation', `⚠️ Scene generation failed: ${formatAIError(errorInfo)}`);
          break;
        }
      }
    } finally {
      setIsGeneratingBattleImage(false); setAwaitingBattleImage(false); setIsLockedIn(false); socket.emit('readyForNextTurn');
      const pendingRoom = pendingBotRoomRef.current; pendingBotRoomRef.current = null;
      if (pendingRoom) { generateNpcAllyActions(pendingRoom, pendingRoom.turnId); generateBotAction(pendingRoom, pendingRoom.turnId); }
    }
  };

  const generateBotAction = async (currentRoom: any, turnId?: number) => {
    if (!currentRoom || !currentRoom.isBotMatch || botActionInFlightRef.current) return;
    const botId = Object.keys(currentRoom.players).find(id => id.startsWith('bot_'));
    const playerId = Object.keys(currentRoom.players).find(id => !id.startsWith('bot_'));
    if (!botId || !playerId || currentRoom.players[botId].lockedIn) return;
    if (typeof turnId === 'number') botLastActionTurnRef.current = turnId;
    botActionInFlightRef.current = true;
    setLocalRoomTypingIds(prev => prev.includes(botId) ? prev : [...prev, botId]);
    try {
      const aiClient = getAIClient();
      const botSysPrompt = await getBotSystemPrompt();
      const botPrompt = `Difficulty: ${currentRoom.botDifficulty}\nAs: ${currentRoom.players[botId].character.name}\nHistory: ${battleLogsRef.current.slice(-10).join('\n')}`;
      const botRes = await aiClient.models.generateContent({ model: settingsRef.current.botModel, contents: botPrompt, config: { systemInstruction: botSysPrompt, temperature: 0.8 } });
      socket.emit('playerAction', { playerId: botId, action: (botRes.text || "I strike!").trim() });
    } catch (error) { socket.emit('playerAction', { playerId: botId, action: `${currentRoom.players[botId].character.name} attacks!` }); } finally {
      botActionInFlightRef.current = false; setLocalRoomTypingIds(prev => prev.filter(id => id !== botId));
    }
  };

  const generateNpcAllyActions = async (currentRoom: any, turnId?: number) => {
    if (!currentRoom) return;
    const npcAllyIds = Object.keys(currentRoom.players).filter(id => id.startsWith('npc_ally_'));
    if (npcAllyIds.length === 0) return;
    await Promise.all(npcAllyIds.map(async (npcId) => {
      const npcData = currentRoom.players[npcId];
      if (!npcData || npcData.lockedIn || npcAllyActionsInFlightRef.current.has(npcId)) return;
      npcAllyActionsInFlightRef.current.add(npcId);
      upsertBattleStatusLog(`npc-ally-${npcId}`, `🤝 ${npcData.character.name} is choosing an action...`);
      setLocalRoomTypingIds(prev => prev.includes(npcId) ? prev : [...prev, npcId]);
      try {
        const aiClient = getAIClient();
        const sysPrompt = await getBotSystemPrompt();
        const prompt = `NPC ally as: ${npcData.character.name}\nHP: ${npcData.character.hp}\nHistory: ${battleLogsRef.current.slice(-10).join('\n')}`;
        const res = await aiClient.models.generateContent({ model: settingsRef.current.botModel, contents: prompt, config: { systemInstruction: sysPrompt, temperature: 0.8 } });
        socket.emit('playerAction', { playerId: npcId, action: (res.text || "I help!").trim() });
      } catch (e) { socket.emit('playerAction', { playerId: npcId, action: `${npcData.character.name} attacks!` }); } finally {
        npcAllyActionsInFlightRef.current.delete(npcId); setLocalRoomTypingIds(prev => prev.filter(id => id !== npcId));
      }
    }));
  };

  const renderTopBar = () => {
    const p = socket.id ? players[socket.id] : undefined;
    const hp = p ? p.character.hp : character?.hp ?? 100;
    const mana = p ? p.character.mana : character?.mana ?? 100;
    const gold = p ? p.character.gold : character?.gold ?? DEFAULT_STARTING_GOLD;
    const name = p ? p.character.name : character?.name ?? 'No Legend';
    return (
      <div className="sticky top-0 z-20 bg-white border-b-2 border-duo-gray shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-duo-gray-dark">
            {(gameState === 'battle' || gameState === 'post_match') && <button onClick={() => { setGameState('menu'); socket.emit('leaveQueue'); }} className="mr-1 hover:text-duo-blue"><ArrowLeft className="w-6 h-6" /></button>}
            <button onClick={() => { if (character?.profileMarkdown) { setProfileToView(character.profileMarkdown); setShowProfileModal(true); } }} className="flex items-center gap-2 hover:opacity-80">
              {character?.imageUrl ? <img src={character.imageUrl} className="w-7 h-7 rounded-full border-2 border-duo-gray object-cover" /> : <div className="w-7 h-7 rounded-full bg-duo-gray flex items-center justify-center"><User className="w-4 h-4 text-duo-gray-dark" /></div>}
              <span className="uppercase text-sm truncate max-w-[120px]">{name}</span>
            </button>
          </div>
          <div className="flex items-center gap-4 text-lg font-bold">
            {gameState !== 'menu' && <><div className="flex items-center gap-1 text-amber-500"><Coins className="w-6 h-6" /><span>{gold}</span></div><div className="flex items-center gap-1 text-fuchsia-600"><Orbit className="w-6 h-6" /><span>{mana}</span></div><div className="flex items-center gap-1 text-duo-red"><Heart className="w-6 h-6 fill-current" /><span>{hp}</span></div></>}
            <button onClick={() => setShowSettings(true)} className="ml-2 hover:text-duo-blue text-duo-gray-dark"><Settings className="w-6 h-6" /></button>
          </div>
        </div>
        {connectionPhase !== 'online' && <div className={`px-4 py-1.5 text-[10px] font-black uppercase border-t ${connectionPhase === 'reconnecting' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`}>{connectionPhase === 'reconnecting' ? 'Reconnecting...' : 'Resyncing...'}</div>}
        {gameState === 'battle' && <div className="px-4 py-2 border-t border-duo-gray/30 flex flex-wrap gap-2">{Object.keys(players).map(id => { const isMe = id === socket.id; const p = players[id]; return <div key={id} className="flex-1 min-w-[120px] space-y-1"><div className="flex justify-between items-center gap-2 text-[10px] font-bold text-duo-gray-dark uppercase"><button onClick={() => { setProfileToView(p.character.profileMarkdown); setShowProfileModal(true); }} className="truncate flex-1 text-left">{isMe ? 'You' : p.character.name}</button><div className="flex gap-2"><span>{p.character.mana} MNA</span><span>{p.character.hp} HP</span></div></div><div className="h-2 bg-duo-gray rounded-full overflow-hidden"><div className={`h-full transition-all duration-500 ${isMe ? 'bg-duo-green' : 'bg-duo-red'}`} style={{ width: `${Math.max(0, p.character.hp)}%` }} /></div></div>; })}</div>}
      </div>
    );
  };

  const renderBottomBar = () => {
    if (['battle', 'arena_prep', 'matchmaking', 'exploration', 'level_select'].includes(gameState)) return null;
    return (
      <div className="w-full max-w-md bg-white border-t-2 border-duo-gray flex justify-around py-3 pb-safe mt-auto">
        <button onClick={() => { setActiveTab('home'); setGameState('menu'); }} className={activeTab === 'home' ? 'text-duo-green' : 'text-duo-gray-dark'}><Home className={`w-8 h-8 ${activeTab === 'home' ? 'fill-current' : ''}`} /></button>
        <button onClick={() => { setActiveTab('profile'); setGameState('char_creation'); if (messages.length === 0) setMessages([{ role: 'model', text: "Welcome! character?" }]); }} className={activeTab === 'profile' ? 'text-duo-green' : 'text-duo-gray-dark'}><User className={`w-8 h-8 ${activeTab === 'profile' ? 'fill-current' : ''}`} /></button>
        <button onClick={() => setActiveTab('social')} className={activeTab === 'social' ? 'text-duo-green' : 'text-duo-gray-dark'}><Users className={`w-8 h-8 ${activeTab === 'social' ? 'fill-current' : ''}`} /></button>
      </div>
    );
  };

  const renderBattleZoneMap = (showInline = true) => {
    const zones = battleMapState.zones || [];
    const combatantZones = battleMapState.combatantZones || {};
    const mapW = 140, mapH = 140;
    const cx = mapW / 2, cy = mapH / 2, radius = Math.min(mapW, mapH) / 2 - 22;
    const posMap: Record<string, { x: number; y: number }> = {};
    zones.forEach((z, i) => { const a = (2 * Math.PI * i) / zones.length - Math.PI / 2; posMap[z.id] = { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }; });
    const myId = socket.id || '';
    const myZoneId = Object.entries(combatantZones).find(([name]) => players[Object.entries(players).find(([, p]) => p.character?.name === name)?.[0] || '']?.id === myId)?.[1];
    const zoneOccupants: Record<string, { name: string; isMe: boolean; isAlly: boolean }[]> = {};
    for (const [charName, zoneId] of Object.entries(combatantZones)) {
      if (!zoneOccupants[zoneId]) zoneOccupants[zoneId] = [];
      const pid = Object.entries(players).find(([, p]) => p.character?.name === charName)?.[0];
      zoneOccupants[zoneId].push({ name: charName, isMe: pid === myId, isAlly: !!pid && players[pid]?.character?.isNpcAlly });
    }
    const renderZoneGraph = (w: number, h: number, interactive: boolean) => {
      const gcx = w / 2, gcy = h / 2, gr = Math.min(w, h) / 2 - (interactive ? 60 : 22);
      const subPosMap: Record<string, { x: number; y: number }> = {};
      zones.forEach((z, i) => { const a = (2 * Math.PI * i) / zones.length - Math.PI / 2; subPosMap[z.id] = { x: gcx + gr * Math.cos(a), y: gcy + gr * Math.sin(a) }; });
      return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {zones.flatMap(z => z.connections.filter(c => c > z.id).map(c => <line key={`${z.id}-${c}`} x1={subPosMap[z.id].x} y1={subPosMap[z.id].y} x2={subPosMap[c].x} y2={subPosMap[c].y} stroke="rgba(255,255,255,0.3)" strokeWidth={interactive ? 2 : 1} />))}
          {zones.map(z => {
            const p = subPosMap[z.id], occ = zoneOccupants[z.id] || [], isMine = z.id === myZoneId;
            return (
              <g key={z.id} onClick={() => { if (showFullMap) { if (z.id !== myZoneId) setBattleInput(`I move to ${z.name}`); } else setShowFullMap(true); }} style={{ cursor: interactive ? 'pointer' : 'default' }}>
                <circle cx={p.x} cy={p.y} r={interactive ? 28 : 12} fill={isMine ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'} stroke={isMine ? '#22c55e' : 'rgba(255,255,255,0.4)'} strokeWidth={interactive ? 2 : 1} />
                <text x={p.x} y={p.y - (interactive ? 36 : 16)} textAnchor="middle" fontSize={interactive ? 11 : 5} fill={isMine ? '#22c55e' : 'white'}>{z.name}</text>
                {occ.map((o, i) => <circle key={o.name} cx={p.x + (i - (occ.length - 1) / 2) * (interactive ? 12 : 6)} cy={p.y} r={interactive ? 5 : 2.5} fill={o.isMe ? '#22c55e' : o.isAlly ? '#facc15' : '#1cb0f6'} stroke="white" strokeWidth={0.5} />)}
              </g>
            );
          })}
        </svg>
      );
    };
    return (
      <div className="relative">
        {!showFullMap && showInline && <div className="bg-blue-900/80 rounded-xl border-2 border-duo-gray overflow-hidden relative cursor-pointer" style={{ width: mapW, height: mapH }} onClick={() => setShowFullMap(true)}>{renderZoneGraph(mapW, mapH, false)}<div className="absolute bottom-1 right-1 bg-white/80 rounded px-1"><Maximize2 className="w-3 h-3 text-blue-900" /></div></div>}
        {showFullMap && <div className="fixed inset-0 z-50 bg-black/60 flex flex-col p-4" onClick={() => setShowFullMap(false)}><div className="bg-blue-900/95 rounded-3xl border-2 border-duo-gray overflow-hidden flex flex-col flex-1" onClick={e => e.stopPropagation()}><div className="p-3 flex justify-between items-center text-white"><span className="font-black text-sm">Battle Arena</span><button onClick={() => setShowFullMap(false)} className="bg-white rounded-full p-2"><X className="w-5 h-5 text-duo-text" /></button></div><div className="flex-1 relative">{renderZoneGraph(window.innerWidth - 32, window.innerHeight - 140, true)}</div></div></div>}
      </div>
    );
  };

  const renderMinimap = (showInline = true) => {
    if (!worldData) return null;
    if (gameState === 'battle' && battleMapState.zones && battleMapState.zones.length > 0) return renderBattleZoneMap(showInline);
    const activePos = (gameState === 'battle' ? battleMapState.players.find(p => p.id === socket.id) : null) || { locationId: explorationState.locationId, x: explorationState.x, y: explorationState.y };
    const mapW = 140, mapH = 140, gridSize = worldData.meta.gridSize;
    const miniScaleX = mapW / gridSize.width, miniScaleY = mapH / gridSize.height;
    const miniOffsetX = mapW / 2 - (activePos.x * miniScaleX), miniOffsetY = mapH / 2 - (activePos.y * miniScaleY);
    const discovered = gameState === 'battle' ? battleMapState.discoveredLocations : explorationState.discoveredLocations;
    return (
      <div className="bg-blue-900/80 rounded-xl border-2 border-duo-gray overflow-hidden relative cursor-pointer" style={{ width: mapW, height: mapH }} onClick={() => setShowFullMap(true)}>
        <div style={{ transform: `translate(${miniOffsetX}px, ${miniOffsetY}px)`, position: 'absolute', inset: 0 }}>
          {worldData.islands.map((i: any) => <div key={i.id} className="absolute rounded opacity-30" style={{ left: i.bounds.x * miniScaleX, top: i.bounds.y * miniScaleY, width: i.bounds.width * miniScaleX, height: i.bounds.height * miniScaleY, backgroundColor: i.biome === 'volcanic' ? '#8B4513' : '#228B22' }} />)}
          {worldData.locations.filter((l: any) => discovered.includes(l.id)).map((loc: any) => <div key={loc.id} className={`absolute rounded-full ${loc.id === activePos.locationId ? 'bg-duo-green' : 'bg-white/70'}`} style={{ left: loc.x * miniScaleX, top: loc.y * miniScaleY, width: 4, height: 4, transform: 'translate(-50%,-50%)' }} />)}
        </div>
        <div className="absolute rounded-full bg-duo-green" style={{ left: mapW / 2 - 2, top: mapH / 2 - 2, width: 4, height: 4 }} />
      </div>
    );
  };

  const renderMenu = () => (
    <div className="flex-1 flex flex-col items-center p-6 gap-8 overflow-y-auto">
      <div className="text-center"><h1 className="text-8xl font-black text-duo-text tracking-tight">What If</h1><p className="text-duo-gray-dark font-bold">Learn to fight. Forever.</p></div>
      <div className="flex flex-col gap-6 w-full max-w-xs">
        <div className="flex flex-col items-center gap-3">
          <div className="w-24 h-24 rounded-full bg-duo-gray border-4 border-white shadow-md overflow-hidden">{character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full object-cover" /> : <User className="w-12 h-12 text-duo-gray-dark m-auto h-full" />}</div>
          <button onClick={() => { if (character) setGameState('char_creation'); }} className="duo-btn duo-btn-blue w-full py-3">{character ? 'Tweak Legend' : 'Build Legend'}</button>
          <button onClick={handleEnterArena} className="duo-btn duo-btn-green w-full py-3">Enter Arena</button>
          <button onClick={handlePlayBot} className="duo-btn duo-btn-blue w-full py-3">1v1 vs Bot</button>
          <button onClick={() => { socket.emit('enterExploration', {}); setGameState('exploration'); }} className="duo-btn duo-btn-blue w-full py-3">Explore World</button>
        </div>
      </div>
    </div>
  );

  const getBattleSendBlockReason = () => {
    if (!battleInput.trim()) return 'Action required';
    if (awaitingBattleImage) return 'Scene generating...';
    if (isLockedIn) return 'Locked';
    return null;
  };

  const renderArenaPreparation = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-3 bg-white border-b border-duo-gray flex justify-between items-center"><h2 className="font-black">Prepare for Duel</h2><div className="bg-blue-50 px-3 py-1 rounded-xl text-blue-700 font-bold">{arenaPreparation?.remaining}s</div></div>
      <div className="flex-1 p-6 flex flex-col items-center justify-center text-center">
        <div className="duo-card p-6 w-full"><h3 className="text-lg font-black mb-2">Final Rewrite</h3><p className="text-sm text-duo-gray-dark mb-4">One pass to tweak based on opponent.</p><button onClick={() => setGameState('char_creation')} className="duo-btn duo-btn-blue w-full py-3">Open Architect</button></div>
      </div>
    </div>
  );

  const renderBattle = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-2 bg-white border-b border-gray-200 flex justify-between items-center"><h1 className="font-black text-sm">Arena</h1>{renderMinimap(true)}</div>
      <div ref={battleScrollContainerRef} onScroll={handleBattleScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
        {battleLogs.map((log, i) => {
          if (log.startsWith('STATUS_IMAGE_URL::')) return <div key={i} className="rounded-xl overflow-hidden border-2 border-duo-gray shadow-md my-2"><img src={log.slice(18)} /></div>;
          return <div key={i} className="duo-card p-3 text-sm markdown-body"><Markdown rehypePlugins={[rehypeRaw]}>{log}</Markdown></div>;
        })}
        <div ref={battleEndRef} />
      </div>
      <div className="p-2 composer-safe bg-white border-t border-duo-gray flex gap-2">
        <textarea ref={battleInputRef} value={battleInput} onChange={e => setBattleInput(e.target.value)} disabled={isLockedIn} placeholder={isLockedIn ? "Action locked..." : "Your move?"} className="flex-1 bg-duo-gray rounded-2xl px-3 py-2 text-sm focus:outline-none resize-none" rows={1} />
        <button onClick={handleSendBattleAction} disabled={!!getBattleSendBlockReason()} className="duo-btn duo-btn-blue px-4 flex items-center"><Send className="w-4 h-4" /></button>
      </div>
    </div>
  );

  const renderExploration = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-2 bg-white border-b border-duo-gray flex justify-between items-center"><button onClick={() => setGameState('menu')}><ArrowLeft className="w-5 h-5" /></button>{renderMinimap(true)}</div>
      <div ref={explorationScrollContainerRef} onScroll={handleExplorationScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
        {explorationLog.map((msg, i) => <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={msg.role === 'user' ? 'chat-bubble-me' : 'chat-bubble-them'}><div className="markdown-body"><Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown></div></div></div>)}
        <div ref={explorationEndRef} />
      </div>
      <div className="p-2 composer-safe bg-white border-t border-duo-gray flex gap-2">
        <textarea ref={explorationInputRef} value={explorationInput} onChange={e => setExplorationInput(e.target.value)} placeholder="Explore..." className="flex-1 bg-duo-gray rounded-2xl px-3 py-2 text-sm focus:outline-none resize-none" rows={1} />
        <button onClick={() => { const a = explorationInput; setExplorationInput(''); socket.emit('explorationAction', { action: a, explorationState }); setExplorationLog(prev => [...prev, { role: 'user', text: a }]); }} className="duo-btn duo-btn-blue px-4 flex items-center"><Send className="w-4 h-4" /></button>
      </div>
    </div>
  );

  const renderPostMatch = () => <div className="flex-1 flex flex-col items-center justify-center p-6"><h1 className="text-4xl font-black mb-8">Victory!</h1><button onClick={() => setGameState('menu')} className="duo-btn duo-btn-green w-full py-4 text-lg">Menu</button></div>;
  const renderLevelSelect = () => <div className="p-6">Levels placeholder</div>;
  const renderCharCreation = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-3 bg-white border-b border-duo-gray flex justify-between items-center"><button onClick={() => setGameState('menu')}><ArrowLeft className="w-5 h-5" /></button><h2 className="font-black">Legend Architect</h2><div /></div>
      <div ref={chatScrollContainerRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, i) => <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={msg.role === 'user' ? 'chat-bubble-me' : 'chat-bubble-them'}><div className="markdown-body"><Markdown rehypePlugins={[rehypeRaw]}>{msg.text}</Markdown></div></div></div>)}
        <div ref={chatEndRef} />
      </div>
      <div className="p-2.5 composer-safe bg-white border-t border-duo-gray flex gap-2">
        <textarea ref={charInputRef} value={inputText} onChange={e => setInputText(e.target.value)} placeholder="Describe your legend..." className="flex-1 bg-duo-gray rounded-2xl px-4 py-3 font-bold focus:outline-none resize-none" rows={1} />
        <button onClick={() => { const t = inputText; setInputText(''); setMessages(prev => [...prev, { role: 'user', text: t }]); }} className="duo-btn duo-btn-blue px-6 flex items-center"><Send className="w-5 h-5" /></button>
      </div>
    </div>
  );

  const renderMatchmaking = () => <div className="flex-1 flex flex-col items-center justify-center bg-gray-50"><Loader2 className="w-12 h-12 animate-spin text-duo-blue mb-4" /><h2 className="text-xl font-black text-duo-gray-dark uppercase tracking-widest">Searching...</h2></div>;

  return (
    <div className="h-safe-screen bg-duo-bg flex justify-center overflow-hidden">
      <div className="w-full max-w-md bg-white h-full flex flex-col relative shadow-2xl overflow-hidden">
        {renderTopBar()}
        {gameState === 'menu' && renderMenu()}
        {gameState === 'char_creation' && renderCharCreation()}
        {gameState === 'matchmaking' && renderMatchmaking()}
        {gameState === 'arena_prep' && renderArenaPreparation()}
        {gameState === 'battle' && renderBattle()}
        {gameState === 'post_match' && renderPostMatch()}
        {gameState === 'exploration' && renderExploration()}
        {gameState === 'level_select' && renderLevelSelect()}
        {renderBottomBar()}
      </div>
      {showSettings && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-gray-200">
              <h3 className="text-2xl font-black text-center mb-6">Settings</h3>
              <div className="space-y-4 mb-8">
                <div><label className="block text-xs font-black uppercase mb-1">API Key</label><input type="password" value={settings.apiKey} onChange={e => setSettings({ ...settings, apiKey: e.target.value })} className="w-full bg-duo-gray rounded-xl px-4 py-2 font-bold focus:outline-none" /></div>
              </div>
              <button onClick={() => setShowSettings(false)} className="duo-btn duo-btn-blue w-full py-3">Done</button>
            </div>
          </div>
      )}
      {showProfileModal && profileToView && (
          <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowProfileModal(false)}>
            <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="p-4 bg-duo-blue text-white flex justify-between items-center"><h3 className="text-xl font-black">Legend Profile</h3><button onClick={() => setShowProfileModal(false)}><X className="w-6 h-6" /></button></div>
              <div className="flex-1 overflow-y-auto p-6 markdown-body"><Markdown rehypePlugins={[rehypeRaw]}>{profileToView}</Markdown></div>
            </div>
          </div>
      )}
    </div>
  );
}