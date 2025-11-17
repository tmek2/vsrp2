const { EmbedBuilder } = require('discord.js');
const ReminderState = require('./models/reminderState');

const GLOBAL_EMBED_COLOR = process.env.GLOBAL_EMBED_COLOR || '#4c79eb';
const COLOR_HEX = GLOBAL_EMBED_COLOR || process.env.DASH_COLOR || '#2b2d31ff';
const IMAGE_URL = process.env.REMINDER_IMAGE_URL || process.env.DASH_IMAGE_URL || '';
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID || '';
const REMINDER_INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_MS || 43_200_000);
const REMINDER_INITIAL_DELAY_MS = Number(process.env.REMINDER_INITIAL_DELAY_MS || 43_200_000);

async function sendReminder(client) {
  try {
    if (!REMINDER_CHANNEL_ID) {
      console.warn('autoReminder: REMINDER_CHANNEL_ID not set; skipping reminder send.');
      return;
    }
    const channel = await client.channels.fetch(REMINDER_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn('autoReminder: failed to fetch reminder channel or channel is not text-based');
      return;
    }

    // Delete previous reminder if known
    try {
      const state = await ReminderState.findOne({ key: 'default' });
      if (state && state.messageId) {
        const oldMsg = await channel.messages.fetch(state.messageId).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
    } catch (err) {
      console.warn('autoReminder: could not delete previous reminder:', err?.message || err);
    }

    // Build the reminder embed per specification
    const reminderEmbed = new EmbedBuilder()
      .setColor(COLOR_HEX)
      .setTitle('<:vrmt:1439648331465752646> Vermont State Reminder')
      .addFields(
        {
          name: '<:sparkle2:1439648693237190696> | Fun & Rewards',
          value: '**Waiting for a session?** Jump into ⁠<#1370848317059239969>, earn cash, flex your balance, and unlock awesome perks!'
        },
        {
          name: '<:tickets2:1439648955343310949> | Assistance',
          value: '**Got a question or issue?** Visit ⁠<#1370856943136018432> and open a ticket. Our support team will be with you shortly.'
        },
        {
          name: '<:diamonds:1435328269539868782> | Elevate Your Experience',
          value: '**Looking to elevate your experience?** Explore perks and exclusives in ⁠<#1370851986525913098>!'
        },
        {
          name: '<:hierarchy2:1439649849632096266> | Explore Our Departments',
          value: '**Interested in joining a department?** Head to ⁠<#1370851831584129024> and start your journey today!'
        },
        {
          name: '<:support:1439649520219852850> | Join the Team!',
          value: '**Think you’ve got what it takes?** Submit your application and join the [Vermont State Roleplay Staff Team!](https://melon.ly/form/7360790631297323008)'
        }
      );
    if (IMAGE_URL) reminderEmbed.setImage(IMAGE_URL);

    const sent = await channel.send({ embeds: [reminderEmbed] });

    // Persist latest message id
    await ReminderState.findOneAndUpdate(
      { key: 'default' },
      { channelId: channel.id, messageId: sent.id, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (err) {
    console.error('autoReminder: error sending reminder:', err);
  }
}

function start(client) {
  // Begin after initial delay (defaults to 24h), then repeat by interval
  setTimeout(() => {
    sendReminder(client);
    setInterval(() => sendReminder(client), Math.max(REMINDER_INTERVAL_MS, 60_000));
  }, Math.max(REMINDER_INITIAL_DELAY_MS, 60_000));
}

module.exports = { start };
