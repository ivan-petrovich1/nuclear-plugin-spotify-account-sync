import React, { useCallback, useEffect, useState } from 'react';
import type {
  NuclearPlugin,
  NuclearPluginAPI,
  Playlist,
  PlaylistItem,
  Track,
} from '@nuclearplayer/plugin-sdk';

const SETTING_IDS = {
  ACCOUNT_INPUT: 'accountInput',
  AUTO_SYNC: 'autoSyncOnLaunch',
  SYNC_PANEL: 'syncPanel',
  SYNCED_MAP_JSON: 'syncedMapJson',
  LAST_SYNCED_ISO: 'lastSyncedIso',
  LAST_SUMMARY: 'lastSummary',
} as const;

const WIDGET_ID = 'spotify-account-sync-widget';
const VIEW_ID = 'spotify-account-sync';

type SpotifyEmbedTrack = {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
};

type SpotifyEmbedEntity = {
  name?: string;
  subtitle?: string;
  trackList?: SpotifyEmbedTrack[];
  visualIdentity?: {
    image?: Array<{ url?: string; maxWidth?: number; maxHeight?: number }>;
  };
  coverArt?: {
    sources?: Array<{ url?: string; width?: number; height?: number }>;
  };
};

type SyncProgressListener = (state: {
  syncing: boolean;
  progressText: string | null;
}) => void;

const generateId = (): string => {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

type ParsedTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'playlist'; playlistId: string };

const parseSpotifyInput = (input: string): ParsedTarget | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const playlistUrlMatch = trimmed.match(
    /open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/i,
  );
  if (playlistUrlMatch?.[1]) {
    return { kind: 'playlist', playlistId: playlistUrlMatch[1] };
  }

  const playlistUriMatch = trimmed.match(
    /spotify:playlist:([a-zA-Z0-9]{22})/i,
  );
  if (playlistUriMatch?.[1]) {
    return { kind: 'playlist', playlistId: playlistUriMatch[1] };
  }

  const userUrlMatch = trimmed.match(
    /open\.spotify\.com\/user\/([a-zA-Z0-9._-]+)/i,
  );
  if (userUrlMatch?.[1]) {
    return { kind: 'user', userId: userUrlMatch[1] };
  }

  const userUriMatch = trimmed.match(/spotify:user:([a-zA-Z0-9._-]+)/i);
  if (userUriMatch?.[1]) {
    return { kind: 'user', userId: userUriMatch[1] };
  }

  if (/^[a-zA-Z0-9._-]{2,}$/.test(trimmed)) {
    return { kind: 'user', userId: trimmed };
  }

  return null;
};

const fetchText = async (
  api: NuclearPluginAPI,
  url: string,
): Promise<string> => {
  const res = await api.Http.fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok || res.status < 200 || res.status >= 400) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
};

const parseEmbedPlaylist = (
  spotifyPlaylistId: string,
  html: string,
): { name: string; coverUrl?: string; tracks: Track[] } | null => {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) {
    return null;
  }

  let json: {
    props?: {
      pageProps?: {
        state?: {
          data?: {
            entity?: SpotifyEmbedEntity;
          };
        };
      };
    };
  };
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const entity = json.props?.pageProps?.state?.data?.entity;
  if (!entity || !entity.name) {
    return null;
  }

  const coverUrl =
    entity.visualIdentity?.image?.[0]?.url ??
    entity.coverArt?.sources?.[0]?.url;

  const rawTracks = entity.trackList ?? [];
  const tracks: Track[] = rawTracks
    .filter((t) => Boolean(t.title))
    .map((t, idx) => {
      const artists = (t.subtitle || 'Unknown Artist')
        .split(/,\s*/)
        .filter(Boolean)
        .map((name, aIdx) => ({
          name,
          roles: [],
          source: {
            provider: 'spotify-sync',
            id: `${spotifyPlaylistId}:artist:${idx}:${aIdx}`,
          },
        }));

      return {
        title: t.title!,
        artists,
        durationMs: typeof t.duration === 'number' ? t.duration : undefined,
        artwork: coverUrl
          ? { items: [{ url: coverUrl, purpose: 'thumbnail' as const }] }
          : undefined,
        source: {
          provider: 'spotify-sync',
          id: t.uri || `spotify:playlist:${spotifyPlaylistId}:track:${idx}`,
        },
      };
    });

  return { name: entity.name, coverUrl, tracks };
};

