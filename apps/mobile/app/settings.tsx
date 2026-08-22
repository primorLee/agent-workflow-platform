import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native';

import { ApiError, fetchDashboard } from '@/lib/api';
import { fireTestNotification } from '@/lib/notify';
import {
  DEFAULT_BASE_URL,
  DEFAULT_DEV_KEY,
  loadSettings,
  POLL_OPTIONS,
  saveSettings,
  type PollMinutes,
} from '@/lib/settings';
import { useTheme } from '@/lib/theme';

type TestResult =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; summary: string }
  | { kind: 'fail'; message: string };

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [devKey, setDevKey] = useState(DEFAULT_DEV_KEY);
  const [pollMinutes, setPollMinutes] = useState<PollMinutes>(60);
  const [loaded, setLoaded] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: 'idle' });
  const [notificationStatus, setNotificationStatus] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then((settings) => {
      setBaseUrl(settings.baseUrl);
      setDevKey(settings.devKey);
      setPollMinutes(settings.pollMinutes);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    Notifications.getPermissionsAsync()
      .then((permission) =>
        setNotificationStatus(permission.granted ? '已授权' : '未授权'),
      )
      .catch(() => setNotificationStatus(null));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveSettings({ baseUrl, devKey, pollMinutes }).catch(() => {});
  }, [baseUrl, devKey, pollMinutes, loaded]);

  const runTest = async () => {
    setTest({ kind: 'testing' });
    try {
      await saveSettings({ baseUrl, devKey, pollMinutes });
      const data = await fetchDashboard(baseUrl, devKey);
      setTest({
        kind: 'ok',
        summary: `连接成功：${data.tasks.length} 个任务，${data.sessions.length} 个会话`,
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : -1;
      const message = error instanceof Error ? error.message : '未知错误';
      setTest({
        kind: 'fail',
        message: status === 401 ? '本地开发密钥不匹配' : message,
      });
    }
  };

  const testNotification = async () => {
    try {
      const current = await Notifications.getPermissionsAsync();
      const permission = current.granted
        ? current
        : await Notifications.requestPermissionsAsync();
      setNotificationStatus(permission.granted ? '已授权' : '未授权');
      if (permission.granted) await fireTestNotification();
    } catch {
      setNotificationStatus('此设备不支持');
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={[styles.label, { color: theme.textDim }]}>Control-plane 地址</Text>
          <TextInput
            style={[
              styles.input,
              { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
            ]}
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_BASE_URL}
            placeholderTextColor={theme.textFaint}
          />
          <Text style={[styles.hint, { color: theme.textFaint }]}>
            本机默认端口为 8100。Android USB 可使用 adb reverse；iOS 真机请填写操作者提供的 HTTPS 反向代理或可信隧道地址。
          </Text>

          <Text style={[styles.label, { color: theme.textDim }]}>本地开发密钥</Text>
          <TextInput
            style={[
              styles.input,
              { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
            ]}
            value={devKey}
            onChangeText={setDevKey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="粘贴 Compose 生成的随机开发密钥"
            placeholderTextColor={theme.textFaint}
          />
          <Text style={[styles.hint, { color: theme.textFaint }]}>
            此字段默认为空。请从本机 Compose 控制面容器读取随机密钥后粘贴；不要把密钥写入源码或截图。
          </Text>

          <Text style={[styles.label, { color: theme.textDim }]}>后台检查间隔</Text>
          <View style={styles.segmented}>
            {POLL_OPTIONS.map((minutes) => {
              const selected = pollMinutes === minutes;
              return (
                <Pressable
                  key={minutes}
                  onPress={() => setPollMinutes(minutes)}
                  style={[
                    styles.segment,
                    {
                      borderColor: selected ? theme.accent : theme.border,
                      backgroundColor: selected ? theme.accent : theme.card,
                    },
                  ]}
                >
                  <Text style={[styles.segmentText, { color: selected ? '#fff' : theme.textDim }]}>
                    {minutes < 60 ? `${minutes} 分` : `${minutes / 60} 小时`}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            style={[styles.primaryButton, { backgroundColor: theme.accent }]}
            onPress={runTest}
            disabled={test.kind === 'testing'}
          >
            {test.kind === 'testing' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>测试真实接口</Text>
            )}
          </Pressable>

          {test.kind === 'ok' && (
            <ResultBox
              text={test.summary}
              color="#22C55E"
              border={theme.border}
              background={theme.card}
            />
          )}
          {test.kind === 'fail' && (
            <ResultBox
              text={test.message}
              color="#EF4444"
              border={theme.border}
              background={theme.card}
            />
          )}

          <Pressable
            style={[
              styles.secondaryButton,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            onPress={testNotification}
          >
            <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
              测试本地通知{notificationStatus ? `（${notificationStatus}）` : ''}
            </Text>
          </Pressable>

          <Pressable style={styles.doneButton} onPress={() => router.back()}>
            <Text style={[styles.doneText, { color: theme.accent }]}>完成</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ResultBox({
  text,
  color,
  border,
  background,
}: {
  text: string;
  color: string;
  border: string;
  background: string;
}) {
  return (
    <View style={[styles.result, { borderColor: border, backgroundColor: background }]}>
      <Text style={[styles.resultText, { color }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  label: { fontSize: 13, fontWeight: '800', marginTop: 18, marginBottom: 8 },
  input: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15 },
  hint: { fontSize: 12.5, lineHeight: 19, marginTop: 7 },
  segmented: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, borderRadius: 11, borderWidth: 1, paddingVertical: 11, alignItems: 'center' },
  segmentText: { fontSize: 13.5, fontWeight: '700' },
  primaryButton: { borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 30 },
  primaryButtonText: { color: '#fff', fontWeight: '800', fontSize: 15.5 },
  secondaryButton: { borderRadius: 14, borderWidth: 1, paddingVertical: 15, alignItems: 'center', marginTop: 10 },
  secondaryButtonText: { fontWeight: '800', fontSize: 14.5 },
  result: { borderRadius: 12, borderWidth: 1, padding: 14, marginTop: 14 },
  resultText: { fontSize: 13.5, lineHeight: 21 },
  doneButton: { alignItems: 'center', paddingVertical: 18, marginTop: 14 },
  doneText: { fontSize: 16, fontWeight: '700' },
});
