import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';

import { Badge, Card, EmptyState, KV } from '@/components/ui';
import { fmtTime, prettyJson } from '@/lib/format';
import { getTaskById } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function TaskDetailScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const task = id ? getTaskById(id) : undefined;

  if (!task) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <EmptyState text="找不到任务；返回首页刷新后再试" t={theme} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card t={theme}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>{task.task_type}</Text>
            <Badge status={task.status} t={theme} />
          </View>
          <KV k="task_id" v={task.id} t={theme} mono />
          <KV k="created_at" v={fmtTime(task.created_at)} t={theme} />
          <KV k="updated_at" v={fmtTime(task.updated_at)} t={theme} />
          <Block label="payload" body={prettyJson(task.payload)} />
          <Block label="result" body={prettyJson(task.result)} />
          <Block label="error" body={task.error ?? ''} />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  const theme = useTheme();
  if (!body) return null;
  return (
    <View style={styles.block}>
      <Text style={[styles.blockLabel, { color: theme.textFaint }]}>{label}</Text>
      <Text style={[styles.blockBody, { color: theme.text }]} selectable>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 18, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 21, fontWeight: '800', flex: 1, lineHeight: 30 },
  block: { marginTop: 20 },
  blockLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  blockBody: { fontFamily: 'monospace', fontSize: 13.5, lineHeight: 22, marginTop: 8 },
});
