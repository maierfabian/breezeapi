import type { PluginContext } from '@breezeapi/core';
import { loadDiscordConfig, loadCommands, loadEvents, loadContextMenus } from './loader.js';
import { getClient, sendToChannel, Client } from './client.js';
import { REST, Routes, MessageFlags, ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import { Permissions } from './types.js';
export { Intents, GatewayIntentBits } from './types.js';
export type { DiscordContext, CommandOptions } from './types.js';
export { sendToChannel } from './client.js';

// Global registry for command configs by file
export const __commandRegistry: Record<string, any> = {};

// Command registration helper
export function Command(options: import('./types.js').CommandOptions) {
  // Try to get the caller file from the stack
  const err = new Error();
  const stack = err.stack?.split('\n');
  // Find the first stack line that is not this file
  const callerLine = stack?.find(line => !line.includes('Command') && line.includes('.ts'));
  const match = callerLine?.match(/\((.*):(\d+):(\d+)\)/) || callerLine?.match(/at (.*):(\d+):(\d+)/);
  const file = match?.[1];
  if (file) {
    __commandRegistry[file] = options;
  }
}

// Discord option type mapping (string to number)
const OptionTypeMap: Record<string, number> = {
  subcommand: 1,
  subcommand_group: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11,
};

function resolveOptionType(type: string | number): number {
  if (typeof type === 'number') return type;
  return OptionTypeMap[type] ?? 3; // default to string if unknown
}

function mapOptions(options?: any[]): any[] {
  if (!options) return [];
  return options.map(opt => ({
    ...opt,
    type: resolveOptionType(opt.type),
    options: opt.options ? mapOptions(opt.options) : undefined,
  }));
}

function commandToAPI(cmd: any) {
  return {
    name: cmd.name,
    description: cmd.handler.commandOptions?.description || 'No description',
    type: 1, // 1 = ChatInput (slash command)
    options: mapOptions(cmd.handler.commandOptions?.options),
  };
}

function commandsEqual(a: any[], b: any[]) {
  if (a.length !== b.length) return false;
  const sort = (arr: any[]) => arr.slice().sort((x, y) => x.name.localeCompare(y.name));
  const aSorted = sort(a);
  const bSorted = sort(b);
  for (let i = 0; i < aSorted.length; i++) {
    if (
      aSorted[i].name !== bSorted[i].name ||
      aSorted[i].description !== bSorted[i].description
    ) {
      return false;
    }
  }
  return true;
}

// Patch all relevant interaction types for safe replies
const interactionClasses = [
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  // Add more as needed (e.g., UserContextMenuCommandInteraction, MessageContextMenuCommandInteraction)
];
let patched = false;
for (const InteractionClass of interactionClasses) {
  if (InteractionClass && InteractionClass.prototype) {
    patched = true;
    const methods = ['reply', 'editReply', 'followUp'];
    for (const method of methods) {
      const orig = (InteractionClass.prototype as any)[method];
      if (!orig) continue;
      (InteractionClass.prototype as any)[method] = async function (options: any) {
        if (typeof options === 'object' && options !== null) {
          if ('ephemeral' in options) {
            if (options.ephemeral) {
              options.flags = (options.flags ?? 0) | MessageFlags.Ephemeral;
            }
            delete options.ephemeral;
          }
        }
        if (this.replied || this.deferred) {
          console.warn(`[Breeze Discord] Tried to ${method} on an already acknowledged interaction.`);
          return;
        }
        try {
          return await orig.call(this, options);
        } catch (err: any) {
          if (err?.code === 40060 || err?.message?.includes('already been acknowledged')) {
            console.warn(`[Breeze Discord] Interaction already acknowledged, ${method} skipped.`);
            return;
          }
          throw err;
        }
      };
    }
  }
}
if (!patched) {
  console.warn('[Breeze Discord] Could not patch any Interaction prototypes: No relevant classes found.');
}

export async function discordPlugin(ctx: PluginContext) {
  const config = await loadDiscordConfig();
  const client = getClient(config);
  // Load commands
  const commands = await loadCommands();
  if (commands.length) {
    console.log(`[Breeze Discord] Registered commands:`);
    for (const cmd of commands) {
      const group = cmd.group ? `[${cmd.group}]` : '';
      console.log(`  /${cmd.name} ${group} (${cmd.rel})`);
    }
  } else {
    console.log('[Breeze Discord] No commands registered.');
  }
  // Auto-register commands with Discord
  const commandData = commands.map(commandToAPI);
  const rest = new REST({ version: '10' }).setToken(config.token);
  let current: any[] = [];
  try {
    current = (await rest.get(
      Routes.applicationCommands(config.clientId)
    )) as any[];
  } catch (e) {
    console.error('[Breeze Discord] Failed to fetch current commands:', e);
  }
  if (commandsEqual(commandData, current)) {
    console.log('[Breeze Discord] No command changes detected. Skipping Discord registration.');
  } else {
    try {
      console.log(`[Breeze Discord] Registering ${commandData.length} commands with Discord...`);
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commandData }
      );
      console.log('[Breeze Discord] Successfully registered commands with Discord!');
    } catch (error) {
      console.error('[Breeze Discord] Failed to register commands with Discord:', error);
    }
  }
  // Load events
  const events = await loadEvents();
  if (events.length) {
    console.log(`[Breeze Discord] Registered events:`);
    for (const evt of events) {
      console.log(`  ${evt.name} (${evt.file})`);
    }

    // Attach event handlers to client with proper error handling
    if (client) {
      const resolvedClient = await client;
      for (const evt of events) {
        resolvedClient.on(evt.name, async (...args: unknown[]) => {
          try {
            await evt.handler(...(args as any));
          } catch (error) {
            console.error(`[Breeze Discord] Error in event handler ${evt.name}:`, error);
          }
        });
      }
    } else {
      console.error('[Breeze Discord] Client is not initialized.');
    }

    // Load context menus
    const contextMenus = await loadContextMenus();
    if (contextMenus.length) {
      console.log(`[Breeze Discord] Registered context menus:`);
      for (const ctxm of contextMenus) {
        const type = ctxm.type ? `[${ctxm.type}]` : '';
        console.log(`  ${ctxm.name} ${type} (${ctxm.file})`);
      }
    } else {
      console.log('[Breeze Discord] No context menus registered.');
    }
    // Build command map
    const commandMap = new Map<string, any>();
    for (const cmd of commands) {
      commandMap.set(cmd.name, cmd.handler);
    }

    // Attach interactionCreate event
    if (client) {
      const resolvedClient = await client;
      resolvedClient.on('interactionCreate', async (interaction: any) => {
        if (!interaction.isChatInputCommand()) return;
        const handler = commandMap.get(interaction.commandName);
        if (!handler) return;
        // Build options object from interaction.options
        const optionsObj: Record<string, any> = {};
        if (interaction.options && Array.isArray(handler.commandOptions?.options)) {
          for (const opt of handler.commandOptions.options) {
            const val = interaction.options.get(opt.name)?.value;
            if (val !== undefined) optionsObj[opt.name] = val;
          }
        }
        // Build context
        const ctx = {
          client: resolvedClient,
          interaction,
          options: optionsObj,
          reply: (data: any) => interaction.reply(data),
          defer: () => interaction.deferReply(),
          followUp: (data: any) => interaction.followUp(data),
        };
        try {
          // Permission check (if defined)
          const perms = handler.commandOptions?.permissions;
          if (perms) {
            const member = interaction.member as any;
            const required = Array.isArray(perms) ? perms : [perms];
            // Only check if member.permissions is a PermissionsBitField
            const hasPerms = member?.permissions && typeof member.permissions.has === 'function';
            const missing = hasPerms
              ? required.filter((perm: string) => !member.permissions.has(Permissions[perm as keyof typeof Permissions]))
              : required;
            if (missing.length > 0) {
              await interaction.reply({ content: `You lack the required permissions: ${missing.join(', ')}`, ephemeral: true });
              return;
            }
          }
          // Run checks, before, after hooks if needed
          if (handler.commandOptions?.checks) {
            for (const check of handler.commandOptions.checks) {
              if (!(await check(ctx))) return;
            }
          }
          if (handler.commandOptions?.before) {
            await handler.commandOptions.before(ctx);
          }
          const result = await handler(ctx);
          if (result !== undefined && !interaction.replied && !interaction.deferred) {
            await ctx.reply(result);
          }
          if (handler.commandOptions?.after) {
            await handler.commandOptions.after(ctx, result);
          }
        } catch (err) {
          console.error('[Breeze Discord] Command error:', err);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred.', ephemeral: true });
          }
        }
      });
      // TODO: Wire up HTTP endpoint
      (ctx as any).discord = resolvedClient;
    } else {
      console.error('[Breeze Discord] Client is not initialized.');
    }
  }
}

/**
 * Adds a role to a user in a specified guild.
 * @param guildId The ID of the guild
 * @param userId The ID of the user
 * @param roleId The ID of the role to add
 * @returns Promise resolving to the GuildMember or throws on error
 */
export async function addRoleToUser(guildId: string, userId: string, roleId: string) {
  const guild = await Client.guilds.fetch(guildId);
  if (!guild) throw new Error(`Guild not found: ${guildId}`);
  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    throw new Error('User is not a member of the guild');
  }
  if (!member || typeof member.roles?.add !== 'function') {
    throw new Error('User is not a member of the guild or member object is invalid');
  }
  await member.roles.add(roleId);
  return member;
}

export { Client } from './client.js';
