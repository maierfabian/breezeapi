import type { PluginContext } from '../index';
import { CronJob } from 'cron';
import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// --- Cron job logic (adapted for plugin) ---
export interface CronConfig {
    enabled: boolean;
    useTime: boolean;
    cronTime: string;
    timeZone: string;
    timeBetween: string;
    runOnStart: boolean;
    runOnStartDelay?: number;
}

interface CronModule {
    cronConfig: CronConfig;
    default: () => Promise<void>;
}

const lastExecutions: Record<string, Date> = {};

function shouldExecuteTimeBased(jobName: string, timeBetween: string): boolean {
    const now = new Date();
    const lastExecution = lastExecutions[jobName];
    if (!lastExecution) return true;
    // parseDuration: expects ms, fallback to 0 if not available
    const minTimeBetween = parseDuration(timeBetween);
    const timeDiff = now.getTime() - lastExecution.getTime();
    return timeDiff >= minTimeBetween;
}

function parseDuration(duration: string): number {
    // Simple parser: "1h" => 3600000, "30m" => 1800000, "10s" => 10000
    if (!duration) return 0;
    const match = duration?.match(/(\d+)([smhd])/);
    if (!match) return 0;
    const value = parseInt(match[1]!, 10);
    switch (match[2]) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return 0;
    }
}

function registerCronJob(jobName: string, cronModule: CronModule) {
    const { cronConfig, default: cronFunction } = cronModule;
    if (!cronConfig.enabled) {
        console.log(`[Breeze Cron] Cron job ${jobName} is disabled`);
        return;
    }
    const onTick = async () => {
        try {
            if (cronConfig.useTime && !shouldExecuteTimeBased(jobName, cronConfig.timeBetween)) {
                console.log(`[Breeze Cron] Skipping ${jobName}: Not enough time passed`);
                return;
            }
            console.log(`[Breeze Cron] Running cron job: ${jobName}`);
            await cronFunction();
            lastExecutions[jobName] = new Date();
        } catch (error) {
            console.error(`[Breeze Cron] Error in cron job ${jobName}:`, error);
        }
    };
    const job = new CronJob(
        cronConfig.cronTime,
        onTick,
        null,
        false,
        cronConfig.timeZone
    );
    job.start();
    console.log(`[Breeze Cron] Registered cron job: ${jobName} with schedule ${cronConfig.cronTime}`);
    if (cronConfig.runOnStart) {
        const delay = typeof cronConfig.runOnStartDelay === 'number' ? cronConfig.runOnStartDelay : 5000;
        console.log(`[Breeze Cron] Running ${jobName} on start after ${delay}ms delay`);
        setTimeout(onTick, delay);
    }
}

async function loadCronJobsFromDir(dir: string, cronJobsDir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Recurse into subdirectories
            await loadCronJobsFromDir(fullPath, cronJobsDir);
        } else if (entry.name === 'cron.ts' || entry.name === 'cron.js') {
            try {
                const relativePath = relative(cronJobsDir, dir);
                const jobName = relativePath || 'root';
                const cronModule = await import(fullPath) as CronModule;
                // Validate cronConfig
                if (
                    !cronModule.cronConfig ||
                    typeof cronModule.cronConfig.cronTime !== 'string' ||
                    !cronModule.default ||
                    typeof cronModule.default !== 'function'
                ) {
                    console.warn(`[Breeze Cron] Skipping invalid cron job at ${fullPath}: missing cronConfig or cronTime`);
                    continue;
                }
                registerCronJob(jobName, cronModule);
            } catch (error) {
                console.error(`[Breeze Cron] Error loading cron job from ${fullPath}:`, error);
            }
        }
    }
}

async function loadPluginConfig() {
    const configPath = join(process.cwd(), '.breeze', 'plugins', 'cron.config.ts');
    if (existsSync(configPath)) {
        try {
            const config = await import(configPath);
            return config.default || config;
        } catch (e) {
            console.warn('[Breeze Cron] Failed to import .breeze/plugins/cron.config.ts:', e);
        }
    }
    return {};
}

export async function cronPlugin(ctx: PluginContext) {
    // Load config from .breeze/plugins/cron.config.ts if present
    const pluginConfig = await loadPluginConfig();
    // Merge: pluginConfig > ctx.config?.breezeCron > defaults
    const cronConfig = {
        ...(ctx.config?.breezeCron || {}),
        ...pluginConfig,
    };
    const cronJobsDir = cronConfig.cronJobsDir
        ? cronConfig.cronJobsDir
        : join(process.cwd(), 'src', 'cronjobs');

    try {
        const stats = await stat(cronJobsDir);
        if (!stats.isDirectory()) {
            console.log('[Breeze Cron] No cronjobs directory found at', cronJobsDir, ', skipping initialization');
            return;
        }
    } catch {
        console.log('[Breeze Cron] No cronjobs directory found at', cronJobsDir, ', skipping initialization');
        return;
    }

    console.log('[Breeze Cron] Initializing cron jobs from', cronJobsDir, '...');
    await loadCronJobsFromDir(cronJobsDir, cronJobsDir);
    console.log('[Breeze Cron] Cron jobs initialization complete');
}

// Optionally export helpers/types
export type { PluginContext } from '../index'; 