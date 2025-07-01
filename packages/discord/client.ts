import { Client as DiscordClient, GatewayIntentBits, ChannelType, User, GuildMember, Role, Guild, Collection } from 'discord.js';
import type { IntentGroup } from './types.js';
import { Intents } from './types.js';

let client: DiscordClient | null = null;
let ready = false;
let initializationPromise: Promise<DiscordClient> | null = null;
const RESTART_DELAY_MS = 5000;

// Helper: Create a proxy that automatically fetches when cache is accessed
function createAutoFetchProxy<T extends { fetch: () => Promise<any> }>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop as keyof T];
      
      // If accessing cache, ensure the object is fetched first
      if (prop === 'cache' && value instanceof Collection) {
        return new Proxy(value, {
          get(cacheObj, cacheProp) {
            const cacheValue = cacheObj[cacheProp as keyof typeof cacheObj];
            
            // If it's a function, wrap it to ensure fetch
            if (typeof cacheValue === 'function') {
              return async (...args: any[]) => {
                try {
                  await obj.fetch();
                } catch (error) {
                  console.error(`Failed to fetch ${obj.constructor.name}:`, error);
                }
                return cacheValue.apply(cacheObj, args);
              };
            }
            
            return cacheValue;
          }
        });
      }
      
      return value;
    }
  });
}

export const Client: DiscordClient = new Proxy({}, {
  get(_target, prop) {
    if (!client || !ready) throw new Error('Discord Client not initialized yet.');
    // @ts-ignore
    return client[prop];
  }
}) as DiscordClient;

// Helper: Get a user, fetching from API if not in cache
export async function getUser(userId: string): Promise<User> {
  const cachedUser = Client.users.cache.get(userId);
  if (cachedUser) return cachedUser;
  
  try {
    const user = await Client.users.fetch(userId);
    return user;
  } catch (error) {
    throw new Error(`Failed to fetch user ${userId}: ${error}`);
  }
}

// Helper: Get multiple users, fetching from API if not in cache
export async function getUsers(userIds: string[]): Promise<User[]> {
  const users: User[] = [];
  const toFetch: string[] = [];
  
  // First check cache
  for (const id of userIds) {
    const cached = Client.users.cache.get(id);
    if (cached) {
      users.push(cached);
    } else {
      toFetch.push(id);
    }
  }
  
  // Fetch missing users
  if (toFetch.length > 0) {
    try {
      const fetched = await Promise.all(toFetch.map(id => Client.users.fetch(id)));
      users.push(...fetched);
    } catch (error) {
      console.error('Failed to fetch some users:', error);
    }
  }
  
  return users;
}

// Helper: Wrap a member with auto-fetch proxy
export function wrapMember(member: GuildMember): GuildMember {
  if (!member.fetch) return member;
  return createAutoFetchProxy(member);
}

function resolveIntents(intents: (number | IntentGroup)[]): number[] {
  const bits: number[] = [];
  for (const intent of intents) {
    if (typeof intent === 'string' && Intents[intent]) {
      bits.push(...Intents[intent]);
    } else if (typeof intent === 'number') {
      bits.push(intent);
    }
  }
  // Remove duplicates
  return Array.from(new Set(bits));
}

async function startDiscordClient(config: { token: string, intents: any[], publicKey?: string }): Promise<DiscordClient> {
  // Wrap the entire logic in a promise
  return new Promise(async (resolve, reject) => {
    if (client) {
      try { await client.destroy(); } catch {}
      client = null;
      ready = false;
    }

    client = new DiscordClient({ intents: resolveIntents(config.intents) });
    if (config.publicKey) (client as any).publicKey = config.publicKey;

    client.once('ready', () => {
      ready = true;
      client = client as DiscordClient;
      if (client && client.user) {
        console.log(`[Breeze Discord] Bot started as @${client.user.tag} (ID: ${client.user.id})`);
      } else {
        console.log('[Breeze Discord] Bot started (no user info)');
      }
      resolve(client); 
    });

    client.on('error', (err) => {
      console.error('[Breeze Discord] Client error:', err);
      // If the client hasn't logged in yet, reject the promise
      if (!ready) {
        reject(err);
      }
    });

    // ... (keep your other event listeners like shardDisconnect)

    client.login(config.token).catch(err => {
      console.error('[Breeze Discord] Login failed:', err);
      // Reject the promise if login fails
      reject(err);
    });
  });
}

