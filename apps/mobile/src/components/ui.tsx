/** Small reusable presentational pieces. */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { statusColors, type Theme } from '@/lib/theme';

export function Badge({ status, t }: { status: string | null | undefined; t: Theme }) {
  const { bg, fg } = statusColors(status, t);
  const label = (status ?? '—').toString();
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Chip({
  label,
  value,
  t,
  tint,
}: {
  label: string;
  value: string | number;
  t: Theme;
  tint?: string;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: t.chipBg, borderColor: t.border }]}>
      <Text style={[styles.chipValue, { color: tint ?? t.text }]}>{value}</Text>
      <Text style={[styles.chipLabel, { color: t.textDim }]}>{label}</Text>
    </View>
  );
}

export function Card({
  t,
  children,
  style,
}: {
  t: Theme;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: t.card,
          borderColor: t.border,
          shadowColor: t.shadow,
          shadowOpacity: t.shadowOpacity,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionHeader({
  title,
  count,
  t,
}: {
  title: string;
  count?: number;
  t: Theme;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleWrap}>
        <View style={[styles.sectionAccent, { backgroundColor: t.accent }]} />
        <Text style={[styles.sectionTitle, { color: t.text }]}>{title}</Text>
      </View>
      {typeof count === 'number' && (
        <Text style={[styles.sectionCount, { color: t.textFaint }]}>{count}</Text>
      )}
    </View>
  );
}

export function EmptyState({ text, t }: { text: string; t: Theme }) {
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyText, { color: t.textFaint }]}>{text}</Text>
    </View>
  );
}

export function KV({
  k,
  v,
  t,
  mono,
}: {
  k: string;
  v: string;
  t: Theme;
  mono?: boolean;
}) {
  if (!v) return null;
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvKey, { color: t.textFaint }]}>{k}</Text>
      <Text style={[styles.kvVal, { color: t.textDim }, mono && styles.mono]} selectable>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: 180,
  },
  badgeText: { fontSize: 12.5, fontWeight: '700', lineHeight: 16 },
  chip: {
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 14,
    minWidth: 84,
    alignItems: 'center',
  },
  chipValue: { fontSize: 22, fontWeight: '800', lineHeight: 26 },
  chipLabel: { fontSize: 12, marginTop: 3, fontWeight: '600' },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
    // iOS shadow (color + opacity are injected per-theme).
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    // Android elevation.
    elevation: 2,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    marginBottom: 10,
  },
  sectionTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  sectionAccent: { width: 4, height: 20, borderRadius: 2 },
  sectionTitle: { fontSize: 20, fontWeight: '800' },
  sectionCount: { fontSize: 14, fontWeight: '600' },
  empty: { paddingVertical: 28, alignItems: 'center' },
  emptyText: { fontSize: 14, lineHeight: 22 },
  kv: { marginTop: 12 },
  kvKey: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  kvVal: { fontSize: 14.5, marginTop: 3, lineHeight: 23 },
  mono: { fontFamily: 'monospace', fontSize: 13 },
});
