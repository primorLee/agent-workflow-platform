import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { registerMonitorTask } from '@/lib/notify';
import { getTheme } from '@/lib/theme';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  const theme = getTheme(useColorScheme());

  useEffect(() => {
    registerMonitorTask().catch(() => {});
  }, []);

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.navBg },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: '800', fontSize: 18 },
          contentStyle: { backgroundColor: theme.bg },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Agent 工作流监控' }} />
        <Stack.Screen name="settings" options={{ title: '连接设置', presentation: 'modal' }} />
        <Stack.Screen name="task" options={{ title: '任务详情' }} />
        <Stack.Screen name="session" options={{ title: '会话详情' }} />
      </Stack>
    </>
  );
}
