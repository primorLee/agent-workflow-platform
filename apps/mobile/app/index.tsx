import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native';

import { Badge, Card, Chip, EmptyState, SectionHeader } from '@/components/ui';
import { ApiError, fetchDashboard } from '@/lib/api';
import { fmtTime, shortId, taskStatusCounts, taskSummary } from '@/lib/format';
import { loadSettings, type Settings } from '@/lib/settings';
import { setLastDashboard } from '@/lib/store';
import { statusColors, useTheme } from '@/lib/theme';
import type { DashboardData, SessionRecord, TaskRecord } from '@/lib/types';

type LoadState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ok'; data: DashboardData }
  | { phase: 'error'; status: number; message: string };

export default function MainScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setState({ phase: 'loading' });
    try {
      const nextSettings = await loadSettings();
      setSettings(nextSettings);
      const data = await fetchDashboard(nextSettings.baseUrl, nextSettings.devKey);
      setLastDashboard(data);
      setState({ phase: 'ok', data });
    } catch (error) {
      setState({
        phase: 'error',
        status: error instanceof ApiError ? error.status : -1,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(true);
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(false);
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              hitSlop={12}
              onPress={() => router.push('/settings')}
              accessibilityLabel="连接设置"
            >
              <Text style={{ color: theme.text, fontSize: 22 }}>⚙︎</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
      >
        {state.phase === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.dim, { color: theme.textDim }]}>连接本地 control-plane…</Text>
          </View>
        )}

        {state.phase === 'error' && (
          <ErrorView
            status={state.status}
            message={state.message}
            onRetry={() => load(true)}
            onSettings={() => router.push('/settings')}
          />
        )}

        {state.phase === 'ok' && (
          <Dashboard data={state.data} baseUrl={settings?.baseUrl ?? ''} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ErrorView({
  status,
  message,
  onRetry,
  onSettings,
}: {
  status: number;
  message: string;
  onRetry: () => void;
  onSettings: () => void;
}) {
  const theme = useTheme();
  const authProblem = status === 401 || status === 403;
  return (
    <View style={styles.center}>
      <Text style={{ fontSize: 40 }}>{authProblem ? '🔑' : '⚠️'}</Text>
      <Text style={[styles.errTitle, { color: theme.text }]}>{message}</Text>
      <View style={styles.errButtons}>
        <Pressable
          style={[styles.button, { backgroundColor: theme.accent }]}
          onPress={authProblem ? onSettings : onRetry}
        >
          <Text style={styles.buttonText}>{authProblem ? '检查设置' : '重试'}</Text>
        </Pressable>
        <Pressable
          style={[styles.ghostButton, { borderColor: theme.border }]}
          onPress={onSettings}
        >
          <Text style={[styles.ghostButtonText, { color: theme.textDim }]}>连接设置</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Dashboard({ data, baseUrl }: { data: DashboardData; baseUrl: string }) {
  const theme = useTheme();
  const router = useRouter();
  const statusEntries = taskStatusCounts(data.tasks);
  const ready = data.health.status.toLowerCase() === 'ok';

  return (
    <View>
      <Card t={theme} style={styles.healthCard}>
        <View style={styles.rowBetween}>
          <View>
            <Text style={[styles.eyebrow, { color: theme.textFaint }]}>CONTROL PLANE</Text>
            <Text style={[styles.healthTitle, { color: theme.text }]}>
              {ready ? '本地服务已就绪' : `状态：${data.health.status}`}
            </Text>
          </View>
          <View
            style={[
              styles.healthDot,
              { backgroundColor: ready ? '#22C55E' : '#F59E0B' },
            ]}
          />
        </View>
        <Text style={[styles.endpoint, { color: theme.textDim }]} numberOfLines={1}>
          {baseUrl}
        </Text>
        <Text style={[styles.fetched, { color: theme.textFaint }]}>
          更新于 {fmtTime(data.fetchedAt)}
        </Text>
      </Card>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {statusEntries.length === 0 && <Chip label="任务" value={0} t={theme} />}
        {statusEntries.map(([status, count]) => (
          <Chip
            key={status}
            label={status}
            value={count}
            t={theme}
            tint={statusColors(status, theme).bg}
          />
        ))}
        <Chip label="活跃会话" value={data.sessions.length} t={theme} />
      </ScrollView>

      <SectionHeader title="最近任务" count={data.tasks.length} t={theme} />
      {data.tasks.length === 0 ? (
        <EmptyState text="还没有任务；可通过 POST /v1/tasks 创建" t={theme} />
      ) : (
        data.tasks.slice(0, 30).map((task) => (
          <Pressable
            key={task.id}
            onPress={() => router.push({ pathname: '/task', params: { id: task.id } })}
          >
            <TaskCard task={task} />
          </Pressable>
        ))
      )}

      <SectionHeader title="会话" count={data.sessions.length} t={theme} />
      {data.sessions.length === 0 ? (
        <EmptyState text="当前没有会话" t={theme} />
      ) : (
        data.sessions.slice(0, 30).map((session) => (
          <Pressable
            key={session.session_id}
            onPress={() =>
              router.push({ pathname: '/session', params: { id: session.session_id } })
            }
          >
            <SessionCard session={session} />
          </Pressable>
        ))
      )}
      <View style={{ height: 28 }} />
    </View>
  );
}

function TaskCard({ task }: { task: TaskRecord }) {
  const theme = useTheme();
  return (
    <Card t={theme}>
      <View style={styles.rowBetween}>
        <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>
          {task.task_type}
        </Text>
        <Badge status={task.status} t={theme} />
      </View>
      <Text style={[styles.cardBody, { color: theme.textDim }]} numberOfLines={3}>
        {taskSummary(task)}
      </Text>
      <Text style={[styles.cardMeta, { color: theme.textFaint }]}>
        {shortId(task.id)}{task.created_at ? ` · ${fmtTime(task.created_at)}` : ''}
      </Text>
    </Card>
  );
}

function SessionCard({ session }: { session: SessionRecord }) {
  const theme = useTheme();
  return (
    <Card t={theme}>
      <View style={styles.rowBetween}>
        <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>
          {session.session_type}
        </Text>
        <Badge status={session.status} t={theme} />
      </View>
      <Text style={[styles.cardMeta, { color: theme.textFaint }]}>
        {shortId(session.session_id)}
        {session.last_heartbeat ? ` · heartbeat ${fmtTime(session.last_heartbeat)}` : ''}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 32, flexGrow: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 88, gap: 14 },
  dim: { fontSize: 14, lineHeight: 22 },
  healthCard: { marginTop: 2 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  healthTitle: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  healthDot: { width: 13, height: 13, borderRadius: 7 },
  endpoint: { fontFamily: 'monospace', fontSize: 12.5, marginTop: 14 },
  fetched: { fontSize: 12, marginTop: 6 },
  chipRow: { gap: 10, paddingRight: 8, paddingVertical: 2 },
  cardTitle: { fontSize: 17, fontWeight: '700', lineHeight: 24, flex: 1 },
  cardBody: { fontSize: 14.5, lineHeight: 22, marginTop: 10 },
  cardMeta: { fontSize: 12.5, lineHeight: 18, marginTop: 10 },
  errTitle: { fontSize: 16.5, fontWeight: '700', textAlign: 'center', lineHeight: 24, marginTop: 8 },
  errButtons: { flexDirection: 'row', gap: 12, marginTop: 12 },
  button: { borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },
  ghostButton: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  ghostButtonText: { fontWeight: '700', fontSize: 14.5 },
});
