const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const SessionStatusState = require('../models/sessionStatusState');
// Emojis removed per request; no emoji helpers needed

const SESSIONS_EMBED_COLOR = process.env.SESSIONS_EMBED_COLOR || '#5865F2';
const COLOR_HEX = SESSIONS_EMBED_COLOR;
// Explicit images per request
const IMAGE_URL_1 = 'https://media.discordapp.net/attachments/1438861655890198602/1439669721812177057/vrmt_sessions.png?ex=691b5c69&is=691a0ae9&hm=3789ee3d9f71b7bc16ee35d914ddeaa7d8e8635eca81144855ec206030068597&=&format=webp&quality=lossless';
const IMAGE_URL_2 = 'https://media.discordapp.net/attachments/1430646260032999465/1435002231760879646/clearline.png?ex=690b0a39&is=6909b8b9&hm=53c842e645874a78d117bd8546a057493c422e9f70c19fb8d1aeceab70a1229b&=&format=webp&quality=lossless';
const IMAGE_URL_3 = 'https://media.discordapp.net/attachments/1438861655890198602/1439334160475885888/bottombanner_vsrp.png?ex=691acca5&is=69197b25&hm=02aeaa0c0fab3f6be2fc350471575092d1cdd3cf91b02dd09e53c66d055b686e&=&format=webp&quality=lossless&width=1872&height=103';
const CHANNEL_ID = process.env.SESSION_STATUS_CHANNEL_ID || '';
const POLL_INTERVAL_MS = Number(process.env.SESSION_STATUS_POLL_INTERVAL_MS || 60_000);
const SESSIONS_SCAN_LIMIT = Number(process.env.SESSIONS_HISTORY_SCAN_LIMIT || 50);

function buildComponents(status) {
  // status: 'online' | 'offline' | 'unknown'
  const label = status === 'online' ? 'Session Online' : status === 'offline' ? 'Session Offline' : 'Session Status';
  const style = status === 'online' ? ButtonStyle.Success : status === 'offline' ? ButtonStyle.Danger : ButtonStyle.Secondary;

  const sessionRoleBtn = new ButtonBuilder().setCustomId('sessionsRole:button').setLabel('Session Role').setStyle(ButtonStyle.Secondary);
  const statusBtn = new ButtonBuilder().setCustomId('session_status_button').setLabel(label).setStyle(style).setDisabled(true);
  return new ActionRowBuilder().addComponents(sessionRoleBtn, statusBtn);
}

let intervalId = null;
let isUpdating = false;
let panelStatus = 'unknown';

function buildTopImageEmbed() {
  const e = new EmbedBuilder().setColor(COLOR_HEX);
  if (IMAGE_URL_1) e.setImage(IMAGE_URL_1);
  return e;
}

function buildScheduleEmbed() {
  const e = new EmbedBuilder().setColor(COLOR_HEX);
  const description = [
    '> Below is the current session schedule. Please be aware that adjustments may occur based on staff availability.',
    ' ',
    ' **Session Schedule** ',
    ' <:bullet:1435684662314930216> Weekdays: <t:1754953259:t> – <t:1754956800:t> ',
    ' <:bullet:1435684662314930216> Weekends: <t:1755021600:t> – <t:1754953259:t> '
  ].join('\n');
  e.setDescription(description);
  if (IMAGE_URL_2) e.setImage(IMAGE_URL_2);
  return e;
}

function buildStatsEmbed(stats) {
  const lastUpdated = stats?.timestamp ? `<t:${Math.floor(stats.timestamp / 1000)}:R>` : '—';
  const e = new EmbedBuilder().setColor(COLOR_HEX);
  // Show "Last Updated" as normal text above fields (no code block, no emoji)
  e.setDescription(`**Last Updated:** ${lastUpdated}`);

  // Stats fields (retain code blocks for values)
  e.addFields(
    { name: `Player Count`, value: `\`\`\`${stats.players}/${stats.maxPlayers}\`\`\``, inline: true },
    { name: `Active Staff`, value: `\`\`\`${stats.staff}\`\`\``, inline: true },
    { name: `In Queue`, value: `\`\`\`${stats.queue}\`\`\``, inline: true }
  );
  if (IMAGE_URL_3) e.setImage(IMAGE_URL_3);
  return e;
}

async function fetchStats(client) {
  const prcKey = (client && client.config && client.config.PRC_KEY) || process.env.PRC_KEY || '';
  if (!prcKey) return null;
  try {
    const commonHeaders = { 'server-key': prcKey, 'Accept': '*/*' };
    const serverRes = await axios.get('https://api.policeroleplay.community/v1/server/', { headers: commonHeaders, timeout: 10000 });
    const staffRes = await axios.get('https://api.policeroleplay.community/v1/server/staff', { headers: commonHeaders, timeout: 10000 }).catch(() => ({ data: [] }));
    const queueRes = await axios.get('https://api.policeroleplay.community/v1/server/queue', { headers: commonHeaders, timeout: 10000 }).catch(() => ({ data: [] }));
    const server = serverRes.data || {};
    let playersCount = Number(server.CurrentPlayers ?? 0);
    if (!playersCount || Number.isNaN(playersCount)) {
      try {
        const playersRes = await axios.get('https://api.policeroleplay.community/v1/server/players', { headers: commonHeaders, timeout: 10000 });
        const playersArr = Array.isArray(playersRes.data) ? playersRes.data : [];
        playersCount = playersArr.length;
      } catch {}
    }
    const staffData = staffRes?.data ?? [];
    let staffCount = 0;
    if (Array.isArray(staffData)) staffCount = staffData.length;
    else if (Array.isArray(staffData.Staff)) staffCount = staffData.Staff.length;
    else staffCount = Number(staffData.Online ?? staffData.Count ?? staffData.length ?? 0);

    const queueData = queueRes?.data ?? [];
    let queueCount = 0;
    if (Array.isArray(queueData)) queueCount = queueData.length;
    else if (Array.isArray(queueData.Queue)) queueCount = queueData.Queue.length;
    else queueCount = Number(queueData.InQueue ?? queueData.Count ?? queueData.length ?? 0);

    const stats = {
      players: playersCount,
      maxPlayers: Number(server.MaxPlayers || 40),
      staff: staffCount,
      queue: queueCount,
      timestamp: Date.now()
    };
    return stats;
  } catch (err) {
    console.warn('sessionStatusPanel: fetchStats failed:', err?.message || err);
    return null;
  }
}

