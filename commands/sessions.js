const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const crypto = require('crypto');
const { ephemeralEmoji } = require('../utils/emoji');
const { requireRole } = require('../utils/roleGate');
const axios = require('axios');
const AXIOS_TIMEOUT_MS = Number(process.env.PRC_TIMEOUT_MS || 10000);
const sessionStatusPanel = require('../panels/sessionStatusPanel');
// Fixed server owner username as requested
const FIXED_OWNER_USERNAME = 'KingFridayOfAlzuria';

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

// Noblox lookup removed; using a fixed, configured username instead

const subBannerUrls = {
  shutdown: 'https://media.discordapp.net/attachments/1055153591280742481/1439678655142822008/sessions_shutdown.png?ex=691b64bb&is=691a133b&hm=1669cf4450c2e502afbd6cf2fddb174a940a614865a9e29e40442a2d5d071f01&=&format=webp&quality=lossless',
  full: 'https://media.discordapp.net/attachments/1055153591280742481/1427729651920273449/greeen_sessions.png?ex=691ac51a&is=6919739a&hm=a8ca162366c44c52a23c3e366610a14a80ef4c692635914d58c2fb2494f6ddb4&=&format=webp&quality=lossless&width=1768&height=366',
  boost: 'https://media.discordapp.net/attachments/1055153591280742481/1427729652276924438/yellow_sesions.png?ex=691ac51b&is=6919739b&hm=2f8992035bca1c87fe096d1e7e1b0d63ab6767a7015b51e2c22329beec22786f&=&format=webp&quality=lossless&width=1768&height=366',
  poll: 'https://media.discordapp.net/attachments/1055153591280742481/1427729652276924438/yellow_sesions.png?ex=691ac51b&is=6919739b&hm=2f8992035bca1c87fe096d1e7e1b0d63ab6767a7015b51e2c22329beec22786f&=&format=webp&quality=lossless&width=1768&height=366',
  start: 'https://media.discordapp.net/attachments/1055153591280742481/1427729651920273449/greeen_sessions.png?ex=691ac51a&is=6919739a&hm=a8ca162366c44c52a23c3e366610a14a80ef4c692635914d58c2fb2494f6ddb4&=&format=webp&quality=lossless&width=1768&height=366',
  default: 'https://media.discordapp.net/attachments/1055153591280742481/1439678655142822008/sessions_shutdown.png?ex=691b64bb&is=691a133b&hm=1669cf4450c2e502afbd6cf2fddb174a940a614865a9e29e40442a2d5d071f01&=&format=webp&quality=lossless'
};