// getClient now manages the single initialization promise
export function getClient(config: { token: string, intents: any[], publicKey?: string }): Promise<DiscordClient> {
  if (!initializationPromise) {
    initializationPromise = startDiscordClient(config);
  }
  return initializationPromise;
}


// Helper: Send a message to a channel by ID (default: only text channels with .send)
export async function sendToChannel(
  channelId: string,
  message: string,
  opts?: { allow?: ChannelType[] }
) {
  const channel = await Client.channels.fetch(channelId);
  if (!channel) throw new Error('Channel not found');
  if (
    channel.isTextBased() &&
    'send' in channel &&
    (!opts?.allow || opts.allow.includes(channel.type))
  ) {
    // @ts-ignore
    return channel.send(message);
  }
  throw new Error('Channel is not a text-based channel with send()');
}

// Helper: Pull all messages and metadata from a channel
export async function pullChannel(
  channelId: string, 
  onProgress?: (count: number) => Promise<void> | void
) {
  const channel = await Client.channels.fetch(channelId);
  if (!channel) throw new Error('Channel not found');
  if (!channel.isTextBased()) throw new Error('Channel is not text-based');

  // Get channel metadata
  const channelData: any = {
    id: channel.id,
    type: channel.type,
    createdTimestamp: channel.createdTimestamp,
    lastMessageId: channel.lastMessageId,
    messages: [] as any[],
    attachments: [] as any[] // New array to store all attachments
  };

  // Add text channel specific metadata
  if ('name' in channel) channelData.name = channel.name;
  if ('topic' in channel) channelData.topic = channel.topic;
  if ('nsfw' in channel) channelData.nsfw = channel.nsfw;
  if ('position' in channel) channelData.position = channel.position;
  if ('parentId' in channel) channelData.parentId = channel.parentId;
  if ('rateLimitPerUser' in channel) channelData.rateLimitPerUser = channel.rateLimitPerUser;

  // Add guild-specific metadata if available
  if ('guild' in channel && channel.guild) {
    channelData.guild = {
      id: channel.guild.id,
      name: channel.guild.name,
      icon: channel.guild.icon,
      banner: channel.guild.banner,
      description: channel.guild.description,
      memberCount: channel.guild.memberCount,
      createdAt: channel.guild.createdAt
    };
  }

  let lastMessageId: string | undefined;
  let messageCount = 0;
  let batchCount = 0;

  // Fetch all messages
  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100, // Discord's maximum limit
      ...(lastMessageId && { before: lastMessageId })
    });

    const messagesArray = [...messages.values()];
    if (messagesArray.length === 0) break;

    const batch = messagesArray.map(msg => {
      // Process attachments
      const attachmentRefs = msg.attachments.map(a => {
        const attachment = {
          id: a.id,
          name: a.name,
          url: a.url,
          contentType: a.contentType,
          size: a.size,
          messageId: msg.id // Reference to the message this attachment belongs to
        };
        channelData.attachments.push(attachment);
        return a.id; // Return just the ID to reference the attachment
      });

      return {
        id: msg.id,
        content: msg.content,
        url: msg.url,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          globalName: msg.author.globalName,
          isBot: msg.author.bot
        },
        createdTimestamp: msg.createdTimestamp,
        isSystem: msg.system,
        attachmentIds: attachmentRefs, // Reference to attachments by ID
        embeds: msg.embeds.map(embed => ({ ...embed.data })),
        reactions: msg.reactions.cache.map(r => ({
          emoji: r.emoji.name,
          count: r.count
        }))
      };
    });

    channelData.messages.push(...batch);
    messageCount += messagesArray.length;
    lastMessageId = messagesArray[messagesArray.length - 1]?.id;

    // Update progress every 5 batches
    batchCount++;
    if (onProgress && batchCount % 5 === 0) {
      await onProgress(messageCount);
    }
  }

  return {
    channel: channelData,
    messageCount
  };
} 