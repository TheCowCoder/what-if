import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { Home, User, Users, Shield, Heart, Send, Check, Loader2, Sword, Settings, ChevronDown, ArrowLeft, AlertTriangle, Info, Compass, Map, Star, ChevronUp, Maximize2, Minimize2, Target, Beef, GlassWater, Zap, Package, X, Eye, Coins, Orbit } from 'lucide-react';
import { classifyAIError, formatAIError, getAIRetryDelaySeconds } from '../ai-errors';

// ErrorBoundary to prevent white-screen crashes from markdown rendering errors
class MarkdownErrorBoundary extends React.Component<{ children: React.ReactNode; fallback: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) { console.error('[MarkdownErrorBoundary]', error.message); }
  render() { return this.state.hasError ? <span>{this.props.fallback}</span> : this.props.children; }
}

const SafeMarkdown = ({ children }: { children: string }) => (
  <MarkdownErrorBoundary fallback={children}>
    <Markdown rehypePlugins={[rehypeRaw]}>{children}</Markdown>
  </MarkdownErrorBoundary>
);

declare global {
  interface Window {
    aistudio?: {
      openSelectKey: () => Promise<void>;
      hasSelectedApiKey: () => Promise<boolean>;
    };
  }
}

const CLIENT_SESSION_STORAGE_KEY = 'arena_clash_session_id';
const getClientSessionId = () => {
  try {
    const stored = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (stored) return stored;
    const generated = crypto.randomUUID?.() || `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
};

const socket: Socket = io(undefined, {
  auth: {
    sessionId: getClientSessionId(),
  },
  reconnection: true,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 5_000,
  reconnectionAttempts: Infinity,
  closeOnBeforeunload: false,
});

type Tab = 'home' | 'profile' | 'social';
type GameState = 'menu' | 'char_creation' | 'matchmaking' | 'arena_prep' | 'battle' | 'post_match' | 'exploration' | 'level_select';
type ConnectionPhase = 'online' | 'reconnecting' | 'resyncing' | 'reconnected';

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

type AppSettings = {
  apiKey: string;
  charModel: string;
  explorationModel: string;
  battleModel: string;
  botModel: string;
  unlimitedTurnTime: boolean;
};

type ModelSettingsPayload = Pick<AppSettings, 'charModel' | 'explorationModel' | 'battleModel' | 'botModel'>;

const DEFAULT_STARTING_GOLD = 25;
const BATTLE_STREAM_THOUGHTS_PREFIX = 'STREAMING_THOUGHTS_';
const BATTLE_STREAM_ANSWER_PREFIX = 'STREAMING_ANSWER_';
const BATTLE_PLAYER_ACTIONS_PREFIX = 'PLAYER_ACTIONS_';
const BATTLE_PENDING_ACTION_PREFIX = 'PENDING_PLAYER_ACTION_';
const BATTLE_TRACE_SAMPLE_INTERVAL_MS = 200;
const BATTLE_TRACE_MAX_ENTRIES = 2400;
const VALID_MODEL_OPTIONS = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'] as const;
const DEFAULT_MODEL_SETTINGS = {
  charModel: 'gemini-2.5-flash',
  explorationModel: 'gemini-3-flash-preview',
  battleModel: 'gemini-2.5-pro',
  botModel: 'gemini-2.5-flash',
};

const sanitizeModelSettings = (value?: Partial<typeof DEFAULT_MODEL_SETTINGS> | null) => ({
  charModel: typeof value?.charModel === 'string' && VALID_MODEL_OPTIONS.includes(value.charModel as typeof VALID_MODEL_OPTIONS[number])
    ? value.charModel
    : DEFAULT_MODEL_SETTINGS.charModel,
  explorationModel: typeof value?.explorationModel === 'string' && VALID_MODEL_OPTIONS.includes(value.explorationModel as typeof VALID_MODEL_OPTIONS[number])
    ? value.explorationModel
    : DEFAULT_MODEL_SETTINGS.explorationModel,
  battleModel: typeof value?.battleModel === 'string' && VALID_MODEL_OPTIONS.includes(value.battleModel as typeof VALID_MODEL_OPTIONS[number])
    ? value.battleModel
    : DEFAULT_MODEL_SETTINGS.battleModel,
  botModel: typeof value?.botModel === 'string' && VALID_MODEL_OPTIONS.includes(value.botModel as typeof VALID_MODEL_OPTIONS[number])
    ? value.botModel
    : DEFAULT_MODEL_SETTINGS.botModel,
});

const buildModelSettingsPayload = (value?: Partial<ModelSettingsPayload> | AppSettings | null): ModelSettingsPayload => (
  sanitizeModelSettings(value)
);

const getModelSettingsSignature = (value?: Partial<ModelSettingsPayload> | AppSettings | null) => (
  JSON.stringify(buildModelSettingsPayload(value))
);

const isServiceUnavailableRetry = (errorInfo?: { statusCode?: number; statusText?: string } | null) => (
  errorInfo?.statusCode === 503 || errorInfo?.statusText === 'UNAVAILABLE'
);

const logBattleDebug = (event: string, details: Record<string, unknown> = {}) => {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  };

  try {
    console.log('[BattleDebug]', JSON.stringify(payload, null, 2));
  } catch {
    console.log('[BattleDebug]', payload);
  }
};

const isCoarsePointerDevice = () => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches
);

const summarizeBattleLogEntry = (entry: string) => {
  if (entry.startsWith('STATUS_IMAGE_URL::')) {
    return `STATUS_IMAGE_URL(len=${entry.length - 'STATUS_IMAGE_URL::'.length})`;
  }
  if (entry.startsWith('STATUS_IMAGE::')) {
    return entry;
  }
  if (entry.startsWith('STATUS_')) {
    return entry;
  }
  return entry.replace(/\s+/g, ' ').slice(0, 140);
};

const getHealthBarFillClass = (hp: number, maxHp: number) => {
  const safeMaxHp = Math.max(1, maxHp || 1);
  const ratio = Math.max(0, Math.min(1, hp / safeMaxHp));
  if (ratio > 0.75) return 'bg-green-500';
  if (ratio > 0.5) return 'bg-yellow-400';
  if (ratio > 0.25) return 'bg-orange-400';
  return 'bg-red-500';
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

const renderPromptTemplate = (template: string, values: Record<string, string>) => (
  template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? '')
);

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

const appendBattleLogIfMissing = (logs: string[], entry: string): string[] => (
  logs.includes(entry) ? logs : [...logs, entry]
);

const appendBattleImageResultLogs = (logs: string[], actorName: string, imageUrl: string, completionText: string): string[] => {
  const transientPrefixes = [
    BATTLE_PENDING_ACTION_PREFIX,
    BATTLE_PLAYER_ACTIONS_PREFIX,
    BATTLE_STREAM_THOUGHTS_PREFIX,
    BATTLE_STREAM_ANSWER_PREFIX,
    'STATUS_TOOL::',
  ];
  const withoutImageStatuses = logs.filter(log => (
    !log.startsWith('STATUS_battle-image-pending::')
    && !log.startsWith('STATUS_battle-image-complete::')
  ));
  let transientStartIndex = withoutImageStatuses.length;
  while (
    transientStartIndex > 0
    && transientPrefixes.some(prefix => withoutImageStatuses[transientStartIndex - 1].startsWith(prefix))
  ) {
    transientStartIndex -= 1;
  }
  const stableLogs = withoutImageStatuses.slice(0, transientStartIndex);
  const trailingLogs = withoutImageStatuses.slice(transientStartIndex);
  const withStatus = appendBattleLogIfMissing(stableLogs, `STATUS_IMAGE::🎨 **${actorName}** visualized the scene`);
  const withImage = appendBattleLogIfMissing(withStatus, `STATUS_IMAGE_URL::${imageUrl}`);
  const withCompleteStatus = appendBattleLogIfMissing(withImage, `STATUS_battle-image-complete::${completionText}`);
  return [...withCompleteStatus, ...trailingLogs];
};

const buildPendingBattleActionLog = (playerId: string, action: string): string => (
  `${BATTLE_PENDING_ACTION_PREFIX}${playerId}::${action}`
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

const buildCompactCharacterStatSheet = (character: Character | null) => {
  if (!character) return null;

  return {
    name: character.name,
    hp: character.hp,
    maxHp: character.maxHp,
    mana: character.mana,
    maxMana: character.maxMana,
    gold: character.gold,
  };
};

const isScrollViewportNearBottom = (element: HTMLElement, threshold = 56) => {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining <= threshold;
};

const ImageSequencePreview = ({ frames, fps = 60, alt }: { frames: string[]; fps?: number; alt: string }) => {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (frames.length <= 1) {
      setFrameIndex(0);
      return;
    }

    let animationFrame = 0;
    let lastTimestamp = 0;
    const frameDuration = 1000 / Math.max(1, fps);

    const tick = (timestamp: number) => {
      if (!lastTimestamp || timestamp - lastTimestamp >= frameDuration) {
        setFrameIndex(previous => (previous + 1) % frames.length);
        lastTimestamp = timestamp;
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [frames, fps]);

  if (!frames.length) return null;

  return <img src={frames[frameIndex] || frames[0]} alt={alt} className="w-full" />;
};

const InlineMessageMedia = ({ message, alt }: { message: Message; alt: string }) => {
  const frames = message.imageFrames?.length ? message.imageFrames : message.imageUrl ? [message.imageUrl] : [];
  if (!frames.length) return null;

  return (
    <div className="mt-2 rounded-lg overflow-hidden border-2 border-duo-gray bg-white">
      {frames.length > 1 ? (
        <>
          <ImageSequencePreview frames={frames} fps={message.imageFrameFps || 60} alt={alt} />
          <div className="px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-duo-blue bg-duo-blue/5 border-t border-duo-blue/10">
            {frames.length} frame preview at {message.imageFrameFps || 60} FPS
          </div>
        </>
      ) : (
        <img src={frames[0]} alt={alt} className="w-full" />
      )}
    </div>
  );
};

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
  x: number;
  y: number;
  followTargetId?: string | null;
}

interface BattleMapState {
  discoveredLocations: string[];
  players: WorldPlayer[];
  npcs: WorldNpc[];
}

interface ArenaPreparationState {
  stage: 'preview' | 'tweak';
  remaining: number | null;
  isBotMatch: boolean;
  skipVotes: string[];
  playerRemaining?: Record<string, number | null>;
  tweakDuration?: number | null;
  unlimited?: boolean;
}

interface MapMarkerLayoutInput {
  id: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  fixed?: boolean;
}

interface MapMarkerLayoutPosition {
  x: number;
  y: number;
}

const clampMapValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const estimateMarkerLabelWidth = (label: string, minWidth: number, maxWidth: number, charWidth: number) => (
  clampMapValue(label.length * charWidth, minWidth, maxWidth)
);

const getLocationMarkerGlyph = (type: string) => {
  if (type === 'village') return '🏘️';
  if (type === 'ruins') return '🏚️';
  if (type === 'cave') return '🕳️';
  return '·';
};

const getWorldLocationById = (worldData: any, locationId?: string | null): WorldLocation | null => (
  worldData?.locations?.find((entry: WorldLocation) => entry.id === locationId) || null
);

const getWorldIslandById = (worldData: any, islandId?: string | null) => (
  worldData?.islands?.find((entry: any) => entry.id === islandId) || null
);

const getLocationHopDistance = (worldData: any, startLocationId?: string | null, endLocationId?: string | null): number => {
  if (!startLocationId || !endLocationId) return Number.POSITIVE_INFINITY;
  if (startLocationId === endLocationId) return 0;

  const visited = new Set<string>([startLocationId]);
  const queue: Array<{ locationId: string; distance: number }> = [{ locationId: startLocationId, distance: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const location = getWorldLocationById(worldData, current.locationId);
    for (const connectionId of location?.connections || []) {
      if (visited.has(connectionId)) continue;
      if (connectionId === endLocationId) return current.distance + 1;
      visited.add(connectionId);
      queue.push({ locationId: connectionId, distance: current.distance + 1 });
    }
  }

  return Number.POSITIVE_INFINITY;
};

const buildBattleMapContext = (worldData: any, mapState?: BattleMapState, roomPlayers?: Record<string, any>) => {
  if (!worldData || !mapState || mapState.players.length === 0) return '';

  let context = 'BATTLE MAP STATE:\n';
  for (const player of mapState.players) {
    const location = getWorldLocationById(worldData, player.locationId);
    const island = getWorldIslandById(worldData, location?.islandId);
    const playerName = roomPlayers?.[player.id]?.character?.name || player.name;
    context += `- ${playerName} is at grid (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) on ${island?.name || location?.islandId || 'an unknown island'} near ${location?.name || player.locationId}. Connected routes: ${(location?.connections || []).join(', ') || 'none'}.\n`;
  }

  if (mapState.players.length >= 2) {
    for (let index = 0; index < mapState.players.length; index += 1) {
      for (let innerIndex = index + 1; innerIndex < mapState.players.length; innerIndex += 1) {
        const left = mapState.players[index];
        const right = mapState.players[innerIndex];
        const leftLocation = getWorldLocationById(worldData, left.locationId);
        const rightLocation = getWorldLocationById(worldData, right.locationId);
        const distance = getLocationHopDistance(worldData, left.locationId, right.locationId);
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
  worldData: any,
  currentMapState: BattleMapState | undefined,
  positionUpdates: Record<string, { x?: number; y?: number; locationId?: string }> | null | undefined,
  roomPlayers: Record<string, any>,
): BattleMapState | undefined => {
  if (!currentMapState || !positionUpdates) return currentMapState;

  const gridWidth = worldData?.meta?.gridSize?.width ?? 0;
  const gridHeight = worldData?.meta?.gridSize?.height ?? 0;
  const discoveredLocations = new Set(currentMapState.discoveredLocations);
  const clampCoordinate = (value: number, max: number) => (
    max > 0 ? clampMapValue(value, 0, max) : value
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
    const nextLocation = getWorldLocationById(worldData, nextLocationId);
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

  return {
    ...currentMapState,
    discoveredLocations: Array.from(discoveredLocations),
    players,
    npcs,
  };
};

const EMPTY_BATTLE_MAP_STATE: BattleMapState = {
  discoveredLocations: [],
  players: [],
  npcs: [],
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

const layoutRepelledMarkers = (
  markers: MapMarkerLayoutInput[],
  bounds: { width: number; height: number },
): Record<string, MapMarkerLayoutPosition> => {
  if (markers.length === 0) return {};

  const padding = 8;
  const positions = markers.map(marker => ({
    ...marker,
    x: marker.anchorX,
    y: marker.anchorY,
    fixed: !!marker.fixed,
  }));

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
      if (marker.fixed) {
        marker.x = marker.anchorX;
        marker.y = marker.anchorY;
        return;
      }

      forces[index].x += (marker.anchorX - marker.x) * 0.12;
      forces[index].y += (marker.anchorY - marker.y) * 0.12;

      marker.x = clampMapValue(marker.x + forces[index].x, marker.width / 2 + 4, bounds.width - marker.width / 2 - 4);
      marker.y = clampMapValue(marker.y + forces[index].y, marker.height / 2 + 4, bounds.height - marker.height / 2 - 4);
    });
  }

  return Object.fromEntries(positions.map(marker => [
    marker.id,
    { x: marker.x, y: marker.y },
  ]));
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [gameState, setGameState] = useState<GameState>('menu');
  const gameStateRef = useRef<GameState>('menu');
  
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
    const savedCharacters = normalizeCharacters(JSON.parse(localStorage.getItem('duo_characters') || '[]'));
    const preferredCharacter = pickPreferredCharacter(savedCharacters, localStorage.getItem('duo_active_character_name'));
    if (preferredCharacter) return preferredCharacter;

    const saved = localStorage.getItem('duo_character');
    return saved ? normalizeCharacter(JSON.parse(saved)) : null;
  });
  const charactersRef = useRef<Character[]>([]);
  const characterRef = useRef<Character | null>(null);
  const activeCharacterNameRef = useRef<string | null>(localStorage.getItem('duo_active_character_name'));
  
  const [settings, setSettings] = useState<AppSettings>(() => {
    const defaultSettings = {
      apiKey: '',
      ...DEFAULT_MODEL_SETTINGS,
      unlimitedTurnTime: true,
    };
    const saved = localStorage.getItem('duo_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          ...defaultSettings,
          ...parsed,
          ...sanitizeModelSettings(parsed),
          unlimitedTurnTime: true,
        };
      } catch (e) {
        return defaultSettings;
      }
    }
    return defaultSettings;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'general' | 'debug'>('general');
  const settingsRef = useRef(settings);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const initialModelSettingsSignatureRef = useRef(getModelSettingsSignature(settings));
  const lastSharedModelSettingsSignatureRef = useRef(getModelSettingsSignature(settings));

  const applyRemoteModelSettings = useCallback((incoming: any, options?: { preserveLocalIfChangedFromInitial?: boolean }) => {
    if (!incoming) return;

    const sanitized = buildModelSettingsPayload(incoming);
    const incomingSignature = getModelSettingsSignature(sanitized);

    setSettings(prev => {
      const prevSignature = getModelSettingsSignature(prev);
      if (prevSignature === incomingSignature) {
        lastSharedModelSettingsSignatureRef.current = incomingSignature;
        return prev;
      }

      if (options?.preserveLocalIfChangedFromInitial && prevSignature !== initialModelSettingsSignatureRef.current) {
        return prev;
      }

      lastSharedModelSettingsSignatureRef.current = incomingSignature;
      return {
        ...prev,
        ...sanitized,
        unlimitedTurnTime: true,
        apiKey: prev.apiKey,
      };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrateSettings = async () => {
      try {
        const response = await fetch('/api/settings');
        if (!response.ok) return;

        const remoteSettings = await response.json();
        if (cancelled || !remoteSettings) return;

        applyRemoteModelSettings(remoteSettings, { preserveLocalIfChangedFromInitial: true });
      } catch (error) {
        console.warn('Failed to load shared settings', error);
      } finally {
        if (!cancelled) {
          setSettingsHydrated(true);
        }
      }
    };

    void hydrateSettings();

    return () => {
      cancelled = true;
    };
  }, [applyRemoteModelSettings]);

  useEffect(() => {
    if (character) {
      localStorage.setItem('duo_character', JSON.stringify(character));
      localStorage.setItem('duo_active_character_name', character.name);
      activeCharacterNameRef.current = character.name;
      setCharacters(prev => {
        const index = prev.findIndex(c => c.name === character.name);
        let newChars = prev;
        if (index >= 0) {
          const previousCharacter = prev[index];
          if (JSON.stringify(previousCharacter) === JSON.stringify(character)) {
            localStorage.setItem('duo_characters', JSON.stringify(prev));
            return prev;
          }
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

  useEffect(() => {
    charactersRef.current = characters;
  }, [characters]);

  useEffect(() => {
    characterRef.current = character;
  }, [character]);

  const getAIClient = useCallback(() => {
    const customKey = settingsRef.current.apiKey?.trim();
    const buildServerAIError = (payload: any, fallbackStatus?: number) => {
      const error: any = new Error(payload?.message || payload?.detail || payload?.error || `Gemini request failed${fallbackStatus ? ` (${fallbackStatus})` : ''}`);
      const statusCode = typeof payload?.statusCode === 'number' ? payload.statusCode : fallbackStatus;
      error.status = statusCode;
      error.code = statusCode;
      error.details = payload?.detail || payload?.message || payload?.error;
      error.retryWindowExpired = !!payload?.retryWindowExpired;
      error.error = {
        code: statusCode,
        status: payload?.statusText,
        message: payload?.detail || payload?.error || payload?.message,
      };
      return error;
    };

    const buildRequestBody = (request: any) => {
      const { abortSignal: _abortSignal, ...config } = request?.config || {};
      return {
        apiKey: customKey || '',
        model: request?.model,
        contents: request?.contents,
        config,
      };
    };

    return {
      models: {
        generateContent: async (request: any) => {
          const abortSignal = request?.config?.abortSignal;
          const response = await fetch('/api/ai/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody(request)),
            signal: abortSignal,
          });

          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw buildServerAIError(payload, response.status);
          }

          return {
            text: typeof payload?.text === 'string' ? payload.text : '',
            candidates: Array.isArray(payload?.candidates) ? payload.candidates : [],
          };
        },
        generateContentStream: async (request: any) => {
          const abortSignal = request?.config?.abortSignal;
          const response = await fetch('/api/ai/generate-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody(request)),
            signal: abortSignal,
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw buildServerAIError(payload, response.status);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw buildServerAIError({ message: 'Gemini stream body was empty' }, response.status);
          }

          return {
            async *[Symbol.asyncIterator]() {
              const decoder = new TextDecoder();
              let buffer = '';

              const flushLine = (line: string) => {
                const parsed = JSON.parse(line);
                if (parsed?.error) {
                  throw buildServerAIError(parsed.error, response.status);
                }
                return {
                  candidates: Array.isArray(parsed?.candidates) ? parsed.candidates : [],
                };
              };

              while (true) {
                const { value, done } = await reader.read();
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex >= 0) {
                  const line = buffer.slice(0, newlineIndex).trim();
                  buffer = buffer.slice(newlineIndex + 1);
                  if (line) {
                    yield flushLine(line);
                  }
                  newlineIndex = buffer.indexOf('\n');
                }

                if (done) {
                  const trailing = buffer.trim();
                  if (trailing) {
                    yield flushLine(trailing);
                  }
                  return;
                }
              }
            },
          };
        },
      },
    };
  }, []);

  const getPromptTemplate = useCallback(async (filename: string) => {
    const cached = promptTemplateCacheRef.current[filename];
    if (cached) return cached;

    const response = await fetch(`/api/prompts/${filename}`);
    if (!response.ok) {
      throw new Error(`Prompt not found: ${filename}`);
    }

    const template = await response.text();
    promptTemplateCacheRef.current[filename] = template;
    return template;
  }, []);

  const clearRetryRestartButton = useCallback((key: string) => {
    delete retryRestartHandlersRef.current[key];
    setLocalRetryRestartButtons(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const registerRetryRestartButton = useCallback((key: string, label: string, handler: () => void) => {
    retryRestartHandlersRef.current[key] = handler;
    setLocalRetryRestartButtons(prev => ({ ...prev, [key]: label }));
  }, []);

  const upsertExplorationStreamMessage = useCallback((streamId: string, text: string, kind: 'thought' | 'answer') => {
    setExplorationLog(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].streamId === streamId && next[i].kind === kind) {
          next[i] = { ...next[i], role: 'model', text, streamId, kind };
          return next;
        }
      }
      return [...prev, { role: 'model', text, streamId, kind }];
    });
  }, []);

  const clearExplorationStreamMessage = useCallback((streamId: string, kind?: 'thought' | 'answer') => {
    setExplorationLog(prev => prev.filter(message => message.streamId !== streamId || (kind ? message.kind !== kind : false)));
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

  const clearBattleImageTimers = useCallback(() => {
    if (battleImageReadyTimeoutRef.current) {
      window.clearTimeout(battleImageReadyTimeoutRef.current);
      battleImageReadyTimeoutRef.current = null;
    }
    if (battleImageFallbackTimeoutRef.current) {
      window.clearTimeout(battleImageFallbackTimeoutRef.current);
      battleImageFallbackTimeoutRef.current = null;
    }
  }, []);

  const showBattleImagePendingStatus = useCallback((retryCount = 0) => {
    setBattleImageSkipHintVisible(false);
    clearBattleStatusLog('battle-image-complete');
    const retryText = retryCount > 0 ? ` Retried ${retryCount} time${retryCount === 1 ? '' : 's'}.` : '';
    upsertBattleStatusLog('battle-image-pending', `Generating image...${retryText} Server retries automatically if Gemini is busy.`);
  }, [clearBattleStatusLog, upsertBattleStatusLog]);

  const showBattleImageCompleteStatus = useCallback((text: string) => {
    setBattleImageSkipHintVisible(false);
    clearBattleStatusLog('battle-image-pending');
    upsertBattleStatusLog('battle-image-complete', text);
  }, [clearBattleStatusLog, upsertBattleStatusLog]);

  const scheduleReadyForNextTurn = useCallback((reason: string, delayMs = 900) => {
    if (battleImageReadyTimeoutRef.current) {
      window.clearTimeout(battleImageReadyTimeoutRef.current);
    }

    battleImageReadyTimeoutRef.current = window.setTimeout(() => {
      logBattleDebug('ready_for_next_turn_emit', {
        roomId: roomIdRef.current,
        reason,
        delayMs,
      });
      socket.emit('readyForNextTurn');
      battleImageReadyTimeoutRef.current = null;
    }, delayMs);
  }, []);

  const handleSkipBattleImageWait = useCallback(() => {
    battleImageSkipRef.current = true;
    setBattleImageRetryAttempt(0);
    setBattleImageSkipHintVisible(false);
    clearBattleImageTimers();
    logBattleDebug('image_generation_manually_skipped', {
      roomId: roomIdRef.current,
    });
    showBattleImageCompleteStatus('Continuing without image');
    scheduleReadyForNextTurn('manual_skip_image', 300);
  }, [clearBattleImageTimers, scheduleReadyForNextTurn, showBattleImageCompleteStatus]);
  
  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isWaitingForChar, setIsWaitingForChar] = useState(false);
  const [charModelStreamStarted, setCharModelStreamStarted] = useState(false);
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('online');
  const connectionPhaseRef = useRef<ConnectionPhase>('online');
  const [participantConnectionNotice, setParticipantConnectionNotice] = useState<{ text: string; tone: 'amber' | 'green' | 'blue' } | null>(null);
  const [charCreatorRetryAttempt, setCharCreatorRetryAttempt] = useState(0);
  const [charCreator503RetryAttempt, setCharCreator503RetryAttempt] = useState(0);
  const [charCreatorError, setCharCreatorError] = useState<string | null>(null);
  const lastCharCreatorPromptRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const [charAutoScroll, setCharAutoScroll] = useState(true);
  const initialConnectHandledRef = useRef(false);
  const reconnectRecoveryRef = useRef(false);
  const connectionPhaseTimeoutRef = useRef<number | null>(null);
  const participantNoticeTimeoutRef = useRef<number | null>(null);

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
  const [showAllGoals, setShowAllGoals] = useState(false);
  const [showFullMap, setShowFullMap] = useState(false);
  const [spawnMarker, setSpawnMarker] = useState<{ locationId: string; x: number; y: number } | null>(null);
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const mapZoomRef = useRef(1);
  const mapDragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({ dragging: false, lastX: 0, lastY: 0 });
  const closeFullMap = useCallback(() => {
    mapDragRef.current = { dragging: false, lastX: 0, lastY: 0 };
    setShowFullMap(false);
  }, []);
  const [showInventory, setShowInventory] = useState(false);
  const [showCharImage, setShowCharImage] = useState(false);
  const [isGeneratingCharImage, setIsGeneratingCharImage] = useState(false);
  const [explorationCombatReturn, setExplorationCombatReturn] = useState(false);
  const explorationEndRef = useRef<HTMLDivElement>(null);
  const explorationScrollContainerRef = useRef<HTMLDivElement>(null);
  const explorationInputRef = useRef<HTMLTextAreaElement>(null);
  const worldDataRef = useRef<any>(null);
  const activeExplorationStreamIdRef = useRef<string | null>(null);
  const lastExplorationRequestRef = useRef<{ mode: 'action' | 'lock'; payload: any } | null>(null);
  const [explorationRetryAttempt, setExplorationRetryAttempt] = useState(0);
  const [exploration503RetryAttempt, setExploration503RetryAttempt] = useState(0);
  const [explorationError, setExplorationError] = useState<string | null>(null);
  const [explorationAutoScroll, setExplorationAutoScroll] = useState(true);
  const [showSurvivalDetails, setShowSurvivalDetails] = useState(false);

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

  const syncBattleMapState = useCallback((nextState?: Partial<BattleMapState> | null) => {
    setBattleMapState({
      discoveredLocations: nextState?.discoveredLocations ?? [],
      players: nextState?.players ?? [],
      npcs: nextState?.npcs ?? [],
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
  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem('duo_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!settingsHydrated) {
      return;
    }

    const modelSettingsPayload = buildModelSettingsPayload(settings);
    const modelSettingsSignature = getModelSettingsSignature(modelSettingsPayload);

    if (lastSharedModelSettingsSignatureRef.current === modelSettingsSignature) {
      return;
    }

    lastSharedModelSettingsSignatureRef.current = modelSettingsSignature;

    if (roomId) {
      socket.emit('updateRoomSettings', modelSettingsPayload);
    }

    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelSettingsPayload),
    }).catch((error) => {
      console.warn('Failed to persist shared settings', error);
    });
  }, [roomId, settings.battleModel, settings.botModel, settings.charModel, settings.explorationModel, settingsHydrated]);

  const [players, setPlayers] = useState<Record<string, any>>({});
  const playersRef = useRef<Record<string, any>>({});
  const [battleMapState, setBattleMapState] = useState<BattleMapState>(EMPTY_BATTLE_MAP_STATE);
  const [arenaPreparation, setArenaPreparation] = useState<ArenaPreparationState | null>(null);
  const [battleLogs, setBattleLogs] = useState<string[]>([]);
  const battleLogsRef = useRef<string[]>([]);
  const battleLogSnapshotRef = useRef<string>('');
  const [battleInput, setBattleInput] = useState('');
  const [battleError, setBattleError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [battle503RetryAttempt, setBattle503RetryAttempt] = useState(0);
  const [battleRetryRestartAvailable, setBattleRetryRestartAvailable] = useState(false);
  const [battleImageRetryAttempt, setBattleImageRetryAttempt] = useState(0);
  const [bot503RetryAttempt, setBot503RetryAttempt] = useState(0);
  const [localRetryRestartButtons, setLocalRetryRestartButtons] = useState<Record<string, string>>({});
  const [expandedThoughts, setExpandedThoughts] = useState<Set<number>>(new Set());
  const [expandedExplorationThoughts, setExpandedExplorationThoughts] = useState<Set<string>>(new Set());
  const retryRestartHandlersRef = useRef<Record<string, () => void>>({});
  const [isLockedIn, setIsLockedIn] = useState(false);
  const [roomTypingIds, setRoomTypingIds] = useState<string[]>([]);
  const [localRoomTypingIds, setLocalRoomTypingIds] = useState<string[]>([]);
  const typingStopTimeoutsRef = useRef<Record<string, number>>({});
  const battleEndRef = useRef<HTMLDivElement>(null);
  const battleScrollContainerRef = useRef<HTMLDivElement>(null);
  const charInputRef = useRef<HTMLTextAreaElement>(null);
  const battleInputRef = useRef<HTMLTextAreaElement>(null);
  const handleGenerateBattleImageRef = useRef<(() => void) | null>(null);
  const battleImageReadyTimeoutRef = useRef<number | null>(null);
  const battleImageFallbackTimeoutRef = useRef<number | null>(null);
  const battleImageSkipRef = useRef(false);
  const [battleAutoScroll, setBattleAutoScroll] = useState(true);
  const [allyActedIds, setAllyActedIds] = useState<string[]>([]);
  const [isBattleTraceRecording, setIsBattleTraceRecording] = useState(false);
  const [battleTraceEntryCount, setBattleTraceEntryCount] = useState(0);
  const [battleTraceCopyStatus, setBattleTraceCopyStatus] = useState<{ text: string; tone: 'green' | 'red' } | null>(null);
  const battleTraceEntriesRef = useRef<string[]>([]);
  const battleTraceSnapshotRef = useRef<Record<string, unknown>>({});
  const battleTraceStartMsRef = useRef<number | null>(null);
  const battleTraceLastSampleMsRef = useRef(0);
  const battleTraceLoopRef = useRef<number | null>(null);
  const battleTraceRecordingRef = useRef(false);
  const battleTraceChunkCountRef = useRef(0);

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
  const hasVisualizedThisTurnRef = useRef(false);
  const battleImageTurnNonceRef = useRef(0);
  const [battleImageSkipHintVisible, setBattleImageSkipHintVisible] = useState(false);
  const [turnTimerRemaining, setTurnTimerRemaining] = useState<number | null>(null);
  const [isVisualizingScene, setIsVisualizingScene] = useState(false);
  const isBotMatchRef = useRef(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileToView, setProfileToView] = useState<string | null>(null);
  const closeProfileModal = useCallback(() => {
    setShowProfileModal(false);
    setProfileToView(null);
  }, []);
  const [showBattleMeta, setShowBattleMeta] = useState(false);
  const [showExplorationMeta, setShowExplorationMeta] = useState(false);
  const [showExplorationNearby, setShowExplorationNearby] = useState(false);
  useEffect(() => { isBotMatchRef.current = isBotMatch; }, [isBotMatch]);
  const difficultyLabels = ['Easy', 'Medium', 'Hard', 'Superintelligent'];
  const avatarSyncKeysRef = useRef<Record<string, string>>({});
  const promptTemplateCacheRef = useRef<Record<string, string>>({});

  const appendBattleTraceEvent = useCallback((event: string, details: Record<string, unknown> = {}) => {
    if (!battleTraceRecordingRef.current) return;

    const now = Date.now();
    const startedAt = battleTraceStartMsRef.current ?? now;
    if (!battleTraceStartMsRef.current) {
      battleTraceStartMsRef.current = startedAt;
    }

    let line: string;
    try {
      line = JSON.stringify({
        t: new Date(now).toISOString(),
        elapsedMs: now - startedAt,
        event,
        ...details,
      });
    } catch {
      line = JSON.stringify({
        t: new Date(now).toISOString(),
        elapsedMs: now - startedAt,
        event,
        note: 'battle trace serialization failed',
      });
    }

    const entries = battleTraceEntriesRef.current;
    entries.push(line);
    if (entries.length > BATTLE_TRACE_MAX_ENTRIES) {
      entries.splice(0, entries.length - BATTLE_TRACE_MAX_ENTRIES);
    }

    setBattleTraceEntryCount(entries.length);
  }, []);

  const stopBattleTraceLoop = useCallback(() => {
    if (battleTraceLoopRef.current !== null) {
      window.cancelAnimationFrame(battleTraceLoopRef.current);
      battleTraceLoopRef.current = null;
    }
  }, []);

  const handleStartBattleTrace = useCallback(() => {
    stopBattleTraceLoop();
    battleTraceEntriesRef.current = [];
    battleTraceStartMsRef.current = Date.now();
    battleTraceLastSampleMsRef.current = 0;
    battleTraceChunkCountRef.current = 0;
    battleTraceRecordingRef.current = true;
    setBattleTraceEntryCount(0);
    setBattleTraceCopyStatus(null);
    setIsBattleTraceRecording(true);
    appendBattleTraceEvent('trace_started', {
      sampleIntervalMs: BATTLE_TRACE_SAMPLE_INTERVAL_MS,
      snapshot: battleTraceSnapshotRef.current,
    });
  }, [appendBattleTraceEvent, stopBattleTraceLoop]);

  const handleStopBattleTrace = useCallback(() => {
    if (!battleTraceRecordingRef.current) return;
    appendBattleTraceEvent('trace_stopped', {
      entryCount: battleTraceEntriesRef.current.length,
      snapshot: battleTraceSnapshotRef.current,
    });
    battleTraceRecordingRef.current = false;
    setIsBattleTraceRecording(false);
    stopBattleTraceLoop();
  }, [appendBattleTraceEvent, stopBattleTraceLoop]);

  const handleCopyBattleTrace = useCallback(async () => {
    const header = [
      'BATTLE_TRACE_V1',
      `capturedAt=${new Date().toISOString()}`,
      `entryCount=${battleTraceEntriesRef.current.length}`,
      `sampleIntervalMs=${BATTLE_TRACE_SAMPLE_INTERVAL_MS}`,
      `recording=${battleTraceRecordingRef.current}`,
      `socketId=${socket.id || 'none'}`,
      `roomId=${roomIdRef.current || 'none'}`,
      `battleModel=${settingsRef.current.battleModel}`,
      '',
    ];
    const text = [...header, ...battleTraceEntriesRef.current].join('\n');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error('Clipboard copy failed');
        }
      }

      setBattleTraceCopyStatus({ text: `Copied ${battleTraceEntriesRef.current.length} trace lines`, tone: 'green' });
    } catch (error) {
      console.error('[BattleTrace] Copy failed', error);
      setBattleTraceCopyStatus({ text: 'Copy failed on this device/browser', tone: 'red' });
    }
  }, []);

  const battleTraceMapPlayersById = new globalThis.Map(battleMapState.players.map(player => [player.id, player]));
  const activeStreamThoughtLog = battleLogs.find(log => log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX));
  const activeStreamAnswerLog = battleLogs.find(log => log.startsWith(BATTLE_STREAM_ANSWER_PREFIX));
  battleTraceSnapshotRef.current = {
    socketConnected: socket.connected,
    socketId: socket.id || null,
    connectionPhase,
    gameState,
    roomId,
    arenaPreparationStage: arenaPreparation?.stage || null,
    isLockedIn,
    battleInputPreview: battleInput.slice(0, 160),
    battleError,
    retryAttempt,
    battle503RetryAttempt,
    battleImageRetryAttempt,
    isGeneratingBattleImage,
    hasVisualizedThisTurn,
    turnTimerRemaining,
    showFullMap,
    roomTypingIds: [...roomTypingIds],
    localRoomTypingIds: [...localRoomTypingIds],
    allyActedIds: [...allyActedIds],
    pendingBattleActionCount: battleLogs.filter(log => log.startsWith(BATTLE_PENDING_ACTION_PREFIX)).length,
    battleLogCount: battleLogs.length,
    battleLogTail: battleLogs.slice(-4).map(summarizeBattleLogEntry),
    streamThoughtLength: activeStreamThoughtLog ? activeStreamThoughtLog.slice(BATTLE_STREAM_THOUGHTS_PREFIX.length).length : 0,
    streamAnswerLength: activeStreamAnswerLog ? activeStreamAnswerLog.slice(BATTLE_STREAM_ANSWER_PREFIX.length).length : 0,
    players: Object.values(players).map((player: any) => {
      const mapPlayer = battleTraceMapPlayersById.get(player.id);
      return {
        id: player.id,
        name: player.character?.name || 'Unknown',
        hp: player.character?.hp ?? null,
        mana: player.character?.mana ?? null,
        lockedIn: !!player.lockedIn,
        locationId: mapPlayer?.locationId || null,
        x: typeof mapPlayer?.x === 'number' ? Number(mapPlayer.x.toFixed(1)) : null,
        y: typeof mapPlayer?.y === 'number' ? Number(mapPlayer.y.toFixed(1)) : null,
      };
    }),
  };

  useEffect(() => {
    if (!isBattleTraceRecording) return;

    const sample = (now: number) => {
      if (!battleTraceRecordingRef.current) {
        battleTraceLoopRef.current = null;
        return;
      }

      if (!battleTraceLastSampleMsRef.current || now - battleTraceLastSampleMsRef.current >= BATTLE_TRACE_SAMPLE_INTERVAL_MS) {
        battleTraceLastSampleMsRef.current = now;
        appendBattleTraceEvent('sample', battleTraceSnapshotRef.current);
      }

      battleTraceLoopRef.current = window.requestAnimationFrame(sample);
    };

    battleTraceLoopRef.current = window.requestAnimationFrame(sample);
    return () => {
      stopBattleTraceLoop();
    };
  }, [appendBattleTraceEvent, isBattleTraceRecording, stopBattleTraceLoop]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    connectionPhaseRef.current = connectionPhase;
  }, [connectionPhase]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const mergeWorldPlayers = useCallback((nextPlayers: WorldPlayer[]) => {
    setWorldPlayers(prev => {
      const previousById = new globalThis.Map(prev.map(player => [player.id, player]));
      return (nextPlayers || []).map(player => {
        const previous = previousById.get(player.id);
        return {
          ...previous,
          ...player,
          acting: player.acting ?? previous?.acting,
          typing: player.typing ?? previous?.typing,
        };
      });
    });
  }, []);

  const setExplorationTypingIds = useCallback((typingIds: string[]) => {
    const typingSet = new Set(typingIds);
    setWorldPlayers(prev => prev.map(player => ({
      ...player,
      typing: typingSet.has(player.id),
    })));
  }, []);

  const clearConnectionPhaseTimeout = useCallback(() => {
    if (connectionPhaseTimeoutRef.current) {
      window.clearTimeout(connectionPhaseTimeoutRef.current);
      connectionPhaseTimeoutRef.current = null;
    }
  }, []);

  const flashConnectionPhase = useCallback((phase: ConnectionPhase, duration = 2400) => {
    clearConnectionPhaseTimeout();
    setConnectionPhase(phase);
    if (phase === 'online') return;
    connectionPhaseTimeoutRef.current = window.setTimeout(() => {
      setConnectionPhase('online');
      connectionPhaseTimeoutRef.current = null;
    }, duration);
  }, [clearConnectionPhaseTimeout]);

  const flashParticipantConnectionNotice = useCallback((text: string, tone: 'amber' | 'green' | 'blue', duration = 3200) => {
    if (participantNoticeTimeoutRef.current) {
      window.clearTimeout(participantNoticeTimeoutRef.current);
      participantNoticeTimeoutRef.current = null;
    }

    setParticipantConnectionNotice({ text, tone });
    if (duration <= 0) return;

    participantNoticeTimeoutRef.current = window.setTimeout(() => {
      setParticipantConnectionNotice(null);
      participantNoticeTimeoutRef.current = null;
    }, duration);
  }, []);

  useEffect(() => {
    return () => {
      clearConnectionPhaseTimeout();
      if (participantNoticeTimeoutRef.current) {
        window.clearTimeout(participantNoticeTimeoutRef.current);
      }
    };
  }, [clearConnectionPhaseTimeout]);

  useEffect(() => {
    return () => {
      clearBattleImageTimers();
    };
  }, [clearBattleImageTimers]);

  const resumeChatAutoScroll = useCallback(() => {
    setCharAutoScroll(true);
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const resumeBattleAutoScroll = useCallback(() => {
    setBattleAutoScroll(true);
    battleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const resumeExplorationAutoScroll = useCallback(() => {
    setExplorationAutoScroll(true);
    explorationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleChatLogScroll = useCallback(() => {
    const container = chatScrollContainerRef.current;
    if (!container || !charAutoScroll) return;
    if (!isScrollViewportNearBottom(container)) {
      setCharAutoScroll(false);
    }
  }, [charAutoScroll]);

  const handleBattleLogScroll = useCallback(() => {
    const container = battleScrollContainerRef.current;
    if (!container || !battleAutoScroll) return;
    if (!isScrollViewportNearBottom(container)) {
      setBattleAutoScroll(false);
    }
  }, [battleAutoScroll]);

  const handleExplorationLogScroll = useCallback(() => {
    const container = explorationScrollContainerRef.current;
    if (!container || !explorationAutoScroll) return;
    if (!isScrollViewportNearBottom(container)) {
      setExplorationAutoScroll(false);
    }
  }, [explorationAutoScroll]);

  const pauseChatAutoScrollOnIntent = useCallback(() => {
    const container = chatScrollContainerRef.current;
    if (!container || !charAutoScroll) return;
    if (container.scrollHeight > container.clientHeight) {
      setCharAutoScroll(false);
    }
  }, [charAutoScroll]);

  const pauseBattleAutoScrollOnIntent = useCallback(() => {
    const container = battleScrollContainerRef.current;
    if (!container || !battleAutoScroll) return;
    if (container.scrollHeight > container.clientHeight) {
      setBattleAutoScroll(false);
    }
  }, [battleAutoScroll]);

  const pauseExplorationAutoScrollOnIntent = useCallback(() => {
    const container = explorationScrollContainerRef.current;
    if (!container || !explorationAutoScroll) return;
    if (container.scrollHeight > container.clientHeight) {
      setExplorationAutoScroll(false);
    }
  }, [explorationAutoScroll]);

  const updateTypingPresence = useCallback((channel: 'character' | 'battle' | 'exploration', value: string) => {
    const timeoutId = typingStopTimeoutsRef.current[channel];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete typingStopTimeoutsRef.current[channel];
    }

    const isTyping = value.trim().length > 0;
    socket.emit('typing', { isTyping });

    if (!isTyping) {
      return;
    }

    typingStopTimeoutsRef.current[channel] = window.setTimeout(() => {
      socket.emit('typing', { isTyping: false });
      delete typingStopTimeoutsRef.current[channel];
    }, 1100);
  }, []);

  const clearTypingPresence = useCallback((channel: 'character' | 'battle' | 'exploration') => {
    const timeoutId = typingStopTimeoutsRef.current[channel];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete typingStopTimeoutsRef.current[channel];
    }
    socket.emit('typing', { isTyping: false });
  }, []);

  const syncCharacterAvatarToCloud = useCallback(async (targetCharacter: Character) => {
    if (!authToken || !targetCharacter.imageUrl) return;

    const syncKey = `${targetCharacter.name}:${targetCharacter.imageUrl.length}:${targetCharacter.imageUrl.slice(-48)}`;
    if (avatarSyncKeysRef.current[targetCharacter.name] === syncKey) return;

    const res = await fetch('/api/account/character-avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        name: targetCharacter.name,
        imageUrl: targetCharacter.imageUrl,
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    avatarSyncKeysRef.current[targetCharacter.name] = syncKey;
  }, [authToken]);

  useEffect(() => {
    if (socket.connected && !initialConnectHandledRef.current) {
      initialConnectHandledRef.current = true;
    }

    const handleCharacterSynced = () => setIsSynced(true);
    const handleDisconnect = (reason: string) => {
      appendBattleTraceEvent('socket_disconnect', { reason, roomId: roomIdRef.current, gameState: gameStateRef.current });
      closeFullMap();
      setIsSynced(false);
      if (reason === 'io server disconnect') {
        reconnectRecoveryRef.current = false;
        clearConnectionPhaseTimeout();
        setConnectionPhase('online');
        return;
      }
      reconnectRecoveryRef.current = initialConnectHandledRef.current;
      clearConnectionPhaseTimeout();
      setConnectionPhase('reconnecting');
    };
    
    const handleReconnectAttempt = () => {
      appendBattleTraceEvent('socket_reconnect_attempt', { roomId: roomIdRef.current, gameState: gameStateRef.current });
      reconnectRecoveryRef.current = true;
      clearConnectionPhaseTimeout();
      setConnectionPhase('reconnecting');
    };
    
    const handleReconnectError = () => {
      appendBattleTraceEvent('socket_reconnect_error', { roomId: roomIdRef.current, gameState: gameStateRef.current });
      reconnectRecoveryRef.current = true;
      clearConnectionPhaseTimeout();
      setConnectionPhase('reconnecting');
    };
    
    const handleReconnectFailed = () => {
      appendBattleTraceEvent('socket_reconnect_failed', { roomId: roomIdRef.current, gameState: gameStateRef.current });
      reconnectRecoveryRef.current = false;
      clearConnectionPhaseTimeout();
      setConnectionPhase('online');
    };
    
    const handleConnect = () => {
      appendBattleTraceEvent('socket_connect', {
        recovered: socket.recovered,
        roomId: roomIdRef.current,
        reconnectRecovery: reconnectRecoveryRef.current,
      });
      if (!initialConnectHandledRef.current) {
        initialConnectHandledRef.current = true;
        clearConnectionPhaseTimeout();
        setConnectionPhase('online');
        return;
      }

      clearConnectionPhaseTimeout();
      if (reconnectRecoveryRef.current || !socket.recovered) {
        setConnectionPhase('resyncing');
        appendBattleTraceEvent('resume_session_requested', {
          recovered: socket.recovered,
          roomId: roomIdRef.current,
          gameState: gameStateRef.current,
        });
        socket.emit('resumeSession');
        return;
      }

      setConnectionPhase('online');
    };

    socket.on('characterSynced', handleCharacterSynced);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect_error', handleReconnectError);
    socket.io.on('reconnect_failed', handleReconnectFailed);
    socket.on('connect', handleConnect);

    // iOS Safari: force reconnect when returning from background
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !socket.connected) {
        console.log('[Visibility] Page visible, socket disconnected — forcing reconnect');
        appendBattleTraceEvent('visibility_reconnect_forced', { roomId: roomIdRef.current, gameState: gameStateRef.current });
        socket.connect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      clearConnectionPhaseTimeout();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.off('characterSynced', handleCharacterSynced);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect', handleConnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect_error', handleReconnectError);
      socket.io.off('reconnect_failed', handleReconnectFailed);
    };
  }, [clearConnectionPhaseTimeout, closeFullMap]);

  useEffect(() => {
    const sync = () => {
      const syncCharacter = stripCharacterImageForSync(character);
      const charStr = JSON.stringify(syncCharacter);
      if (syncCharacter && charStr !== lastSyncedCharRef.current) {
        socket.emit('characterCreated', syncCharacter);
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
    hasVisualizedThisTurnRef.current = hasVisualizedThisTurn;
  }, [hasVisualizedThisTurn]);

  useEffect(() => {
    const snapshot = {
      count: battleLogs.length,
      imageStatusCount: battleLogs.filter(log => log.startsWith('STATUS_IMAGE::')).length,
      imageUrlCount: battleLogs.filter(log => log.startsWith('STATUS_IMAGE_URL::')).length,
      pendingImageCount: battleLogs.filter(log => log.startsWith('STATUS_battle-image-pending::')).length,
      completeImageCount: battleLogs.filter(log => log.startsWith('STATUS_battle-image-complete::')).length,
      tail: battleLogs.slice(-6).map(summarizeBattleLogEntry),
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === battleLogSnapshotRef.current) return;
    battleLogSnapshotRef.current = serialized;
    logBattleDebug('battle_logs_state', snapshot);
  }, [battleLogs]);

  useEffect(() => {
    if (charAutoScroll) {
      chatEndRef.current?.scrollIntoView();
    }
  }, [charAutoScroll, messages]);

  useEffect(() => {
    if (battleAutoScroll) {
      battleEndRef.current?.scrollIntoView();
    }
  }, [battleAutoScroll, battleLogs]);

  useEffect(() => {
    if (explorationAutoScroll) {
      explorationEndRef.current?.scrollIntoView();
    }
  }, [explorationAutoScroll, explorationLog]);

  const roomIdRef = useRef(roomId);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  const botDifficultyRef = useRef(botDifficulty);
  useEffect(() => { botDifficultyRef.current = botDifficulty; }, [botDifficulty]);
  const arenaPreparationStageRef = useRef<ArenaPreparationState['stage'] | null>(null);
  const botPreparationRewriteRoomRef = useRef<string | null>(null);

  useEffect(() => {
    if (gameState !== 'arena_prep' || !arenaPreparation) return;

    if (arenaPreparation.stage === arenaPreparationStageRef.current) return;
    arenaPreparationStageRef.current = arenaPreparation.stage;

    if (arenaPreparation.stage === 'preview') {
      setMessages([]);
      setInputText('');
      setIsWaitingForChar(false);
      setCharCreatorError(null);
      setCharCreatorRetryAttempt(0);
      clearChatStatusMessage('char-creator-retry');
      clearTypingPresence('character');
      return;
    }

    closeProfileModal();
    setMessages([{ role: 'model', text: 'You have one rewrite window before the duel. Refine your legend now.' }]);
    setInputText('');
    setCharCreatorError(null);
    setCharCreatorRetryAttempt(0);
    clearChatStatusMessage('char-creator-retry');
  }, [arenaPreparation, clearChatStatusMessage, clearTypingPresence, closeProfileModal, gameState]);

  useEffect(() => {
    if (!arenaPreparation) {
      arenaPreparationStageRef.current = null;
      botPreparationRewriteRoomRef.current = null;
    }
  }, [arenaPreparation]);

  useEffect(() => {
    const lockedInIds = Object.entries(players)
      .filter(([, player]) => !!player?.lockedIn)
      .map(([id]) => id);

    if (lockedInIds.length === 0) return;

    setLocalRoomTypingIds(prev => prev.filter(id => !lockedInIds.includes(id)));
  }, [players]);

  useEffect(() => {
    const roomPlayers = playersRef.current;
    const botId = Object.keys(roomPlayers).find(id => id.startsWith('bot_'));
    const botPlayer = botId ? roomPlayers[botId] : null;
    const botHasRewriteAccess = !!botPlayer?.prepSkippedPreview || arenaPreparation?.stage === 'tweak';
    if (!arenaPreparation?.isBotMatch || !roomId || !botId || !botHasRewriteAccess || botPreparationRewriteRoomRef.current === roomId) return;

    if (!botPlayer?.character) return;

    botPreparationRewriteRoomRef.current = roomId;
    setLocalRoomTypingIds(prev => prev.includes(botId) ? prev : [...prev, botId]);

    let cancelled = false;
    let rewriteSubmitted = false;
    const previewFallbackTimeout = window.setTimeout(() => {
      if (cancelled || rewriteSubmitted) return;
      rewriteSubmitted = true;
      socket.emit('characterCreated', {
        playerId: botId,
        ...botPlayer.character,
        profileMarkdown: botPlayer.character.profileMarkdown,
      });
    }, 2500);

    const rewriteBotProfile = async () => {
      setBot503RetryAttempt(0);
      try {
        const aiClient = getAIClient();
        const opponents = Object.entries(roomPlayers)
          .filter(([id]) => id !== botId)
          .map(([, player]) => `Opponent: ${player.character.name}\n${player.character.profileMarkdown}`)
          .join('\n\n');

        if (cancelled) return;

        const response = await aiClient.models.generateContent({
          model: settingsRef.current.botModel,
          contents: `You are revising your dueling profile before the arena begins. Keep the same name and return markdown only.\n\nCurrent profile:\n${botPlayer.character.profileMarkdown}\n\nOpponents:\n${opponents}\n\nRefine the profile to better prepare for this duel while preserving identity and formatting.`,
          config: {
            temperature: 0.8,
          },
        });

        const rewrittenProfile = response?.text?.trim();
        if (!cancelled && rewrittenProfile) {
          setBot503RetryAttempt(0);
          rewriteSubmitted = true;
          window.clearTimeout(previewFallbackTimeout);
          socket.emit('characterCreated', {
            playerId: botId,
            ...botPlayer.character,
            profileMarkdown: rewrittenProfile,
          });
        }
      } catch (error) {
        setBot503RetryAttempt(0);
        console.error('Failed to rewrite bot preparation profile', error);
      }

      if (!cancelled && !rewriteSubmitted) {
        setBot503RetryAttempt(0);
        rewriteSubmitted = true;
        window.clearTimeout(previewFallbackTimeout);
        socket.emit('characterCreated', {
          playerId: botId,
          ...botPlayer.character,
          profileMarkdown: botPlayer.character.profileMarkdown,
        });
      }
    };

    rewriteBotProfile();

    return () => {
      cancelled = true;
      window.clearTimeout(previewFallbackTimeout);
      setLocalRoomTypingIds(prev => prev.filter(id => id !== botId));
    };
  }, [arenaPreparation?.isBotMatch, getAIClient, roomId]);

  const generateBotAction = async (currentRoom: any) => {
    if (!currentRoom || !currentRoom.isBotMatch) return;
    
    const playerIds = Object.keys(currentRoom.players);
    const botId = playerIds.find(id => id.startsWith('bot_'));
    const playerId = playerIds.find(id => !id.startsWith('bot_'));
    
    if (!botId || !playerId) return;

    const p1Data = currentRoom.players[playerId];
    const p2Data = currentRoom.players[botId];

    if (p2Data.lockedIn) return;

    setLocalRoomTypingIds(prev => prev.includes(botId) ? prev : [...prev, botId]);
    setBot503RetryAttempt(0);
    try {
      const aiClient = getAIClient();
      const botPromptRes = await fetch('/api/prompts/bot_player.txt');
      const botSysPrompt = await botPromptRes.text();
      
      const cleanLogs = battleLogsRef.current.filter(log => !log.startsWith("> **Judge's Thoughts:**"));
      const fullLogText = cleanLogs.join('\n\n');
      const logLines = fullLogText.split('\n');
      const totalLines = logLines.length;
      const battleMapContext = buildBattleMapContext(worldDataRef.current, currentRoom.mapState, currentRoom.players);

      const botPrompt = `
DIFFICULTY: ${currentRoom.botDifficulty}
YOU ARE PLAYING AS: ${p2Data.character.name}
YOUR STATE: ${JSON.stringify(p2Data.character)}
OPPONENT STATE: ${JSON.stringify(p1Data.character)}
    ${battleMapContext ? `${battleMapContext}\n` : ''}
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
      
      const action = botRes?.text || "I do nothing.";
      setBot503RetryAttempt(0);
      socket.emit('playerAction', { playerId: botId, action });
    } catch (error) {
      setBot503RetryAttempt(0);
      console.error("Error generating bot action:", error);
      // Fallback: send a generic attack so the battle doesn't stall
      socket.emit('playerAction', {
        playerId: botId,
        action: `${currentRoom.players[botId!]?.character?.name || 'The enemy'} attacks with a basic strike!`,
      });
    } finally {
      setLocalRoomTypingIds(prev => prev.filter(id => id !== botId));
    }
  };

  useEffect(() => {
    let portraitAborted = false;
    let portraitTimeoutId: ReturnType<typeof setTimeout> | null = null;
    socket.on('characterSaved', (state: Character) => {
      const existingCharacter = charactersRef.current.find(entry => entry.name === state.name)
        || (characterRef.current?.name === state.name ? characterRef.current : null);
      const normalizedState = normalizeCharacter({
        ...existingCharacter,
        ...state,
        imageUrl: state.imageUrl || existingCharacter?.imageUrl,
      });
      const stateStr = JSON.stringify(stripCharacterImageForSync(normalizedState));
      if (stateStr !== lastSyncedCharRef.current) {
        setCharacter(normalizedState);
        const isUpdate = charactersRef.current.some(c => c.name === normalizedState.name);
      setMessages(prev => [...prev, { role: 'system', text: isUpdate ? `Updated character: ${normalizedState.name}!` : `Created character: ${normalizedState.name}!` }]);
        lastSyncedCharRef.current = stateStr;
        // Auto-generate character portrait
        if (!normalizedState.imageUrl && gameStateRef.current !== 'arena_prep') {
          portraitTimeoutId = setTimeout(async () => {
            if (portraitAborted) return;
            const generationMessageId = `avatar-generation-${state.name}-${Date.now()}`;
            try {
              console.log("[Portrait Auto] Starting generation for:", state.name);
              setMessages(prev => [...prev, { role: 'system', text: '🎨 Generating portrait...', streamId: generationMessageId }]);
              const aiClient = getAIClient();
              const prompt = `Generate a fantasy character portrait for: ${state.name}. ${state.profileMarkdown.substring(0, 500)}. Style: detailed digital art, fantasy RPG character portrait, vibrant colors.`;
              const imgRes = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash-image',
                contents: prompt,
                config: { responseModalities: ['IMAGE', 'TEXT'] },
              });
              if (portraitAborted) return;
              const imgParts = imgRes.candidates?.[0]?.content?.parts || [];
              const imageFrames = extractInlineImageFrames(imgParts);
              if (imageFrames.length > 0) {
                const optimizedImageUrl = await optimizeCharacterAvatar(imageFrames[imageFrames.length - 1]);
                if (portraitAborted) return;
                setCharacter(prev => prev ? { ...prev, imageUrl: optimizedImageUrl } : prev);
                setMessages(prev => {
                  const filtered = prev.filter(message => message.streamId !== generationMessageId);
                  return [...filtered, {
                    role: 'system',
                    text: '🎨 Portrait generated!',
                    imageUrl: optimizedImageUrl,
                    imageFrames: imageFrames.length > 1 ? imageFrames : undefined,
                    imageFrameFps: imageFrames.length > 1 ? 60 : undefined,
                  }];
                });
                console.log("[Portrait Auto] Success!");
                return;
              }
              console.warn("[Portrait Auto] No image in response");
            } catch (err: any) {
              console.error("[Portrait Auto] Error:", err.message);
            } finally {
              if (!portraitAborted) {
                setMessages(prev => prev.filter(message => message.streamId !== generationMessageId));
              }
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

    socket.on('arenaPreparationState', (data: { roomId: string; players: Record<string, any>; isBotMatch: boolean; stage: 'preview' | 'tweak'; remaining: number | null; skipVotes?: string[]; playerRemaining?: Record<string, number | null>; tweakDuration?: number | null; unlimited?: boolean }) => {
      setRoomId(data.roomId);
      setPlayers(data.players);
      setIsBotMatch(data.isBotMatch);
      setArenaPreparation({
        stage: data.stage,
        remaining: data.remaining,
        isBotMatch: data.isBotMatch,
        skipVotes: data.skipVotes || [],
        playerRemaining: data.playerRemaining || {},
        tweakDuration: data.tweakDuration ?? null,
        unlimited: !!data.unlimited,
      });
      setBattleLogs([]);
      setBattleInput('');
      setGameState('arena_prep');
    });

    socket.on('roomPlayersUpdated', (data: { players: Record<string, any>; phase: string; modelSettings?: any }) => {
      setPlayers(data.players);
      if (data.phase === 'preview' || data.phase === 'tweak') {
        setArenaPreparation(prev => prev ? { ...prev, stage: data.phase as ArenaPreparationState['stage'] } : prev);
      }
      if (data.modelSettings) {
        applyRemoteModelSettings(data.modelSettings);
      }
    });

    socket.on('roomSettingsUpdated', (modelSettings: any) => {
      if (modelSettings) {
        applyRemoteModelSettings(modelSettings);
      }
    });

    socket.on('matchFound', (data) => {
      setRoomId(data.roomId);
      setPlayers(data.players);
      syncBattleMapState(data.mapState);
      setArenaPreparation(null);
      setRoomTypingIds([]);
      setLocalRoomTypingIds([]);
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

    socket.on('battleMapStateUpdated', (data: Partial<BattleMapState>) => {
      syncBattleMapState(data);
    });

    socket.on('battleMapMovementLog', (data: { log: string }) => {
      setBattleLogs(prev => appendBattleLogIfMissing(prev, data.log));
    });

    socket.on('participantConnectionState', (data: { playerName?: string; state: 'reconnecting' | 'rejoined'; graceSeconds?: number }) => {
      if (data.state === 'reconnecting') {
        const graceText = typeof data.graceSeconds === 'number' ? ` · holding ${data.graceSeconds}s` : '';
        flashParticipantConnectionNotice(`${data.playerName || 'Opponent'} reconnecting${graceText}`, 'amber', 0);
        return;
      }

      flashParticipantConnectionNotice(`${data.playerName || 'Opponent'} rejoined`, 'green');
    });

    socket.on('sessionResumed', (payload: any) => {
      closeFullMap();
      reconnectRecoveryRef.current = false;

      const roomSnapshot = payload?.room;
      const explorationSnapshot = payload?.exploration;
      const queueSnapshot = payload?.queue;

      appendBattleTraceEvent('session_resumed', {
        hasRoom: !!roomSnapshot,
        hasExploration: !!explorationSnapshot,
        hasQueue: !!queueSnapshot,
        roomPhase: roomSnapshot?.phase || null,
        needsTurnResolution: !!roomSnapshot?.needsTurnResolution,
      });

      if (roomSnapshot) {
        const restoredHistory = Array.isArray(roomSnapshot.history) ? roomSnapshot.history.filter(Boolean) : [];
        const restoredMediaLogs = Array.isArray(roomSnapshot.battleMediaLogs) ? roomSnapshot.battleMediaLogs.filter(Boolean) : [];
        const restoredLogs = removeBattleStreamPlaceholders([...restoredHistory, ...restoredMediaLogs]);
        const activeStream = roomSnapshot.activeBattleStream;

        if (activeStream?.thoughts) {
          restoredLogs.push(BATTLE_STREAM_THOUGHTS_PREFIX + activeStream.thoughts);
        }
        if (activeStream?.answer) {
          restoredLogs.push(BATTLE_STREAM_ANSWER_PREFIX + activeStream.answer);
        }

        const lastNarrativeLog = [...restoredHistory].reverse().find((entry: string) => (
          entry
          && !entry.startsWith('STATUS_')
          && !entry.startsWith('> **Judge')
          && !entry.startsWith('NPC_ALLY_ACTION_')
          && !entry.startsWith(BATTLE_PLAYER_ACTIONS_PREFIX)
          && !entry.startsWith(BATTLE_PENDING_ACTION_PREFIX)
        )) || null;

        setRoomId(roomSnapshot.roomId);
        setPlayers(roomSnapshot.players || {});
        syncBattleMapState(roomSnapshot.mapState);
        setArenaPreparation(roomSnapshot.arenaPreparation ?? null);
        setBattleLogs(restoredLogs);
        setBattleError(null);
        setRetryAttempt(0);
        setBattleRetryRestartAvailable(!!roomSnapshot.battleRetryRestartAvailable);
        setTurnTimerRemaining(roomSnapshot.turnTimerRemaining ?? null);
        setIsBotMatch(!!roomSnapshot.isBotMatch);
        setIsLockedIn(!!roomSnapshot.players?.[socket.id || '']?.lockedIn);
        setRoomTypingIds([]);
        setLocalRoomTypingIds([]);
        setAllyActedIds([]);
        battleImageTurnNonceRef.current += 1;
        setHasVisualizedThisTurn(false);
        setGameState(roomSnapshot.phase === 'preview' || roomSnapshot.phase === 'tweak' ? 'arena_prep' : 'battle');

        logBattleDebug('session_resumed', {
          roomId: roomSnapshot.roomId,
          phase: roomSnapshot.phase,
          awaitingNextTurnReady: !!roomSnapshot.awaitingNextTurnReady,
          needsTurnResolution: !!roomSnapshot.needsTurnResolution,
          turnTimerRemaining: roomSnapshot.turnTimerRemaining ?? null,
          historyCount: restoredLogs.length,
          mediaLogCount: restoredMediaLogs.length,
          hasActiveStream: !!(activeStream?.thoughts || activeStream?.answer),
        });

        if (roomSnapshot.awaitingNextTurnReady) {
          battleImageSkipRef.current = false;
          showBattleImagePendingStatus();
        } else {
          battleImageSkipRef.current = false;
          clearBattleImageTimers();
          clearBattleStatusLog('battle-image-pending');
          clearBattleStatusLog('battle-image-complete');
        }

        if (roomSnapshot.needsTurnResolution) {
          clearConnectionPhaseTimeout();
          setConnectionPhase('resyncing');
          upsertBattleStatusLog('battle-resync', '⚠️ Resyncing turn state...');
        } else {
          clearBattleStatusLog('battle-resync');
          flashConnectionPhase('reconnected');
        }
        return;
      }

      setBattleRetryRestartAvailable(false);

      if (explorationSnapshot) {
        const nextState = explorationSnapshot.state || {};
        const resumedSpawnLocationId = typeof nextState.locationId === 'string' && Array.isArray(nextState.discoveredLocations) && nextState.discoveredLocations.length > 0
          ? nextState.discoveredLocations[0]
          : null;
        const resumedSpawnLocation = resumedSpawnLocationId ? getWorldLocationById(worldDataRef.current, resumedSpawnLocationId) : null;
        setRoomId(null);
        setArenaPreparation(null);
        syncBattleMapState(null);
        setExplorationState(prev => ({
          ...prev,
          ...nextState,
          discoveredLocations: Array.isArray(nextState.discoveredLocations) ? nextState.discoveredLocations : prev.discoveredLocations,
          inventory: nextState.inventory ?? prev.inventory,
          goals: Array.isArray(nextState.goals) ? nextState.goals : prev.goals,
          equippedWeapon: nextState.equippedWeapon ?? prev.equippedWeapon,
          equippedArmor: nextState.equippedArmor ?? prev.equippedArmor,
        }));
        if (explorationSnapshot.character) {
          setCharacter(prev => prev
            ? normalizeCharacter({ ...prev, ...explorationSnapshot.character })
            : normalizeCharacter(explorationSnapshot.character)
          );
        }
        mergeWorldPlayers(explorationSnapshot.worldPlayers || []);
        setWorldNpcs(explorationSnapshot.npcStates || []);
        setExplorationLockStatus(explorationSnapshot.lockStatus || []);
        if (resumedSpawnLocationId && resumedSpawnLocation) {
          setSpawnMarker({
            locationId: resumedSpawnLocationId,
            x: resumedSpawnLocation.x,
            y: resumedSpawnLocation.y,
          });
        }
        setIsExplorationLockedIn(false);
        setIsExplorationProcessing(false);
        setGameState('exploration');

        if (explorationSnapshot.interruptedAction) {
          setExplorationError('Connection recovered. Your last action was interrupted.');
          upsertExplorationStatusMessage('exploration-retry', '⚠️ Connection recovered. Your last action was interrupted. Send it again if needed.');
        } else {
          clearExplorationStatusMessage('exploration-retry');
          setExplorationError(null);
        }

        flashConnectionPhase('reconnected');
        return;
      }

      if (queueSnapshot?.inQueue) {
        setQueuePlayers(queueSnapshot.players || []);
        setGameState('matchmaking');
        flashConnectionPhase('reconnected');
        return;
      }

      setGameState('menu');
      flashConnectionPhase('reconnected');
    });

    socket.on('typingStatusUpdated', (data: { context: 'room' | 'exploration'; typingIds: string[] }) => {
      if (data.context === 'room') {
        setRoomTypingIds(data.typingIds || []);
        return;
      }

      setExplorationTypingIds(data.typingIds || []);
    });

    socket.on('battleActionsSubmitted', (data: { log: string }) => {
      appendBattleTraceEvent('battle_actions_submitted', {
        logPreview: summarizeBattleLogEntry(data.log),
      });
      setAllyActedIds([]);
      setBattleLogs(prev => {
        const nextLogs = removePendingBattleActionLogs(prev);
        const resolvedLogs = nextLogs[nextLogs.length - 1] === data.log ? nextLogs : [...nextLogs, data.log];
        battleLogsRef.current = resolvedLogs;
        return resolvedLogs;
      });
    });

    socket.on('playerLockedIn', (id) => {
      appendBattleTraceEvent('player_locked_in', {
        id,
        name: playersRef.current[id]?.character?.name || null,
      });
      setPlayers(prev => ({
        ...prev,
        [id]: { ...prev[id], lockedIn: true }
      }));
    });

    socket.on('playerUnlocked', (id) => {
      appendBattleTraceEvent('player_unlocked', {
        id,
        name: playersRef.current[id]?.character?.name || null,
      });
      setPlayers(prev => ({
        ...prev,
        [id]: { ...prev[id], lockedIn: false }
      }));
      setBattleLogs(prev => removePendingBattleActionLogs(prev, id));
      if (id === socket.id) {
        setIsLockedIn(false);
      }
    });

    socket.on('turnResolved', (data) => {
      appendBattleTraceEvent('turn_resolved', {
        roomId: roomIdRef.current,
        playerCount: Object.keys(data.players || {}).length,
        hasMapState: !!data.mapState,
        logLength: typeof data.log === 'string' ? data.log.length : 0,
        thoughtsLength: typeof data.thoughts === 'string' ? data.thoughts.length : 0,
      });
      const battleImageTurnNonce = battleImageTurnNonceRef.current + 1;
      battleImageTurnNonceRef.current = battleImageTurnNonce;
      setHasVisualizedThisTurn(false);
      clearBattleStatusLog('battle-resync');
      clearBattleStatusLog('battle-retry');
      setBattle503RetryAttempt(0);
      setBattleRetryRestartAvailable(false);
      setBattleError(null);
      if (connectionPhaseRef.current === 'resyncing') {
        flashConnectionPhase('reconnected');
      }
      setBattleLogs(prev => {
        const filtered = removePendingBattleActionLogs(removeBattleStreamPlaceholders(prev));
        const thoughts = data.thoughts || "";
        const resolvedLogs = [...filtered, `> **Judge's Thoughts:**\n> ${thoughts.replace(/\n/g, '\n> ')}`, data.log];
        battleLogsRef.current = resolvedLogs;
        return resolvedLogs;
      });
      if (data.players) {
        setPlayers(data.players);
      }
      if (data.mapState) {
        syncBattleMapState(data.mapState);
      }
        
        // Check win condition
        const alivePlayers = Object.values(data.players).filter((p: any) => p.character.hp > 0);
        if (alivePlayers.length <= 1) {
          const winner = alivePlayers[0] as any;
          const winnerName = winner ? winner.character.name : "No one";
          battleImageSkipRef.current = false;
          clearBattleImageTimers();
          clearBattleStatusLog('battle-image-pending');
          clearBattleStatusLog('battle-image-complete');
          setBattleLogs(prev => {
            const resolvedLogs = [...prev, `**GAME OVER!** ${winnerName} is victorious!`];
            battleLogsRef.current = resolvedLogs;
            return resolvedLogs;
          });
        } else {
          battleImageSkipRef.current = false;
          clearBattleImageTimers();
          showBattleImagePendingStatus();
          // If it's a bot match, trigger next bot action
          const room = {
            id: roomIdRef.current,
            players: data.players,
            mapState: data.mapState ?? battleMapState,
            isBotMatch: isBotMatchRef.current,
            botDifficulty: botDifficultyRef.current,
          };
          if (room.isBotMatch) {
            generateBotAction(room);
          }
        }
      setIsLockedIn(false);
      const playerIds = Object.keys(data.players);
      logBattleDebug('turn_resolved_post_processing', {
        roomId: roomIdRef.current,
        playerIds,
        alivePlayerNames: alivePlayers.map((player: any) => player.character.name),
          battleImageSource: 'server',
        isBotMatch: isBotMatchRef.current,
      });
        logBattleDebug('image_generation_waiting_for_backend', {
          roomId: roomIdRef.current,
          awaitingSharedImage: true,
        });
    });

    socket.on('battleEndedByInactivity', (data: { log: string }) => {
      appendBattleTraceEvent('battle_ended_by_inactivity', {
        roomId: roomIdRef.current,
        logPreview: summarizeBattleLogEntry(data.log),
      });

      setBattleLogs(prev => [...removePendingBattleActionLogs(removeBattleStreamPlaceholders(prev)), data.log]);
      setBattleError(null);
      setRetryAttempt(0);
      setBattle503RetryAttempt(0);
      setIsLockedIn(false);
      setTurnTimerRemaining(null);
      setRoomId(null);
      syncBattleMapState(null);
      setArenaPreparation(null);
      setAllyActedIds([]);
      battleImageSkipRef.current = false;
      clearBattleImageTimers();
      clearBattleStatusLog('battle-image-pending');
      clearBattleStatusLog('battle-image-complete');
      setRoomTypingIds([]);
      setLocalRoomTypingIds([]);
      setBattleInput('');
      setGameState('post_match');
    });

    socket.on('streamTurnResolutionStart', () => {
      battleTraceChunkCountRef.current = 0;
      appendBattleTraceEvent('stream_start_received', {
        roomId: roomIdRef.current,
      });
      clearBattleStatusLog('battle-retry');
      setBattle503RetryAttempt(0);
      setBattleRetryRestartAvailable(false);
      setBattleError(null);
      setBattleLogs(prev => ensureBattleStreamPlaceholders(prev));
    });

    socket.on('battleRetryStatus', (data: { attempt: number; statusCode?: number; statusText?: string; label?: string; delay?: number; restartAvailable?: boolean }) => {
      appendBattleTraceEvent('battle_retry_status', {
        roomId: roomIdRef.current,
        attempt: data.attempt,
        statusCode: data.statusCode ?? null,
        statusText: data.statusText ?? null,
        restartAvailable: !!data.restartAvailable,
      });
      setBattle503RetryAttempt(isServiceUnavailableRetry(data) ? data.attempt : 0);
      setBattleRetryRestartAvailable(!!data.restartAvailable);
      const retryStatusText = data.restartAvailable
        ? `${data.label || 'Gemini is temporarily unavailable'}. Retry window expired.`
        : data.attempt > 0
          ? `Battle retry #${data.attempt}${data.delay ? ` in ${Math.max(1, data.delay)}s` : ''}. ${data.label || 'Retrying turn resolution.'}`
          : '';
      if (retryStatusText) {
        upsertBattleStatusLog('battle-retry', retryStatusText);
      } else {
        clearBattleStatusLog('battle-retry');
      }
      if (data.restartAvailable) {
        setBattleError(`${data.label || 'Gemini is temporarily unavailable'}. Retry window expired. Start a new 2-minute retry session when ready.`);
      } else {
        setBattleError(null);
      }
    });

    socket.on('streamTurnResolutionChunk', (data: { type: 'thought' | 'answer' | 'tool', text: string }) => {
      battleTraceChunkCountRef.current += 1;
      if (battleTraceChunkCountRef.current <= 5 || battleTraceChunkCountRef.current % 20 === 0 || data.type === 'tool') {
        appendBattleTraceEvent('stream_chunk_received', {
          roomId: roomIdRef.current,
          chunkIndex: battleTraceChunkCountRef.current,
          type: data.type,
          isRefresh: data.text.startsWith('REFRESH:'),
          textLength: data.text.length,
        });
      }
      if (data.type !== 'tool') {
        clearBattleStatusLog('battle-retry');
        setBattle503RetryAttempt(0);
        setBattleRetryRestartAvailable(false);
        setBattleError(null);
      }
      setBattleLogs(prev => {
        if (data.type === 'tool') {
          if (data.text.includes('submit_battle_result')) {
            return prev;
          }
          return appendBattleLogIfMissing(prev, `STATUS_TOOL::${data.text}`);
        }

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

    socket.on('battleImageShared', (data: { imageUrl: string; fromName?: string }) => {
      appendBattleTraceEvent('battle_image_shared_received', {
        roomId: roomIdRef.current,
        fromName: data.fromName || null,
        imageUrlLength: data.imageUrl.length,
      });
      setHasVisualizedThisTurn(true);
      setBattleImageRetryAttempt(0);
      logBattleDebug('battle_image_shared_received', {
        roomId: roomIdRef.current,
        fromName: data.fromName || 'Opponent',
        imageUrlLength: data.imageUrl.length,
        skipped: battleImageSkipRef.current,
      });
      if (battleImageFallbackTimeoutRef.current) {
        window.clearTimeout(battleImageFallbackTimeoutRef.current);
        battleImageFallbackTimeoutRef.current = null;
      }

      if (battleImageSkipRef.current) {
        return;
      }

      setBattleLogs(prev => {
        return appendBattleImageResultLogs(prev, data.fromName || 'Opponent', data.imageUrl, 'Image ready');
      });
      scheduleReadyForNextTurn('battle_image_shared_received');
    });

    socket.on('turnTimerTick', (data: { remaining: number | null }) => {
      if (data.remaining != null) {
        battleImageSkipRef.current = false;
        clearBattleImageTimers();
        clearBattleStatusLog('battle-image-pending');
        clearBattleStatusLog('battle-image-complete');
      }
      setTurnTimerRemaining(data.remaining);
    });

    socket.on('turnTimerAutoLocked', (data: { playerId: string; playerName: string }) => {
      setBattleLogs(prev => [...prev, `⏰ **${data.playerName}** ran out of time and took a defensive stance!`]);
      if (data.playerId === socket.id) {
        setIsLockedIn(true);
      }
    });

    socket.on('opponentDisconnected', () => {
      closeFullMap();
      setBattle503RetryAttempt(0);
      setBattleLogs(prev => [...prev, '**Opponent disconnected.** You win by default!']);
      setArenaPreparation(null);
      setRoomTypingIds([]);
      setLocalRoomTypingIds([]);
    });

    socket.on('npcAllyAction', (data: { npcId: string; npcName: string; action: string }) => {
      setAllyActedIds(prev => prev.includes(data.npcId) ? prev : [...prev, data.npcId]);
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
      setSpawnMarker({ locationId: data.locationId, x: data.x, y: data.y });
      mergeWorldPlayers(data.worldPlayers || []);
      setWorldNpcs(data.npcStates || []);
    });

    socket.on('playerMoved', (data) => {
      moveExplorationStateToLocation(data.locationId, data.x, data.y);
    });

    socket.on('explorationPlayersUpdated', (players) => {
      const selfPlayer = (players || []).find((entry: WorldPlayer) => entry.id === socket.id);
      if (selfPlayer) {
        setExplorationState(prev => {
          if (prev.locationId === selfPlayer.locationId && prev.x === selfPlayer.x && prev.y === selfPlayer.y) {
            return prev;
          }

          const discoveredLocations = new Set(prev.discoveredLocations);
          discoveredLocations.add(selfPlayer.locationId);
          const location = worldDataRef.current?.locations?.find((entry: WorldLocation) => entry.id === selfPlayer.locationId);
          for (const connectionId of location?.connections || []) {
            discoveredLocations.add(connectionId);
          }

          return {
            ...prev,
            locationId: selfPlayer.locationId,
            x: selfPlayer.x,
            y: selfPlayer.y,
            discoveredLocations: Array.from(discoveredLocations),
          };
        });
      }
      mergeWorldPlayers(players || []);
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
      setExploration503RetryAttempt(0);
      
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
      upsertExplorationStreamMessage(data.requestId, '', 'thought');
    });

    socket.on('explorationStreamChunk', (data: { requestId: string; type: 'thought' | 'answer'; text: string }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      if (!data.text) return;
      upsertExplorationStreamMessage(data.requestId, data.text, data.type);
    });

    socket.on('explorationActionResult', (data: { requestId: string; text: string; thoughts?: string; toolCalls: any[] }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      activeExplorationStreamIdRef.current = null;
      console.log('[SERVER AI] Result received, text length:', data.text?.length, 'tools:', data.toolCalls?.length);
      clearRetryRestartButton('exploration');
      setIsExplorationProcessing(false);
      setExplorationLockStatus([]);
      setExplorationRetryAttempt(0);
      setExploration503RetryAttempt(0);
      setExplorationError(null);
      clearExplorationStatusMessage('exploration-retry');
      socket.emit('explorationActing', { acting: false });

      if (data.thoughts?.trim()) {
        upsertExplorationStreamMessage(data.requestId, data.thoughts, 'thought');
      } else {
        clearExplorationStreamMessage(data.requestId, 'thought');
      }

      if (data.text) {
        upsertExplorationStreamMessage(data.requestId, data.text, 'answer');
      } else {
        clearExplorationStreamMessage(data.requestId, 'answer');
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
              apiKey: settingsRef.current.apiKey?.trim() || '',
              difficulty: 'Medium',
              botProfile: fullProfile,
              botName: enemyName,
              npcAllies,
              unlimitedTurnTime: settingsRef.current.unlimitedTurnTime,
              modelSettings: { charModel: settingsRef.current.charModel, explorationModel: settingsRef.current.explorationModel, battleModel: settingsRef.current.battleModel, botModel: settingsRef.current.botModel },
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

    socket.on('explorationRetry', (data: { requestId: string; attempt: number; delay: number; label: string; statusCode?: number; statusText?: string; restartAvailable?: boolean }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      if (data.restartAvailable) {
        setExplorationRetryAttempt(0);
        setExploration503RetryAttempt(0);
        setExplorationError(`${data.label}. Retry window expired. Start a new 2-minute retry session when ready.`);
        upsertExplorationStatusMessage('exploration-retry', `⚠️ ${data.label}. Retry window expired. Start a new 2-minute retry session when ready.`);
        registerRetryRestartButton('exploration', 'Retry Explore For 2m', () => {
          restartLatestExplorationRequest();
        });
        return;
      }
      setExplorationRetryAttempt(data.attempt);
      setExploration503RetryAttempt(isServiceUnavailableRetry(data) ? data.attempt : 0);
      setExplorationError(`${data.label}. Retrying in ${data.delay}s...`);
      upsertExplorationStatusMessage('exploration-retry', `⚠️ ${data.label}. Retrying in **${data.delay}s**. Attempt **#${data.attempt}**...`);
      upsertExplorationStreamMessage(data.requestId, '', 'thought');
    });

    socket.on('explorationActionError', (data: { requestId: string; message: string }) => {
      if (activeExplorationStreamIdRef.current && activeExplorationStreamIdRef.current !== data.requestId) return;
      activeExplorationStreamIdRef.current = null;
      setIsExplorationProcessing(false);
      setExplorationLockStatus([]);
      setExplorationRetryAttempt(0);
      setExploration503RetryAttempt(0);
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
      portraitAborted = true;
      if (portraitTimeoutId) clearTimeout(portraitTimeoutId);
      socket.off('characterSaved');
      socket.off('waitingForOpponent');
      socket.off('arenaPreparationState');
      socket.off('roomPlayersUpdated');
      socket.off('roomSettingsUpdated');
      socket.off('matchFound');
      socket.off('battleMapStateUpdated');
      socket.off('battleMapMovementLog');
      socket.off('participantConnectionState');
      socket.off('sessionResumed');
      socket.off('battleActionsSubmitted');
      socket.off('typingStatusUpdated');
      socket.off('playerLockedIn');
      socket.off('turnResolved');
      socket.off('battleEndedByInactivity');
      socket.off('battleRetryStatus');
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
            const preferredCharacter = pickPreferredCharacter(
              normalizedCharacters,
              activeCharacterNameRef.current,
              data.activeCharacterIndex || 0,
            );
            setCharacters(normalizedCharacters);
            setCharacter(preferredCharacter);
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
        const preferredCharacter = pickPreferredCharacter(
          normalizedCharacters,
          activeCharacterNameRef.current,
          data.activeCharacterIndex || 0,
        );
        setCharacters(normalizedCharacters);
        setCharacter(preferredCharacter);
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
        body: JSON.stringify({ characters: stripCharacterImagesForCloud(characters), activeCharacterIndex: Math.max(0, activeIndex) })
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

  useEffect(() => {
    if (!authToken) return;

    const charactersWithAvatars = characters.filter(entry => !!entry.imageUrl);
    if (charactersWithAvatars.length === 0) return;

    let cancelled = false;

    const syncAvatars = async () => {
      for (const entry of charactersWithAvatars) {
        if (cancelled) return;
        try {
          await syncCharacterAvatarToCloud(entry);
        } catch (error) {
          console.error('[Avatar Sync] Failed to sync character avatar', entry.name, error);
        }
      }
    };

    syncAvatars();

    return () => {
      cancelled = true;
    };
  }, [authToken, characters, syncCharacterAvatarToCloud]);

  const handleSendCharMessage = async () => {
    if (!inputText.trim() || isWaitingForChar || (gameStateRef.current === 'arena_prep' && !!players[socket.id || '']?.lockedIn)) return;
    
    const sentText = inputText.trim();
    clearRetryRestartButton('char-creator');
    lastCharCreatorPromptRef.current = sentText;
    clearTypingPresence('character');
    const newMessages = [...messages, { role: 'user' as const, text: sentText }];
    setMessages(newMessages);
    setInputText('');
    if (charInputRef.current) charInputRef.current.style.height = 'auto';
    setIsWaitingForChar(true);
    setCharModelStreamStarted(false);
    setCharCreatorError(null);
    setCharCreatorRetryAttempt(0);
    clearChatStatusMessage('char-creator-retry');
    
    const sysPromptRes = await fetch('/api/prompts/char_creator.txt');
    const sysPrompt = await sysPromptRes.text();

    let fullSysPrompt = sysPrompt;
    if (character) {
      const compactCharacterState = buildCompactCharacterStatSheet(character);
      const rosterProfiles = characters
        .map(entry => `# ${entry.name}\n${entry.profileMarkdown}`)
        .join('\n\n');

      fullSysPrompt += `\n\nCompact Character Stat Sheet (machine-readable):\n${JSON.stringify(compactCharacterState)}\n\nExisting Character Profile JSON:\n${JSON.stringify(stripCharacterImageForSync(character))}\n\nExisting Character Markdown (canonical identity details, unusual resources, abilities, and constraints live here):\n${character.profileMarkdown}\n\nAll Saved Character Markdown Profiles:\n${rosterProfiles || 'None'}\n\nIMPORTANT: The user is TWEAKING an existing character. Use the markdown as canonical context, especially for nonstandard resources or unusual mechanics. Ask clarifying questions about what they want to change before outputting a new state. Do NOT jump straight to creating. When you do save the character, this is an UPDATE, not a creation.`;
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
    const charDebugLabel = gameStateRef.current === 'arena_prep' ? 'arena-prep-char-tweaker' : 'main-menu-char-creator';
    const charResponseStreamId = `char-response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logCharStream = (event: string, details: Record<string, unknown> = {}) => {
      console.log('[CharStream]', { event, scope: charDebugLabel, ...details });
    };

    const charApiConfig = {
      model: settingsRef.current.charModel,
      contents: contents,
      config: {
        systemInstruction: fullSysPrompt,
        temperature: 0.7,
        debugLabel: charDebugLabel,
        tools: [{ functionDeclarations: [saveCharacterTool as any] }]
      },
    };

    let attempts = 0;
    const CHAR_STREAM_STALL_MS = 60_000;
    const CHAR_VISIBLE_OUTPUT_TIMEOUT_MS = 45_000;
    const retryWindowStartedAt = Date.now();
    const characterThinkingPlaceholder = 'Thinking...';
    setCharCreator503RetryAttempt(0);

    const ensureCharThinkingMessage = () => {
      setCharModelStreamStarted(true);
      setMessages(prev => {
        const next = [...prev];
        const existingIndex = next.findIndex(message => message.streamId === charResponseStreamId);
        if (existingIndex >= 0) {
          if (next[existingIndex].role === 'model' && next[existingIndex].text && next[existingIndex].text !== characterThinkingPlaceholder) {
            return prev;
          }
          if (next[existingIndex].role === 'model' && next[existingIndex].text === characterThinkingPlaceholder) {
            return prev;
          }
          next[existingIndex] = { role: 'model', text: characterThinkingPlaceholder, streamId: charResponseStreamId };
          return next;
        }
        return [...prev, { role: 'model', text: characterThinkingPlaceholder, streamId: charResponseStreamId }];
      });
    };

    while (true) {
      setCharCreatorError(null);
      setCharCreatorRetryAttempt(attempts);

      const attemptNumber = attempts + 1;
      const attemptAbort = new AbortController();

      let charStallTimer: ReturnType<typeof setTimeout> | null = null;
      let charVisibleOutputTimer: ReturnType<typeof setTimeout> | null = null;
      let streamStallTimedOut = false;
      let visibleOutputTimedOut = false;
      let sawAnyChunk = false;
      let sawThoughtChunk = false;
      let sawVisibleOutput = false;
      let sawFunctionCall = false;
      const clearCharStallTimer = () => { if (charStallTimer) { clearTimeout(charStallTimer); charStallTimer = null; } };
      const clearCharVisibleOutputTimer = () => { if (charVisibleOutputTimer) { clearTimeout(charVisibleOutputTimer); charVisibleOutputTimer = null; } };
      const clearCharAttemptTimers = () => {
        clearCharStallTimer();
        clearCharVisibleOutputTimer();
      };
      const resetCharStallTimer = () => {
        clearCharStallTimer();
        charStallTimer = setTimeout(() => {
          streamStallTimedOut = true;
          console.warn('[CharStream] No chunk received in 60s — aborting stalled stream');
          attemptAbort.abort();
        }, CHAR_STREAM_STALL_MS);
      };
      const startCharVisibleOutputTimer = () => {
        clearCharVisibleOutputTimer();
        charVisibleOutputTimer = setTimeout(() => {
          visibleOutputTimedOut = true;
          console.warn('[CharStream] No visible output received in 45s — aborting hidden-thought stream');
          attemptAbort.abort();
        }, CHAR_VISIBLE_OUTPUT_TIMEOUT_MS);
      };

      try {
        logCharStream('attempt_start', {
          attempt: attemptNumber,
          stage: arenaPreparation?.stage || null,
          hasCharacter: !!character,
          promptLength: sentText.length,
        });
        resetCharStallTimer();
        startCharVisibleOutputTimer();
        const responseStream = await aiClient.models.generateContentStream({
          ...charApiConfig,
          config: { ...charApiConfig.config, abortSignal: attemptAbort.signal },
        });
        
        let fullText = "";
        let currentModelMessage = "";
        let toolCallData: any = null;
        
        for await (const chunk of responseStream) {
          resetCharStallTimer();
          sawAnyChunk = true;
          if (attemptAbort.signal.aborted) break;
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          if (parts.length > 0) {
            ensureCharThinkingMessage();
          }
          for (const part of parts) {
            if (part.functionCall) {
              toolCallData = part.functionCall;
              if (!sawFunctionCall) {
                sawFunctionCall = true;
                clearCharVisibleOutputTimer();
                logCharStream('first_tool_call', {
                  attempt: attemptNumber,
                  name: part.functionCall.name || 'unknown',
                });
              }
            } else if ((part as any).thought) {
              if (!sawThoughtChunk) {
                sawThoughtChunk = true;
                logCharStream('first_thought_chunk', { attempt: attemptNumber });
              }
            } else {
              const partText = (part as any).text || "";
              fullText += partText;
              if (partText.trim() && !sawVisibleOutput) {
                sawVisibleOutput = true;
                clearCharVisibleOutputTimer();
                logCharStream('first_visible_text', {
                  attempt: attemptNumber,
                  length: partText.trim().length,
                });
              }
            }
          }
          
          const displayText = fullText.trim();
          if (displayText !== currentModelMessage) {
            currentModelMessage = displayText;
            setMessages(prev => {
              const newMsgs = [...prev];
              const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
              if (responseIndex >= 0) {
                newMsgs[responseIndex] = { role: 'model', text: displayText, streamId: charResponseStreamId };
                return newMsgs;
              }
              return [...newMsgs, { role: 'model', text: displayText, streamId: charResponseStreamId }];
            });
          }
        }

        logCharStream('stream_completed', {
          attempt: attemptNumber,
          sawAnyChunk,
          sawThoughtChunk,
          sawVisibleOutput,
          sawFunctionCall,
          textLength: fullText.trim().length,
        });

        if (!fullText.trim() && !toolCallData && !attemptAbort.signal.aborted) {
          logCharStream('fallback_generate_start', { attempt: attemptNumber });
          ensureCharThinkingMessage();
          const fallbackResponse = await aiClient.models.generateContent({
            ...charApiConfig,
            config: { ...charApiConfig.config, abortSignal: attemptAbort.signal },
          });
          const fallbackParts = fallbackResponse.candidates?.[0]?.content?.parts || [];
          for (const part of fallbackParts) {
            if (part.functionCall) {
              toolCallData = part.functionCall;
              if (!sawFunctionCall) {
                sawFunctionCall = true;
                logCharStream('fallback_tool_call', {
                  attempt: attemptNumber,
                  name: part.functionCall.name || 'unknown',
                });
              }
            } else if ((part as any).thought) {
              // Skip thought parts
            } else {
              const partText = (part as any).text || "";
              fullText += partText;
              if (partText.trim() && !sawVisibleOutput) {
                sawVisibleOutput = true;
                logCharStream('fallback_visible_text', {
                  attempt: attemptNumber,
                  length: partText.trim().length,
                });
              }
            }
          }
          logCharStream('fallback_generate_completed', {
            attempt: attemptNumber,
            textLength: fullText.trim().length,
            hasToolCall: !!toolCallData,
          });
        }

        const finalDisplayText = fullText.trim();
        if (finalDisplayText && finalDisplayText !== currentModelMessage) {
          currentModelMessage = finalDisplayText;
          setMessages(prev => {
            const newMsgs = [...prev];
            const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
            if (responseIndex >= 0) {
              newMsgs[responseIndex] = { role: 'model', text: finalDisplayText, streamId: charResponseStreamId };
              return newMsgs;
            }
            return [...newMsgs, { role: 'model', text: finalDisplayText, streamId: charResponseStreamId }];
          });
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

        if (!fullText.trim() && toolCallData?.name === 'save_character') {
          const confirmationText = character ? 'Legend updated.' : 'Legend saved.';
          setMessages(prev => {
            const newMsgs = [...prev];
            const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
            if (responseIndex >= 0) {
              newMsgs[responseIndex] = { role: 'model', text: confirmationText, streamId: charResponseStreamId };
              return newMsgs;
            }
            return [...newMsgs, { role: 'model', text: confirmationText, streamId: charResponseStreamId }];
          });
        } else if (!fullText.trim() && !toolCallData) {
          setMessages(prev => {
            const newMsgs = [...prev];
            const fallbackText = 'I could not produce a usable legend reply. Try sending that again.';
            const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
            if (responseIndex >= 0) {
              newMsgs[responseIndex] = { role: 'model', text: fallbackText, streamId: charResponseStreamId };
              return newMsgs;
            }
            return [...newMsgs, { role: 'model', text: fallbackText, streamId: charResponseStreamId }];
          });
        }

        // Success
        clearCharAttemptTimers();
        clearChatStatusMessage('char-creator-retry');
        setCharCreatorRetryAttempt(0);
        setCharCreator503RetryAttempt(0);
        setCharCreatorError(null);
        setCharModelStreamStarted(false);
        logCharStream('attempt_succeeded', {
          attempt: attemptNumber,
          textLength: fullText.trim().length,
          hasToolCall: !!toolCallData,
        });
        break;

      } catch (error: any) {
        clearCharAttemptTimers();

        let errorInfo: ReturnType<typeof classifyAIError> | {
          label: string;
          detail: string;
          retryable: boolean;
          statusCode?: number;
          statusText?: string;
          suggestedRetrySeconds?: number;
        };

        if ((error.name === 'AbortError' || attemptAbort.signal.aborted) && (streamStallTimedOut || visibleOutputTimedOut)) {
          errorInfo = {
            label: visibleOutputTimedOut ? 'Character rewrite stalled before a visible reply' : 'Character rewrite stream stalled',
            detail: visibleOutputTimedOut
              ? 'Gemini kept thinking without visible text or a tool call.'
              : 'No stream chunks arrived before the stall timeout.',
            retryable: true,
            statusCode: 408,
            statusText: 'TIMEOUT',
            suggestedRetrySeconds: 2,
          };
          logCharStream('attempt_timeout', {
            attempt: attemptNumber,
            sawAnyChunk,
            sawThoughtChunk,
            sawVisibleOutput,
            sawFunctionCall,
            visibleOutputTimedOut,
            streamStallTimedOut,
          });
        } else if (error.name === 'AbortError' || attemptAbort.signal.aborted) {
          setCharCreator503RetryAttempt(0);
          setCharModelStreamStarted(false);
          console.warn('Character creator stream aborted (timeout or cleanup)');
          setMessages(prev => {
            const newMsgs = [...prev];
            const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
            if (responseIndex >= 0 && (!newMsgs[responseIndex].text || newMsgs[responseIndex].text === characterThinkingPlaceholder)) {
              newMsgs.splice(responseIndex, 1);
            }
            return [...newMsgs, { role: 'system', text: '⚠️ Character creator timed out. Try sending your message again.' }];
          });
          break;
        } else {
          console.error("Error creating character:", error);
          errorInfo = classifyAIError(error);
        }

        if (errorInfo.retryable) {
          // Remove the empty model placeholder from failed attempt
          setMessages(prev => {
            const newMsgs = [...prev];
            const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
            if (responseIndex >= 0 && (!newMsgs[responseIndex].text || newMsgs[responseIndex].text === characterThinkingPlaceholder)) {
              newMsgs.splice(responseIndex, 1);
            }
            return newMsgs;
          });
          attempts++;
          const remainingMs = 120_000 - (Date.now() - retryWindowStartedAt);
          if (remainingMs <= 0) {
            const retryPrompt = lastCharCreatorPromptRef.current || sentText;
            registerRetryRestartButton('char-creator', 'Retry Character For 2m', () => {
              setInputText(retryPrompt);
              window.setTimeout(() => {
                void handleSendCharMessage();
              }, 0);
            });
            setCharCreatorRetryAttempt(0);
            setCharCreator503RetryAttempt(0);
            setCharCreatorError(`${errorInfo.label}. Retry window expired. Start a new 2-minute retry session when ready.`);
            setCharModelStreamStarted(false);
            upsertChatStatusMessage('char-creator-retry', `⚠️ ${errorInfo.label}. Retry window expired. Start a new 2-minute retry session when ready.`);
            break;
          }
          const delay = Math.min(
            getAIRetryDelaySeconds(attempts, errorInfo.suggestedRetrySeconds),
            Math.max(1, remainingMs / 1000),
          );
          const delaySec = Math.round(delay);
          logCharStream('retry_scheduled', {
            attempt: attemptNumber,
            nextAttempt: attempts + 1,
            label: errorInfo.label,
            delaySec,
            statusCode: errorInfo.statusCode,
            statusText: errorInfo.statusText,
          });
          setCharCreatorRetryAttempt(attempts);
          setCharCreator503RetryAttempt(isServiceUnavailableRetry(errorInfo) ? attempts : 0);
          setCharCreatorError(`${errorInfo.label}. Retrying in ${delaySec}s...`);
          upsertChatStatusMessage('char-creator-retry', `⚠️ ${errorInfo.label}. Retrying in **${delaySec}s**. Attempt **#${attempts}**...`);
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          continue;
        }

        const formattedError = formatAIError(errorInfo);
        const errorMsg = `[SYSTEM ERROR]: Failed to generate response using model ${settingsRef.current.charModel}. ${formattedError}`;
        setMessages(prev => {
          const newMsgs = [...prev];
          const responseIndex = newMsgs.findIndex(message => message.streamId === charResponseStreamId);
          if (responseIndex >= 0 && (!newMsgs[responseIndex].text || newMsgs[responseIndex].text === characterThinkingPlaceholder)) {
            newMsgs.splice(responseIndex, 1);
          }
          return [...newMsgs, { role: 'system', text: errorMsg }];
        });
        setCharCreatorRetryAttempt(0);
        setCharCreator503RetryAttempt(0);
        setCharCreatorError(formattedError);
        setCharModelStreamStarted(false);
        upsertChatStatusMessage('char-creator-retry', `⚠️ Character creator error: ${formattedError}`);
        break;
      }
    }

    setIsWaitingForChar(false);
    setCharModelStreamStarted(false);
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

  const handleBattleMapMove = (locationId: string) => {
    if (!roomId) return;

    const location = worldData?.locations?.find((entry: WorldLocation) => entry.id === locationId);
    if (!location) return;

    syncBattleMapState({
      discoveredLocations: Array.from(new Set([
        ...battleMapState.discoveredLocations,
        location.id,
        ...(location.connections || []),
      ])),
      players: battleMapState.players.map(player => player.id === socket.id ? {
        ...player,
        locationId: location.id,
        x: location.x,
        y: location.y,
      } : player),
      npcs: battleMapState.npcs,
    });
    socket.emit('battleMoveToLocation', { roomId, locationId });
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

  const restartLatestExplorationRequest = useCallback(() => {
    const pendingRequest = lastExplorationRequestRef.current;
    if (!pendingRequest) return;

    clearRetryRestartButton('exploration');
    setExplorationError(null);
    setExplorationRetryAttempt(0);
    setExploration503RetryAttempt(0);

    if (pendingRequest.mode === 'lock') {
      setIsExplorationLockedIn(true);
      socket.emit('explorationLockIn', pendingRequest.payload);
      return;
    }

    setIsExplorationProcessing(true);
    socket.emit('explorationAction', pendingRequest.payload);
  }, [clearRetryRestartButton]);

  const isImmediateExplorationAction = (action: string) => {
    const normalized = action.toLowerCase();
    const directTradeVerb = /^(?:buy|purchase|sell|offer|trade|accept(?:\s+trade)?|decline(?:\s+trade)?)/i;
    if (directTradeVerb.test(normalized)) return true;
    return false;
  };

  const handleExplorationSend = () => {
    const action = explorationInput.trim();
    if (!action || isExplorationProcessing || isExplorationLockedIn) return;
    clearTypingPresence('exploration');
    
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
    
    const othersInWorld = worldPlayers.filter(p => p.id !== socket.id);
    const isImmediateAction = isImmediateExplorationAction(action);
    if (othersInWorld.length > 0 && !isImmediateAction) {
      // Multiplayer: lock in action and wait for others
      setIsExplorationLockedIn(true);
      setExplorationLog(prev => [...prev, { role: 'user', text: `🔒 ${action}` }]);
      const payload = { action, ...getExplorationContext() };
      lastExplorationRequestRef.current = { mode: 'lock', payload };
      socket.emit('explorationLockIn', payload);
    } else {
      // Solo or immediate deterministic action: send action to server now
      setExplorationLog(prev => [...prev, { role: 'user', text: action }]);
      setIsExplorationProcessing(true);
      setExplorationError(null);
      setExplorationRetryAttempt(0);
      setExploration503RetryAttempt(0);
      clearExplorationStatusMessage('exploration-retry');
      socket.emit('explorationActing', { acting: true });
      const payload = { action, ...getExplorationContext() };
      lastExplorationRequestRef.current = { mode: 'action', payload };
      socket.emit('explorationAction', payload);
    }
  };

  const handleExplorationUnlock = () => {
    clearTypingPresence('exploration');
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
    clearRetryRestartButton('char-image');
    setIsGeneratingCharImage(true);
    console.log("[Portrait] Starting generation for:", character.name);
    const generationMessageId = `avatar-generation-${character.name}-${Date.now()}`;
    setMessages(prev => [...prev, { role: 'system', text: '🎨 Generating portrait... server retries automatically if Gemini is busy.', streamId: generationMessageId }]);
    try {
      const aiClient = getAIClient();
      const promptTemplate = await getPromptTemplate('avatar_image.txt');
      const prompt = renderPromptTemplate(promptTemplate, {
        CHARACTER_NAME: character.name,
        PROFILE_SNIPPET: character.profileMarkdown.substring(0, 500),
      });
      
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
      const imageFrames = extractInlineImageFrames(parts);
      if (imageFrames.length > 0) {
        const optimizedImageUrl = await optimizeCharacterAvatar(imageFrames[imageFrames.length - 1]);
        setCharacter(prev => prev ? { ...prev, imageUrl: optimizedImageUrl } : prev);
        setMessages(prev => {
          const filtered = prev.filter(message => message.streamId !== generationMessageId);
          return [...filtered, {
            role: 'system',
            text: '🎨 Portrait generated!',
            imageUrl: optimizedImageUrl,
            imageFrames: imageFrames.length > 1 ? imageFrames : undefined,
            imageFrameFps: imageFrames.length > 1 ? 60 : undefined,
          }];
        });
        console.log("[Portrait] Success! Image generated.");
        return;
      }
      console.warn("[Portrait] No image data in response parts:", parts.map((p: any) => Object.keys(p)));
      setMessages(prev => [...prev, { role: 'system', text: '⚠️ No image was generated. Try again.' }]);
    } catch (error: any) {
      console.error("[Portrait] Generation error:", error);
      if (error?.retryWindowExpired) {
        registerRetryRestartButton('char-image', 'Retry Portrait For 2m', () => {
          void handleGenerateCharImage();
        });
      }
      setMessages(prev => [...prev, { role: 'system', text: `⚠️ Image generation failed: ${error.message}` }]);
    } finally {
      setMessages(prev => prev.filter(message => message.streamId !== generationMessageId));
      setIsGeneratingCharImage(false);
    }
  };

  const handleVisualizeScene = async () => {
    if (!worldData || !explorationState.locationId || isVisualizingScene) return;
    const loc = getCurrentLocation();
    if (!loc) return;
    clearRetryRestartButton('scene-image');
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
      if (error?.retryWindowExpired) {
        registerRetryRestartButton('scene-image', 'Retry Scene For 2m', () => {
          void handleVisualizeScene();
        });
      }
      setExplorationLog(prev => [...prev, { role: 'system', text: `[ERROR]: Scene visualization failed: ${error.message}` }]);
    } finally {
      setIsVisualizingScene(false);
    }
  };

  // ============ END EXPLORATION HANDLERS ============

  const handleGenerateBattleImage = async () => {
    if (isGeneratingBattleImage || hasVisualizedThisTurn) {
      appendBattleTraceEvent('battle_image_generation_skipped', {
        roomId,
        isGeneratingBattleImage,
        hasVisualizedThisTurn,
      });
      logBattleDebug('image_generation_skipped', {
        roomId,
        isGeneratingBattleImage,
        hasVisualizedThisTurn,
      });
      return;
    }

    clearRetryRestartButton('battle-image');
    showBattleImagePendingStatus();
    setBattleImageRetryAttempt(0);
    setIsGeneratingBattleImage(true);
    appendBattleTraceEvent('battle_image_generation_started', {
      roomId: roomIdRef.current || roomId,
      playerCount: Object.keys(players).length,
      battleLogCount: battleLogs.length,
    });
    let generatedImage = false;
    let generatedImageUrlLength = 0;
    let readyReason: string | null = null;
    let completionLabel = 'Continuing without image';
    let readyScheduled = false;
    const activeImageRoomId = roomIdRef.current || roomId;
    const continueWithoutBlocking = (reason: string, label = 'Continuing while image retries') => {
      if (readyScheduled || battleImageSkipRef.current) return;
      readyScheduled = true;
      readyReason = reason;
      completionLabel = label;
      appendBattleTraceEvent('battle_image_generation_backgrounded', {
        roomId: activeImageRoomId,
        reason,
        label,
      });
      showBattleImageCompleteStatus(label);
      scheduleReadyForNextTurn(reason, 300);
    };
    try {
      const aiClient = getAIClient();
      const latestBattleLogs = battleLogsRef.current;
      const imageNarrativeLogs = extractRecentBattleNarrative(sanitizeBattleHistoryForJudge(latestBattleLogs));
      const recentLogs = imageNarrativeLogs.join('\n\n').substring(0, 900);
      const playerNames = Object.values(players).map((p: any) => p.character.name).join(' vs ');
      const battleMapImageContext = buildBattleMapContext(worldDataRef.current, battleMapState, players)
        .replace('BATTLE MAP STATE:\n', '')
        .substring(0, 1200);
      const battleLocationSummary = battleMapState.players.map((player) => {
        const location = getWorldLocationById(worldDataRef.current, player.locationId);
        const island = getWorldIslandById(worldDataRef.current, location?.islandId);
        const playerName = players[player.id]?.character?.name || player.name;
        return `${playerName} is on ${island?.name || location?.islandId || 'an unknown island'}, near ${location?.name || player.locationId} at (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`;
      }).join('; ');
      const orderedCombatants = Object.values(players)
        .filter((p: any) => !p.character?.isNpcAlly)
        .slice(0, 2);
      const combatantAnchors = orderedCombatants.map((participant: any, idx: number) => {
        const mapPlayer = battleMapState.players.find((entry) => entry.id === participant.id);
        const location = getWorldLocationById(worldDataRef.current, mapPlayer?.locationId);
        const island = getWorldIslandById(worldDataRef.current, location?.islandId);

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
        ? getLocationHopDistance(worldDataRef.current, leftLocationId, rightLocationId)
        : Number.POSITIVE_INFINITY;
      const separatedIslands = !!combatantAnchors[0]?.islandId && !!combatantAnchors[1]?.islandId && combatantAnchors[0].islandId !== combatantAnchors[1].islandId;
      const compositionDirective = separatedIslands
        ? `COMPOSITION MODE: split view or a wide establishing shot with both islands visible. ${combatantAnchors[0]?.name || 'Combatant 1'} must remain on ${combatantAnchors[0]?.islandName || 'their island'} and ${combatantAnchors[1]?.name || 'Combatant 2'} must remain on ${combatantAnchors[1]?.islandName || 'their island'}. Show visible ocean, distance, or distinct landmasses between them. Do NOT place both fighters on the same ground plane, beach, bridge, arena floor, or cliff.`
        : combatantHopDistance > 0
          ? `COMPOSITION MODE: single-island wide view. Both fighters are on ${combatantAnchors[0]?.islandName || 'the same island'} but separated across the terrain. Preserve that distance with a broad island view instead of staging them shoulder-to-shoulder.`
          : 'COMPOSITION MODE: shared close battlefield. A tighter duel frame is allowed because the combatants are currently close together.';
      const combatantAnchorSummary = combatantAnchors
        .map((anchor) => `- ${anchor.side}: ${anchor.name} is on ${anchor.islandName} near ${anchor.locationName}.`)
        .join('\n');
      const transformationCuesByName = new globalThis.Map(orderedCombatants.map((participant: any) => {
        const participantName = participant.character?.name || 'Combatant';
        return [participantName, extractTransformationCueForCombatant(recentLogs, participantName)];
      }));
      const transformationSummary = orderedCombatants
        .map((participant: any) => {
          const participantName = participant.character?.name || 'Combatant';
          const cue = transformationCuesByName.get(participantName);
          return cue ? buildTransformationRenderDirective(participantName, cue) : null;
        })
        .filter(Boolean)
        .join('\n');
      const avatarReferenceParts = orderedCombatants
        .flatMap((participant: any, idx: number) => {
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
      const avatarReferenceImageCount = avatarReferenceParts.filter((part: any) => !!part?.inlineData).length;
      const leftName = (orderedCombatants[0] as any)?.character?.name || 'Combatant 1';
      const rightName = (orderedCombatants[1] as any)?.character?.name || 'Combatant 2';
      const posterLayoutDirective = [
        '- Build the artwork as a fresh original battle poster for this turn only.',
        '- Put a bold comic-style headline at the top, but choose a new framing and scene composition from the current narrative instead of imitating any stock layout.',
        '- Add at least one small floating location callout tied to a real battlefield position from this turn.',
        `- Add a bottom split result banner with ${leftName} locked on the LEFT and ${rightName} locked on the RIGHT. Each side must show the character name, a strong icon, the move name, and a short outcome.`,
        '- Keep typography readable and energetic, but do not let the text treatment force repeated camera angles, repeated horizons, or repeated combatant poses.',
      ].join('\n');
      const promptTemplate = await getPromptTemplate('battle_image.txt');
      const prompt = renderPromptTemplate(promptTemplate, {
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

      logBattleDebug('image_generation_start', {
        roomId,
        playerNames,
        playerIds: Object.keys(players),
        battleLogCount: latestBattleLogs.length,
        recentLogsPreview: recentLogs,
        battleLocationSummary,
        battleMapImageContext,
        compositionDirective,
        combatantAnchors,
        transformationSummary,
        posterLayoutMode: 'text-only',
        avatarReferenceCount: avatarReferenceImageCount,
      });

      const requestParts: any[] = [{ text: prompt }];
      requestParts.push(...avatarReferenceParts);
      let attempt = 0;
      while (!battleImageSkipRef.current && !hasVisualizedThisTurnRef.current && (!activeImageRoomId || roomIdRef.current === activeImageRoomId)) {
        try {
          const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: [{ role: 'user', parts: requestParts }],
            config: {
              responseModalities: ['IMAGE', 'TEXT'],
            },
          });

          const parts = response.candidates?.[0]?.content?.parts || [];
          const imageFrames = extractInlineImageFrames(parts);
          logBattleDebug('image_generation_response', {
            roomId,
            attempt,
            partCount: parts.length,
            imageFrameCount: imageFrames.length,
            parts: parts.map((part: any) => ({
              hasInlineData: !!part?.inlineData,
              mimeType: part?.inlineData?.mimeType || null,
              textPreview: typeof part?.text === 'string' ? part.text.slice(0, 120) : null,
            })),
          });

          if (imageFrames.length > 0) {
            const rawImageUrl = imageFrames[imageFrames.length - 1];
            const imageUrl = await optimizeCharacterAvatar(rawImageUrl);
            generatedImage = true;
            generatedImageUrlLength = imageUrl.length;
            setBattleImageRetryAttempt(0);
            appendBattleTraceEvent('battle_image_generation_succeeded', {
              roomId: activeImageRoomId,
              attempt,
              imageFrameCount: imageFrames.length,
              imageUrlLength: imageUrl.length,
            });
            logBattleDebug('image_generation_success', {
              roomId,
              attempt,
              rawImageUrlLength: rawImageUrl.length,
              imageUrlLength: imageUrl.length,
              imageFrameCount: imageFrames.length,
              skipped: battleImageSkipRef.current,
            });

            if (battleImageSkipRef.current || hasVisualizedThisTurnRef.current) {
              return;
            }

            completionLabel = 'Image ready';
            if (!readyScheduled) {
              readyReason = 'image_generation_success';
            }
            if (roomIdRef.current) {
              setHasVisualizedThisTurn(true);
              socket.emit('shareBattleImage', { roomId: roomIdRef.current, imageUrl });
            } else {
              setBattleLogs(prev => appendBattleImageResultLogs(prev, character?.name || 'You', imageUrl, completionLabel));
              setHasVisualizedThisTurn(true);
            }
            return;
          }

          attempt += 1;
          setBattleImageRetryAttempt(attempt);
          showBattleImagePendingStatus(attempt);
          continueWithoutBlocking('image_generation_background_retry', `Continuing while image retries (Retried ${attempt} time${attempt === 1 ? '' : 's'})`);
          const delay = getAIRetryDelaySeconds(attempt);
          const delaySec = Math.round(delay);
          appendBattleTraceEvent('battle_image_retry_scheduled', {
            roomId: activeImageRoomId,
            attempt,
            delaySeconds: delaySec,
            reason: 'no_inline_data',
          });
          logBattleDebug('image_generation_no_inline_data', {
            roomId,
            attempt,
            partCount: parts.length,
            imageFrameCount: imageFrames.length,
            retryDelaySeconds: delaySec,
          });
          await new Promise(resolve => window.setTimeout(resolve, delay * 1000));
          continue;
        } catch (error: any) {
          if (error?.retryWindowExpired) {
            throw error;
          }
          const errorInfo = classifyAIError(error);
          attempt += 1;
          setBattleImageRetryAttempt(attempt);
          showBattleImagePendingStatus(attempt);
          continueWithoutBlocking('image_generation_background_retry', `Continuing while image retries (Retried ${attempt} time${attempt === 1 ? '' : 's'})`);
          const delay = getAIRetryDelaySeconds(attempt, errorInfo.suggestedRetrySeconds);
          const delaySec = Math.round(delay);
          console.error("Battle image error:", error);
          appendBattleTraceEvent('battle_image_retry_scheduled', {
            roomId: activeImageRoomId,
            attempt,
            delaySeconds: delaySec,
            reason: errorInfo.label,
            statusCode: errorInfo.statusCode ?? null,
            statusText: errorInfo.statusText ?? null,
          });
          logBattleDebug('image_generation_error', {
            roomId,
            attempt,
            name: error?.name || null,
            message: error?.message || String(error),
            retryDelaySeconds: delaySec,
            statusCode: errorInfo.statusCode,
            statusText: errorInfo.statusText,
          });
          await new Promise(resolve => window.setTimeout(resolve, delay * 1000));
          continue;
        }
      }

      if (!generatedImage && !readyScheduled && !battleImageSkipRef.current) {
        readyReason = 'image_generation_fallback';
      }
    } catch (error: any) {
      console.error("Battle image error:", error);
      if (error?.retryWindowExpired) {
        registerRetryRestartButton('battle-image', 'Retry Image For 2m', () => {
          void handleGenerateBattleImage();
        });
      }
      appendBattleTraceEvent('battle_image_generation_failed', {
        roomId: activeImageRoomId,
        message: error?.message || String(error),
      });
      logBattleDebug('image_generation_error', {
        roomId,
        name: error?.name || null,
        message: error?.message || String(error),
      });
      readyReason = 'image_generation_fallback';
    } finally {
      setIsGeneratingBattleImage(false);
      if (!generatedImage && readyReason && !battleImageSkipRef.current && !readyScheduled) {
        setBattleImageRetryAttempt(0);
        showBattleImageCompleteStatus(completionLabel);
      }
      if (readyReason && !readyScheduled) {
        appendBattleTraceEvent('battle_image_ready_for_next_turn_scheduled', {
          roomId: activeImageRoomId,
          reason: readyReason,
          generatedImage,
          completionLabel,
        });
        logBattleDebug('ready_for_next_turn_scheduled', {
          roomId,
          reason: readyReason,
          generatedImage,
          imageUrlLength: generatedImageUrlLength,
          completionLabel,
        });
        scheduleReadyForNextTurn(readyReason);
      }
    }
  };
  handleGenerateBattleImageRef.current = handleGenerateBattleImage;

  const handleBattleUnlock = () => {
    appendBattleTraceEvent('player_action_unlock_requested', {
      roomId: roomIdRef.current,
      playerId: socket.id || null,
    });
    clearTypingPresence('battle');
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
    socket.emit('enterArena', { apiKey: settingsRef.current.apiKey?.trim() || '', unlimitedTurnTime: settingsRef.current.unlimitedTurnTime, modelSettings: { charModel: settingsRef.current.charModel, explorationModel: settingsRef.current.explorationModel, battleModel: settingsRef.current.battleModel, botModel: settingsRef.current.botModel } });
  };

  const handleNewCharacter = () => {
    activeCharacterNameRef.current = null;
    localStorage.removeItem('duo_active_character_name');
    setCharacter(null);
    setMessages([{ role: 'model', text: "Let's build a new legend. What kind of character do you want to create?" }]);
    setGameState('char_creation');
    setActiveTab('profile');
  };

  const handleSelectCharacter = (name: string) => {
    const selected = characters.find(c => c.name === name);
    if (selected) {
      activeCharacterNameRef.current = selected.name;
      localStorage.setItem('duo_active_character_name', selected.name);
      setCharacter(selected);
      setMessages([{ role: 'model', text: `Switched to ${selected.name}. Ready for action!` }]);
    }
  };

  const handleSendBattleAction = () => {
    const action = battleInput.trim();
    if (!action || isLockedIn) return;
    appendBattleTraceEvent('player_action_submitted', {
      roomId: roomIdRef.current,
      playerId: socket.id || null,
      actionLength: action.length,
      actionPreview: action.slice(0, 160),
    });
    clearTypingPresence('battle');

    const socketId = socket.id;
    if (socketId) {
      setBattleLogs(prev => [...removePendingBattleActionLogs(prev, socketId), buildPendingBattleActionLog(socketId, action)]);
    }

    socket.emit('playerAction', action);
    setIsLockedIn(true);
    setBattleInput('');
    if (battleInputRef.current) battleInputRef.current.style.height = 'auto';
  };

  const getBattleSendBlockReason = () => {
    if (!battleInput.trim()) return 'Action required';
    if (isLockedIn) return 'Locked';
    return null;
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

    if ((gameState === 'battle' || gameState === 'arena_prep') && currentBattlePlayer) {
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

    const selfConnectionNotice = connectionPhase === 'reconnecting'
      ? { text: '🔄 Reconnecting...', tone: 'amber' as const }
      : connectionPhase === 'resyncing'
        ? { text: '🧭 Resyncing turn...', tone: 'blue' as const }
        : connectionPhase === 'reconnected'
          ? { text: '✓ Reconnected!', tone: 'green' as const }
          : null;

    return (
      <div className="sticky top-0 z-20 bg-white border-b-2 border-duo-gray shadow-sm">
        {gameState !== 'battle' && (
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-duo-gray-dark font-bold">
              {gameState === 'post_match' && (
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
              <button onClick={() => {
                setSettingsPage('general');
                setShowSettings(true);
              }} className="text-duo-gray-dark hover:text-duo-blue transition-colors ml-2">
                <Settings className="w-6 h-6" />
              </button>
            </div>
          </div>
        )}
        {(selfConnectionNotice || participantConnectionNotice) && (
          <div className="px-2 py-1.5 border-t flex flex-wrap items-center justify-center gap-1.5 bg-gray-50/70">
            {selfConnectionNotice && (
              <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${selfConnectionNotice.tone === 'amber' ? 'bg-amber-50 text-amber-700 border-amber-200' : selfConnectionNotice.tone === 'blue' ? 'bg-blue-50 text-duo-blue border-blue-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
                {selfConnectionNotice.text}
              </span>
            )}
            {participantConnectionNotice && (
              <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${participantConnectionNotice.tone === 'amber' ? 'bg-amber-50 text-amber-700 border-amber-200' : participantConnectionNotice.tone === 'blue' ? 'bg-blue-50 text-duo-blue border-blue-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
                {participantConnectionNotice.text}
              </span>
            )}
          </div>
        )}
        {gameState === 'battle' && (
          <>
            <div className="px-4 py-2 border-t border-duo-gray/30 flex items-start gap-2">
              <button onClick={() => {
                setGameState('menu');
                socket.emit('leaveQueue');
              }} className="mt-0.5 text-duo-gray-dark hover:text-duo-blue transition-colors flex-shrink-0">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex-1 flex flex-wrap gap-2">
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
                    <button
                      type="button"
                      onClick={() => {
                        setProfileToView(p.character.profileMarkdown);
                        setShowProfileModal(true);
                      }}
                      className="block w-full h-2 bg-duo-gray rounded-full overflow-hidden hover:ring-2 hover:ring-duo-blue/30 transition"
                      title={`View ${isMe ? 'your' : `${p.character.name}'s`} legend`}
                    >
                      <div 
                          className={`h-full transition-all duration-500 ${getHealthBarFillClass(p.character.hp, p.character.maxHp)}`}
                          style={{ width: `${Math.max(0, Math.min(100, (p.character.hp / Math.max(1, p.character.maxHp || 1)) * 100))}%` }} 
                      />
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
            <div className="px-2 py-1 flex flex-wrap justify-center gap-x-4 gap-y-1 border-t border-duo-gray/50 bg-gray-50/50">
            </div>
          </>
        )}
      </div>
    );
  };

  const render503RetryPills = () => {
    const restartEntries = Object.entries(localRetryRestartButtons);
    const pills = [
      battleImageRetryAttempt > 0 ? { key: 'battle-image', label: 'Image', attempt: battleImageRetryAttempt } : null,
      charCreator503RetryAttempt > 0 ? { key: 'char-creator', label: '503 Character', attempt: charCreator503RetryAttempt } : null,
      exploration503RetryAttempt > 0 ? { key: 'exploration', label: '503 Explore', attempt: exploration503RetryAttempt } : null,
      bot503RetryAttempt > 0 ? { key: 'bot', label: '503 Bot', attempt: bot503RetryAttempt } : null,
    ].filter(Boolean) as Array<{ key: string; label: string; attempt: number }>;

    if (pills.length === 0 && restartEntries.length === 0) return null;

    return (
      <div className="px-2 pt-2 flex flex-wrap justify-end gap-1.5 bg-white">
        {pills.map((pill) => (
          <span
            key={pill.key}
            className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-[10px] font-black uppercase text-amber-900 shadow-sm"
          >
            {pill.label} Retry #{pill.attempt}
          </span>
        ))}
        {restartEntries.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              const handler = retryRestartHandlersRef.current[key];
              clearRetryRestartButton(key);
              handler?.();
            }}
            className="inline-flex items-center rounded-full border border-amber-500 bg-amber-200 px-3 py-1 text-[10px] font-black uppercase text-amber-950 shadow-sm"
          >
            {label}
          </button>
        ))}
      </div>
    );
  };

  const renderBottomBar = () => {
    if (gameState === 'battle' || gameState === 'arena_prep' || gameState === 'matchmaking' || gameState === 'exploration' || gameState === 'level_select') return null;

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
    clearRetryRestartButton('generate-bot');
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
      if (err?.retryWindowExpired) {
        registerRetryRestartButton('generate-bot', 'Retry Bot For 2m', () => {
          void handleGenerateBot();
        });
      }
      alert(`Failed to generate bot using model ${settingsRef.current.botModel}. Error: ${err.message}`);
    } finally {
      setIsGeneratingBot(false);
    }
  };

  const renderMenu = () => (
    <div className="flex-1 flex flex-col items-center p-6 gap-8 overflow-y-auto">
      <div className="text-center space-y-2">
        <h1 className="text-5xl font-black text-duo-text tracking-tight">What If</h1>
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
                    apiKey: settingsRef.current.apiKey?.trim() || '',
                    difficulty: difficultyLabels[botDifficulty],
                    botProfile: selectedChar?.content,
                    botName: selectedChar?.name,
                    unlimitedTurnTime: settingsRef.current.unlimitedTurnTime,
                    modelSettings: { charModel: settings.charModel, explorationModel: settings.explorationModel, battleModel: settings.battleModel, botModel: settings.botModel },
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

  const renderCharWaitingState = () => {
    if (!isWaitingForChar) return null;

    if (!charModelStreamStarted) {
      return (
        <div className="flex justify-start px-1">
          <div className="flex items-center gap-2 text-sm font-bold text-black">
            <span>Waiting for model</span>
            <TypingDots dotClassName="h-1.5 w-1.5" />
          </div>
        </div>
      );
    }

    if (messages.length === 0 || messages[messages.length - 1].role === 'user' || !messages[messages.length - 1].text) {
      return (
        <div className="flex justify-start">
          <div className="chat-bubble-them flex items-center gap-2">
            <span className="font-bold text-sm">Thinking...</span>
          </div>
        </div>
      );
    }

    return null;
  };

  const renderCharCreation = () => (
    <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
      <div className="p-3 bg-white border-b border-duo-gray flex justify-between items-center gap-3">
        <button 
          onClick={() => setGameState('menu')}
          className="text-duo-gray-dark hover:text-duo-text flex items-center gap-1 font-bold text-sm"
        >
          <ArrowLeft className="w-5 h-5" /> Back
        </button>
        <h2 className="text-base font-black text-duo-text truncate">Legend Architect</h2>
        {character ? (
          <button 
            onClick={() => {
              setProfileToView(character.profileMarkdown);
              setShowProfileModal(true);
            }}
            className="text-duo-blue hover:text-duo-blue-dark flex items-center gap-1 font-bold text-xs whitespace-nowrap"
          >
            <Info className="w-4 h-4" /> Profile
          </button>
        ) : <div className="w-12" />}
      </div>
      <div className="flex-1 relative min-h-0">
        <div ref={chatScrollContainerRef} onScroll={handleChatLogScroll} onWheelCapture={pauseChatAutoScrollOnIntent} onTouchStart={pauseChatAutoScrollOnIntent} className="h-full overflow-y-auto p-3 space-y-3">
          {messages.map((msg, i) => {
            if (!msg.text && msg.role === 'model') return null;
            return (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'system' ? (
                  <div className="w-full">
                    <div className="text-center text-sm font-bold text-red-500 bg-red-50 border border-red-100 rounded-lg py-2 px-4 my-2 markdown-body">
                      <SafeMarkdown>{msg.text}</SafeMarkdown>
                    </div>
                    <InlineMessageMedia message={msg} alt="Portrait generation" />
                  </div>
                ) : (
                  <div className={msg.role === 'user' ? 'chat-bubble-me' : 'chat-bubble-them'}>
                    <div className="markdown-body">
                      <SafeMarkdown>{msg.text}</SafeMarkdown>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {renderCharWaitingState()}
          <div ref={chatEndRef} />
        </div>
        {!charAutoScroll && (
          <button
            onClick={resumeChatAutoScroll}
            className="absolute bottom-3 right-3 rounded-full bg-duo-blue text-white px-3 py-1.5 text-[10px] font-black uppercase shadow-lg"
          >
            Jump to latest
          </button>
        )}
      </div>
      <div className="p-2.5 bg-white border-t border-duo-gray flex gap-2 composer-safe">
        <textarea
          ref={charInputRef}
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            updateTypingPresence('character', e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendCharMessage();
            }
          }}
          placeholder="Describe your legend..."
          className="flex-1 bg-duo-gray rounded-2xl px-4 py-3 font-bold text-sm text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue resize-none overflow-y-auto"
          rows={1}
          style={{ minHeight: '44px', maxHeight: '50vh' }}
        />
        <button 
          onClick={handleSendCharMessage}
          disabled={isWaitingForChar || !inputText.trim()}
          className="duo-btn duo-btn-blue px-5 flex items-center justify-center disabled:opacity-50"
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

  const renderArenaPreparation = () => {
    const prepPlayers = Object.entries(players);
    const activeTypingIds = new Set([...roomTypingIds, ...localRoomTypingIds]);
    const hasLocalRewriteAccess = !!(socket.id && players[socket.id]?.prepSkippedPreview);
    const isTweakStage = arenaPreparation?.stage === 'tweak' || hasLocalRewriteAccess;
    const isHeadStartRewrite = arenaPreparation?.stage === 'preview' && hasLocalRewriteAccess;
    const isPrepLockedIn = !!(socket.id && players[socket.id]?.lockedIn);
    const previewSkipVotes = arenaPreparation?.skipVotes ?? [];
    const previewParticipantCount = prepPlayers.filter(([, player]) => !player.character?.isNpcAlly).length;
    const previewSkippers = previewSkipVotes.length;

    return (
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        <div className="px-3 py-2 bg-white border-b-2 border-duo-gray space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-duo-blue">Arena Preparation</div>
              <h2 className="text-lg font-black text-duo-text mt-0.5">
                {isTweakStage ? (isHeadStartRewrite ? 'Head Start Rewrite' : 'Final Rewrite Window') : 'Study The Opponents'}
              </h2>
              <p className="text-[11px] font-bold text-duo-gray-dark mt-0.5 max-w-[16rem] leading-tight">
                {isTweakStage
                  ? (isHeadStartRewrite
                    ? 'You started your rewrite early while the remaining preview phase continues for anyone still reviewing.'
                    : 'Refine your legend before the duel begins.')
                  : 'Inspect every legend. The rewrite window opens once everyone is ready.'}
              </p>
            </div>
            <div className={`rounded-2xl px-2.5 py-1.5 border text-center min-w-[72px] ${isTweakStage ? 'bg-yellow-50 text-yellow-700 border-yellow-200' : 'bg-blue-50 text-duo-blue border-blue-200'}`}>
              <div className="text-[9px] font-black uppercase">{isTweakStage ? (isHeadStartRewrite ? 'Head Start' : 'Tweak') : 'Preview'}</div>
              <div className="text-[10px] font-black leading-none mt-1 uppercase">Always On</div>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-3 pt-0.5">
            {prepPlayers.map(([id, player]) => {
              const isMe = id === socket.id;
              const isLockedIn = !!player.lockedIn;
              const isTyping = activeTypingIds.has(id) && !isLockedIn;
              const canInspect = !isTweakStage || isMe;
              return (
                <button
                  key={id}
                  onClick={() => {
                    if (!canInspect) return;
                    setProfileToView(player.character.profileMarkdown);
                    setShowProfileModal(true);
                  }}
                  className={`flex flex-col items-center gap-1.5 min-w-[80px] ${canInspect ? '' : 'opacity-80 cursor-default'}`}
                >
                  <div className={`relative w-16 h-16 rounded-full border-4 shadow-lg overflow-hidden ${isMe ? 'border-duo-green bg-duo-green/10' : 'border-duo-blue bg-duo-blue/10'}`}>
                    {(isMe ? character?.imageUrl : player.character.imageUrl) ? (
                      <img src={isMe ? character?.imageUrl : player.character.imageUrl} alt={player.character.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className={`w-full h-full flex items-center justify-center text-2xl font-black ${isMe ? 'text-duo-green-dark' : 'text-duo-blue'}`}>
                        {player.character.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="text-center">
                    <div className="text-xs font-black text-duo-text truncate max-w-[90px]">{isMe ? 'You' : player.character.name}</div>
                    <div className="text-[10px] font-bold text-duo-gray-dark">Tap to inspect</div>
                  </div>
                  <div className="h-6 flex items-center justify-center">
                    {isLockedIn ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 text-[10px] font-black">
                        <Check className="w-3 h-3" /> Locked in
                      </span>
                    ) : isTyping ? (
                      <span className="inline-flex items-center justify-center rounded-full bg-white/95 px-2 py-1 text-duo-blue shadow-sm border border-duo-blue/20">
                        <TypingDots dotClassName="h-1.5 w-1.5" />
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {!isTweakStage ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6 text-center text-duo-gray-dark overflow-y-auto">
            <div className="w-20 h-20 rounded-full bg-duo-blue/10 text-duo-blue flex items-center justify-center mb-4">
              <Users className="w-12 h-12" />
            </div>
            <h3 className="text-xl font-black text-duo-text">Avatar Review Phase</h3>
            <p className="text-sm font-bold max-w-[22rem] mt-2">
              Open every profile, compare strengths, and decide what needs changing before the rewrite phase begins.
            </p>
            <button
              onClick={() => socket.emit('skipArenaPreparationPreview')}
              className="duo-btn duo-btn-blue mt-5 px-5 py-3"
            >
              Start rewrite now
            </button>
            <p className="text-[11px] font-bold max-w-[22rem] mt-2">
              Skipping opens your rewrite phase immediately. Once every human player has skipped, the whole room advances to the shared write stage.
            </p>
            {previewParticipantCount > 1 && previewSkippers > 0 && (
              <p className="text-[11px] font-bold max-w-[22rem] mt-1 text-duo-blue">
                {previewSkippers} of {previewParticipantCount} human players already started rewriting.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex-1 relative min-h-0">
              <div ref={chatScrollContainerRef} onScroll={handleChatLogScroll} onWheelCapture={pauseChatAutoScrollOnIntent} onTouchStart={pauseChatAutoScrollOnIntent} className="h-full overflow-y-auto p-4 space-y-4">
                {messages.map((msg, i) => {
                  if (!msg.text && msg.role === 'model') return null;
                  return (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'system' ? (
                        <div className="w-full">
                          <div className="text-center text-sm font-bold text-red-500 bg-red-50 border border-red-100 rounded-lg py-2 px-4 my-2 markdown-body">
                            <SafeMarkdown>{msg.text}</SafeMarkdown>
                          </div>
                          <InlineMessageMedia message={msg} alt="Portrait generation" />
                        </div>
                      ) : (
                        <div className={msg.role === 'user' ? 'chat-bubble-me' : 'chat-bubble-them'}>
                          <div className="markdown-body">
                            <SafeMarkdown>{msg.text}</SafeMarkdown>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {renderCharWaitingState()}
                <div ref={chatEndRef} />
              </div>
              {!charAutoScroll && (
                <button
                  onClick={resumeChatAutoScroll}
                  className="absolute bottom-3 right-3 rounded-full bg-duo-blue text-white px-3 py-1.5 text-[10px] font-black uppercase shadow-lg"
                >
                  Jump to latest
                </button>
              )}
            </div>
            <div className="p-4 bg-white border-t-2 border-duo-gray flex gap-2 composer-safe">
              <textarea
                ref={charInputRef}
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  updateTypingPresence('character', e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendCharMessage();
                  }
                }}
                placeholder="Describe exactly what you want to change before the duel starts..."
                className="flex-1 bg-duo-gray rounded-2xl px-4 py-3 font-bold text-duo-text focus:outline-none focus:ring-2 focus:ring-duo-blue resize-none overflow-y-auto"
                rows={1}
                style={{ minHeight: '48px', maxHeight: '50vh' }}
                disabled={isWaitingForChar || isPrepLockedIn}
              />
              <button
                onClick={() => {
                  clearTypingPresence('character');
                  socket.emit('passArenaPreparation');
                }}
                disabled={isWaitingForChar || isPrepLockedIn}
                className="duo-btn duo-btn-gray px-4 flex items-center justify-center disabled:opacity-50 text-xs font-black"
              >
                Pass
              </button>
              <button
                onClick={handleSendCharMessage}
                disabled={isWaitingForChar || isPrepLockedIn || !inputText.trim()}
                className="duo-btn duo-btn-blue px-6 flex items-center justify-center disabled:opacity-50"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderBattle = () => {
    const currentBattleLocationId = battleMapState.players.find(player => player.id === socket.id)?.locationId;
    const currentBattleLocation = getWorldLocationById(worldData, currentBattleLocationId);
    const battleConnectedLocations = (currentBattleLocation?.connections || [])
      .map((locationId: string) => getWorldLocationById(worldData, locationId))
      .filter(Boolean) as WorldLocation[];
    const battleTitle = explorationCombatReturn && getCurrentLocation()?.name ? `⚔️ ${getCurrentLocation()?.name}` : 'Arena';
    const primaryCombatants = Object.entries(players).filter(([, player]) => !player.character?.isNpcAlly);
    const followerPlayers = Object.entries(players).filter(([, player]) => !!player.character?.isNpcAlly);
    const combatantCount = primaryCombatants.length;
    const lockedCount = primaryCombatants.filter(([, player]) => player.lockedIn).length;
    const battleSendBlockReason = getBattleSendBlockReason();

    return (
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        <div className="p-2 bg-white border-b border-duo-gray flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2">
            <h1 className="font-black text-sm text-duo-text truncate">{battleTitle}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSettingsPage('debug');
                setShowSettings(true);
              }}
              className="rounded-full bg-duo-gray/70 p-1.5 text-duo-gray-dark hover:text-duo-text"
              aria-label="Open battle debug settings"
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowBattleMeta(prev => !prev)}
              className="rounded-full bg-duo-gray/70 p-1.5 text-duo-gray-dark hover:text-duo-text"
              aria-label={showBattleMeta ? 'Hide battle details' : 'Show battle details'}
            >
              {showBattleMeta ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {renderMinimap()}
          </div>
        </div>

        <div className="px-2 py-1.5 bg-white border-b border-duo-gray flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
            {lockedCount}/{combatantCount} locked
          </span>
          <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-blue-50 text-duo-blue border border-blue-200">
            {battleConnectedLocations.length} routes
          </span>
          {battleError && (
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
              Judge issue
            </span>
          )}
        </div>

        {followerPlayers.length > 0 && (
          <div className="px-2 py-2 bg-white border-b border-duo-gray space-y-2">
            {followerPlayers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-black uppercase text-duo-gray-dark">Followers</span>
                {followerPlayers.map(([id, player]) => {
                  const isTyping = roomTypingIds.includes(id) || localRoomTypingIds.includes(id);
                  const status = allyActedIds.includes(id)
                    ? { label: 'Acted', className: 'bg-green-100 text-green-700 border-green-200' }
                    : isTyping
                      ? { label: 'Typing', className: 'bg-blue-50 text-duo-blue border-blue-200' }
                      : player.lockedIn
                        ? { label: 'Locked', className: 'bg-yellow-50 text-yellow-700 border-yellow-200' }
                        : { label: 'Ready', className: 'bg-gray-100 text-duo-gray-dark border-gray-200' };

                  return (
                    <span key={id} className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${status.className}`}>
                      {player.character.name}: {status.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {showBattleMeta && (
          <div className="px-2 py-2 bg-white border-b border-duo-gray space-y-2">
            {battleConnectedLocations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {battleConnectedLocations.map(location => (
                  <button
                    key={location.id}
                    onClick={() => handleBattleMapMove(location.id)}
                    disabled={isLockedIn}
                    className="text-[10px] font-bold bg-duo-blue/10 text-duo-blue border border-duo-blue/20 rounded-lg px-2 py-1 hover:bg-duo-blue/20 transition-colors disabled:opacity-50"
                  >
                    ↔ {location.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black text-yellow-700 uppercase">Turn</span>
              {Object.keys(players).map(id => {
                const player = players[id];
                const isMe = id === socket.id;
                const isLocked = player.lockedIn;
                const isTyping = !isLocked && id !== socket.id && (roomTypingIds.includes(id) || localRoomTypingIds.includes(id));
                return (
                  <span key={id} className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${isLocked ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                    {isLocked ? '🔒' : isTyping ? <TypingDots className="mx-0.5 align-middle" dotClassName="h-1.5 w-1.5" /> : '⏳'} {isMe ? 'You' : player.character.name}
                  </span>
                );
              })}
            </div>
            {Object.keys(explorationState.inventory).length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[9px] font-black text-duo-gray-dark">🎒</span>
                {Object.entries(explorationState.inventory).map(([item, qty]) => (
                  <span key={item} className="text-[9px] font-bold bg-duo-gray rounded-full px-1.5 py-0.5 text-duo-gray-dark">
                    {item}({qty})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 relative min-h-0">
          <div ref={battleScrollContainerRef} onScroll={handleBattleLogScroll} onWheelCapture={pauseBattleAutoScrollOnIntent} onTouchStart={pauseBattleAutoScrollOnIntent} className="h-full overflow-y-auto p-3 space-y-3">
            {battleLogs.map((log, i) => {
            const isStreamingThoughts = log.startsWith(BATTLE_STREAM_THOUGHTS_PREFIX);
            const isStreamingAnswer = log.startsWith(BATTLE_STREAM_ANSWER_PREFIX);
            const isThoughts = log.startsWith("> **Judge's Thoughts:**") || isStreamingThoughts;
            const isStatusLog = log.startsWith('STATUS_');
            const isToolStatus = log.startsWith('STATUS_TOOL::');
            const isBattleRetryStatus = log.startsWith('STATUS_battle-retry::');
            const isImagePendingStatus = log.startsWith('STATUS_battle-image-pending::');
            const isImageCompleteStatus = log.startsWith('STATUS_battle-image-complete::');
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
                <div key={log} className="rounded-lg overflow-hidden border-2 border-duo-gray shadow-md my-2">
                  <img src={content} alt="Battle Scene" className="w-full" />
                </div>
              );
            }

            if (isToolStatus) {
              return (
                <div key={i} className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 shadow-sm">
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div className="font-semibold leading-relaxed">{content}</div>
                  </div>
                </div>
              );
            }

            if (isBattleRetryStatus) {
              return (
                <div key={i} className="flex justify-center">
                  <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-amber-300 bg-amber-100 px-3 py-2 text-[10px] text-amber-900 shadow-sm">
                    <span className="font-black uppercase tracking-[0.16em]">Battle Retry</span>
                    <span className="font-semibold normal-case">{content}</span>
                    {battleRetryRestartAvailable && roomId && (
                      <button
                        type="button"
                        onClick={() => {
                          setBattleRetryRestartAvailable(false);
                          setBattle503RetryAttempt(0);
                          setBattleError(null);
                          clearBattleStatusLog('battle-retry');
                          socket.emit('restartBattleRetryWindow');
                        }}
                        className="inline-flex items-center rounded-full border border-amber-500 bg-amber-200 px-2.5 py-1 font-black uppercase text-amber-950 shadow-sm"
                      >
                        Retry Battle For 2m
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            if (isImagePendingStatus) {
              return (
                <div
                  key={i}
                  className="group w-full rounded-xl border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 shadow-sm"
                  onClick={() => {
                    if (isCoarsePointerDevice() && !battleImageSkipHintVisible) {
                      setBattleImageSkipHintVisible(true);
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 font-semibold min-w-0">
                      <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                      <span className="truncate">{content}</span>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        handleSkipBattleImageWait();
                      }}
                      className={`${battleImageSkipHintVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity rounded-full border border-yellow-400 bg-white/80 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-yellow-800`}
                    >
                      Don't use image
                    </button>
                  </div>
                </div>
              );
            }

            if (isImageCompleteStatus) {
              return (
                <div key={i} className="w-full rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800 shadow-sm">
                  <div className="flex items-center gap-2 font-semibold">
                    <Check className="w-4 h-4 flex-shrink-0" />
                    <span>{content}</span>
                  </div>
                </div>
              );
            }

            if (isStatusLog) {
              return (
                <div key={i} className="flex justify-start">
                  <div className="chat-bubble-them max-w-[85%]">
                    <div className="markdown-body text-sm">
                      <SafeMarkdown>{content}</SafeMarkdown>
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
                    <SafeMarkdown>{content}</SafeMarkdown>
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
                      <SafeMarkdown>{cleanContent}</SafeMarkdown>
                    </div>
                  )}
                </div>
              );
            }

            if (!content.trim() && (isStreamingAnswer || isStreamingThoughts)) return null;

            if (isPendingPlayerAction) {
              return (
                <div key={i} className="flex justify-end w-full">
                  <div className="flex items-start gap-2 w-[82%] max-w-[82%] flex-row-reverse">
                    <div className="w-7 h-7 rounded-full bg-duo-green flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 overflow-hidden">
                      {character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full object-cover" /> : character?.name?.charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="w-full min-w-0">
                      <span className="text-[10px] font-bold text-duo-gray-dark block text-right">Queued Action</span>
                      <div className="chat-bubble-me w-full">
                        <div className="markdown-body text-sm">
                          <SafeMarkdown>{content}</SafeMarkdown>
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
                        <div className={`flex items-start gap-2 w-[82%] max-w-[82%] ${isMyAction ? 'flex-row-reverse' : ''}`}>
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-black flex-shrink-0 ${isMyAction ? 'bg-duo-green' : 'bg-duo-blue'}`}>
                            {isMyAction && character?.imageUrl ? <img src={character.imageUrl} className="w-full h-full rounded-full object-cover" /> : pName.charAt(0).toUpperCase()}
                          </div>
                          <div className="w-full min-w-0">
                            {!isMyAction && <span className="text-[10px] font-bold text-duo-gray-dark">{pName}</span>}
                            <div className={isMyAction ? 'chat-bubble-me w-full' : 'chat-bubble-them w-full'}>
                              <div className="markdown-body text-sm">
                                <SafeMarkdown>{pAction}</SafeMarkdown>
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
                  <SafeMarkdown>{content}</SafeMarkdown>
                  {isStreamingAnswer && <span className="inline-block w-2 h-4 ml-1 bg-duo-blue animate-pulse" />}
                </div>
              </div>
            );
            })}
            <div ref={battleEndRef} />
          </div>
          {!battleAutoScroll && (
            <button
              onClick={resumeBattleAutoScroll}
              className="absolute bottom-3 right-3 rounded-full bg-duo-blue text-white px-3 py-1.5 text-[10px] font-black uppercase shadow-lg"
            >
              Jump to latest
            </button>
          )}
        </div>

        <div className="p-2 bg-white border-t border-duo-gray space-y-1.5 composer-safe">
          {battleSendBlockReason && battleInput.trim() && (
            <div className="text-[10px] font-black text-duo-gray-dark uppercase px-1">
              {battleSendBlockReason}
            </div>
          )}
          <div className="flex gap-2">
          <textarea
            ref={battleInputRef}
            value={battleInput}
            onChange={(e) => {
              setBattleInput(e.target.value);
              updateTypingPresence('battle', e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendBattleAction();
              }
            }}
            placeholder={isLockedIn ? "Action locked..." : "Your move?"}
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
              disabled={!!battleSendBlockReason}
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
    const isBattleMap = gameState === 'battle' && (
      battleMapState.discoveredLocations.length > 0 ||
      battleMapState.players.length > 0 ||
      battleMapState.npcs.length > 0
    );
    const activeBattlePlayer = isBattleMap
      ? battleMapState.players.find(player => player.id === socket.id)
      : null;
    const activePosition = activeBattlePlayer || {
      locationId: explorationState.locationId,
      x: explorationState.x,
      y: explorationState.y,
    };
    const activeLocationId = activePosition.locationId ?? explorationState.locationId;
    const currentLoc = worldData.locations.find((loc: WorldLocation) => loc.id === activeLocationId) ?? getCurrentLocation();
    const spawnLocationId = !isBattleMap
      ? spawnMarker?.locationId || explorationState.discoveredLocations[0] || null
      : null;
    const fallbackSpawnLocation = spawnLocationId ? getWorldLocationById(worldData, spawnLocationId) : null;
    const effectiveSpawnMarker = !isBattleMap && spawnLocationId
      ? {
          locationId: spawnLocationId,
          x: spawnMarker?.x ?? fallbackSpawnLocation?.x ?? 0,
          y: spawnMarker?.y ?? fallbackSpawnLocation?.y ?? 0,
        }
      : null;
    const gridSize = worldData.meta.gridSize;
    const mapW = 140;
    const mapH = 140;
    const fullMapW = window.innerWidth - 32;
    const fullMapH = window.innerHeight - 32;

    const miniScaleX = mapW / gridSize.width;
    const miniScaleY = mapH / gridSize.height;
    const fullScaleX = fullMapW / gridSize.width;
    const fullScaleY = fullMapH / gridSize.height;
    const currentMapX = typeof activePosition.x === 'number' && Number.isFinite(activePosition.x)
      ? activePosition.x
      : currentLoc?.x ?? gridSize.width / 2;
    const currentMapY = typeof activePosition.y === 'number' && Number.isFinite(activePosition.y)
      ? activePosition.y
      : currentLoc?.y ?? gridSize.height / 2;
    const playerPixelX = currentMapX * miniScaleX;
    const playerPixelY = currentMapY * miniScaleY;
    const miniOffsetX = mapW / 2 - playerPixelX;
    const miniOffsetY = mapH / 2 - playerPixelY;
    const centerFullMapOnCurrentPosition = (zoom: number) => {
      const containerW = window.innerWidth - 32;
      const containerH = window.innerHeight - 32;
      setMapPan({
        x: containerW / 2 - currentMapX * (containerW / gridSize.width) * zoom,
        y: containerH / 2 - currentMapY * (containerH / gridSize.height) * zoom,
      });
    };

    const discoveredLocationIds = isBattleMap ? battleMapState.discoveredLocations : explorationState.discoveredLocations;
    const connectedLocationIds = new Set(currentLoc?.connections || []);
    const discoveredLocations = worldData.locations.filter((loc: WorldLocation) => discoveredLocationIds.includes(loc.id));
    const visibleNpcs = (isBattleMap ? battleMapState.npcs : worldNpcs)
      .filter(npc => discoveredLocationIds.includes(npc.locationId) || npc.followTargetId === socket.id);
    const visiblePlayers = (isBattleMap ? battleMapState.players : worldPlayers)
      .filter(player => player.id !== socket.id);
    const localPlayerLabel = 'You';
    const miniSelfAnchorX = currentMapX * miniScaleX;
    const miniSelfAnchorY = currentMapY * miniScaleY;
    const fullSelfAnchorX = currentMapX * fullScaleX;
    const fullSelfAnchorY = currentMapY * fullScaleY;

    const miniMarkerLayouts = layoutRepelledMarkers([
      ...discoveredLocations.map((loc: WorldLocation) => ({
        id: `mini-loc-${loc.id}`,
        anchorX: loc.x * miniScaleX,
        anchorY: loc.y * miniScaleY,
        width: estimateMarkerLabelWidth(loc.name, 16, 44, 3.1),
        height: 14,
      })),
      ...visibleNpcs.map(npc => ({
        id: `mini-npc-${npc.id}`,
        anchorX: npc.x * miniScaleX,
        anchorY: npc.y * miniScaleY,
        width: estimateMarkerLabelWidth(npc.name, 18, 54, 3.6),
        height: 14,
      })),
      ...visiblePlayers.map(player => ({
        id: `mini-player-${player.id}`,
        anchorX: player.x * miniScaleX,
        anchorY: player.y * miniScaleY,
        width: estimateMarkerLabelWidth(player.name, 20, 58, 3.8),
        height: 14,
      })),
      {
        id: 'mini-self',
        anchorX: miniSelfAnchorX,
        anchorY: miniSelfAnchorY,
        width: estimateMarkerLabelWidth(localPlayerLabel, 24, 60, 4.1),
        height: 16,
      },
      ...discoveredLocations.map((loc: WorldLocation) => ({
        id: `mini-loc-obstacle-${loc.id}`,
        anchorX: loc.x * miniScaleX,
        anchorY: loc.y * miniScaleY,
        width: loc.id === spawnLocationId ? 12 : 8,
        height: loc.id === spawnLocationId ? 12 : 8,
        fixed: true,
      })),
      ...visibleNpcs.map(npc => ({
        id: `mini-npc-obstacle-${npc.id}`,
        anchorX: npc.x * miniScaleX,
        anchorY: npc.y * miniScaleY,
        width: 8,
        height: 8,
        fixed: true,
      })),
      ...visiblePlayers.map(player => ({
        id: `mini-player-obstacle-${player.id}`,
        anchorX: player.x * miniScaleX,
        anchorY: player.y * miniScaleY,
        width: 8,
        height: 8,
        fixed: true,
      })),
      {
        id: 'mini-self-obstacle',
        anchorX: miniSelfAnchorX,
        anchorY: miniSelfAnchorY,
        width: 10,
        height: 10,
        fixed: true,
      },
      ...(effectiveSpawnMarker ? [{
        id: 'mini-spawn-target-obstacle',
        anchorX: effectiveSpawnMarker.x * miniScaleX,
        anchorY: effectiveSpawnMarker.y * miniScaleY - 6,
        width: 12,
        height: 12,
        fixed: true,
      }] : []),
    ], { width: mapW, height: mapH });

    const fullMarkerLayouts = layoutRepelledMarkers([
      ...discoveredLocations.map((loc: WorldLocation) => ({
        id: `full-loc-${loc.id}`,
        anchorX: loc.x * fullScaleX,
        anchorY: loc.y * fullScaleY,
        width: estimateMarkerLabelWidth(loc.name, 44, 150, 6.8),
        height: 26,
      })),
      ...visibleNpcs.map(npc => ({
        id: `full-npc-${npc.id}`,
        anchorX: npc.x * fullScaleX,
        anchorY: npc.y * fullScaleY,
        width: estimateMarkerLabelWidth(npc.name, 40, 130, 6.3),
        height: 22,
      })),
      ...visiblePlayers.map(player => ({
        id: `full-player-${player.id}`,
        anchorX: player.x * fullScaleX,
        anchorY: player.y * fullScaleY,
        width: estimateMarkerLabelWidth(player.name, 36, 120, 6.1),
        height: 20,
      })),
      {
        id: 'full-self',
        anchorX: fullSelfAnchorX,
        anchorY: fullSelfAnchorY,
        width: estimateMarkerLabelWidth(localPlayerLabel, 54, 126, 7.2),
        height: 24,
      },
      ...discoveredLocations.map((loc: WorldLocation) => ({
        id: `full-loc-obstacle-${loc.id}`,
        anchorX: loc.x * fullScaleX,
        anchorY: loc.y * fullScaleY,
        width: loc.id === spawnLocationId ? 18 : 12,
        height: loc.id === spawnLocationId ? 18 : 12,
        fixed: true,
      })),
      ...visibleNpcs.map(npc => ({
        id: `full-npc-obstacle-${npc.id}`,
        anchorX: npc.x * fullScaleX,
        anchorY: npc.y * fullScaleY,
        width: 12,
        height: 12,
        fixed: true,
      })),
      ...visiblePlayers.map(player => ({
        id: `full-player-obstacle-${player.id}`,
        anchorX: player.x * fullScaleX,
        anchorY: player.y * fullScaleY,
        width: 12,
        height: 12,
        fixed: true,
      })),
      {
        id: 'full-self-obstacle',
        anchorX: fullSelfAnchorX,
        anchorY: fullSelfAnchorY,
        width: 16,
        height: 16,
        fixed: true,
      },
      ...(effectiveSpawnMarker ? [{
        id: 'full-spawn-target-obstacle',
        anchorX: effectiveSpawnMarker.x * fullScaleX,
        anchorY: effectiveSpawnMarker.y * fullScaleY - 20,
        width: 22,
        height: 22,
        fixed: true,
      }] : []),
    ], { width: fullMapW, height: fullMapH });
    const miniSelfLayout = miniMarkerLayouts['mini-self'] || { x: miniSelfAnchorX, y: miniSelfAnchorY };
    const fullSelfLayout = fullMarkerLayouts['full-self'] || { x: fullSelfAnchorX, y: fullSelfAnchorY };

    const renderMarkerConnector = (anchorX: number, anchorY: number, x: number, y: number, color: string, thickness = 1) => {
      const dx = x - anchorX;
      const dy = y - anchorY;
      const distance = Math.hypot(dx, dy);
      if (distance < 6) return null;

      return (
        <div
          className="absolute pointer-events-none"
          style={{
            left: anchorX,
            top: anchorY,
            width: distance,
            height: thickness,
            backgroundColor: color,
            opacity: 0.55,
            transformOrigin: '0 50%',
            transform: `translateY(-50%) rotate(${Math.atan2(dy, dx)}rad)`,
          }}
        />
      );
    };

    return (
      <div className="relative" style={{ width: mapW, height: mapH }}>
        {/* Small minimap (always visible as click target) */}
        {!showFullMap && (
          <div 
            className="bg-blue-900/80 rounded-xl border-2 border-duo-gray overflow-hidden relative cursor-pointer"
            style={{ width: mapW, height: mapH }}
            onClick={() => {
              if (worldData?.meta?.gridSize) {
                mapZoomRef.current = 1;
                setMapZoom(1);
                centerFullMapOnCurrentPosition(1);
              }
              setShowFullMap(true);
            }}
          >
            <div style={{ transform: `translate(${miniOffsetX}px, ${miniOffsetY}px)`, position: 'absolute', inset: 0 }}>
            {worldData.islands.map((island: any) => {
              return (
                <div key={island.id} className="absolute rounded opacity-40" style={{
                  left: island.bounds.x * miniScaleX, top: island.bounds.y * miniScaleY,
                  width: island.bounds.width * miniScaleX, height: island.bounds.height * miniScaleY,
                  backgroundColor: island.biome === 'volcanic' ? '#8B4513' : island.biome === 'enchanted_forest' ? '#2d5a27' : island.biome === 'coral_reef' ? '#00CED1' : '#228B22',
                }}>
                  <span className="absolute inset-0 flex items-center justify-center text-[4px] font-black text-white/60 pointer-events-none whitespace-nowrap overflow-hidden">{island.name}</span>
                </div>
              );
            })}
            {discoveredLocations.map((loc: WorldLocation) => {
              const anchorX = loc.x * miniScaleX;
              const anchorY = loc.y * miniScaleY;
              const layout = miniMarkerLayouts[`mini-loc-${loc.id}`] || { x: anchorX, y: anchorY };
              const isCurrent = loc.id === activeLocationId;
              const isSpawn = loc.id === spawnLocationId;
              return (
                <React.Fragment key={loc.id}>
                  {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, isCurrent ? 'rgba(250, 204, 21, 0.75)' : 'rgba(255, 255, 255, 0.45)')}
                  <div
                    className={`absolute rounded-full pointer-events-none ${isCurrent ? 'bg-yellow-400' : 'bg-white/70'}`}
                    style={{ left: anchorX, top: anchorY, width: isSpawn ? 4 : 3, height: isSpawn ? 4 : 3, transform: 'translate(-50%, -50%)' }}
                  />
                  <div
                    className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out"
                    style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}
                    title={loc.name}
                  >
                    <span className="text-[5px] leading-none">{getLocationMarkerGlyph(loc.type)}</span>
                    <span className="text-[4px] font-black whitespace-nowrap text-white/80">{loc.name}</span>
                  </div>
                </React.Fragment>
              );
            })}
            {effectiveSpawnMarker && (
              <Target
                className="absolute w-3 h-3 text-duo-green pointer-events-none"
                style={{
                  left: effectiveSpawnMarker.x * miniScaleX,
                  top: effectiveSpawnMarker.y * miniScaleY - 6,
                  transform: 'translate(-50%, -50%)',
                }}
              />
            )}
            {visibleNpcs.map(npc => {
              const anchorX = npc.x * miniScaleX;
              const anchorY = npc.y * miniScaleY;
              const layout = miniMarkerLayouts[`mini-npc-${npc.id}`] || { x: anchorX, y: anchorY };
              return (
                <React.Fragment key={npc.id}>
                  {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, 'rgba(250, 204, 21, 0.65)')}
                  <div
                    className="absolute rounded-full bg-yellow-200/80 pointer-events-none"
                    style={{ left: anchorX, top: anchorY, width: 3, height: 3, transform: 'translate(-50%, -50%)' }}
                  />
                  <div
                    className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out"
                    style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}
                    title={npc.name}
                  >
                    <span className="text-[6px] leading-none">{getNpcRoleEmoji(npc.role)}</span>
                    <span className="text-[5px] font-bold text-yellow-200 whitespace-nowrap">{npc.name}</span>
                  </div>
                </React.Fragment>
              );
            })}
            {visiblePlayers.map(player => {
              const anchorX = player.x * miniScaleX;
              const anchorY = player.y * miniScaleY;
              const layout = miniMarkerLayouts[`mini-player-${player.id}`] || { x: anchorX, y: anchorY };
              return (
                <React.Fragment key={player.id}>
                  {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, 'rgba(59, 130, 246, 0.65)')}
                  <div
                    className="absolute rounded-full bg-duo-blue pointer-events-none"
                    style={{ left: anchorX, top: anchorY, width: 3, height: 3, transform: 'translate(-50%, -50%)' }}
                  />
                  <div
                    className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out"
                    style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}
                  >
                    <div className="rounded-full bg-duo-blue" style={{ width: 4, height: 4 }} />
                    <span className="text-[5px] font-bold text-duo-blue whitespace-nowrap">{player.name}</span>
                  </div>
                </React.Fragment>
              );
            })}
            <React.Fragment>
              {renderMarkerConnector(miniSelfAnchorX, miniSelfAnchorY, miniSelfLayout.x, miniSelfLayout.y, 'rgba(34, 197, 94, 0.85)', 1.2)}
              <div
                className="absolute rounded-full border border-white/90 bg-duo-green shadow-sm pointer-events-none"
                style={{ left: miniSelfAnchorX, top: miniSelfAnchorY, width: 4, height: 4, transform: 'translate(-50%, -50%)' }}
              />
              <div
                className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out"
                style={{ left: miniSelfLayout.x, top: miniSelfLayout.y, transform: 'translate(-50%, -50%)' }}
              >
                <span className="rounded-full border border-white/80 bg-duo-green px-1.5 py-[1px] text-[4px] font-black uppercase tracking-[0.16em] text-white shadow-sm whitespace-nowrap">
                  {localPlayerLabel}
                </span>
              </div>
            </React.Fragment>
            </div>
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
          <div className="fixed inset-0 z-50 bg-black/60" onClick={closeFullMap}>
            <button onClick={closeFullMap} className="absolute top-4 right-4 z-[60] bg-white rounded-full p-2 shadow-xl border border-duo-gray">
              <X className="w-5 h-5" />
            </button>
            <div 
              className="absolute inset-4 bg-blue-900/95 rounded-3xl border-2 border-duo-gray overflow-hidden"
              style={{ touchAction: 'none' }}
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const oldZoom = mapZoomRef.current;
                const newZoom = Math.min(5, Math.max(0.5, oldZoom + (e.deltaY > 0 ? -0.15 : 0.15)));
                const scale = newZoom / oldZoom;
                mapZoomRef.current = newZoom;
                setMapZoom(newZoom);
                setMapPan(p => ({
                  x: mouseX - scale * (mouseX - p.x),
                  y: mouseY - scale * (mouseY - p.y)
                }));
              }}
              onPointerDown={(e) => {
                // Track active pointers for pinch-zoom
                const el = e.currentTarget as HTMLElement;
                if (!el.dataset.pointers) el.dataset.pointers = '{}';
                const pointers: Record<string, {x: number; y: number}> = JSON.parse(el.dataset.pointers);
                pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
                el.dataset.pointers = JSON.stringify(pointers);
                el.dataset.lastPinchDist = '';
                mapDragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
                // Skip setPointerCapture for touch — Safari blocks second pointer
                if (e.pointerType !== 'touch') el.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const el = e.currentTarget as HTMLElement;
                const pointers: Record<string, {x: number; y: number}> = JSON.parse(el.dataset.pointers || '{}');
                pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
                el.dataset.pointers = JSON.stringify(pointers);
                const pts = Object.values(pointers);
                if (pts.length >= 2) {
                  // Pinch zoom + 2-finger pan
                  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                  const midX = (pts[0].x + pts[1].x) / 2;
                  const midY = (pts[0].y + pts[1].y) / 2;
                  const lastDist = parseFloat(el.dataset.lastPinchDist || '');
                  const lastMidX = parseFloat(el.dataset.lastPinchMidX || '');
                  const lastMidY = parseFloat(el.dataset.lastPinchMidY || '');
                  if (lastDist && lastDist > 0) {
                    // Clamp scale to prevent abrupt jumps
                    const rawScale = dist / lastDist;
                    const scale = Math.min(1.08, Math.max(0.92, rawScale));
                    const rect = el.getBoundingClientRect();
                    const cx = midX - rect.left;
                    const cy = midY - rect.top;
                    const oldZoom = mapZoomRef.current;
                    const newZoom = Math.min(5, Math.max(0.5, oldZoom * scale));
                    const s = newZoom / oldZoom;
                    mapZoomRef.current = newZoom;
                    setMapZoom(newZoom);
                    // Apply both zoom pivot and 2-finger pan delta
                    const panDx = lastMidX ? midX - lastMidX : 0;
                    const panDy = lastMidY ? midY - lastMidY : 0;
                    setMapPan(p => ({ x: cx - s * (cx - p.x) + panDx, y: cy - s * (cy - p.y) + panDy }));
                  }
                  el.dataset.lastPinchDist = String(dist);
                  el.dataset.lastPinchMidX = String(midX);
                  el.dataset.lastPinchMidY = String(midY);
                  return;
                }
                if (!mapDragRef.current.dragging) return;
                const dx = e.clientX - mapDragRef.current.lastX;
                const dy = e.clientY - mapDragRef.current.lastY;
                mapDragRef.current.lastX = e.clientX;
                mapDragRef.current.lastY = e.clientY;
                setMapPan(p => ({ x: p.x + dx, y: p.y + dy }));
              }}
              onPointerUp={(e) => {
                const el = e.currentTarget as HTMLElement;
                const pointers: Record<string, {x: number; y: number}> = JSON.parse(el.dataset.pointers || '{}');
                delete pointers[e.pointerId];
                el.dataset.pointers = JSON.stringify(pointers);
                el.dataset.lastPinchDist = '';
                el.dataset.lastPinchMidX = '';
                el.dataset.lastPinchMidY = '';
                const remaining = Object.values(pointers);
                if (remaining.length === 1) {
                  // Transition from pinch to single-finger drag: reset drag origin to avoid snap
                  mapDragRef.current = { dragging: true, lastX: remaining[0].x, lastY: remaining[0].y };
                } else if (remaining.length === 0) {
                  mapDragRef.current.dragging = false;
                }
              }}
              onPointerCancel={(e) => {
                const el = e.currentTarget as HTMLElement;
                const pointers: Record<string, {x: number; y: number}> = JSON.parse(el.dataset.pointers || '{}');
                delete pointers[e.pointerId];
                el.dataset.pointers = JSON.stringify(pointers);
                el.dataset.lastPinchDist = '';
                el.dataset.lastPinchMidX = '';
                el.dataset.lastPinchMidY = '';
                const remaining = Object.values(pointers);
                if (remaining.length === 1) {
                  mapDragRef.current = { dragging: true, lastX: remaining[0].x, lastY: remaining[0].y };
                } else if (remaining.length === 0) {
                  mapDragRef.current.dragging = false;
                }
              }}
            >
              <div className="absolute top-2 left-2 z-10 flex gap-1">
                <button onClick={() => setMapZoom(z => { const v = Math.min(5, z + 0.3); mapZoomRef.current = v; return v; })} className="bg-white/90 rounded-full w-7 h-7 text-sm font-black text-blue-900 shadow">+</button>
                <button onClick={() => setMapZoom(z => { const v = Math.max(0.5, z - 0.3); mapZoomRef.current = v; return v; })} className="bg-white/90 rounded-full w-7 h-7 text-sm font-black text-blue-900 shadow">−</button>
                <button onClick={() => {
                  if (gridSize) {
                    centerFullMapOnCurrentPosition(mapZoom);
                  }
                }} className="bg-white/90 rounded-full px-2 h-7 text-[10px] font-bold text-blue-900 shadow flex items-center gap-1">
                  <Target className="w-3 h-3" /> Center
                </button>
              </div>
              {/* Pannable/zoomable content */}
              <div style={{ transform: `translate(${mapPan.x}px, ${mapPan.y}px) scale(${mapZoom})`, transformOrigin: '0 0', position: 'absolute', inset: 0 }}>
                {/* Islands */}
                {worldData.islands.map((island: any) => {
                  return (
                    <div key={island.id} className="absolute rounded opacity-30" style={{
                      left: island.bounds.x * fullScaleX, top: island.bounds.y * fullScaleY,
                      width: island.bounds.width * fullScaleX, height: island.bounds.height * fullScaleY,
                      backgroundColor: island.biome === 'volcanic' ? '#8B4513' : island.biome === 'enchanted_forest' ? '#2d5a27' : island.biome === 'coral_reef' ? '#00CED1' : '#228B22',
                    }}>
                      <span className="absolute inset-0 flex items-center justify-center text-[20px] font-black text-white/40 pointer-events-none whitespace-nowrap">{island.name}</span>
                    </div>
                  );
                })}
                {discoveredLocations.map((loc: WorldLocation) => {
                  const anchorX = loc.x * fullScaleX;
                  const anchorY = loc.y * fullScaleY;
                  const layout = fullMarkerLayouts[`full-loc-${loc.id}`] || { x: anchorX, y: anchorY };
                  const isCurrent = loc.id === activeLocationId;
                  const isSpawn = loc.id === spawnLocationId;
                  const isConnected = connectedLocationIds.has(loc.id);
                  return (
                    <React.Fragment key={loc.id}>
                      {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, isCurrent || isConnected ? 'rgba(250, 204, 21, 0.75)' : 'rgba(255, 255, 255, 0.4)', 1.5)}
                      <div className="absolute" style={{ left: anchorX, top: anchorY, transform: 'translate(-50%, -50%)' }}>
                        {isSpawn && (
                          <Target className="w-5 h-5 text-duo-green animate-pulse mb-0.5 -translate-x-1/2 -translate-y-full absolute left-1/2 top-0" />
                        )}
                        <div
                          className={`rounded-full cursor-pointer transition-all ${isCurrent || isConnected ? 'bg-yellow-400 hover:bg-yellow-300' : 'bg-white/60'}`}
                          style={{ width: isSpawn ? 10 : 8, height: isSpawn ? 10 : 8 }}
                          onClick={() => {
                            if (!isCurrent && isConnected) {
                              if (isBattleMap) {
                                handleBattleMapMove(loc.id);
                              } else {
                                handleExplorationMove(loc.id);
                              }
                              closeFullMap();
                            }
                          }}
                        />
                      </div>
                      <div className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out" style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}>
                        <span className="text-[8px] font-bold whitespace-nowrap text-white/80">
                          {getLocationMarkerGlyph(loc.type)} {loc.name}
                        </span>
                        {(loc.npcs?.length > 0 || loc.enemies?.length > 0) && (
                          <span className="text-[8px] font-bold whitespace-nowrap">
                            {loc.npcs?.length > 0 && <span className="text-yellow-300/80">👤{loc.npcs.length} NPC{loc.npcs.length > 1 ? 's' : ''} </span>}
                            {loc.enemies?.length > 0 && <span className="text-red-400/80">⚔️{loc.enemies.length} Enem{loc.enemies.length > 1 ? 'ies' : 'y'}</span>}
                          </span>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
                {effectiveSpawnMarker && (
                  <Target
                    className="absolute w-5 h-5 text-duo-green animate-pulse pointer-events-none"
                    style={{
                      left: effectiveSpawnMarker.x * fullScaleX,
                      top: effectiveSpawnMarker.y * fullScaleY - 20,
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                )}
                {visibleNpcs.map(npc => {
                  const anchorX = npc.x * fullScaleX;
                  const anchorY = npc.y * fullScaleY;
                  const layout = fullMarkerLayouts[`full-npc-${npc.id}`] || { x: anchorX, y: anchorY };
                  return (
                    <React.Fragment key={npc.id}>
                      {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, 'rgba(250, 204, 21, 0.7)', 1.5)}
                      <div className="absolute rounded-full bg-yellow-200/80" style={{ left: anchorX, top: anchorY, width: 5, height: 5, transform: 'translate(-50%, -50%)' }} />
                      <div className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out" style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}>
                        <div className="text-sm">{getNpcRoleEmoji(npc.role)}</div>
                        <span className="text-[8px] font-bold mt-0.5 whitespace-nowrap text-yellow-200">{npc.name}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
                {visiblePlayers.map(player => {
                  const anchorX = player.x * fullScaleX;
                  const anchorY = player.y * fullScaleY;
                  const layout = fullMarkerLayouts[`full-player-${player.id}`] || { x: anchorX, y: anchorY };
                  return (
                    <React.Fragment key={player.id}>
                      {renderMarkerConnector(anchorX, anchorY, layout.x, layout.y, 'rgba(59, 130, 246, 0.7)', 1.5)}
                      <div className="absolute rounded-full bg-duo-blue" style={{ left: anchorX, top: anchorY, width: 6, height: 6, transform: 'translate(-50%, -50%)' }} />
                      <div className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out" style={{ left: layout.x, top: layout.y, transform: 'translate(-50%, -50%)' }}>
                        <div className="rounded-full bg-duo-blue" style={{ width: 6, height: 6 }} />
                        <span className="text-[7px] font-bold text-duo-blue mt-0.5 whitespace-nowrap">{player.name}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
                <React.Fragment>
                  {renderMarkerConnector(fullSelfAnchorX, fullSelfAnchorY, fullSelfLayout.x, fullSelfLayout.y, 'rgba(34, 197, 94, 0.9)', 2)}
                  <div
                    className="absolute rounded-full border-2 border-white bg-duo-green shadow-lg"
                    style={{ left: fullSelfAnchorX, top: fullSelfAnchorY, width: 8, height: 8, transform: 'translate(-50%, -50%)' }}
                  />
                  <div
                    className="absolute flex flex-col items-center pointer-events-none transition-all duration-300 ease-out"
                    style={{ left: fullSelfLayout.x, top: fullSelfLayout.y, transform: 'translate(-50%, -50%)' }}
                  >
                    <span className="rounded-full border border-white/80 bg-duo-green px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.18em] text-white shadow-lg whitespace-nowrap">
                      {localPlayerLabel}
                    </span>
                  </div>
                </React.Fragment>
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

  const renderSurvivalBars = () => {
    const survivalNeedsAttention = explorationState.hunger < 75 || explorationState.thirst < 75 || explorationState.stamina < 75;
    const shouldExpand = showSurvivalDetails || survivalNeedsAttention;

    if (!shouldExpand) {
      return (
        <button
          onClick={() => setShowSurvivalDetails(true)}
          className="w-full flex items-center justify-between gap-3 px-3 py-1.5 bg-gray-50 border-b border-duo-gray text-left"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-black uppercase text-duo-gray-dark">Survival Stable</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-duo-gray text-duo-gray-dark">🍖 {explorationState.hunger}</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-duo-gray text-duo-gray-dark">💧 {explorationState.thirst}</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-duo-gray text-duo-gray-dark">⚡ {explorationState.stamina}</span>
          </div>
          <ChevronDown className="w-4 h-4 text-duo-gray-dark" />
        </button>
      );
    }

    return (
      <div className="bg-gray-50 border-b border-duo-gray">
        <div className="flex items-center justify-between px-3 pt-1.5">
          <span className="text-[10px] font-black uppercase text-duo-gray-dark">Survival</span>
          {survivalNeedsAttention ? (
            <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
              Needs attention
            </span>
          ) : (
            <button onClick={() => setShowSurvivalDetails(false)} className="text-duo-gray-dark hover:text-duo-text">
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex gap-2 px-3 py-1.5">
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
      </div>
    );
  };

  const renderExploration = () => {
    const currentLoc = getCurrentLocation();
    const connected = getConnectedLocations();
    const activeExplorationThoughtId = activeExplorationStreamIdRef.current;
    const explorationEntries = explorationLog.filter(msg => msg.text.trim() !== '' || (msg.kind === 'thought' && msg.streamId === activeExplorationThoughtId));
    const nearbyPlayers = worldPlayers.filter(player => player.id !== socket.id && player.locationId === explorationState.locationId);
    const nearbyNpcs = worldNpcs.filter(npc => npc.locationId === explorationState.locationId);
    const activeFollowers = worldNpcs.filter(npc => npc.followTargetId === socket.id);
    const activeGoal = explorationState.goals[0] || 'No goals';

    return (
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        <div className="p-2 bg-white border-b border-duo-gray space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <button onClick={() => { setGameState('menu'); socket.emit('leaveExploration'); }} className="text-duo-gray-dark hover:text-duo-text">
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h2 className="text-sm font-black text-duo-text truncate">🗺️ {currentLoc?.name || 'Loading...'}</h2>
              </div>
              <div className="mt-1.5 flex gap-1 flex-wrap">
                <button 
                  onClick={() => {
                    setShowAllGoals(false);
                    setShowGoalsModal(true);
                  }}
                  className="flex items-center gap-1 bg-yellow-100 border border-yellow-300 rounded-full px-2 py-0.5 text-[9px] font-bold text-yellow-700 hover:bg-yellow-200 transition-colors"
                >
                  <Star className="w-3 h-3 fill-yellow-500 text-yellow-500" />
                  {activeGoal}
                </button>
                <button 
                  onClick={() => setShowInventory(true)}
                  className="flex items-center gap-1 bg-duo-gray/50 rounded-full px-2 py-0.5 text-[9px] font-bold text-duo-gray-dark hover:bg-duo-gray transition-colors"
                >
                  <Package className="w-3 h-3" />
                  {Object.keys(explorationState.inventory).length}
                </button>
                <button 
                  onClick={handleVisualizeScene}
                  disabled={isVisualizingScene}
                  className="flex items-center gap-1 bg-sky-100 border border-sky-200 rounded-full px-2 py-0.5 text-[9px] font-bold text-sky-700 hover:bg-sky-200 transition-colors disabled:opacity-50"
                >
                  {isVisualizingScene ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                  {isVisualizingScene ? 'Generating...' : 'Visualize'}
                </button>
                {activeFollowers.length > 0 && (
                  <button
                    onClick={() => setShowExplorationNearby(true)}
                    className="flex items-center gap-1 bg-green-100 border border-green-200 rounded-full px-2 py-0.5 text-[9px] font-bold text-duo-green-dark hover:bg-green-200 transition-colors"
                  >
                    <Users className="w-3 h-3" />
                    {activeFollowers.length} follower{activeFollowers.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowExplorationMeta(prev => !prev)}
                className="rounded-full bg-duo-gray/70 p-1.5 text-duo-gray-dark hover:text-duo-text"
                aria-label={showExplorationMeta ? 'Hide exploration details' : 'Show exploration details'}
              >
                {showExplorationMeta ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {(nearbyPlayers.length > 0 || nearbyNpcs.length > 0) && (
                <button
                  onClick={() => setShowExplorationNearby(prev => !prev)}
                  className={`rounded-full p-1.5 border ${showExplorationNearby ? 'bg-duo-blue/10 text-duo-blue border-duo-blue/20' : 'bg-duo-gray/70 text-duo-gray-dark border-transparent hover:text-duo-text'}`}
                  aria-label={showExplorationNearby ? 'Hide nearby characters' : 'Show nearby characters'}
                >
                  <Users className="w-4 h-4" />
                </button>
              )}
              {renderMinimap()}
            </div>
          </div>

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
            {connected.length === 0 && (
              <span className="text-[10px] font-bold bg-duo-gray rounded-lg px-2 py-1 text-duo-gray-dark">
                No routes
              </span>
            )}
          </div>

          {showExplorationMeta && (
            <div className="pt-1 border-t border-duo-gray/70 space-y-1.5">
              <p className="text-[10px] text-duo-gray-dark leading-relaxed">{currentLoc?.description || ''}</p>
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-green-50 text-duo-green-dark border border-duo-green/20">
                  {connected.length} routes
                </span>
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-blue-50 text-duo-blue border border-blue-200">
                  {nearbyPlayers.length} players
                </span>
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">
                  {nearbyNpcs.length} npcs
                </span>
                {activeFollowers.length > 0 && (
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-green-50 text-duo-green-dark border border-green-200">
                    followers: {activeFollowers.map(npc => npc.name).join(', ')}
                  </span>
                )}
                {(explorationState.equippedWeapon || explorationState.equippedArmor) && (
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-gray-100 text-duo-gray-dark border border-duo-gray">
                    {explorationState.equippedWeapon || explorationState.equippedArmor}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {renderSurvivalBars()}

        {showExplorationNearby && (nearbyPlayers.length > 0 || nearbyNpcs.length > 0) && (
          <div className="px-2 py-2 bg-white border-b border-duo-gray space-y-2">
            {nearbyPlayers.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-[9px] font-bold text-duo-gray-dark self-center">Players:</span>
                {nearbyPlayers.map(player => (
                  <button
                    key={player.id}
                    onClick={() => {
                      const draftedAction = `attack ${player.name}`;
                      setExplorationInput(draftedAction);
                      updateTypingPresence('exploration', draftedAction);
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
                    ⚔️ {player.name}
                    {player.typing && <TypingDots dotClassName="h-1.5 w-1.5" />}
                    {player.acting && <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" title="Acting..." />}
                  </button>
                ))}
              </div>
            )}
            {nearbyNpcs.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                <span className="text-[9px] font-bold text-duo-gray-dark self-center">NPCs:</span>
                {nearbyNpcs.map(npc => (
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
        )}

        {/* Exploration log */}
        <div className="flex-1 relative min-h-0">
          <div ref={explorationScrollContainerRef} onScroll={handleExplorationLogScroll} onWheelCapture={pauseExplorationAutoScrollOnIntent} onTouchStart={pauseExplorationAutoScrollOnIntent} className="h-full overflow-y-auto p-3 space-y-3">
            {explorationEntries.map((msg, i) => {
            const isOtherPlayer = msg.role === 'user' && msg.playerName;
            const isMe = msg.role === 'user' && !msg.playerName;
            const isThought = msg.kind === 'thought';
            const thoughtId = msg.streamId || `explore-thought-${i}`;
            const isStreamingThought = isThought && msg.streamId === activeExplorationThoughtId && isExplorationProcessing;
            return (
            <div key={i} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              {isThought ? (
                <div className="duo-card p-3 bg-duo-gray/20 border-dashed text-xs text-duo-text w-full">
                  <div
                    className="flex items-center gap-2 cursor-pointer select-none"
                    onClick={() => {
                      const next = new Set(expandedExplorationThoughts);
                      if (next.has(thoughtId)) next.delete(thoughtId);
                      else next.add(thoughtId);
                      setExpandedExplorationThoughts(next);
                    }}
                  >
                    <Loader2 className={`w-3 h-3 flex-shrink-0 ${isStreamingThought ? 'animate-spin' : ''}`} />
                    <span className="font-bold text-duo-gray-dark flex-1">{getThoughtTitle(msg.text)}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${expandedExplorationThoughts.has(thoughtId) ? 'rotate-180' : ''}`} />
                  </div>
                  {expandedExplorationThoughts.has(thoughtId) && msg.text.trim() && (
                    <div className="markdown-body mt-2 pt-2 border-t border-duo-gray/30">
                      <SafeMarkdown>{msg.text}</SafeMarkdown>
                    </div>
                  )}
                </div>
              ) : msg.role === 'system' ? (
                <div className="w-full">
                  <div className="text-center text-sm font-bold text-duo-blue bg-duo-blue/5 border border-duo-blue/10 rounded-lg py-2 px-4 my-1 markdown-body">
                    <SafeMarkdown>{msg.text}</SafeMarkdown>
                  </div>
                  <InlineMessageMedia message={msg} alt="Inline scene" />
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
                        <SafeMarkdown>{msg.text}</SafeMarkdown>
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
                      <SafeMarkdown>{msg.text}</SafeMarkdown>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={msg.role === 'model' ? 'chat-bubble-them' : 'chat-bubble-me'}>
                  <div className="markdown-body">
                    <SafeMarkdown>{msg.text}</SafeMarkdown>
                  </div>
                </div>
              )}
            </div>
            );
            })}
            <div ref={explorationEndRef} />
          </div>
          {!explorationAutoScroll && (
            <button
              onClick={resumeExplorationAutoScroll}
              className="absolute bottom-3 right-3 rounded-full bg-duo-blue text-white px-3 py-1.5 text-[10px] font-black uppercase shadow-lg"
            >
              Jump to latest
            </button>
          )}
        </div>

        {explorationLockStatus.length > 0 && (
          <div className="px-2 py-1.5 bg-yellow-50 border-t border-yellow-200 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-black text-yellow-700">TURN</span>
            {explorationLockStatus.map(p => (
              <span key={p.id} className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${p.lockedIn ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                {p.lockedIn ? '🔒' : '⏳'} {p.id === socket.id ? 'You' : p.name}
              </span>
            ))}
            {explorationLockStatus.every(p => p.lockedIn) && (
              <span className="text-[10px] font-bold text-duo-blue animate-pulse ml-auto">Processing...</span>
            )}
          </div>
        )}

        <div className="p-2 bg-white border-t border-duo-gray flex gap-2 composer-safe">
          <textarea
            ref={explorationInputRef}
            value={explorationInput}
            onChange={(e) => {
              setExplorationInput(e.target.value);
              updateTypingPresence('exploration', e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight / 2) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleExplorationSend();
              }
            }}
            placeholder={isExplorationLockedIn ? "Action locked..." : "What now?"}
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
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setShowGoalsModal(false); setShowAllGoals(false); }}>
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-yellow-300" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-xl font-black text-duo-text mb-4 flex items-center gap-2">
                <Star className="w-6 h-6 fill-yellow-500 text-yellow-500" /> Active Goals
              </h3>
              <div className="space-y-3">
                {(showAllGoals ? explorationState.goals : explorationState.goals.slice(0, 3)).map((goal, i) => (
                  <div key={i} className={`flex items-start gap-3 p-3 rounded-xl ${i === 0 ? 'bg-yellow-50 border-2 border-yellow-300' : 'bg-gray-50 border border-duo-gray'}`}>
                    <span className="text-lg font-black text-duo-gray-dark w-6 text-center">{i + 1}</span>
                    <span className="font-bold text-sm text-duo-text flex-1">{goal}</span>
                    {i === 0 && <Star className="w-5 h-5 fill-yellow-500 text-yellow-500 flex-shrink-0" />}
                  </div>
                ))}
                {!showAllGoals && explorationState.goals.length > 3 && (
                  <button onClick={() => setShowAllGoals(true)} className="w-full rounded-2xl bg-gray-100 border border-duo-gray px-3 py-2 text-sm font-black text-duo-gray-dark">
                    Show {explorationState.goals.length - 3} more goals
                  </button>
                )}
              </div>
              <button onClick={() => { setShowGoalsModal(false); setShowAllGoals(false); }} className="duo-btn duo-btn-blue w-full py-3 mt-6">Close</button>
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
                    apiKey: settingsRef.current.apiKey?.trim() || '',
                    difficulty: bot.difficulty,
                    botProfile,
                    botName: bot.name,
                    unlimitedTurnTime: settingsRef.current.unlimitedTurnTime,
                    modelSettings: { charModel: settingsRef.current.charModel, explorationModel: settingsRef.current.explorationModel, battleModel: settingsRef.current.battleModel, botModel: settingsRef.current.botModel },
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
        {!explorationCombatReturn && (
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
        )}
        
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
    <div className="h-safe-screen bg-duo-bg flex justify-center overflow-hidden">
      <div className="w-full max-w-md bg-white h-full min-h-0 flex flex-col relative shadow-2xl">
        {renderTopBar()}
        {render503RetryPills()}
        
        {gameState === 'menu' && renderMenu()}
        {gameState === 'char_creation' && renderCharCreation()}
        {gameState === 'matchmaking' && renderMatchmaking()}
        {gameState === 'arena_prep' && renderArenaPreparation()}
        {gameState === 'battle' && renderBattle()}
        {gameState === 'post_match' && renderPostMatch()}
        {gameState === 'exploration' && renderExploration()}
        {gameState === 'level_select' && renderLevelSelect()}

        {renderBottomBar()}

        {showSettings && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl border-b-4 border-gray-200 max-h-[90vh] overflow-y-auto">
              <h3 className="text-2xl font-black text-duo-text mb-6 text-center">Settings</h3>
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setSettingsPage('general')}
                  className={`flex-1 rounded-xl px-3 py-2 text-sm font-black transition-colors ${settingsPage === 'general' ? 'bg-duo-blue text-white' : 'bg-duo-gray text-duo-gray-dark'}`}
                >
                  General
                </button>
                <button
                  onClick={() => setSettingsPage('debug')}
                  className={`flex-1 rounded-xl px-3 py-2 text-sm font-black transition-colors ${settingsPage === 'debug' ? 'bg-duo-blue text-white' : 'bg-duo-gray text-duo-gray-dark'}`}
                >
                  Debug
                </button>
              </div>
              
              {settingsPage === 'general' ? (
                <>
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
                </>
              ) : (
                <div className="space-y-4 mb-8">
                  <div className="rounded-2xl border border-duo-gray bg-duo-gray/30 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-black text-duo-text">Unlimited Turn Times</h4>
                        <p className="text-xs text-duo-gray-dark mt-1">
                          Arena preview, rewrite, and battle phases now run without countdowns for new PvP rooms and bot fights.
                        </p>
                      </div>
                      <span className="inline-flex items-center rounded-full bg-duo-green px-3 py-1 text-[10px] font-black uppercase text-white">
                        Always On
                      </span>
                    </div>
                    <div className="mt-3 text-[11px] font-bold text-duo-gray-dark">
                      Current state: All arena phase timers are disabled for new rooms.
                    </div>
                  </div>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-black text-duo-text">Battle Trace Recorder</h4>
                        <p className="text-xs text-duo-gray-dark mt-1">
                          Samples battle state every {BATTLE_TRACE_SAMPLE_INTERVAL_MS}ms and tags socket, retry, stream, and image events.
                        </p>
                      </div>
                      <span className={`inline-flex items-center rounded-full px-3 py-1 text-[10px] font-black uppercase ${isBattleTraceRecording ? 'bg-amber-400 text-white' : 'bg-white text-duo-gray-dark border border-amber-200'}`}>
                        {isBattleTraceRecording ? 'Recording' : 'Idle'}
                      </span>
                    </div>
                    <div className="mt-3 text-[11px] font-bold text-duo-gray-dark space-y-1">
                      <div>Trace lines: {battleTraceEntryCount}</div>
                      <div>Use this for the exact "both players submitted, then silence" repro.</div>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <button
                        onClick={handleStartBattleTrace}
                        className="rounded-xl bg-duo-blue px-3 py-2 text-xs font-black text-white transition-colors hover:bg-duo-blue-light"
                      >
                        Start Trace
                      </button>
                      <button
                        onClick={handleStopBattleTrace}
                        className="rounded-xl bg-duo-gray-dark px-3 py-2 text-xs font-black text-white transition-colors hover:bg-black/80"
                      >
                        Stop Trace
                      </button>
                      <button
                        onClick={() => { void handleCopyBattleTrace(); }}
                        className="rounded-xl bg-amber-400 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-amber-500"
                      >
                        Copy Trace
                      </button>
                    </div>
                    {battleTraceCopyStatus && (
                      <div className={`mt-3 text-[11px] font-bold ${battleTraceCopyStatus.tone === 'green' ? 'text-duo-green-dark' : 'text-red-500'}`}>
                        {battleTraceCopyStatus.text}
                      </div>
                    )}
                    {battleTraceEntryCount > 0 && (
                      <pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-black px-3 py-2 text-[10px] font-bold text-amber-100 whitespace-pre-wrap">
                        {battleTraceEntriesRef.current.slice(-2).join('\n')}
                      </pre>
                    )}
                  </div>
                </div>
              )}

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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4 backdrop-blur-sm" onClick={closeProfileModal}>
          <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl border-b-8 border-duo-gray overflow-hidden" onClick={(event) => event.stopPropagation()}>
            <div className="p-4 border-b-2 border-duo-gray flex justify-between items-center bg-duo-blue text-white">
              <h3 className="text-xl font-black tracking-tight">Legend Profile</h3>
              <button 
                onClick={closeProfileModal}
                className="p-2 hover:bg-white/20 rounded-full transition-colors"
              >
                <ArrowLeft className="w-6 h-6 rotate-180" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 prose prose-slate max-w-none">
              <div className="markdown-body">
                <SafeMarkdown>{profileToView}</SafeMarkdown>
              </div>
            </div>
            <div className="p-4 border-t-2 border-duo-gray bg-gray-50 flex justify-end">
              <button 
                onClick={closeProfileModal}
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

