/**
 * Local notifications for newly failed tasks.
 *
 * No push provider or hosted account is needed. The OS periodically wakes the
 * app, which polls the configured control plane and compares failed task ids
 * with a small local baseline.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { fetchTasks } from './api';
import { loadSettings } from './settings';

export const MONITOR_TASK = 'awp-control-plane-monitor';
const CHANNEL_ID = 'awp-task-alerts';
const K_SEEN_FAILED = 'awp.mobile.seenFailedTaskIds';

function isFailed(status: string): boolean {
  const value = status.toLowerCase();
  return value === 'failed' || value === 'error';
}

async function readSeen(): Promise<Set<string> | null> {
  const raw = await AsyncStorage.getItem(K_SEEN_FAILED);
  if (raw == null) return null;
  try {
    const values = JSON.parse(raw);
    return Array.isArray(values) ? new Set(values.map(String)) : null;
  } catch {
    return null;
  }
}

async function writeSeen(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(K_SEEN_FAILED, JSON.stringify(ids.slice(-500)));
}

export function defineMonitorTask(): void {
  if (TaskManager.isTaskDefined(MONITOR_TASK)) return;

  TaskManager.defineTask(MONITOR_TASK, async () => {
    try {
      const settings = await loadSettings();
      const tasks = await fetchTasks(settings.baseUrl, settings.devKey);
      const failedIds = tasks.filter((task) => isFailed(task.status)).map((task) => task.id);
      const seen = await readSeen();

      if (seen == null) {
        await writeSeen(failedIds);
        return BackgroundTask.BackgroundTaskResult.Success;
      }

      const fresh = failedIds.filter((id) => !seen.has(id));
      if (fresh.length > 0) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Agent Workflow Platform',
            body: `新增 ${fresh.length} 个失败任务，点开查看`,
          },
          trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
        });
      }
      await writeSeen(failedIds);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

defineMonitorTask();

export async function registerMonitorTask(): Promise<Notifications.NotificationPermissionsStatus> {
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync();
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '任务失败提醒',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  try {
    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(MONITOR_TASK);
    if (!alreadyRegistered) {
      const { pollMinutes } = await loadSettings();
      await BackgroundTask.registerTaskAsync(MONITOR_TASK, {
        minimumInterval: pollMinutes,
      });
    }
  } catch {
    // Web previews and some simulators do not provide background scheduling.
  }

  return permission;
}

export async function fireTestNotification(): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Agent Workflow Platform',
      body: '本地任务通知工作正常',
    },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
  });
}
