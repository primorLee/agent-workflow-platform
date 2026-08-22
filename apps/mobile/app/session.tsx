import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';

import { Badge, Card, EmptyState, KV } from '@/components/ui';
import { fmtTime, prettyJson } from '@/lib/format';
import { getSessionById } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function SessionDetailScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = id ? getSessionById(id) : undefined;

  if (!session) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
        <EmptyState text="找不到会话；返回首页刷新后再试" t={theme} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card t={theme}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>{session.session_type}</Text>
            <Badge status={session.status} t={theme} />
          </View>
          <KV k="session_id" v={session.session_id} t={theme} mono />
          <KV k="created_at" v={fmtTime(session.created_at)} t={theme} />
          <KV k="last_heartbeat" v={fmtTime(session.last_heartbeat)} t={theme} />
          <View style={styles.block}>
            <Text style={[styles.blockLabel, { color: theme.textFaint }]}>metadata</Text>
            <Text style={[styles.blockBody, { color: theme.text }]} selectable>
              {prettyJson(session.metadata) || '{}'}
            </Text>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
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