async function start(client, targetChannel = null) {
  try {
    // Prefer explicitly provided channel; fallback to configured channel ID
    let channel = targetChannel;
    if (!channel) {
      if (!CHANNEL_ID) return;
      channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
    }
    if (!channel) return;

    // Load last known status from DB (defaults to 'unknown')
    let state = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
    const initialStatus = state?.status || 'unknown';
    panelStatus = initialStatus;

    // Compose three-embed panel per request
    const initStats = await fetchStats(client);
    const e1 = buildTopImageEmbed();
    const e2 = buildScheduleEmbed();
    const e3 = buildStatsEmbed(initStats || { players: 0, maxPlayers: 40, staff: 0, queue: 0, timestamp: Date.now() });
    const embeds = [e1, e2, e3];

    const row = buildComponents(initialStatus);

    // Find existing session panel messages; edit the latest and delete older ones
    let latestPanel = null;
    const olderPanels = [];
    try {
      const botId = channel.client?.user?.id;
      let scanned = 0;
      let before = undefined;
      const found = [];
      while (scanned < SESSIONS_SCAN_LIMIT) {
        const batchLimit = Math.min(100, SESSIONS_SCAN_LIMIT - scanned);
        const recent = await channel.messages.fetch({ limit: batchLimit, before }).catch(() => null);
        if (!recent || recent.size === 0) break;
        for (const [, m] of recent) {
          if (m.author?.id !== botId) continue;
          const rows = m.components || [];
          const hasSessionComponents = rows.some(r => Array.isArray(r.components) && r.components.some(c => c?.customId === 'session_status_button' || c?.customId === 'sessionsRole:button'));
          if (hasSessionComponents) found.push(m);
        }
        scanned += recent.size;
        before = recent.last()?.id;
        if (recent.size < batchLimit) break;
      }
      found.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      latestPanel = found[0] || null;
      for (const m of found.slice(1)) olderPanels.push(m);
    } catch {}

    // Prefer editing the latest existing panel; otherwise send a new one
    let msg = latestPanel || null;
    if (msg) {
      await msg.edit({ embeds, components: [row] }).catch(() => {});
      try { console.log('sessionStatusPanel: edited existing panel with status', initialStatus); } catch {}
    } else {
      msg = await channel.send({ embeds, components: [row] });
      try { console.log('sessionStatusPanel: created panel with status', initialStatus); } catch {}
    }

    // Delete any older panels
    for (const m of olderPanels) { try { await m.delete(); } catch {} }

    if (!state) {
      state = new SessionStatusState({ key: 'default', channelId: channel.id, messageId: msg.id });
    } else {
      state.channelId = channel.id;
      state.messageId = msg.id;
    }
    state.status = panelStatus || 'unknown';
    state.updatedAt = new Date();
    await state.save().catch(() => {});
    try { console.log('sessionStatusPanel: start saved state', { channelId: state.channelId, messageId: state.messageId, status: state.status }); } catch {}

    // Set up periodic stats updates (rebuild all embeds; stats change reflected in third)
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(async () => {
      await updatePanel(client);
    }, Math.max(POLL_INTERVAL_MS, 30_000));
  } catch (err) {
    console.error('Failed to start session status panel:', err);
  }
}

async function setStatus(client, status) {
  try {
    const state = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
    if (!state || !state.channelId || !state.messageId) return;
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel) return;
    let msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (!msg) {
      try {
        await start(client, channel);
        const refreshed = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
        if (!refreshed) return;
        msg = await channel.messages.fetch(refreshed.messageId).catch(() => null);
        if (!msg) return;
      } catch {}
    }

    panelStatus = status;
    const row = buildComponents(status);
    await msg.edit({ components: [row] }).catch(() => {});
    try {
      state.status = status;
      state.updatedAt = new Date();
      await state.save();
    } catch {}
    try { console.log('sessionStatusPanel: status set', status); } catch {}
  } catch (err) {
    console.error('Failed to update session status button:', err);
  }
}

// Shared updater with concurrency guard to avoid overlapping edits
async function updatePanel(client) {
  if (isUpdating) return; // skip overlapping updates
  isUpdating = true;
  try {
    if (panelStatus === 'offline') { try { console.log('sessionStatusPanel: skip stats update while offline'); } catch {} ; return; }
    const state = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
    if (!state || !state.channelId || !state.messageId) return;
    const stats = await fetchStats(client);
    if (!stats) return;
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (!msg) return;
    const e1u = buildTopImageEmbed();
    const e2u = buildScheduleEmbed();
    const e3u = buildStatsEmbed(stats);
    await msg.edit({ embeds: [e1u, e2u, e3u] }).catch(() => {});
    try { console.log('sessionStatusPanel: stats refreshed'); } catch {}
  } catch (err) {
    console.warn('sessionStatusPanel: updatePanel failed:', err?.message || err);
  } finally {
    isUpdating = false;
  }
}

// Force an immediate stats refresh using the shared updater
async function refresh(client) {
  await updatePanel(client);
}

module.exports = { start, setStatus, refresh };