function bannerFor(type) {
  return subBannerUrls[type] || subBannerUrls.default;
}
// Read all IDs from .env for easy configuration by non-coders
const SESSIONS_CHANNEL_ID = process.env.SESSIONS_CHANNEL_ID || ''; // Channel where session status is posted
const SESSIONS_PING_ROLE_ID = process.env.SESSIONS_PING_ROLE_ID || ''; // Role to ping in boost/poll/start
const SESSIONS_SHUTDOWN_ROLE_ID = process.env.SESSIONS_SHUTDOWN_ROLE_ID || ''; // Role shown in shutdown description
const SESSIONS_REQUIRED_ROLE_ID = process.env.SESSIONS_REQUIRED_ROLE_ID || ''; // Role required to use /sessions
const SessionStatusState = require('../models/sessionStatusState');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('sessions')
		.setDescription('Manage sessions')
		.addSubcommand(x => x
			.setName('shutdown')
			.setDescription('Shutdown the session.')
		)
		.addSubcommand(x => x
			.setName('full')
			.setDescription('Mark the session as full.')
		)
		.addSubcommand(x => x
			.setName('boost')
			.setDescription('Boost the session.')
		)
		.addSubcommand(x => x
			.setName('poll')
			.setDescription('Start a session poll.')
			.addNumberOption(x => x
				.setName('votes')
				.setDescription('The amount of votes needed to start a session')
				.setRequired(true)
			)
		)
		.addSubcommand(x => x
			.setName('start')
			.setDescription('Start the session.')
		),
	execute: async function(interaction, client, args) {
		const subcommand = interaction.options.getSubcommand();
    const user = interaction.user;

    // Simple permission check like the dash command
    // Use shared role gate; supports one or multiple role IDs (comma/space separated)
    const hasAccess = await requireRole(interaction, SESSIONS_REQUIRED_ROLE_ID);
    if (!hasAccess) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Fetch the configured sessions channel by ID from .env
    const channel = await client.channels.fetch(SESSIONS_CHANNEL_ID).catch(() => null);
    if (!channel) {
      return interaction.editReply({ content: `${ephemeralEmoji('not_found')} Sessions channel not found. Please check configuration.` });
    }

			switch (subcommand) {
				case 'shutdown':
					client.activePollId = null;

                // Mention role from .env if provided; otherwise use a generic label
                const shutdownRoleMention = SESSIONS_SHUTDOWN_ROLE_ID ? `<@&${SESSIONS_SHUTDOWN_ROLE_ID}>` : 'the relevant role';
					let shutdownMsg;
					shutdownMsg = await channel.send({
							embeds: [
								new EmbedBuilder()
									.setTitle('Session Shutdown')
									.setDescription(`The in-game server is currently shutdown. Please refrain from joining without staff permission. Doing so can and will result in moderation.`)
									.setColor('#fb2c04')
									.setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
									.setImage(bannerFor('shutdown'))
							]
						});

				await interaction.editReply({ content: 'Successfully shutdown session.' });
				// Update session status panel button to Offline (red)
				try { await sessionStatusPanel.setStatus(client, 'offline'); } catch (e) { console.warn('sessions shutdown: status panel update failed:', e?.message || e); }

				try {
					let panelMsgId = null;
					try {
						const state = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
						if (state && state.channelId === channel.id) panelMsgId = state.messageId || null;
					} catch {}
					const cutoffTs = shutdownMsg?.createdTimestamp || Date.now();
					let before = undefined;
					let scanned = 0;
					while (scanned < 500) {
						const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
						if (!batch || !batch.size) break;
						for (const [, m] of batch) {
							if (m.id === panelMsgId) continue;
							if (m.id === shutdownMsg.id) continue;
							if (m.pinned) continue;
							if (m.createdTimestamp >= cutoffTs) continue;
							if (!m.deletable) continue;
							try { await m.delete(); } catch {}
						}
						scanned += batch.size;
						before = batch.last()?.id;
						if (batch.size < 100) break;
					}
				} catch (err) {
					console.warn('sessions shutdown: purge above failed:', err?.message || err);
				}

				axios.post('https://api.policeroleplay.community/v1/server/command', {
					command: ':m SSD commencing soon! Wrap up your roleplays, want more? Join our comms server code: vrmt'
				},
				{
					headers: {
						'server-key': client.config.PRC_KEY,
						'Content-Type': 'application/json',
						'Accept': '*/*'
					},
					timeout: AXIOS_TIMEOUT_MS
				}).catch(err => {
					const code = err?.response?.status;
					const body = err?.response?.data;
					const retryAfter = err?.response?.headers?.['retry-after'];
					console.warn('sessions shutdown: PRC announce failed:',
						code ? `status=${code}` : (err?.message || err),
						body ? `body=${JSON.stringify(body).slice(0,300)}` : '',
						retryAfter ? `retry-after=${retryAfter}` : ''
					);
				});

				setTimeout(() => {
					axios.post('https://api.policeroleplay.community/v1/server/command', {
						command: ':kick all'
					},
					{
						headers: {
							'server-key': client.config.PRC_KEY,
							'Content-Type': 'application/json',
							'Accept': '*/*'
						},
						timeout: AXIOS_TIMEOUT_MS
					}).catch(err => {
						const code = err?.response?.status;
						const body = err?.response?.data;
						const retryAfter = err?.response?.headers?.['retry-after'];
						console.warn('sessions shutdown: PRC kick failed:',
							code ? `status=${code}` : (err?.message || err),
							body ? `body=${JSON.stringify(body).slice(0,300)}` : '',
							retryAfter ? `retry-after=${retryAfter}` : ''
						);
					});
				}, 1000 * 60 * 2);
				break;
			
			case 'full':
                await channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Session Full')
                            .setDescription(`Thank you South Florida for getting us full! Keep trying to join to experience some immersive roleplays. We got full <t:${Math.floor(Date.now() / 1000)}:R>.`)
                            .setColor('#018f1b')
                            .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
                            .setImage(bannerFor('full'))
                    ]
                });

                await interaction.followUp({ content: `${ephemeralEmoji('success_full')} Successfully marked session as full.`, flags: MessageFlags.Ephemeral });
				break;

			case 'boost':
                // Ping @here plus the configured role if present
                const pingTag = SESSIONS_PING_ROLE_ID ? `<@&${SESSIONS_PING_ROLE_ID}>` : '';
                await channel.send({
                    content: `@everyone${pingTag ? ` | ${pingTag}` : ''}`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Session Boost')
                            .setDescription('We are currently in need of some players! Interested in some immersive and and enjoyable roleplays? Make sure to join. You can press the button below to quickly join.')
                            .setColor('#fde446')
                            .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
                            .setImage(bannerFor('boost'))
                    ],
                    components: [
                        new ActionRowBuilder().addComponents(
							new ButtonBuilder()
								.setLabel('Quick Join')
								.setStyle(ButtonStyle.Link)
								.setURL('https://policeroleplay.community/join?code=vermontST&placeId=2534724415')
						)
					]
				});

                await interaction.followUp({ content: `${ephemeralEmoji('success_boost')} Successfully boosted the session.`, flags: MessageFlags.Ephemeral });
				break;

			case 'poll':
				const votes = interaction.options.getNumber('votes');
				const sessionId = generateId();

                // Duplicate the ping tag (matching original behavior) if configured
                const pollPing = SESSIONS_PING_ROLE_ID ? `<@&${SESSIONS_PING_ROLE_ID}>` : '';
                await channel.send({
                    content: pollPing ? `${pollPing} | @everyone` : '@everyone',
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Session Poll')
                            .setDescription('The HR team has decided to host a session poll. Interested in joining? Make sure to vote with the buttons below. Please note that if you vote, you are required to join within 15 minutes.')
                            .setColor('#fde446')
                            .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
                            .setImage(bannerFor('poll'))
                    ],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`sessionVote:button_${sessionId}_${votes}`)
                                .setLabel(`Vote (0/${votes})`)
                                .setStyle(ButtonStyle.Success),
                            new ButtonBuilder()
                                .setCustomId(`sessionView:button_${sessionId}_${votes}`)
                                .setLabel('View Voters')
                                .setStyle(ButtonStyle.Secondary)
                        )
                    ]
                });

                await interaction.followUp({ content: `${ephemeralEmoji('success_poll')} Successfully started a poll.`, flags: MessageFlags.Ephemeral });
				break;

			case 'start':
				const activePollId = client.activePollId;
				const voters = client.sessions.get(activePollId);
				let votersList;
				if (!voters || voters.size === 0) {
					votersList = 'No Voters';
				} else {
					const votersArray = [...voters.values()];

					if (Array.isArray(votersArray) && votersArray.length > 0) {
						votersList = votersArray.map((user) => `${user.user}`).join(', ');
					} else {
						votersList = 'No Voters';
					}
				}

				let serverInfo;
				try {
					const res = await axios.get('https://api.policeroleplay.community/v1/server', {
						headers: {
							'server-key': client.config.PRC_KEY,
							'Accept': '*/*'
						},
						timeout: AXIOS_TIMEOUT_MS
					});

					serverInfo = res.data;
				} catch (error) {
					console.warn('sessions start: PRC server info fetch failed:', error?.message || error);
					await interaction.followUp({ content: `${ephemeralEmoji('error_generic')} Unable to fetch server details from PRC right now. Try again in a moment.`, flags: MessageFlags.Ephemeral });
					break;
				}

                const ownerUser = FIXED_OWNER_USERNAME;

				// No channel-wide deletion; preserve session panel and history
                const startPing = SESSIONS_PING_ROLE_ID ? `<@&${SESSIONS_PING_ROLE_ID}>` : '';
                let msg;
                try {
                    msg = await channel.send({
                    content: `@everyone${startPing ? ` | ${startPing}` : ''}\n-# ${votersList}`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('Session Start')
                            .setDescription(`The HR team has decided to start a session. If you voted, you **must** join within 15 minutes or else you will be moderated. You can quick join using the button below.\n\n> <:bullet:1435684662314930216> **Server Name:** ${serverInfo.Name}\n> <:bullet:1435684662314930216> **Server Code:** ${serverInfo.JoinKey}\n> <:bullet:1435684662314930216> **Server Owner:** ${ownerUser}`)
                            .setColor('#018f1b')
                            .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
                            .setImage(bannerFor('start'))
                    ],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setLabel('Quick Join')
                                .setStyle(ButtonStyle.Link)
                                .setURL('https://policeroleplay.community/join?code=vermontST&placeId=2534724415')
                        )
                    ]
                });
                } catch (err) {
                    console.warn('sessions start: channel.send failed:', err?.message || err);
                    await interaction.followUp({ content: `${ephemeralEmoji('error_generic')} I couldn’t post the start message in the sessions channel. Please check channel permissions and try again.`, flags: MessageFlags.Ephemeral });
                    break;
                }

				                await interaction.followUp({ content: `${ephemeralEmoji('success_start')} Successfully started the session.`, flags: MessageFlags.Ephemeral });
				                // Update session status panel button to Online (green)
				                try { await sessionStatusPanel.setStatus(client, 'online'); } catch (e) { console.warn('sessions start: status panel update failed:', e?.message || e); }
				
				                // Optionally trigger an immediate status panel refresh once; ongoing updates handled by its 60s timer
				                try { await sessionStatusPanel.refresh(client); } catch (e) { console.warn('sessions start: status panel immediate refresh failed:', e?.message || e); }

                // Purge all messages newer than the session panel while preserving the panel
                try {
                  const state = await SessionStatusState.findOne({ key: 'default' }).catch(() => null);
                  if (!state || state.channelId !== channel.id || !state.messageId) break;
                  const panelMsg = await channel.messages.fetch(state.messageId).catch(() => null);
                  if (!panelMsg) break;
                  const panelTs = panelMsg.createdTimestamp;
                  let before = undefined;
                  let scanned = 0;
                  while (scanned < 1000) {
                    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
                    if (!batch || !batch.size) break;
                    for (const [, m] of batch) {
                      if (m.id === state.messageId) { continue; }
                      if (msg && m.id === msg.id) { continue; }
                      if (m.pinned) continue;
                      if (m.createdTimestamp <= panelTs) continue; // only delete messages newer than the panel
                      if (!m.deletable) continue;
                      try { await m.delete(); } catch {}
                    }
                    scanned += batch.size;
                    before = batch.last()?.id;
                    if (batch.size < 100) break;
                  }
                } catch (purgeErr) {
                  console.warn('sessions start: purge newer-than-panel failed:', purgeErr?.message || purgeErr);
                }
				                break;
		}
	}
}