const readSyncedMap = async (
  api: NuclearPluginAPI,
): Promise<Record<string, string>> => {
  try {
    const raw = await api.Settings.get<string>(SETTING_IDS.SYNCED_MAP_JSON);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Ignore malformed stored map
  }
  return {};
};

let isSyncing = false;
let currentProgressText: string | null = null;
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let autoSyncAttemptedThisSession = false;
const progressListeners = new Set<SyncProgressListener>();

const emitProgress = (syncing: boolean, progressText: string | null) => {
  isSyncing = syncing;
  currentProgressText = progressText;
  for (const listener of progressListeners) {
    try {
      listener({ syncing, progressText });
    } catch {
      // Ignore UI subscriber errors
    }
  }
};

const runSync = async (
  api: NuclearPluginAPI,
  inputOverride?: string,
): Promise<void> => {
  if (isSyncing) {
    return;
  }

  const rawInput =
    inputOverride !== undefined
      ? inputOverride
      : ((await api.Settings.get<string>(SETTING_IDS.ACCOUNT_INPUT)) ?? '');
  const target = parseSpotifyInput(rawInput);

  if (!target) {
    await api.Settings.set(
      SETTING_IDS.LAST_SUMMARY,
      'Enter a public Spotify profile URL, username, or playlist URL first',
    );
    return;
  }

  emitProgress(true, 'Connecting to Spotify...');

  try {
    let playlistIds: string[] = [];
    let label = '';

    if (target.kind === 'playlist') {
      playlistIds = [target.playlistId];
      label = `playlist ${target.playlistId}`;
    } else {
      label = `@${target.userId}`;
      emitProgress(true, `Reading public profile ${label}...`);
      const profileUrl = `https://open.spotify.com/user/${encodeURIComponent(target.userId)}`;
      const profileHtml = await fetchText(api, profileUrl);
      const idMatches = profileHtml.matchAll(/\/playlist\/([a-zA-Z0-9]{22})/g);
      playlistIds = Array.from(
        new Set(Array.from(idMatches, (m) => m[1])),
      ).slice(0, 25);
    }

    if (playlistIds.length === 0) {
      const summary = `No public playlists found for "${label}"`;
      await api.Settings.set(SETTING_IDS.LAST_SUMMARY, summary);
      emitProgress(false, null);
      return;
    }

    const nextMap = await readSyncedMap(api);
    let createdCount = 0;
    let updatedCount = 0;
    let totalTracks = 0;

    for (let i = 0; i < playlistIds.length; i++) {
      const spId = playlistIds[i];
      emitProgress(
        true,
        `Syncing playlist ${i + 1} of ${playlistIds.length}...`,
      );

      try {
        const embedHtml = await fetchText(
          api,
          `https://open.spotify.com/embed/playlist/${spId}`,
        );
        const parsed = parseEmbedPlaylist(spId, embedHtml);
        if (!parsed || parsed.tracks.length === 0) {
          continue;
        }
        totalTracks += parsed.tracks.length;

        const existingNuclearId = nextMap[spId];
        const existingPlaylist = existingNuclearId
          ? await api.Playlists.getPlaylist(existingNuclearId).catch(() => null)
          : null;

        if (existingPlaylist) {
          const oldItemIds = existingPlaylist.items.map((item) => item.id);
          if (oldItemIds.length > 0) {
            await api.Playlists.removeTracks(existingPlaylist.id, oldItemIds);
          }
          await api.Playlists.addTracks(existingPlaylist.id, parsed.tracks);
          updatedCount++;
        } else {
          const now = new Date().toISOString();
          const items: PlaylistItem[] = parsed.tracks.map((track) => ({
            id: generateId(),
            track,
            addedAtIso: now,
          }));
          const newPlaylist: Playlist = {
            id: generateId(),
            name: parsed.name,
            description: `Synced from Spotify (${label})`,
            artwork: parsed.coverUrl
              ? { items: [{ url: parsed.coverUrl, purpose: 'cover' }] }
              : undefined,
            createdAtIso: now,
            lastModifiedIso: now,
            isReadOnly: false,
            items,
          };
          const newId = await api.Playlists.importPlaylist(newPlaylist);
          nextMap[spId] = newId;
          createdCount++;
        }
      } catch (err) {
        api.Logger.warn(
          `Skipped Spotify playlist ${spId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const syncedTotal = createdCount + updatedCount;
    const summary = `Synced ${syncedTotal} playlist${syncedTotal === 1 ? '' : 's'} (${totalTracks} tracks) — ${createdCount} new, ${updatedCount} updated`;
    await api.Settings.set(
      SETTING_IDS.SYNCED_MAP_JSON,
      JSON.stringify(nextMap),
    );
    await api.Settings.set(
      SETTING_IDS.LAST_SYNCED_ISO,
      new Date().toISOString(),
    );
    await api.Settings.set(SETTING_IDS.LAST_SUMMARY, summary);
    api.Logger.info(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await api.Settings.set(
      SETTING_IDS.LAST_SUMMARY,
      `Sync failed: ${msg}`,
    );
    api.Logger.error(`Spotify sync failed: ${msg}`);
  } finally {
    emitProgress(false, null);
  }
};

type SyncedPlaylistSummary = {
  spotifyId: string;
  nuclearId: string;
  name: string;
  trackCount: number;
};

const useSyncState = (api: NuclearPluginAPI) => {
  const [accountInput, setAccountInputState] = useState('');
  const [autoSync, setAutoSyncState] = useState(true);
  const [syncing, setSyncing] = useState(isSyncing);
  const [progressText, setProgressText] = useState<string | null>(
    currentProgressText,
  );
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const [lastSyncedIso, setLastSyncedIso] = useState<string | null>(null);
  const [syncedPlaylists, setSyncedPlaylists] = useState<
    SyncedPlaylistSummary[]
  >([]);

  const loadSyncedPlaylists = useCallback(async () => {
    try {
      const map = await readSyncedMap(api);
      const index = await api.Playlists.getIndex();
      const indexById = new Map(index.map((entry) => [entry.id, entry]));
      const rows: SyncedPlaylistSummary[] = [];
      for (const [spotifyId, nuclearId] of Object.entries(map)) {
        const entry = indexById.get(nuclearId);
        if (entry) {
          rows.push({
            spotifyId,
            nuclearId,
            name: entry.name,
            trackCount: entry.itemCount,
          });
        }
      }
      setSyncedPlaylists(rows);
    } catch {
      // Ignore playlist index read failure
    }
  }, [api]);

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      const [input, auto, summary, iso] = await Promise.all([
        api.Settings.get<string>(SETTING_IDS.ACCOUNT_INPUT),
        api.Settings.get<boolean>(SETTING_IDS.AUTO_SYNC),
        api.Settings.get<string>(SETTING_IDS.LAST_SUMMARY),
        api.Settings.get<string>(SETTING_IDS.LAST_SYNCED_ISO),
      ]);
      if (!mounted) {
        return;
      }
      setAccountInputState(input ?? '');
      setAutoSyncState(auto ?? true);
      setLastSummary(summary ?? null);
      setLastSyncedIso(iso ?? null);
      await loadSyncedPlaylists();
    };
    void init();

    const progressSub: SyncProgressListener = (state) => {
      setSyncing(state.syncing);
      setProgressText(state.progressText);
      if (!state.syncing) {
        void loadSyncedPlaylists();
      }
    };
    progressListeners.add(progressSub);

    const unsubInput = api.Settings.subscribe<string>(
      SETTING_IDS.ACCOUNT_INPUT,
      (v) => setAccountInputState(v ?? ''),
    );
    const unsubAuto = api.Settings.subscribe<boolean>(
      SETTING_IDS.AUTO_SYNC,
      (v) => setAutoSyncState(v ?? true),
    );
    const unsubSummary = api.Settings.subscribe<string>(
      SETTING_IDS.LAST_SUMMARY,
      (v) => setLastSummary(v ?? null),
    );
    const unsubIso = api.Settings.subscribe<string>(
      SETTING_IDS.LAST_SYNCED_ISO,
      (v) => setLastSyncedIso(v ?? null),
    );

    return () => {
      mounted = false;
      progressListeners.delete(progressSub);
      unsubInput();
      unsubAuto();
      unsubSummary();
      unsubIso();
    };
  }, [api, loadSyncedPlaylists]);

  const updateInput = useCallback(
    async (value: string) => {
      setAccountInputState(value);
      await api.Settings.set(SETTING_IDS.ACCOUNT_INPUT, value);
    },
    [api],
  );

  const toggleAutoSync = useCallback(
    async (checked: boolean) => {
      setAutoSyncState(checked);
      await api.Settings.set(SETTING_IDS.AUTO_SYNC, checked);
    },
    [api],
  );

  const triggerSync = useCallback(async () => {
    await api.Settings.set(SETTING_IDS.ACCOUNT_INPUT, accountInput);
    await runSync(api, accountInput);
  }, [api, accountInput]);

  return {
    accountInput,
    autoSync,
    syncing,
    progressText,
    lastSummary,
    lastSyncedIso,
    syncedPlaylists,
    updateInput,
    toggleAutoSync,
    triggerSync,
  };
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border, rgba(255,255,255,0.14))',
  borderRadius: '12px',
  padding: '16px',
  background: 'var(--card, rgba(255,255,255,0.03))',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const buttonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '10px 14px',
  borderRadius: '8px',
  border: 'none',
  fontWeight: 700,
  fontSize: '13px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  background: 'var(--primary, #22c55e)',
  color: 'var(--primary-foreground, #09090b)',
});

const SpotifySyncWidget: React.FC<{ api: NuclearPluginAPI }> = ({ api }) => {
  const {
    syncing,
    progressText,
    lastSummary,
    lastSyncedIso,
    triggerSync,
  } = useSyncState(api);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <button
        type="button"
        disabled={syncing}
        onClick={() => void triggerSync()}
        style={buttonStyle(syncing)}
      >
        {syncing
          ? progressText || 'Checking Spotify profile...'
          : 'Sync Public Playlists Now'}
      </button>
      {lastSummary && (
        <div
          style={{
            borderRadius: '8px',
            padding: '8px 10px',
            fontSize: '12px',
            background: 'rgba(0,0,0,0.2)',
          }}
        >
          <div style={{ fontWeight: 700 }}>{lastSummary}</div>
          {lastSyncedIso && (
            <div style={{ opacity: 0.7, marginTop: '2px' }}>
              Last synced: {new Date(lastSyncedIso).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const SpotifySyncView: React.FC<{
  params: Record<string, string>;
  api: NuclearPluginAPI;
}> = ({ api }) => {
  const {
    accountInput,
    autoSync,
    syncing,
    progressText,
    lastSummary,
    lastSyncedIso,
    syncedPlaylists,
    updateInput,
    toggleAutoSync,
    triggerSync,
  } = useSyncState(api);

  return (
    <div
      style={{
        maxWidth: '680px',
        margin: '0 auto',
        padding: '24px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--foreground, inherit)',
      }}
    >
      <div style={cardStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>
            Public Spotify Account Sync
          </h2>
          <p
            style={{
              margin: '6px 0 0',
              fontSize: '12px',
              opacity: 0.75,
              lineHeight: 1.45,
            }}
          >
            No login or API keys needed. Paste your public Spotify profile URL,
            username, or individual public playlist URL — Nuclear will import and
            update those playlists in place.
          </p>
        </div>

        <input
          type="text"
          value={accountInput}
          onChange={(e) => void updateInput(e.target.value)}
          placeholder="https://open.spotify.com/user/... , username, or playlist URL"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border, rgba(255,255,255,0.16))',
            background: 'var(--input, rgba(0,0,0,0.25))',
            color: 'inherit',
            fontSize: '13px',
          }}
        />

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span>Auto-sync public playlists on app launch</span>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => void toggleAutoSync(e.target.checked)}
          />
        </label>

        <button
          type="button"
          disabled={syncing}
          onClick={() => void triggerSync()}
          style={buttonStyle(syncing)}
        >
          {syncing
            ? progressText || 'Checking Spotify profile...'
            : 'Sync Public Playlists Now'}
        </button>

        {lastSummary && (
          <div
            style={{
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '12px',
              background: 'rgba(0,0,0,0.22)',
            }}
          >
            <div style={{ fontWeight: 700 }}>{lastSummary}</div>
            {lastSyncedIso && (
              <div style={{ opacity: 0.68, marginTop: '3px' }}>
                Last synced: {new Date(lastSyncedIso).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>

      {syncedPlaylists.length > 0 && (
        <div style={cardStyle}>
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700 }}>
            Synced Playlists ({syncedPlaylists.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {syncedPlaylists.map((pl) => (
              <button
                key={pl.nuclearId}
                type="button"
                onClick={() =>
                  void api.Navigation.navigate(`/playlists/${pl.nuclearId}`)
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--border, rgba(255,255,255,0.12))',
                  background: 'rgba(0,0,0,0.16)',
                  color: 'inherit',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '13px',
                }}
              >
                <span style={{ fontWeight: 600 }}>{pl.name}</span>
                <span style={{ opacity: 0.65, fontSize: '12px' }}>
                  {pl.trackCount} tracks →
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: '12px',
          padding: '12px 14px',
          fontSize: '12px',
          opacity: 0.78,
        }}
      >
        <strong>Tip:</strong> Make sure your playlists on Spotify are set to{' '}
        <em>Public</em> and shown on your profile. Whenever you add or remove
        tracks on Spotify, reopen Nuclear or click{' '}
        <strong>Sync Public Playlists Now</strong> to update them in place.
      </div>
    </div>
  );
};

const registerSettingsAndUi = async (api: NuclearPluginAPI) => {
  await api.Settings.register([
    {
      id: SETTING_IDS.ACCOUNT_INPUT,
      title: 'Spotify Profile or Playlist URL',
      description:
        'Public Spotify profile URL (https://open.spotify.com/user/...), username, or public playlist URL',
      category: 'plugins',
      kind: 'string',
      default: '',
      widget: {
        type: 'text',
        placeholder: 'https://open.spotify.com/user/... or username',
      },
    },
    {
      id: SETTING_IDS.AUTO_SYNC,
      title: 'Auto-sync on app launch',
      description:
        'Automatically sync your public Spotify playlists shortly after Nuclear starts',
      category: 'plugins',
      kind: 'boolean',
      default: true,
      widget: { type: 'toggle' },
    },
    {
      id: SETTING_IDS.SYNC_PANEL,
      title: 'Sync Actions',
      description: 'Manually trigger a Spotify sync or view the last result',
      category: 'plugins',
      kind: 'custom',
      widgetId: WIDGET_ID,
    },
    {
      id: SETTING_IDS.SYNCED_MAP_JSON,
      title: 'Synced Playlist Map',
      category: 'plugins',
      kind: 'string',
      default: '{}',
      hidden: true,
    },
    {
      id: SETTING_IDS.LAST_SYNCED_ISO,
      title: 'Last Synced Timestamp',
      category: 'plugins',
      kind: 'string',
      default: '',
      hidden: true,
    },
    {
      id: SETTING_IDS.LAST_SUMMARY,
      title: 'Last Sync Summary',
      category: 'plugins',
      kind: 'string',
      default: '',
      hidden: true,
    },
  ]);

  api.Settings.registerWidget(WIDGET_ID, () => <SpotifySyncWidget api={api} />);

  try {
    api.Views?.register({
      id: VIEW_ID,
      title: 'Spotify Sync',
      icon: 'RefreshCw',
      routes: [{ path: '/', component: SpotifySyncView }],
    });
  } catch (err) {
    api.Logger.warn(
      `Could not register sidebar view: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const cleanupUi = (api: NuclearPluginAPI) => {
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
  }
  try {
    api.Views?.unregister(VIEW_ID);
  } catch {
    // Ignore if not registered
  }
  try {
    api.Settings.unregisterWidget(WIDGET_ID);
  } catch {
    // Ignore if not registered
  }
};

const spotifyAccountSyncPlugin: NuclearPlugin = {
  async onLoad(api: NuclearPluginAPI) {
    await registerSettingsAndUi(api);
  },

  async onEnable(api: NuclearPluginAPI) {
    await registerSettingsAndUi(api);

    if (!autoSyncAttemptedThisSession) {
      autoSyncAttemptedThisSession = true;
      const autoSync =
        (await api.Settings.get<boolean>(SETTING_IDS.AUTO_SYNC)) ?? true;
      const input =
        (await api.Settings.get<string>(SETTING_IDS.ACCOUNT_INPUT)) ?? '';
      if (autoSync && parseSpotifyInput(input)) {
        autoSyncTimer = setTimeout(() => {
          autoSyncTimer = null;
          void runSync(api);
        }, 4000);
      }
    }
  },

  onDisable(api: NuclearPluginAPI) {
    cleanupUi(api);
  },

  onUnload(api: NuclearPluginAPI) {
    cleanupUi(api);
  },
};

export default spotifyAccountSyncPlugin;
